import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeService } from "../service.ts";
import { ProjectStore, projectStateDir } from "../storage.ts";
import { buildChunk, loadSession, parseSessionSnapshot, prefixDigest, readStableJsonl, redactSecrets } from "../sessions.ts";
import { ANALYZER_PROMPT_VERSION, type AnalyzerCandidate, type AnalyzerResult } from "../types.ts";

const stamp = { dev: 1, ino: 2, size: 10, mtimeMs: 1, ctimeMs: 1 };

function lines(cwd: string, id: string, entries: object[]): string {
  return [
    JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ].join("\n") + "\n";
}

function message(id: string, role: string, text: string, extra: object = {}) {
  return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role, content: [{ type: "text", text }], timestamp: Date.now(), ...extra } };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "skill-forge-session-"));
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agent), mkdir(sessionDir)]);
  const location = await projectStateDir(agent, cwd);
  return { root, cwd, agent, sessionDir, location };
}

function context(cwd: string, sessionDir: string) {
  return { cwd, sessionManager: { getSessionDir: () => sessionDir }, model: { provider: "mock", id: "model" } } as any;
}

const zero: AnalyzerResult = { candidates: [], analyzerModel: "mock/model", analyzerPromptVersion: ANALYZER_PROMPT_VERSION };

function generatedCandidate(evidenceRef: string): AnalyzerCandidate {
  return {
    capabilityKey: "verified-workflow",
    title: "Verified workflow",
    rationale: "The session contains a reusable verified workflow.",
    confidence: 0.9,
    skillName: "verified-workflow",
    description: "Use this verified workflow when repeating the project task.",
    skillMd: "# Verified workflow\n\nFollow the verified steps and confirm the outcome.",
    proposedScope: { scope: "project", rationale: "The commands are project-specific.", confidence: 0.9, signals: ["project command"] },
    evidenceRefs: [evidenceRef],
    operation: "create",
  };
}

test("stable reader and malformed JSONL parser isolate bad lines", async () => {
  const f = await fixture();
  try {
    const path = join(f.sessionDir, "one.jsonl");
    await writeFile(path, `${lines(f.cwd, "s1", [message("a", "user", "hello")])}{bad json\n${JSON.stringify(message("b", "assistant", "done"))}\n`);
    const snapshot = await readStableJsonl(path);
    assert.equal(snapshot.text.includes("hello"), true);
    const parsed = parseSessionSnapshot(path, snapshot.text, snapshot.stamp);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.malformed.length, 1);
    assert.equal(parsed.malformed[0]?.line, 3);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("normalization excludes images/thinking/owned content, bounds logs, and redacts secrets", () => {
  const text = lines("/p", "s", [
    { type: "custom", id: "owned", customType: "skill-forge-state", data: { secret: "x" } },
    { type: "message", id: "a", timestamp: "t", message: { role: "assistant", content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "image", data: "base64-secret" },
      { type: "text", text: "API_KEY=super-secret-value" },
      { type: "toolCall", name: "bash", arguments: { token: "ghp_abcdefghijklmnopqrstuvwxyz12345" } },
    ] } },
    { type: "message", id: "b", timestamp: "t", message: { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "x".repeat(20_000) }] } },
  ]);
  const parsed = parseSessionSnapshot("/s", text, stamp);
  const chunk = buildChunk(parsed, 0, 50_000, 100)!;
  assert.doesNotMatch(chunk.transcript, /private reasoning|base64-secret|super-secret-value|ghp_/);
  assert.match(chunk.transcript, /REDACTED/);
  assert.ok(chunk.transcript.length < 10_000);
  assert.equal(chunk.evidence.length, 2);
  assert.equal(redactSecrets("PASSWORD=hunter2"), "PASSWORD=[REDACTED]");
});

test("inventory analyzes every listed current-project session, excludes other projects, chunks fully, and commits watermarks", async () => {
  const f = await fixture();
  try {
    const other = join(f.root, "other"); await mkdir(other);
    const first = join(f.sessionDir, "first.jsonl");
    const second = join(f.sessionDir, "second.jsonl");
    const foreign = join(f.sessionDir, "foreign.jsonl");
    await writeFile(first, lines(f.cwd, "s1", Array.from({ length: 9 }, (_, i) => message(`a${i}`, i % 2 ? "assistant" : "user", `entry ${i} ${"z".repeat(40)}`))));
    await writeFile(second, lines(f.cwd, "s2", [message("b1", "user", "one"), "{bad" as any].filter((x) => typeof x !== "string")));
    // Add a malformed line without poisoning valid entries.
    await writeFile(second, `${await readFile(second, "utf8")}{malformed\n${JSON.stringify(message("b2", "assistant", "two"))}\n`);
    await writeFile(foreign, lines(other, "s3", [message("c", "user", "foreign")]));

    const analyzed: Array<[string, number, number]> = [];
    const service = new ForgeService(
      new ProjectStore(f.location.dir, f.location.cwd, f.location.key), f.agent, ".pi",
      async () => [first, second, foreign].map((path, i) => ({ path, id: `s${i + 1}`, cwd: i === 2 ? other : f.cwd })),
      async (_ctx, chunk) => { analyzed.push([chunk.sessionId, chunk.startEntryIndex, chunk.endEntryIndex]); return zero; },
    );
    await service.initialize();
    await service.store.withLock((state) => { state.config.maxRequestChars = 4_096; state.config.maxEntriesPerChunk = 3; });
    await service.inventory(context(f.cwd, f.sessionDir));
    await service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);

    const state = await service.store.read();
    assert.deepEqual(new Set(Object.values(state.watermarks).map((w) => w.sessionId)), new Set(["s1", "s2"]));
    assert.equal(state.watermarks[first]?.nextEntryIndex, 9);
    assert.equal(state.watermarks[second]?.nextEntryIndex, 2);
    assert.ok(analyzed.filter(([id]) => id === "s1").length >= 3, "large session was chunked");
    assert.equal(state.jobs.length, 0);
    assert.ok(state.diagnostics.some((d) => d.code === "other_project_excluded"));
    assert.ok(state.diagnostics.some((d) => d.code === "malformed_jsonl_line"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("append growth resumes at watermark while rewrite/replacement safely replays", async () => {
  const f = await fixture();
  try {
    const path = join(f.sessionDir, "one.jsonl");
    await writeFile(path, lines(f.cwd, "s1", [message("a", "user", "first"), message("b", "assistant", "second")]));
    const ranges: number[] = [];
    const service = new ForgeService(new ProjectStore(f.location.dir, f.location.cwd, f.location.key), f.agent, ".pi",
      async () => [{ path, id: "s1", cwd: f.cwd }], async (_ctx, chunk) => { ranges.push(chunk.startEntryIndex); return zero; });
    await service.initialize();
    await service.inventory(context(f.cwd, f.sessionDir));
    await service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    const original = await readFile(path, "utf8");
    await writeFile(path, `${original}${JSON.stringify(message("c", "user", "third"))}\n`);
    await service.inventory(context(f.cwd, f.sessionDir));
    await service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    assert.equal(ranges.at(-1), 2);

    // Atomic replacement changes inode and forces full replay even with valid content.
    const replacement = join(f.sessionDir, "replacement");
    await writeFile(replacement, lines(f.cwd, "s1", [message("x", "user", "rewritten")]));
    await (await import("node:fs/promises")).rename(replacement, path);
    await service.inventory(context(f.cwd, f.sessionDir));
    await service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    assert.equal(ranges.at(-1), 0);
    assert.ok((await service.store.read()).diagnostics.some((d) => d.code === "session_replayed"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("startup requeues jobs rejected by the superseded strict thinking-block validator", async () => {
  const f = await fixture();
  try {
    const store = new ProjectStore(f.location.dir, f.location.cwd, f.location.key);
    const service = new ForgeService(store, f.agent, ".pi", async () => [], async () => zero);
    await service.initialize();
    await store.withLock((state) => {
      state.jobs.push({
        id: "job-legacy-protocol", sessionId: "s", sessionPath: "/missing", startEntryIndex: 0, endEntryIndex: 1,
        rangeDigest: "a".repeat(64), status: "dead", attempts: 4, nextRunAt: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        lastError: "Analyzer response must contain exactly one submit_skill_candidates tool call and no text, thinking, or other calls; received 2 parts",
      });
    });
    await service.initialize();
    const job = (await store.read()).jobs[0]!;
    assert.equal(job.status, "queued");
    assert.equal(job.attempts, 0);
    assert.equal(job.lastError, undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("queue is idempotent, recovers leases, retries visibly, and never advances on invalid analyzer output", async () => {
  const f = await fixture();
  try {
    const path = join(f.sessionDir, "one.jsonl");
    await writeFile(path, lines(f.cwd, "s1", [message("a", "user", "first")]));
    let calls = 0; let shouldFail = true;
    const service = new ForgeService(new ProjectStore(f.location.dir, f.location.cwd, f.location.key), f.agent, ".pi",
      async () => [{ path, id: "s1", cwd: f.cwd }], async () => { calls++; if (shouldFail) throw new Error("mock analyzer failure"); return zero; });
    await service.initialize();
    await service.store.withLock((state) => { state.config.maxRetries = 2; });
    await service.inventory(context(f.cwd, f.sessionDir));
    await service.inventory(context(f.cwd, f.sessionDir));
    assert.equal((await service.store.read()).jobs.length, 1, "inventory queue is idempotent");
    await service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    let state = await service.store.read();
    assert.equal(state.jobs[0]?.status, "retry");
    assert.equal(state.watermarks[path]?.nextEntryIndex, 0);
    await service.store.withLock((fresh) => { fresh.jobs[0]!.nextRunAt = 0; });
    await service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    state = await service.store.read();
    assert.equal(state.jobs[0]?.status, "dead");
    assert.equal(calls, 2);
    assert.ok(state.diagnostics.some((d) => d.code === "job_dead"));
    await service.inventory(context(f.cwd, f.sessionDir));
    await service.inventory(context(f.cwd, f.sessionDir));
    state = await service.store.read();
    assert.equal(state.jobs.length, 1, "dead coverage is not auto-duplicated by reinventory");
    assert.equal(state.jobs[0]?.status, "dead");

    await service.store.withLock((fresh) => {
      fresh.jobs[0]!.status = "leased";
      fresh.jobs[0]!.lease = { owner: `${process.pid}-other-process-instance`, token: "live", expiresAt: Date.now() + 100_000 };
    });
    await service.recoverStaleLeases();
    assert.equal((await service.store.read()).jobs[0]?.status, "leased", "a live sibling process lease is not stolen");
    await service.store.withLock((fresh) => {
      fresh.jobs[0]!.lease = { owner: "99999999-dead", token: "token", expiresAt: Date.now() + 100_000 };
    });
    await service.recoverStaleLeases();
    assert.equal((await service.store.read()).jobs[0]?.status, "retry");

    shouldFail = false;
    assert.equal(await service.retry(state.jobs[0]!.id), 1);
    await service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    assert.equal((await service.store.read()).watermarks[path]?.nextEntryIndex, 1, "explicit retry unwedges dead coverage");
    assert.equal((await service.store.read()).jobs.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("lifecycle generation invalidation prevents an old analyzer from committing after shutdown/reload", async () => {
  const f = await fixture();
  try {
    const path = join(f.sessionDir, "generation.jsonl");
    await writeFile(path, lines(f.cwd, "s-generation", [message("a", "user", "work") ]));
    let current = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ForgeService(
      new ProjectStore(f.location.dir, f.location.cwd, f.location.key), f.agent, ".pi",
      async () => [{ path, id: "s-generation", cwd: f.cwd }],
      async () => { await gate; return zero; },
      () => current,
    );
    await service.initialize();
    await service.inventory(context(f.cwd, f.sessionDir));
    const running = service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    current = false;
    release();
    await running;
    const state = await service.store.read();
    assert.equal(state.watermarks[path]?.nextEntryIndex, 0);
    assert.equal(state.jobs[0]?.status, "queued");
    assert.equal(state.jobs[0]?.attempts, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a later correction can explicitly invalidate an earlier ready proposal", async () => {
  const f = await fixture();
  try {
    const path = join(f.sessionDir, "later-correction.jsonl");
    await writeFile(path, lines(f.cwd, "s-correction", [message("ok", "assistant", "The workflow passed") ]));
    let calls = 0;
    const service = new ForgeService(
      new ProjectStore(f.location.dir, f.location.cwd, f.location.key), f.agent, ".pi",
      async () => [{ path, id: "s-correction", cwd: f.cwd }],
      async (_ctx, chunk, _skills, _signal, active) => {
        calls++;
        if (calls === 1) return { ...zero, candidates: [generatedCandidate(chunk.evidence[0]!.ref)] };
        assert.ok(active?.some((item) => item.capabilityKey === "verified-workflow"));
        return {
          ...zero,
          invalidations: [{ capabilityKey: "verified-workflow", rationale: "The user explicitly corrected and rejected the earlier workflow.", evidenceRefs: [chunk.evidence.find((item) => item.entryId === "correction")!.ref] }],
        };
      },
    );
    await service.initialize();
    await service.inventory(context(f.cwd, f.sessionDir));
    await service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    assert.equal((await service.store.read()).proposals[0]?.status, "ready");
    await writeFile(path, `${await readFile(path, "utf8")}${JSON.stringify(message("correction", "user", "Correction: that workflow was wrong; never use it"))}\n`);
    await service.inventory(context(f.cwd, f.sessionDir));
    await service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    const proposal = (await service.store.read()).proposals[0]!;
    assert.equal(proposal.status, "invalidated");
    assert.match(proposal.rejectionReason ?? "", /corrected and rejected/);
    assert.ok(proposal.provenance.some((record) => record.evidence.some((item) => item.entryId === "correction")));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rewritten session evidence invalidates unsupported ready proposals before replay", async () => {
  const f = await fixture();
  try {
    const path = join(f.sessionDir, "rewrite-proposal.jsonl");
    await writeFile(path, lines(f.cwd, "s-rewrite", [message("u", "user", "Run the verified workflow"), message("ok", "assistant", "Verified successfully") ]));
    let emit = true;
    const service = new ForgeService(
      new ProjectStore(f.location.dir, f.location.cwd, f.location.key), f.agent, ".pi",
      async () => [{ path, id: "s-rewrite", cwd: f.cwd }],
      async (_ctx, chunk) => ({ ...zero, candidates: emit ? [generatedCandidate(chunk.evidence[0]!.ref)] : [] }),
    );
    await service.initialize();
    await service.inventory(context(f.cwd, f.sessionDir));
    await service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    assert.equal((await service.store.read()).proposals[0]?.status, "ready");

    emit = false;
    const replacement = join(f.sessionDir, "replacement");
    await writeFile(replacement, lines(f.cwd, "s-rewrite", [message("u2", "user", "The old workflow was removed") ]));
    await (await import("node:fs/promises")).rename(replacement, path);
    await service.inventory(context(f.cwd, f.sessionDir));
    let state = await service.store.read();
    assert.equal(state.proposals[0]?.status, "invalidated");
    assert.equal(state.proposals[0]?.provenance.length, 0);
    await service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    state = await service.store.read();
    assert.equal(state.proposals[0]?.status, "invalidated");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rewrite outside the current overlap invalidates earlier proposal support", async () => {
  const f = await fixture();
  try {
    const path = join(f.sessionDir, "old-prefix-rewrite.jsonl");
    const entries = Array.from({ length: 8 }, (_, index) => message(`e${index}`, index % 2 ? "assistant" : "user", `entry ${index}`));
    await writeFile(path, lines(f.cwd, "s-old-prefix", entries));
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ForgeService(
      new ProjectStore(f.location.dir, f.location.cwd, f.location.key), f.agent, ".pi",
      async () => [{ path, id: "s-old-prefix", cwd: f.cwd }],
      async (_ctx, chunk) => {
        calls++;
        if (calls === 1) return { ...zero, candidates: [generatedCandidate(chunk.evidence.find((item) => item.entryId === "e0")!.ref)] };
        if (calls === 6) await gate;
        return zero;
      },
    );
    await service.initialize();
    await service.store.withLock((state) => { state.config.maxEntriesPerChunk = 1; });
    await service.inventory(context(f.cwd, f.sessionDir));
    const running = service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    while (calls < 6) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    entries[0] = message("e0", "user", "rewritten old evidence that no longer supports the proposal");
    await writeFile(path, lines(f.cwd, "s-old-prefix", entries));
    release();
    await running;
    const state = await service.store.read();
    assert.equal(state.proposals[0]?.status, "invalidated");
    assert.ok(state.diagnostics.some((item) => item.code === "snapshot_invalidated"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("changes to following overlap invalidate an in-flight stale analyzer result", async () => {
  const f = await fixture();
  try {
    const path = join(f.sessionDir, "overlap.jsonl");
    const originalEntries = [message("u", "user", "Try workflow"), message("result", "assistant", "Succeeded"), message("tail", "user", "keep")];
    await writeFile(path, lines(f.cwd, "s-overlap", originalEntries));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const service = new ForgeService(
      new ProjectStore(f.location.dir, f.location.cwd, f.location.key), f.agent, ".pi",
      async () => [{ path, id: "s-overlap", cwd: f.cwd }],
      async (_ctx, chunk) => {
        calls++;
        if (calls === 1) {
          await gate;
          return { ...zero, candidates: [generatedCandidate(chunk.evidence.find((item) => item.entryId === "result")!.ref)] };
        }
        return zero;
      },
    );
    await service.initialize();
    await service.store.withLock((state) => { state.config.maxEntriesPerChunk = 1; });
    await service.inventory(context(f.cwd, f.sessionDir));
    const running = service.kick(context(f.cwd, f.sessionDir), new AbortController().signal, true);
    while (calls < 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    await writeFile(path, lines(f.cwd, "s-overlap", [originalEntries[0]!, message("result", "assistant", "Failed; never use this workflow"), originalEntries[2]!]));
    release();
    await running;
    const state = await service.store.read();
    assert.equal(state.proposals.length, 0, "candidate derived from stale following context was discarded");
    assert.ok(state.diagnostics.some((item) => item.code === "snapshot_invalidated" || item.code === "session_replayed"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("undersized chunk budgets fail instead of silently advancing an uncovered entry", () => {
  const parsed = parseSessionSnapshot("/s", lines("/p", "s", [message("a", "user", "normal entry")]), stamp);
  assert.throws(() => buildChunk(parsed, 0, 180, 1), /too small to represent/);
});

test("inventory refuses a snapshot that became stale before the state lock", async () => {
  const f = await fixture();
  try {
    const path = join(f.sessionDir, "concurrent-inventory.jsonl");
    await writeFile(path, lines(f.cwd, "s-concurrent", [message("one", "user", "first") ]));
    const store = new ProjectStore(f.location.dir, f.location.cwd, f.location.key);
    const service = new ForgeService(store, f.agent, ".pi", async () => [{ path, id: "s-concurrent", cwd: f.cwd }], async () => zero);
    await service.initialize();
    const originalWithLock = store.withLock.bind(store);
    let inject = true;
    (store as any).withLock = async (operation: any) => {
      if (inject) {
        inject = false;
        await writeFile(path, `${await readFile(path, "utf8")}${JSON.stringify(message("two", "user", "second"))}\n`);
      }
      return originalWithLock(operation);
    };
    await service.inventory(context(f.cwd, f.sessionDir));
    let state = await store.read();
    assert.equal(state.watermarks[path], undefined, "stale snapshot did not create or regress a watermark");
    assert.ok(state.diagnostics.some((item) => item.code === "snapshot_stale"));
    await service.inventory(context(f.cwd, f.sessionDir));
    state = await store.read();
    assert.equal(state.watermarks[path]?.lastEntryCount, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a stale crashed reaper mutex is reclaimed", async () => {
  const f = await fixture();
  try {
    const store = new ProjectStore(f.location.dir, f.location.cwd, f.location.key);
    await store.initialize();
    await mkdir(store.lockPath, { recursive: true });
    await writeFile(join(store.lockPath, "owner.json"), JSON.stringify({ pid: 99_999_999, token: "dead", createdAt: 0 }));
    const reaper = `${store.lockPath}.reaper`;
    await mkdir(reaper);
    const old = new Date(Date.now() - 60_000);
    await utimes(reaper, old, old);
    await store.withLock((state) => { state.config.paused = true; });
    assert.equal((await store.read()).config.paused, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("prefix digest is deterministic and changes with rewritten analyzed history", async () => {
  const parsed = parseSessionSnapshot("/s", lines("/p", "s", [message("a", "user", "x"), message("b", "assistant", "y")]), stamp);
  assert.equal(prefixDigest(parsed.entries, 2), prefixDigest(parsed.entries, 2));
  const changed = structuredClone(parsed.entries); (changed[0]!.message as any).content[0].text = "changed";
  assert.notEqual(prefixDigest(parsed.entries, 1), prefixDigest(changed, 1));
});

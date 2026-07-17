import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import skillForge, { renderStatus } from "../index.ts";
import { applyInstall, prepareInstall } from "../install.ts";
import { canonicalSkillMd, mergeCandidate } from "../proposals.ts";
import { ForgeService } from "../service.ts";
import { ProjectStore, projectStateDir, sha256 } from "../storage.ts";
import type { AnalyzerCandidate, EvidenceRef, Proposal } from "../types.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "skill-forge-install-"));
  const cwd = join(root, "project"); const agent = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agent)]);
  const location = await projectStateDir(agent, cwd);
  const store = new ProjectStore(location.dir, location.cwd, location.key);
  await store.initialize();
  const raw: AnalyzerCandidate = {
    capabilityKey: "safe-workflow", title: "Safe workflow", rationale: "Repeated", confidence: 0.9,
    skillName: "safe-workflow", description: "A safe workflow. Use for tests.",
    skillMd: "# Safe workflow\n\nRun tests.", proposedScope: { scope: "project", rationale: "Repo scripts", confidence: 0.9, signals: ["repo script"] },
    evidenceRefs: ["r0"], operation: "create",
  };
  const evidence: EvidenceRef = { ref: "r0", sessionId: "s", sessionPath: "/s", entryId: "e", parentId: null, branchRelation: "root", timestamp: "2026-01-01T00:00:00.000Z", kind: "tool-success", excerpt: "passed", evidenceDigest: sha256("evidence") };
  await store.withLock((state) => { mergeCandidate(state, raw, [evidence], { sessionId: "s", sessionPath: "/s", jobId: "j", analyzedAt: "2026-01-01T00:00:00.000Z", analyzerModel: "mock", analyzerPromptVersion: "v" }); });
  const proposal = (await store.read()).proposals[0]!;
  assert.equal((await lstat(store.statePath)).mode & 0o777, 0o600, "durable state is private");
  return { root, cwd: location.cwd, agent, store, proposal };
}

const options = (f: Awaited<ReturnType<typeof fixture>>, trusted = true) => ({ projectCwd: f.cwd, agentDir: f.agent, configDirName: ".pi", projectTrusted: trusted });

test("install requires trust, confines paths, rejects symlink components, and writes atomically with mode 0600", async () => {
  const f = await fixture();
  try {
    await assert.rejects(prepareInstall(f.proposal, "project", options(f, false)), /trust/);
    const plan = await prepareInstall(f.proposal, "project", options(f));
    assert.equal(plan.collision, "none");
    await applyInstall(f.store, plan, false, options(f));
    assert.equal(await readFile(plan.path, "utf8"), f.proposal.skillMd);
    assert.equal((await lstat(plan.path)).mode & 0o777, 0o600);
    assert.equal((await readdir(plan.skillDir)).some((name) => name.endsWith(".tmp")), false);
    assert.equal((await f.store.read()).proposals[0]?.status, "accepted");

    const unsafe = structuredClone(f.proposal); unsafe.skillName = "../escape";
    await assert.rejects(prepareInstall(unsafe, "user", options(f)), /mismatched|unsafe|confined/);
  } finally { await rm(f.root, { recursive: true, force: true }); }

  const s = await fixture();
  try {
    const target = join(s.root, "outside"); await mkdir(target);
    await symlink(target, join(s.cwd, ".pi"));
    await assert.rejects(prepareInstall(s.proposal, "project", options(s)), /symlink/);
  } finally { await rm(s.root, { recursive: true, force: true }); }
});

test("prompt kind installs a single slash-command template and survives applying recovery", async () => {
  const f = await fixture();
  try {
    const plan = await prepareInstall(f.proposal, "user", options(f), "prompt");
    assert.equal(plan.kind, "prompt");
    assert.equal(plan.path, join(f.agent, "prompts", "safe-workflow.md"));
    await applyInstall(f.store, plan, false, options(f));
    assert.equal(await readFile(plan.path, "utf8"), f.proposal.skillMd);
    const accepted = (await f.store.read()).proposals[0]!;
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.installed?.kind, "prompt");
    assert.equal(accepted.selectedKind, "prompt");

    // Interrupted prompt apply with matching on-disk bytes recovers to accepted.
    await f.store.withLock((state) => {
      const proposal = state.proposals[0]!; proposal.status = "applying";
      proposal.applying = { scope: "user", kind: "prompt", path: plan.path, contentDigest: plan.contentDigest, startedAt: new Date().toISOString(), owner: "99999999-dead", token: "recovery", expiresAt: 0 };
    });
    const service = new ForgeService(f.store, f.agent, ".pi", async () => [], async () => { throw new Error("unused"); });
    await service.initialize();
    const recovered = (await f.store.read()).proposals[0]!;
    assert.equal(recovered.status, "accepted");
    assert.equal(recovered.installed?.kind, "prompt");

    // Project-scope prompt goes under .pi/prompts.
    await f.store.withLock((state) => { state.proposals[0]!.status = "ready"; delete state.proposals[0]!.installed; });
    const projectPlan = await prepareInstall((await f.store.read()).proposals[0]!, "project", options(f), "prompt");
    assert.equal(projectPlan.path, join(f.cwd, ".pi", "prompts", "safe-workflow.md"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("collision requires explicit confirmation/diff and never silently overwrites", async () => {
  const f = await fixture();
  try {
    const first = await prepareInstall(f.proposal, "user", options(f));
    await applyInstall(f.store, first, false, options(f));
    await f.store.withLock((state) => { state.proposals[0]!.status = "ready"; state.proposals[0]!.skillMd = canonicalSkillMd("safe-workflow", "A safe workflow. Use for tests.", "# Changed\n\nNew reviewed content."); });
    const proposal = (await f.store.read()).proposals[0]!;
    const collision = await prepareInstall(proposal, "user", options(f));
    assert.equal(collision.collision, "different");
    assert.match(collision.diff ?? "", /^-/m);
    await assert.rejects(applyInstall(f.store, collision, false, options(f)), /confirmation/);
    assert.equal(await readFile(collision.path, "utf8"), first.content);
    await applyInstall(f.store, collision, true, options(f));
    assert.equal(await readFile(collision.path, "utf8"), collision.content);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("applying recovery marks matching side effect accepted and mismatches failed without replaying writes", async () => {
  const f = await fixture();
  try {
    const plan = await prepareInstall(f.proposal, "user", options(f));
    await mkdir(plan.skillDir, { recursive: true }); await writeFile(plan.path, plan.content);
    await f.store.withLock((state) => {
      const proposal = state.proposals[0]!; proposal.status = "applying";
      proposal.applying = { scope: "user", path: plan.path, contentDigest: sha256(plan.content), startedAt: new Date().toISOString(), owner: "99999999-dead", token: "recovery", expiresAt: 0 };
    });
    const service = new ForgeService(f.store, f.agent, ".pi", async () => [], async () => { throw new Error("unused"); });
    await service.initialize();
    assert.equal((await f.store.read()).proposals[0]?.status, "accepted");

    await f.store.withLock((state) => {
      const proposal = state.proposals[0]!; proposal.status = "applying";
      proposal.applying = { scope: "user", path: join(f.root, "missing"), contentDigest: sha256("nope"), startedAt: new Date().toISOString(), owner: "99999999-dead", token: "recovery-2", expiresAt: 0 };
    });
    await service.initialize();
    const recovered = (await f.store.read()).proposals[0]!;
    assert.equal(recovered.status, "apply_failed");
    assert.match(recovered.lastApplyError ?? "", /interrupted/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("extension registers commands/events but no model-facing tools or recursive messages", () => {
  const commands: string[] = []; const events: string[] = [];
  let tools = 0; let messages = 0;
  skillForge({
    registerCommand(name: string) { commands.push(name); },
    on(name: string) { events.push(name); },
    registerTool() { tools++; }, sendMessage() { messages++; }, sendUserMessage() { messages++; },
  } as any);
  assert.deepEqual(commands, ["forge"]);
  assert.equal(tools, 0);
  assert.equal(messages, 0);
  assert.ok(events.includes("session_start") && events.includes("session_shutdown") && events.includes("agent_settled"));
});

test("narrow status rendering is bounded", () => {
  const status = { ready: 12, queued: 5, leased: 1, retry: 0, dead: 0, sessions: 50, paused: false, backgroundEnabled: true };
  for (const width of [0, 1, 2, 8, 20, 80]) assert.ok(renderStatus(status, width).length <= width);
});

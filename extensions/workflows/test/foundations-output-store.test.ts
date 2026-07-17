import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DurableWorkflowEvent } from "../core/contracts.js";
import { createWorkflowRunRecord } from "../core/reducer.js";
import { encodeWorkflowOutput } from "../core/output-encoder.js";
import { WorkflowRunStore } from "../core/run-store.js";

const runId = "22222222-2222-4222-8222-222222222222";

test("tagged output preserves special values, cycles, aliases, and built-ins", () => {
  const shared = { answer: 42 };
  const root: Record<string, unknown> = {
    bigint: 12n, missing: undefined, nan: NaN, infinity: Infinity,
    date: new Date("2020-01-02T03:04:05.000Z"), error: new Error("bad", { cause: shared }),
    map: new Map([[shared, new Set([1, 2])]]), binary: new Uint8Array([1, 2, 3]), first: shared, second: shared,
  };
  root.self = root;
  const encoded = encodeWorkflowOutput(root);
  const json = JSON.stringify(encoded);
  assert.equal(encoded.truncated, false);
  for (const tag of ["bigint", "undefined", "NaN", "date", "error", "map", "set", "typed-array", "ref"]) assert.match(json, new RegExp(tag));
});

test("output limits produce explicit tags and an actually bounded envelope", () => {
  const deep: any = { text: "é".repeat(100), bytes: new Uint8Array(100), many: Array.from({ length: 100 }, (_, index) => index) };
  deep.next = { next: { next: { value: true } } };
  const encoded = encodeWorkflowOutput(deep, { maxBytes: 256, maxDepth: 2, maxNodes: 20, maxCollectionItems: 3, maxStringBytes: 8, maxBinaryBytes: 4 });
  assert.equal(encoded.truncated, true);
  assert.ok(encoded.truncations > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(encoded), "utf8") <= 256);
});

test("run store durably creates canonical layout, provenance, snapshots, streams, and output", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "workflow-store-"));
  try {
    const store = new WorkflowRunStore(path.join(temporary, "runs"));
    const source = `export const meta={name:"x",description:"x",resumable:true,maxAgents:1,capabilities:["read"]}\nreturn 1`;
    const hash = createHash("sha256").update(source).digest("hex");
    const pathsBefore = store.paths(runId, true);
    const record = createWorkflowRunRecord({
      runId,
      owner: { sessionId: "session", instanceId: "instance", parentPid: 1 },
      source: { kind: "inline", copiedPath: pathsBefore.script, sourceDirectory: temporary, sha256: hash, resolverIdentity: `inline:${hash}` },
      metadata: { name: "x", description: "x", resumable: true, maxAgents: 1, capabilities: ["read"] },
      args: { safe: true }, argsSha256: hash, executionFingerprint: hash, activationIdentity: hash,
      deadlineAt: 1000, cleanupDeadlineAt: 1100, createdAt: 100,
    });
    const paths = await store.createRun(record, source);
    assert.deepEqual((await readdir(paths.runDir)).sort(), ["agents", "artifacts", "events.jsonl", "journal.jsonl", "notification.json", "run.json", "script.js"]);
    assert.deepEqual(await store.readRun(runId), record);
    assert.equal(await readFile(paths.script, "utf8"), source);

    await store.reduceAndCommit(runId, {
      type: "RunStarted", attempt: { attemptId: "attempt", runId, startedAt: 101, status: "running" },
    }, 101);
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.reduceAndCommit(runId, {
      type: "RetentionChanged", pinned: index % 2 === 0, expiresAt: 1_000 + index,
    }, 102 + index)));
    const durableEvents: DurableWorkflowEvent[] = await store.readEvents(runId);
    assert.deepEqual(durableEvents.map((event) => event.sequence), Array.from({ length: 21 }, (_, index) => index + 1));
    assert.equal((await store.readRun(runId)).recordRevision, 21);
    await store.appendEvent({
      schemaVersion: 1, runId, sequence: 22, timestamp: 200,
      event: { type: "RetentionChanged", pinned: true, expiresAt: 2_000 },
    });
    const replayed = await store.readRun(runId);
    assert.equal(replayed.recordRevision, 22);
    assert.equal(replayed.pinned, true);

    await Promise.all(Array.from({ length: 20 }, (_, index) => store.appendJournal(runId, { index })));
    assert.deepEqual((await store.readJournal(runId)).map((entry) => (entry as any).index), Array.from({ length: 20 }, (_, index) => index));

    const output = encodeWorkflowOutput({ ok: true });
    await store.writeOutput(runId, output);
    assert.deepEqual(await store.readOutput(runId), output);
    assert.equal(JSON.parse(await readFile(paths.output, "utf8")).encoding, "tagged-json-v1");
    assert.equal((await readdir(paths.runDir)).some((name) => name.endsWith(".tmp")), false);
    assert.equal((await store.scan())[0].state, "ok");

    await assert.rejects(() => store.appendJournal(runId, { bad: Infinity } as never), /non-finite/);
    assert.throws(() => store.paths("../escape"), /full UUID/);
    await assert.rejects(() => store.createRun(record, source), /EEXIST/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("non-resumable runs have no journal", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "workflow-store-nonresume-"));
  try {
    const store = new WorkflowRunStore(path.join(temporary, "runs"));
    assert.equal(store.paths(runId, false).journal, undefined);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

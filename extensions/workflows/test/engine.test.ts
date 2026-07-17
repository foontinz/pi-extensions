import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { emptyUsageStats } from "../../subagents/core/types.js";
import { pruneWorkflowRuns } from "../core/retention.js";
import { WorkflowEngine } from "../engine.js";

const metadata = `export const meta = {
  name: "test",
  description: "test workflow",
  resumable: false,
  maxAgents: 8,
  capabilities: ["read"],
  phases: [{id:"review",title:"Review"}]
}`;
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function harness(root: string, executor: any = async (options: any) => ({ output: options.task.toUpperCase(), usage: { ...emptyUsageStats(), output: 3, turns: 1 } })) {
  const pi = {
    getThinkingLevel: () => "high",
    getAllTools: () => [{ name: "read", description: "read", parameters: {}, sourceInfo: { source: "builtin", path: "builtin" } }],
  } as any;
  const ctx = {
    cwd: root,
    model: { provider: "provider", id: "model" },
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "session", getSessionFile: () => path.join(root, "session.jsonl") },
  } as any;
  return { engine: new WorkflowEngine(pi, { runRoot: path.join(root, "runs"), workspaceRoot: path.join(root, "workspace"), leafExecutor: executor }), ctx };
}

test("production engine executes only the canonical worker and persists terminal output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-"));
  try {
    const { engine, ctx } = harness(root);
    const launch = await engine.launch({
      script: `${metadata}\nphase("review")\nreturn await parallel([\n  () => agent("one", {id:"one", phase:"review", tools:["read"]}),\n  () => agent("two", {id:"two", phase:"review", tools:["read"]})\n])`,
      background: false,
    }, ctx, true);
    assert.match(launch.runId, /^[0-9a-f-]{36}$/);
    assert.equal(launch.record.status, "running");
    const finished = await launch.completion;
    assert.equal(finished.status, "completed");
    assert.equal(finished.leaves.length, 2);
    assert.equal(finished.usage.output, 6);
    assert.equal(finished.budget.reserved, 0);
    assert.ok(finished.output);
    assert.equal((await engine.store.readEvents(launch.runId)).length > 5, true);
    assert.deepEqual((await engine.store.scan())[0].record?.status, "completed");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("child workflows resolve explicit relative references with independent durable lineage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-child-"));
  try {
    const { engine, ctx } = harness(root);
    const child = path.join(root, "child.js");
    await fs.writeFile(child, `${metadata.replace('name: "test"', 'name: "child"')}\nreturn {child: args.value}`);
    const parent = path.join(root, "parent.js");
    await fs.writeFile(parent, `${metadata}\nreturn await workflow({scriptPath:"./child.js"}, {value:42})`);
    const launch = await engine.launch({ scriptPath: parent }, ctx, true);
    const finished = await launch.completion;
    assert.equal(finished.status, "completed");
    const runs = (await engine.store.scan()).filter((entry) => entry.state === "ok").map((entry) => entry.record!);
    const childRecord = runs.find((record) => record.parentRunId === launch.runId);
    assert.ok(childRecord);
    assert.equal(childRecord?.rootRunId, launch.runId);
    assert.equal((childRecord?.args as { value: number }).value, 42);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("legacy helper signatures and callable args fail the durable run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-legacy-"));
  try {
    const { engine, ctx } = harness(root);
    for (const body of [
      `return await parallel(["x"], (x) => x)`,
      `return await pipeline([1], [(x) => x])`,
      `return args()`,
      `return await workflow("return 1")`,
      `return await agent("x", {id:"x", worktree:true})`,
    ]) {
      const run = await engine.launch({ script: `${metadata}\n${body}` }, ctx, true);
      const finished = await run.completion;
      assert.equal(finished.status, "failed", body);
      assert.ok(finished.error?.kind === "script" || finished.error?.kind === "contract");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("exact resumable pure replay invokes zero executors for cached nodes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-resume-"));
  try {
    await fs.writeFile(path.join(root, "input.txt"), "stable");
    const inputHash = createHash("sha256").update("stable").digest("hex");
    let calls = 0;
    const { engine, ctx } = harness(root, async () => { calls++; return { output: "cached value", usage: emptyUsageStats() }; });
    const resumableMeta = metadata.replace("resumable: false", "resumable: true");
    const script = `${resumableMeta}\nreturn await agent("x", {id:"x", tools:["read"], cachePolicy:"pure", inputManifest:[{path:"input.txt",sha256:"${inputHash}"}]})`;
    const first = await engine.launch({ script }, ctx, true);
    assert.equal((await first.completion).status, "completed");
    const resumed = await engine.resume(first.runId, ctx);
    const replayed = await resumed.completion;
    assert.equal(replayed.status, "completed");
    assert.equal(replayed.leaves[0].status, "cached");
    assert.equal(calls, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("resumable skip and pause use stable controls without masquerading as leaf failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-controls-"));
  try {
    const executor = async (options: any) => {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { output: "", usage: emptyUsageStats(), error: { reason: "stop", message: "aborted" } };
    };
    const { engine, ctx } = harness(root, executor);
    const resumableMeta = metadata.replace("resumable: false", "resumable: true");
    const script = `${resumableMeta}\nreturn await agent("x", {id:"x", tools:["read"]})`;
    const skipped = await engine.launch({ script }, ctx, true);
    await waitFor(async () => (await engine.store.readRun(skipped.runId)).leaves[0]?.status === "running");
    assert.equal(engine.skip(skipped.runId, "root/agent:x", ctx), true);
    const skippedResult = await skipped.completion;
    assert.equal(skippedResult.status, "completed");
    assert.equal(skippedResult.leaves[0].status, "skipped");

    const paused = await engine.launch({ script }, ctx, true);
    await waitFor(async () => (await engine.store.readRun(paused.runId)).leaves[0]?.status === "running");
    assert.equal(engine.pause(paused.runId, ctx), true);
    const pausedResult = await paused.completion;
    assert.equal(pausedResult.status, "paused");
    assert.equal(pausedResult.leaves[0].status, "interrupted");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("manifest-aware retention prunes only delivered, cleaned, expired, unpinned terminal runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-retention-"));
  try {
    const { engine, ctx } = harness(root);
    const run = await engine.launch({ script: `${metadata}\nreturn 1` }, ctx, true);
    const finished = await run.completion;
    await engine.applyEvent(run.runId, { type: "NotificationChanged", notification: { state: "delivered", attempts: 1, updatedAt: Date.now(), deliveredAt: Date.now() } });
    await engine.applyEvent(run.runId, { type: "RetentionChanged", pinned: false, expiresAt: 1 });
    const pruned = await pruneWorkflowRuns(engine.store, Date.now());
    assert.deepEqual(pruned.pruned, [run.runId]);
    assert.equal((await engine.store.scan()).length, 0);
    assert.equal((await engine.store.readTombstone(run.runId))?.expiredAt, 1);
    assert.equal(finished.status, "completed");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("operational leaf failures resolve null and remain structured failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-failure-"));
  try {
    const { engine, ctx } = harness(root, async () => ({ output: "", usage: emptyUsageStats(), error: { reason: "error", message: "provider down" } }));
    const run = await engine.launch({ script: `${metadata}\nreturn await agent("x", {id:"x", tools:["read"]})` }, ctx, true);
    const finished = await run.completion;
    assert.equal(finished.status, "completed");
    assert.equal(finished.leaves[0].status, "failed");
    assert.equal(finished.failures[0].kind, "provider");
    const output = await engine.store.readOutput(run.runId);
    assert.equal(output.value, null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

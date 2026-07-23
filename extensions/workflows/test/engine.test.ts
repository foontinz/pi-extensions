import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { emptyUsageStats } from "../../subagents/core/types.js";
import { pruneWorkflowRuns } from "../core/retention.js";
import { WorkflowEngine } from "../engine.js";

const execFile = promisify(execFileCallback);
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
    modelRegistry: { getAvailable: () => [{ provider: "provider", id: "model" }] },
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
    await fs.writeFile(parent, `${metadata}\nreturn await workflow({id:"child",scriptPath:"./child.js"}, {value:42})`);
    const launch = await engine.launch({ scriptPath: parent }, ctx, true);
    const finished = await launch.completion;
    assert.equal(finished.status, "completed");
    const runs = (await engine.store.scan()).filter((entry) => entry.state === "ok").map((entry) => entry.record!);
    const childRecord = runs.find((record) => record.parentRunId === launch.runId);
    assert.ok(childRecord);
    assert.equal(childRecord?.rootRunId, launch.runId);
    assert.equal((childRecord?.args as { value: number }).value, 42);
    assert.equal(finished.usage.output, 0, "child had no leaf in this fixture");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("runtime updates expose root phases and nested child leaves", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-runtime-view-"));
  try {
    const { engine, ctx } = harness(root);
    const child = path.join(root, "child.js");
    await fs.writeFile(child, `${metadata.replace('name: "test"', 'name: "child"')}\nphase("review")\nreturn await agent("nested", {id:"nested", tools:["read"]})`);
    const parent = path.join(root, "parent.js");
    await fs.writeFile(parent, `${metadata}\nphase("review")\nreturn await workflow({id:"child",scriptPath:"./child.js"}, null)`);
    const updates: any[] = [];
    const launch = await engine.launch({ scriptPath: parent }, ctx, true, (_record, runtime) => updates.push(runtime));
    await launch.completion;
    const nested = updates.find((runtime) => runtime.phases.root === "review"
      && runtime.records.some((record: any) => record.parentRunId === launch.runId && record.leaves.some((leaf: any) => leaf.agentId === "nested")));
    assert.ok(nested, "runtime projection should include the active root phase and nested agent records");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("live child executor claims prevent restart reconciliation from stealing nested runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-child-claim-"));
  try {
    const { engine, ctx } = harness(root, async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { output: "done", usage: emptyUsageStats() };
    });
    await fs.writeFile(path.join(root, "child.js"), `${metadata.replace('name: "test"', 'name: "child"')}\nreturn await agent("wait", {id:"wait", tools:["read"]})`);
    const parent = path.join(root, "parent.js");
    await fs.writeFile(parent, `${metadata}\nreturn await workflow({id:"child",scriptPath:"./child.js"}, null)`);
    const launch = await engine.launch({ scriptPath: parent }, ctx, true);
    let childId = "";
    await waitFor(async () => {
      const child = (await engine.store.scan()).find((entry) => entry.state === "ok" && entry.record?.parentRunId === launch.runId && entry.record.status === "running");
      childId = child?.runId ?? "";
      return Boolean(childId);
    });
    await engine.reconcileInterruptedRuns();
    assert.equal((await engine.store.readRun(childId)).status, "running");
    assert.equal((await launch.completion).status, "completed");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("parent failure aborts and drains nested child coordinators before terminalization", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-child-abort-"));
  try {
    const executor = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { output: "child settled", usage: emptyUsageStats() };
    };
    const { engine, ctx } = harness(root, executor);
    await fs.writeFile(path.join(root, "child.js"), `${metadata.replace('name: "test"', 'name: "child"')}\nreturn await agent("wait", {id:"wait", tools:["read"]})`);
    const parent = path.join(root, "parent.js");
    await fs.writeFile(parent, `${metadata}\nreturn await parallel([\n  () => workflow({id:"child",scriptPath:"./child.js"}, null),\n  () => { throw new Error("parent branch failed") }\n])`);
    const launch = await engine.launch({ scriptPath: parent }, ctx, true);
    const finished = await launch.completion;
    assert.equal(finished.status, "failed");
    const runs = (await engine.store.scan()).filter((entry) => entry.state === "ok").map((entry) => entry.record!);
    const child = runs.find((record) => record.parentRunId === launch.runId);
    assert.ok(child);
    assert.notEqual(child.status, "running");
    assert.ok(["completed", "failed", "cancelled", "interrupted", "recovery_required"].includes(child.status));
    assert.ok(["completed", "failed", "interrupted", "skipped", "cached"].includes(child.leaves[0]!.status));
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

test("nested resumable children replay pure leaves without invoking executors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-child-resume-"));
  try {
    let calls = 0;
    const { engine, ctx } = harness(root, async () => { calls++; return { output: "child cached", usage: emptyUsageStats() }; });
    const resumableMeta = metadata.replace("resumable: false", "resumable: true");
    await fs.writeFile(path.join(root, "input.txt"), "stable");
    const inputHash = createHash("sha256").update("stable").digest("hex");
    await fs.writeFile(path.join(root, "child.js"), `${resumableMeta.replace('name: "test"', 'name: "child"')}\nreturn await agent("child", {id:"child", tools:["read"], cachePolicy:"pure", inputManifest:[{path:"input.txt",sha256:"${inputHash}"}]})`);
    const parent = path.join(root, "parent.js");
    await fs.writeFile(parent, `${resumableMeta}\nreturn await workflow({id:"child",scriptPath:"./child.js"}, null)`);
    const first = await engine.launch({ scriptPath: parent }, ctx, true);
    const firstResult = await first.completion;
    assert.equal(firstResult.status, "completed");
    const resumed = await engine.resume(first.runId, ctx);
    assert.equal((await resumed.completion).status, "completed");
    const runs = (await engine.store.scan()).filter((entry) => entry.state === "ok").map((entry) => entry.record!);
    const resumedChild = runs.find((record) => record.parentRunId === resumed.runId);
    assert.equal(resumedChild?.leaves[0]?.status, "cached");
    assert.equal(calls, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("resumable workspace artifacts are verified in a fresh worktree before cache replay", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-workspace-resume-"));
  try {
    await execFile("git", ["-C", root, "init", "--initial-branch=main"]);
    await execFile("git", ["-C", root, "config", "user.name", "Test"]);
    await execFile("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    await fs.writeFile(path.join(root, "base.txt"), "base\n");
    await execFile("git", ["-C", root, "add", "."]);
    await execFile("git", ["-C", root, "commit", "-m", "base"]);
    let calls = 0;
    const executor = async (options: any) => {
      calls++;
      await fs.writeFile(path.join(options.cwd, "cached.txt"), "cached artifact\n");
      return { output: "cached workspace", usage: emptyUsageStats() };
    };
    const { engine, ctx } = harness(root, executor);
    const workspaceMeta = metadata.replace("resumable: false", "resumable: true").replace('capabilities: ["read"]', 'capabilities: ["read", "workspace"]');
    const script = `${workspaceMeta}\nreturn await agent("write", {id:"write", effects:"workspace", workspace:"isolated", artifactPolicy:"capture", cachePolicy:"workspace-artifact", tools:["read"]})`;
    const first = await engine.launch({ script }, ctx, true);
    const original = await first.completion;
    assert.equal(original.status, "completed");
    const resumed = await engine.resume(first.runId, ctx);
    const replayed = await resumed.completion;
    assert.equal(replayed.status, "completed");
    assert.equal(replayed.leaves[0].status, "cached");
    assert.deepEqual(replayed.leaves[0].artifactIds, original.leaves[0].artifactIds);
    assert.equal(calls, 1);

    await fs.writeFile(path.join(root, "cached.txt"), "current branch owns this path\n");
    await execFile("git", ["-C", root, "add", "cached.txt"]);
    await execFile("git", ["-C", root, "commit", "-m", "conflict with cached artifact"]);
    const cacheMiss = await engine.resume(resumed.runId, ctx);
    const rerun = await cacheMiss.completion;
    assert.equal(rerun.status, "completed");
    assert.equal(rerun.leaves[0].status, "completed");
    assert.equal(calls, 2);
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
    assert.equal(await engine.skip(skipped.runId, "root/agent:x", ctx), true);
    const skippedResult = await skipped.completion;
    assert.equal(skippedResult.status, "completed");
    assert.equal(skippedResult.leaves[0].status, "skipped");

    const paused = await engine.launch({ script }, ctx, true);
    await waitFor(async () => (await engine.store.readRun(paused.runId)).leaves[0]?.status === "running");
    assert.equal(await engine.pause(paused.runId, ctx), true);
    const pausedResult = await paused.completion;
    assert.equal(pausedResult.status, "paused");
    assert.equal(pausedResult.leaves[0].status, "interrupted");
    assert.equal(pausedResult.attempts.at(-1)?.status, "interrupted");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("workspace effects capture verified artifacts before cleanup and apply in a fresh tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-engine-workspace-"));
  let integration: any;
  try {
    await execFile("git", ["-C", root, "init", "--initial-branch=main"]);
    await execFile("git", ["-C", root, "config", "user.name", "Test"]);
    await execFile("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    await fs.writeFile(path.join(root, "base.txt"), "base\n");
    await execFile("git", ["-C", root, "add", "."]);
    await execFile("git", ["-C", root, "commit", "-m", "base"]);
    const executor = async (options: any) => {
      await fs.writeFile(path.join(options.cwd, "result.txt"), "captured\n");
      return { output: "done", usage: emptyUsageStats() };
    };
    const { engine, ctx } = harness(root, executor);
    const workspaceMeta = metadata.replace('capabilities: ["read"]', 'capabilities: ["read", "workspace"]');
    const run = await engine.launch({ script: `${workspaceMeta}\nreturn await agent("write", {id:"write", effects:"workspace", workspace:"isolated", tools:["read"]})` }, ctx, true);
    const finished = await run.completion;
    assert.equal(finished.status, "completed");
    assert.equal(finished.artifacts[0].state, "verified");
    const lease = await engine.artifacts.getLease(finished.leaves[0].workspaceLeaseId!);
    assert.equal(lease.state, "cleaned");
    integration = await engine.artifacts.apply(finished.artifacts[0].artifactId, root);
    assert.equal(await fs.readFile(path.join(integration.root, "result.txt"), "utf8"), "captured\n");
    await engine.artifacts.releaseApplied(integration.integrationId); integration = undefined;
  } finally {
    if (integration) await fs.rm(integration.tempParent, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
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

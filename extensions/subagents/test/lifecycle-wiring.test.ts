import assert from "node:assert/strict";
import test from "node:test";
import { JOB_RECORD_SCHEMA_VERSION, emptyUsageStats, initialLogCursor } from "../core/types.js";
import { __subagentsTest } from "../index.js";

function makeLegacyJob(overrides: Record<string, unknown> = {}) {
  const record = {
    schemaVersion: JOB_RECORD_SCHEMA_VERSION,
    id: "agent_test_1",
    label: "test",
    task: "task",
    sourceCwd: "/repo",
    cwd: "/repo",
    phase: "running" as const,
    cleanupPhase: "none" as const,
    supervisor: "tmux" as const,
    supervisorInfo: {
      kind: "tmux" as const,
      tmuxSession: "pi-agent_test_1",
      stdoutPath: "/repo/.pi/stdout",
      stderrPath: "/repo/.pi/stderr",
      exitCodePath: "/repo/.pi/exit",
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    startedAt: 1_000,
    logCursor: initialLogCursor(),
    usage: emptyUsageStats(),
  };
  return {
    record,
    id: "agent_test_1",
    label: "test",
    task: "task",
    cwd: "/repo",
    sourceCwd: "/repo",
    command: "pi",
    args: [],
    startedAt: 1_000,
    updatedAt: 1_000,
    status: "running",
    messageCount: 0,
    logs: [],
    nextSeq: 1,
    stderr: "",
    stdoutBuffer: "",
    stderrBuffer: "",
    latestAssistantText: "",
    pendingAssistantDelta: "",
    lastAssistantDeltaLogAt: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    supervisor: "tmux",
    tmuxSession: "pi-agent_test_1",
    stdoutPath: "/repo/.pi/stdout",
    stderrPath: "/repo/.pi/stderr",
    exitCodePath: "/repo/.pi/exit",
    stdoutOffset: 0,
    stderrOffset: 0,
    waiters: new Set(),
    closeWaiters: new Set(),
    ...overrides,
  } as any;
}

test("live AgentJob lifecycle dispatch uses S2 stop/timeout race policy", () => {
  const job = makeLegacyJob({ phase: "running" });

  __subagentsTest.dispatchLifecycleEvent(job, { type: "StopRequested", reason: "user" }, 2_000);
  assert.equal(job.status, "running");
  assert.equal(job.phase, "stopping");
  assert.equal(job.pendingTerminal?.reason, "stop");

  __subagentsTest.dispatchLifecycleEvent(job, { type: "TimeoutElapsed", message: "deadline" }, 2_100);
  assert.equal(job.pendingTerminal?.reason, "stop");

  __subagentsTest.dispatchLifecycleEvent(job, { type: "ChildExitObserved", exitCode: 137 }, 2_200);
  assert.equal(job.phase, "draining");

  __subagentsTest.dispatchLifecycleEvent(job, { type: "DrainComplete" }, 2_300);
  assert.equal(job.status, "cancelled");
  assert.equal(job.phase, "cancelled");
  assert.equal(job.terminal?.reason, "stop");
  assert.equal(job.exitCode, 137);
});

test("live AgentJob lifecycle dispatch maps timeout to failed after drain", () => {
  const job = makeLegacyJob({ phase: "running" });

  __subagentsTest.dispatchLifecycleEvent(job, { type: "TimeoutElapsed", message: "deadline" }, 2_000);
  assert.equal(job.status, "running");
  assert.equal(job.phase, "stopping");
  assert.equal(job.pendingTerminal?.reason, "timeout");

  __subagentsTest.dispatchLifecycleEvent(job, { type: "SupervisorGoneObserved", message: "killed" }, 2_100);
  __subagentsTest.dispatchLifecycleEvent(job, { type: "DrainComplete" }, 2_200);

  assert.equal(job.status, "failed");
  assert.equal(job.phase, "failed");
  assert.equal(job.terminal?.reason, "timeout");
  assert.equal(job.finishedAt, 2_200);
});

test("live AgentJob lifecycle dispatch owns output/log cursors", () => {
  const job = makeLegacyJob({ phase: "running" });

  __subagentsTest.dispatchLifecycleEvent(job, { type: "OutputChunkRead", stream: "stdout", bytes: 5, offsetAfter: 5 }, 2_000);
  __subagentsTest.dispatchLifecycleEvent(job, { type: "LogEntriesAppended", firstSeq: 1, count: 1 }, 2_100);

  assert.equal(job.stdoutOffset, 5);
  assert.equal(job.nextSeq, 2);
  assert.throws(
    () => __subagentsTest.dispatchLifecycleEvent(job, { type: "OutputChunkRead", stream: "stdout", bytes: 1, offsetAfter: 4 }, 2_200),
    /stdoutOffset cannot move backwards/,
  );
});

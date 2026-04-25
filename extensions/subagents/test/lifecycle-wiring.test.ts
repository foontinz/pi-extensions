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

test("lifecycle observability de-duplicates log entries by sequence", () => {
  const job = makeLegacyJob({
    logs: [
      { seq: 2, timestamp: 1_002, level: "info", text: "two original" },
      { seq: 1, timestamp: 1_001, level: "info", text: "one" },
      { seq: 2, timestamp: 1_003, level: "info", text: "two hydrated variant" },
    ],
    nextSeq: 3,
  });

  const unique = __subagentsTest.uniqueLogsBySeq(job.logs);
  assert.deepEqual(unique.map((entry: any) => entry.seq), [1, 2]);

  const record = __subagentsTest.lifecycleRecordForJob(job);
  assert.deepEqual(record.observability?.logs?.map((entry: any) => entry.seq), [1, 2]);
});

test("status widget includes short job ids and cleanup-failed indicators", () => {
  const job = makeLegacyJob({
    id: "agent_mabc1234_deadbeef",
    label: "status job",
    cleanupPhase: "failed",
    cleanupError: "rm failed",
  });
  const ctx = { ui: { theme: { fg: (_color: string, text: string) => text } } } as any;

  const lines = __subagentsTest.formatStatusTable([job], ctx);
  assert.match(lines.join("\n"), /id\s+agent/);
  assert.match(lines.join("\n"), /deadbeef/);
  assert.equal(__subagentsTest.shortJobId(job.id), "deadbeef");
  assert.match(__subagentsTest.compactJobState(job), /cleanup-failed rm failed/);
});

test("poll log window metadata reports retained range, truncation, and expired cursors", () => {
  const job = makeLegacyJob({
    logs: [
      { seq: 10, timestamp: 1_010, level: "info", text: "ten" },
      { seq: 11, timestamp: 1_011, level: "info", text: "eleven" },
      { seq: 12, timestamp: 1_012, level: "info", text: "twelve" },
    ],
    nextSeq: 13,
  });

  const expired = __subagentsTest.getLogWindow(job, 0, 2);
  assert.deepEqual(expired.logs.map((entry: any) => entry.seq), [10, 11]);
  assert.equal(expired.logWindowStartSeq, 10);
  assert.equal(expired.logWindowEndSeq, 12);
  assert.equal(expired.logsTruncated, true);
  assert.equal(expired.cursorExpired, true);

  const current = __subagentsTest.getLogWindow(job, 9, 10);
  assert.deepEqual(current.logs.map((entry: any) => entry.seq), [10, 11, 12]);
  assert.equal(current.logsTruncated, false);
  assert.equal(current.cursorExpired, false);
});

test("poll formatting clearly mentions expired cursors and log windows", () => {
  const job = makeLegacyJob({
    logs: [{ seq: 42, timestamp: 1_042, level: "info", text: "retained" }],
    nextSeq: 43,
  });
  const window = __subagentsTest.getLogWindow(job, 0, 20);

  const compact = __subagentsTest.formatCompactPollResult(job, 0, 42, window);
  assert.match(compact, /logWindow: 42-42/);
  assert.match(compact, /warning: sinceSeq 0 predates retained logs/);

  const verbose = __subagentsTest.formatPollResult(job, window.logs, 42, false, window);
  assert.match(verbose, /cursor expired/);
  assert.match(verbose, /logWindowStartSeq 42/);
});

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

test("applying a stale persisted record keeps runtime log cursor contiguous", () => {
  const staleRecord = makeLegacyJob().record;
  staleRecord.logCursor.nextSeq = 64;
  const job = makeLegacyJob({ nextSeq: 72 });

  __subagentsTest.applyLifecycleRecordToJob(job, staleRecord);
  assert.equal(job.nextSeq, 72);
  assert.equal(job.record.logCursor.nextSeq, 72);

  __subagentsTest.dispatchLifecycleEvent(job, { type: "LogEntriesAppended", firstSeq: 72, count: 1 }, 2_000);
  assert.equal(job.nextSeq, 73);
});

test("cleanup-pending jobs are protected from pruning eligibility", () => {
  assert.equal(__subagentsTest.hasUnresolvedCleanup(makeLegacyJob({ status: "failed", cleanupPhase: "failed" })), true);
  assert.equal(__subagentsTest.hasUnresolvedCleanup(makeLegacyJob({ status: "failed", cleanupPending: true })), true);
  assert.equal(__subagentsTest.hasUnresolvedCleanup(makeLegacyJob({ status: "failed", cleanupPhase: "complete" })), false);
});

test("live AgentJob lifecycle record persists compact observability", () => {
  const job = makeLegacyJob({
    messageCount: 2,
    nextSeq: 3,
    latestAssistantText: "latest answer",
    finalOutput: "final answer",
    logs: [
      { seq: 1, timestamp: 2_000, level: "info", text: "started", eventType: "start" },
      { seq: 2, timestamp: 2_100, level: "assistant", text: "assistant: final answer", eventType: "message_update" },
    ],
  });
  job.record.logCursor.nextSeq = 3;

  const record = __subagentsTest.lifecycleRecordForJob(job);
  assert.equal(record.observability?.finalOutput, "final answer");
  assert.equal(record.observability?.latestAssistantText, "latest answer");
  assert.equal(record.observability?.messageCount, 2);
  assert.equal(record.observability?.lastLogAt, 2_100);
  assert.deepEqual(record.observability?.logs?.map((entry) => entry.seq), [1, 2]);

  const reloaded = makeLegacyJob({ logs: [], nextSeq: 1, messageCount: 0, latestAssistantText: "", finalOutput: undefined });
  __subagentsTest.applyLifecycleRecordToJob(reloaded, record);
  assert.equal(reloaded.finalOutput, "final answer");
  assert.equal(reloaded.latestAssistantText, "latest answer");
  assert.equal(reloaded.messageCount, 2);
  assert.deepEqual(reloaded.logs.map((entry: { seq: number }) => entry.seq), [1, 2]);
});

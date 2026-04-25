import {
  JOB_RECORD_SCHEMA_VERSION,
  emptyUsageStats,
  initialLogCursor,
  type DurableWorktreeInfo,
  type JobEvent,
  type JobRecord,
  type ReduceOptions,
} from "../../core/types.js";
import { reduceJobEvent } from "../../core/state-machine.js";

export function makeRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  const base: JobRecord = {
    schemaVersion: JOB_RECORD_SCHEMA_VERSION,
    id: "job-1",
    label: "job",
    task: "do work",
    sourceCwd: "/repo",
    cwd: "/repo",
    phase: "created",
    cleanupPhase: "none",
    supervisor: "tmux",
    createdAt: 1_000,
    updatedAt: 1_000,
    logCursor: initialLogCursor(),
    usage: emptyUsageStats(),
  };
  return {
    ...base,
    ...overrides,
    logCursor: overrides.logCursor ?? base.logCursor,
    usage: overrides.usage ?? base.usage,
  };
}

export function terminalRecord(phase: "completed" | "failed" | "cancelled", reason = phase === "cancelled" ? "stop" : "natural-exit"): JobRecord {
  return makeRecord({
    phase,
    terminal: {
      phase,
      reason: reason as "natural-exit" | "stop",
      finishedAt: 2_000,
      exitCode: phase === "completed" ? 0 : 1,
    },
    updatedAt: 2_000,
  });
}

export function worktree(overrides: Partial<DurableWorktreeInfo> = {}): DurableWorktreeInfo {
  return {
    root: "/tmp/worktree",
    tempParent: "/tmp",
    originalRoot: "/repo",
    originalCwd: "/repo",
    base: "HEAD",
    copied: [],
    postCopy: [],
    keepWorktree: "never",
    ...overrides,
  };
}

export function reduceAll(record: JobRecord, events: Array<JobEvent | [JobEvent, ReduceOptions]>): JobRecord {
  let current = record;
  for (const item of events) {
    const [event, options] = Array.isArray(item) ? item : [item, undefined];
    current = reduceJobEvent(current, event, options).next;
  }
  return current;
}

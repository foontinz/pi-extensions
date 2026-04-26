import {
  assertJobRecordInvariants,
  assertTransitionInvariants,
  cloneJobRecord,
  isTerminalPhase,
  jobRecordsEqual,
  shouldRetainWorktree,
  JobRecordInvariantError,
} from "./invariants.js";
import { USAGE_STAT_KEYS } from "./types.js";
import type {
  JobEvent,
  JobRecord,
  JobTransition,
  JobTransitionEffect,
  PendingTerminalInfo,
  ReduceOptions,
  TerminalInfo,
  TerminalJobPhase,
  TerminalReason,
} from "./types.js";

export function reduceJobEvent(record: JobRecord, event: JobEvent, options: ReduceOptions = {}): JobTransition {
  const now = options.now ?? Date.now();
  assertJobRecordInvariants(record);

  const previous = cloneJobRecord(record);
  const next = cloneJobRecord(record);
  const effects: JobTransitionEffect[] = [];

  switch (event.type) {
    case "PrepareRequested": {
      if (next.phase === "created") next.phase = "preparing";
      break;
    }

    case "PrepareSucceeded": {
      if (next.phase === "preparing") {
        next.phase = "starting";
        next.cwd = event.cwd;
        next.worktree = event.worktree;
      }
      break;
    }

    case "PrepareFailed": {
      if (next.phase === "created" || next.phase === "preparing" || next.phase === "starting") {
        enterTerminal(next, {
          phase: "failed",
          reason: "prepare-failed",
          finishedAt: now,
          error: event.error,
          message: event.error,
        }, effects);
      }
      break;
    }

    case "SupervisorStarted": {
      if (next.phase === "starting") {
        next.phase = "running";
        next.supervisorInfo = event.handle;
        next.startedAt ??= now;
      }
      break;
    }

    case "SupervisorFailed": {
      if (next.phase === "created" || next.phase === "preparing" || next.phase === "starting") {
        enterTerminal(next, {
          phase: "failed",
          reason: "supervisor-failed",
          finishedAt: now,
          error: event.error,
          message: event.error,
        }, effects);
      } else if (next.phase === "running" || next.phase === "stopping") {
        next.phase = "draining";
        setPendingTerminalIfAbsent(next, {
          reason: "supervisor-failed",
          observedAt: now,
          error: event.error,
          message: event.error,
        });
        mergeObservedTerminal(next, { observedAt: now, error: event.error, message: event.error });
      }
      break;
    }

    case "OutputChunkRead": {
      assertNonNegativeInteger(event.bytes, "OutputChunkRead.bytes");
      assertNonNegativeInteger(event.offsetAfter, "OutputChunkRead.offsetAfter");
      const key = event.stream === "stdout" ? "stdoutOffset" : "stderrOffset";
      const current = next.logCursor[key];
      if (event.offsetAfter < current) {
        throw new JobRecordInvariantError(`${key} cannot move backwards from ${current} to ${event.offsetAfter}`);
      }
      next.logCursor[key] = event.offsetAfter;
      break;
    }

    case "LogEntriesAppended": {
      assertPositiveInteger(event.firstSeq, "LogEntriesAppended.firstSeq");
      assertNonNegativeInteger(event.count, "LogEntriesAppended.count");
      if (event.count === 0) break;
      const appendNextSeq = event.firstSeq + event.count;
      const expected = next.logCursor.nextSeq;
      if (event.firstSeq > expected) {
        throw new JobRecordInvariantError(`log append gap: expected seq ${expected}, got ${event.firstSeq}`);
      }
      if (event.firstSeq < expected && appendNextSeq > expected) {
        throw new JobRecordInvariantError(`log append overlap: expected seq ${expected}, got ${event.firstSeq}..${appendNextSeq - 1}`);
      }
      if (appendNextSeq > expected) next.logCursor.nextSeq = appendNextSeq;
      break;
    }

    case "UsageUpdated": {
      for (const key of USAGE_STAT_KEYS) {
        const value = event.usage[key];
        if (value === undefined) continue;
        assertNonNegativeFinite(value, `UsageUpdated.usage.${key}`);
        next.usage[key] = value;
      }
      break;
    }

    case "StopRequested": {
      if (next.phase === "created" || next.phase === "preparing" || next.phase === "starting") {
        enterTerminal(next, {
          phase: "cancelled",
          reason: "stop",
          finishedAt: now,
          message: event.reason,
        }, effects);
      } else if (next.phase === "running") {
        next.phase = "stopping";
        setPendingTerminalIfAbsent(next, {
          reason: "stop",
          requestedAt: now,
          message: event.reason,
        });
        effects.push({ type: "supervisor-stop-requested", reason: event.reason });
      }
      break;
    }

    case "TimeoutElapsed": {
      if (next.phase === "running" || next.phase === "stopping") {
        const message = event.message ?? "timeout elapsed";
        next.phase = "stopping";
        next.timeoutAt = now;
        setPendingTerminalIfAbsent(next, {
          reason: "timeout",
          requestedAt: now,
          message,
        });
        effects.push({ type: "supervisor-timeout-kill-requested", reason: message });
      }
      break;
    }

    case "ChildExitObserved": {
      if (next.phase === "running" || next.phase === "stopping") {
        next.phase = "draining";
        setPendingTerminalIfAbsent(next, {
          reason: "natural-exit",
          observedAt: now,
          exitCode: event.exitCode,
          signal: event.signal,
        });
        mergeObservedTerminal(next, { observedAt: now, exitCode: event.exitCode, signal: event.signal });
      } else if (next.phase === "draining") {
        mergeObservedTerminal(next, { observedAt: now, exitCode: event.exitCode, signal: event.signal });
      }
      break;
    }

    case "SupervisorGoneObserved": {
      if (next.phase === "running" || next.phase === "stopping") {
        next.phase = "draining";
        setPendingTerminalIfAbsent(next, {
          reason: "supervisor-failed",
          observedAt: now,
          message: event.message,
          error: event.message,
        });
        mergeObservedTerminal(next, { observedAt: now, message: event.message, error: event.message });
      } else if (next.phase === "draining") {
        mergeObservedTerminal(next, { observedAt: now, message: event.message, error: event.message });
      }
      break;
    }

    case "DrainComplete": {
      if (next.phase === "draining" && next.pendingTerminal?.observedAt !== undefined) {
        finalizeFromPendingTerminal(next, now, effects);
      }
      break;
    }

    case "CleanupRequested": {
      if (!isTerminalPhase(next.phase)) break;
      if (next.cleanupPhase === "running" || next.cleanupPhase === "complete" || next.cleanupPhase === "retained") break;
      if (!next.worktree) {
        next.cleanupPhase = "complete";
        break;
      }
      if (shouldRetainWorktree(next)) {
        next.cleanupPhase = "retained";
        next.worktree = { ...next.worktree, retained: true };
        effects.push({ type: "cleanup-retained" });
      } else {
        next.cleanupPhase = "running";
        effects.push({ type: "cleanup-run-requested" });
      }
      break;
    }

    case "CleanupSucceeded": {
      if (next.cleanupPhase === "running" || next.cleanupPhase === "pending" || next.cleanupPhase === "failed") {
        next.cleanupPhase = "complete";
      }
      break;
    }

    case "CleanupFailed": {
      if (next.cleanupPhase === "running" || next.cleanupPhase === "pending") {
        next.cleanupPhase = "failed";
      }
      break;
    }
  }

  if (!jobRecordsEqual(previous, next)) {
    next.updatedAt = Math.max(now, previous.updatedAt);
  }

  const transition: JobTransition = {
    previous,
    next,
    event,
    effects,
    changed: !jobRecordsEqual(previous, next),
  };

  assertTransitionInvariants(transition);
  return transition;
}

export function setPendingTerminalIfAbsent(record: JobRecord, pending: PendingTerminalInfo): void {
  if (record.pendingTerminal) return;
  record.pendingTerminal = pending;
}

function mergeObservedTerminal(record: JobRecord, observed: Partial<PendingTerminalInfo>): void {
  if (!record.pendingTerminal || record.pendingTerminal.observedAt !== undefined) return;
  record.pendingTerminal.observedAt = observed.observedAt;
  record.pendingTerminal.exitCode = observed.exitCode;
  record.pendingTerminal.signal = observed.signal;
  record.pendingTerminal.message ??= observed.message;
  record.pendingTerminal.error ??= observed.error;
}

function finalizeFromPendingTerminal(record: JobRecord, now: number, effects: JobTransitionEffect[]): void {
  const pending = record.pendingTerminal;
  if (!pending) return;

  const { phase, reason } = terminalOutcomeFromPending(pending);
  enterTerminal(record, {
    phase,
    reason,
    finishedAt: now,
    exitCode: pending.exitCode,
    signal: pending.signal,
    message: pending.message,
    error: pending.error,
  }, effects);
}

function terminalOutcomeFromPending(pending: PendingTerminalInfo): { phase: TerminalJobPhase; reason: TerminalReason } {
  switch (pending.reason) {
    case "stop":
      return { phase: "cancelled", reason: "stop" };
    case "timeout":
      return { phase: "failed", reason: "timeout" };
    case "supervisor-failed":
      return { phase: "failed", reason: "supervisor-failed" };
    case "error":
      return { phase: "failed", reason: "error" };
    case "natural-exit":
      return pending.exitCode === 0 && !pending.signal
        ? { phase: "completed", reason: "natural-exit" }
        : { phase: "failed", reason: "natural-exit" };
  }
}

function enterTerminal(record: JobRecord, terminal: TerminalInfo, effects: JobTransitionEffect[]): void {
  record.phase = terminal.phase;
  record.terminal = terminal;
  delete record.pendingTerminal;
  effects.push({ type: "terminal-entered", terminal });
}

function assertNonNegativeFinite(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new JobRecordInvariantError(`${path} must be a non-negative finite number`);
  }
}

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  assertNonNegativeFinite(value, path);
  if (!Number.isInteger(value)) throw new JobRecordInvariantError(`${path} must be an integer`);
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  assertNonNegativeInteger(value, path);
  if (value <= 0) throw new JobRecordInvariantError(`${path} must be positive`);
}

import { isDeepStrictEqual } from "node:util";
import {
  JOB_RECORD_SCHEMA_VERSION,
  type CleanupPhase,
  type DurableLogLevel,
  type JobOwnerInfo,
  type JobPhase,
  type JobRecord,
  type JobTransition,
  type SupervisorKind,
  type TerminalJobPhase,
  type UsageStats,
  type WorktreeKeepMode,
} from "./types.js";

export class JobRecordInvariantError extends Error {
  override name = "JobRecordInvariantError";
}

export class JobRecordHydrationError extends Error {
  override name = "JobRecordHydrationError";
}

export const TERMINAL_JOB_PHASES = new Set<TerminalJobPhase>(["completed", "failed", "cancelled"]);

const JOB_PHASES = new Set<JobPhase>([
  "created",
  "preparing",
  "starting",
  "running",
  "stopping",
  "draining",
  "completed",
  "failed",
  "cancelled",
]);

const CLEANUP_PHASES = new Set<CleanupPhase>(["none", "pending", "running", "complete", "retained", "failed"]);
const SUPERVISOR_KINDS = new Set<SupervisorKind>(["process", "tmux"]);
const KEEP_WORKTREE_MODES = new Set<WorktreeKeepMode>(["never", "always", "onFailure"]);
const PENDING_TERMINAL_REASONS = new Set(["natural-exit", "stop", "timeout", "supervisor-failed", "error"]);
const TERMINAL_REASONS = new Set([
  "natural-exit",
  "stop",
  "timeout",
  "prepare-failed",
  "supervisor-failed",
  "error",
]);
const USAGE_KEYS: Array<keyof UsageStats> = ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"];

const JOB_RECORD_KEYS = new Set([
  "schemaVersion",
  "id",
  "owner",
  "label",
  "task",
  "sourceCwd",
  "cwd",
  "phase",
  "cleanupPhase",
  "supervisor",
  "supervisorInfo",
  "createdAt",
  "updatedAt",
  "startedAt",
  "timeoutAt",
  "terminal",
  "pendingTerminal",
  "worktree",
  "logCursor",
  "usage",
  "observability",
]);
const OWNER_KEYS = new Set(["version", "id", "instanceId", "sessionId", "sessionFile", "parentPid", "cwd"]);
const LOG_CURSOR_KEYS = new Set(["stdoutOffset", "stderrOffset", "nextSeq"]);
const SUPERVISOR_INFO_KEYS = new Set(["kind", "pid", "command", "args", "tmuxSession", "stdoutPath", "stderrPath", "exitCodePath"]);
const WORKTREE_KEYS = new Set(["root", "tempParent", "originalRoot", "originalCwd", "configPath", "base", "copied", "postCopy", "keepWorktree", "retained"]);
const WORKTREE_SCRIPT_KEYS = new Set(["command", "cwd", "optional", "timeoutMs", "failed", "stdout", "stderr"]);
const TERMINAL_KEYS = new Set(["phase", "reason", "finishedAt", "exitCode", "signal", "message", "error"]);
const PENDING_TERMINAL_KEYS = new Set(["reason", "requestedAt", "observedAt", "exitCode", "signal", "message", "error"]);
const OBSERVABILITY_KEYS = new Set(["finalOutput", "latestAssistantText", "logs", "messageCount", "lastLogAt"]);
const OBSERVABILITY_LOG_KEYS = new Set(["seq", "timestamp", "level", "text", "eventType"]);
const OBSERVABILITY_LOG_LEVELS = new Set<DurableLogLevel>(["info", "assistant", "tool", "stdout", "stderr", "error"]);

export const RUNTIME_ONLY_KEYS = new Set([
  "proc",
  "timeout",
  "killTimer",
  "monitorTimer",
  "stdoutDecoder",
  "stderrDecoder",
  "waiters",
  "closeWaiters",
  "supervisorHandle",
  "timers",
  "decoders",
  "pendingBuffers",
]);

export function isTerminalPhase(phase: JobPhase): phase is TerminalJobPhase {
  return TERMINAL_JOB_PHASES.has(phase as TerminalJobPhase);
}

export function cloneJobRecord<T extends JobRecord>(record: T): T {
  return structuredClone(record);
}

export function jobRecordsEqual(a: JobRecord, b: JobRecord): boolean {
  return isDeepStrictEqual(a, b);
}

export function assertDurableJobRecord(value: unknown): asserts value is JobRecord {
  assertNoRuntimeFields(value);
  assertJobRecordInvariants(value);
}

export function assertJobRecordInvariants(value: unknown): asserts value is JobRecord {
  if (!isRecord(value)) throw invariant("job record must be an object");

  assertNoRuntimeFields(value);
  assertAllowedKeys(value, JOB_RECORD_KEYS, "$");

  if (value.schemaVersion !== JOB_RECORD_SCHEMA_VERSION) {
    throw invariant(`unsupported job record schemaVersion ${String(value.schemaVersion)}`);
  }
  assertNonEmptyString(value.id, "id");
  assertOwner(value.owner);
  assertString(value.label, "label");
  assertString(value.task, "task");
  assertNonEmptyString(value.sourceCwd, "sourceCwd");
  assertNonEmptyString(value.cwd, "cwd");

  if (!JOB_PHASES.has(value.phase as JobPhase)) throw invariant(`invalid phase ${String(value.phase)}`);
  if (!CLEANUP_PHASES.has(value.cleanupPhase as CleanupPhase)) throw invariant(`invalid cleanupPhase ${String(value.cleanupPhase)}`);
  if (!SUPERVISOR_KINDS.has(value.supervisor as SupervisorKind)) throw invariant(`invalid supervisor ${String(value.supervisor)}`);

  assertNonNegativeFinite(value.createdAt, "createdAt");
  assertNonNegativeFinite(value.updatedAt, "updatedAt");
  if (value.updatedAt < value.createdAt) throw invariant("updatedAt cannot be before createdAt");
  if (value.startedAt !== undefined) assertNonNegativeFinite(value.startedAt, "startedAt");
  if (value.timeoutAt !== undefined) assertNonNegativeFinite(value.timeoutAt, "timeoutAt");

  assertLogCursor(value.logCursor);
  assertUsageStats(value.usage);
  assertObservability(value.observability, isRecord(value.logCursor) ? value.logCursor.nextSeq : undefined);
  assertSupervisorInfo(value.supervisorInfo);
  assertWorktree(value.worktree);

  const phase = value.phase as JobPhase;
  if (isTerminalPhase(phase)) {
    if (!isRecord(value.terminal)) throw invariant("terminal phase must include terminal info");
    assertTerminalInfo(value.terminal, phase);
    if (value.pendingTerminal !== undefined) throw invariant("terminal record cannot retain pendingTerminal");
  } else {
    if (value.terminal !== undefined) throw invariant("non-terminal phase cannot include terminal info");
    if (value.pendingTerminal !== undefined) assertPendingTerminalInfo(value.pendingTerminal);
  }

  if (value.cleanupPhase === "running" && shouldRetainWorktree(value as unknown as JobRecord)) {
    throw invariant("retained worktree cannot enter cleanup running");
  }
  if (value.cleanupPhase === "retained" && !value.worktree) {
    throw invariant("cleanupPhase retained requires a worktree");
  }
}

export function assertTransitionInvariants(transition: JobTransition): void {
  assertJobRecordInvariants(transition.previous);
  assertJobRecordInvariants(transition.next);

  const { previous, next, event } = transition;

  if (isTerminalPhase(previous.phase)) {
    if (next.phase !== previous.phase) throw invariant("terminal phase is sticky");
    if (!isDeepStrictEqual(next.terminal, previous.terminal)) throw invariant("terminal metadata is sticky");
  }

  if (next.logCursor.stdoutOffset < previous.logCursor.stdoutOffset) throw invariant("stdoutOffset cannot move backwards");
  if (next.logCursor.stderrOffset < previous.logCursor.stderrOffset) throw invariant("stderrOffset cannot move backwards");
  if (next.logCursor.nextSeq < previous.logCursor.nextSeq) throw invariant("nextSeq cannot move backwards");

  if (previous.pendingTerminal && next.pendingTerminal && previous.pendingTerminal.reason !== next.pendingTerminal.reason) {
    throw invariant("first terminal intent must win");
  }

  if (event.type === "TimeoutElapsed" && isTerminalPhase(next.phase)) {
    throw invariant("timeout cannot terminalize before drain");
  }

  if (transition.effects.some((effect) => effect.type === "terminal-entered")) {
    if (!isTerminalPhase(next.phase)) throw invariant("terminal-entered effect requires terminal phase");
    const terminalEffect = transition.effects.find((effect) => effect.type === "terminal-entered");
    if (terminalEffect?.type === "terminal-entered" && !isDeepStrictEqual(terminalEffect.terminal, next.terminal)) {
      throw invariant("terminal-entered effect must match next.terminal");
    }
  }
}

export function shouldRetainWorktree(record: JobRecord): boolean {
  if (!record.worktree) return false;
  if (record.worktree.retained) return true;
  if (record.worktree.keepWorktree === "always") return true;
  if (record.worktree.keepWorktree === "onFailure") {
    return record.phase === "failed" || record.phase === "cancelled";
  }
  return false;
}

export function assertNoRuntimeFields(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if (typeof value === "function") throw new JobRecordHydrationError(`${path} contains a function`);
  if (!value || typeof value !== "object") return;

  if (seen.has(value)) throw new JobRecordHydrationError(`${path} contains a circular or shared reference`);
  seen.add(value);

  if (value instanceof Set || value instanceof Map || value instanceof WeakSet || value instanceof WeakMap) {
    throw new JobRecordHydrationError(`${path} contains non-serializable runtime collection`);
  }
  if (value instanceof Promise) {
    throw new JobRecordHydrationError(`${path} contains a Promise`);
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RUNTIME_ONLY_KEYS.has(key) && child !== undefined) {
      throw new JobRecordHydrationError(`${path}.${key} is runtime-only and must not be persisted`);
    }
    assertNoRuntimeFields(child, `${path}.${key}`, seen);
  }
}

function assertOwner(value: unknown): asserts value is JobOwnerInfo {
  if (!isRecord(value)) throw invariant("owner must be an object");
  assertAllowedKeys(value, OWNER_KEYS, "owner");
  if (value.version !== 1) throw invariant(`invalid owner.version ${String(value.version)}`);
  assertNonEmptyString(value.id, "owner.id");
  assertNonEmptyString(value.instanceId, "owner.instanceId");
  assertNonEmptyString(value.sessionId, "owner.sessionId");
  if (value.sessionFile !== undefined) assertString(value.sessionFile, "owner.sessionFile");
  assertNonNegativeInteger(value.parentPid, "owner.parentPid");
  assertNonEmptyString(value.cwd, "owner.cwd");
}

function assertLogCursor(value: unknown): void {
  if (!isRecord(value)) throw invariant("logCursor must be an object");
  assertAllowedKeys(value, LOG_CURSOR_KEYS, "logCursor");
  assertNonNegativeInteger(value.stdoutOffset, "logCursor.stdoutOffset");
  assertNonNegativeInteger(value.stderrOffset, "logCursor.stderrOffset");
  assertPositiveInteger(value.nextSeq, "logCursor.nextSeq");
}

function assertUsageStats(value: unknown): void {
  if (!isRecord(value)) throw invariant("usage must be an object");
  assertAllowedKeys(value, new Set<string>(USAGE_KEYS), "usage");
  for (const key of USAGE_KEYS) assertNonNegativeFinite(value[key], `usage.${key}`);
}

function assertObservability(value: unknown, nextSeq: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw invariant("observability must be an object");
  assertAllowedKeys(value, OBSERVABILITY_KEYS, "observability");
  if (value.finalOutput !== undefined) assertString(value.finalOutput, "observability.finalOutput");
  if (value.latestAssistantText !== undefined) assertString(value.latestAssistantText, "observability.latestAssistantText");
  if (value.messageCount !== undefined) assertNonNegativeInteger(value.messageCount, "observability.messageCount");
  if (value.lastLogAt !== undefined) assertNonNegativeFinite(value.lastLogAt, "observability.lastLogAt");
  if (value.logs !== undefined) {
    if (!Array.isArray(value.logs)) throw invariant("observability.logs must be an array");
    let previousSeq = 0;
    for (const [index, entry] of value.logs.entries()) {
      if (!isRecord(entry)) throw invariant(`observability.logs.${index} must be an object`);
      assertAllowedKeys(entry, OBSERVABILITY_LOG_KEYS, `observability.logs.${index}`);
      assertPositiveInteger(entry.seq, `observability.logs.${index}.seq`);
      assertNonNegativeFinite(entry.timestamp, `observability.logs.${index}.timestamp`);
      if (!OBSERVABILITY_LOG_LEVELS.has(entry.level as DurableLogLevel)) throw invariant(`invalid observability.logs.${index}.level ${String(entry.level)}`);
      assertString(entry.text, `observability.logs.${index}.text`);
      if (entry.eventType !== undefined) assertString(entry.eventType, `observability.logs.${index}.eventType`);
      if (entry.seq <= previousSeq) throw invariant("observability.logs must be sorted by increasing seq");
      previousSeq = entry.seq as number;
      if (typeof nextSeq === "number" && entry.seq >= nextSeq) throw invariant("observability log seq cannot exceed logCursor.nextSeq");
    }
  }
}

function assertSupervisorInfo(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw invariant("supervisorInfo must be an object");
  assertAllowedKeys(value, SUPERVISOR_INFO_KEYS, "supervisorInfo");
  if (value.kind !== undefined && !SUPERVISOR_KINDS.has(value.kind as SupervisorKind)) {
    throw invariant(`invalid supervisorInfo.kind ${String(value.kind)}`);
  }
  if (value.pid !== undefined) assertNonNegativeInteger(value.pid, "supervisorInfo.pid");
  if (value.command !== undefined) assertString(value.command, "supervisorInfo.command");
  if (value.args !== undefined) assertStringArray(value.args, "supervisorInfo.args");
  if (value.tmuxSession !== undefined) assertString(value.tmuxSession, "supervisorInfo.tmuxSession");
  if (value.stdoutPath !== undefined) assertString(value.stdoutPath, "supervisorInfo.stdoutPath");
  if (value.stderrPath !== undefined) assertString(value.stderrPath, "supervisorInfo.stderrPath");
  if (value.exitCodePath !== undefined) assertString(value.exitCodePath, "supervisorInfo.exitCodePath");
}

function assertWorktree(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw invariant("worktree must be an object");
  assertAllowedKeys(value, WORKTREE_KEYS, "worktree");
  assertNonEmptyString(value.root, "worktree.root");
  if (value.tempParent !== undefined) assertString(value.tempParent, "worktree.tempParent");
  if (value.originalRoot !== undefined) assertString(value.originalRoot, "worktree.originalRoot");
  if (value.originalCwd !== undefined) assertString(value.originalCwd, "worktree.originalCwd");
  if (value.configPath !== undefined) assertString(value.configPath, "worktree.configPath");
  if (value.base !== undefined) assertString(value.base, "worktree.base");
  if (!KEEP_WORKTREE_MODES.has(value.keepWorktree as WorktreeKeepMode)) {
    throw invariant(`invalid worktree.keepWorktree ${String(value.keepWorktree)}`);
  }
  if (value.copied !== undefined) assertStringArray(value.copied, "worktree.copied");
  if (value.retained !== undefined && typeof value.retained !== "boolean") throw invariant("worktree.retained must be boolean");
  if (value.postCopy !== undefined) {
    if (!Array.isArray(value.postCopy)) throw invariant("worktree.postCopy must be an array");
    value.postCopy.forEach((script, index) => assertWorktreeScript(script, `worktree.postCopy.${index}`));
  }
}

function assertWorktreeScript(value: unknown, path: string): void {
  if (!isRecord(value)) throw invariant(`${path} must be an object`);
  assertAllowedKeys(value, WORKTREE_SCRIPT_KEYS, path);
  assertNonEmptyString(value.command, `${path}.command`);
  if (value.cwd !== undefined) assertString(value.cwd, `${path}.cwd`);
  if (value.optional !== undefined && typeof value.optional !== "boolean") throw invariant(`${path}.optional must be boolean`);
  if (value.timeoutMs !== undefined) assertNonNegativeFinite(value.timeoutMs, `${path}.timeoutMs`);
  if (value.failed !== undefined && typeof value.failed !== "boolean") throw invariant(`${path}.failed must be boolean`);
  if (value.stdout !== undefined) assertString(value.stdout, `${path}.stdout`);
  if (value.stderr !== undefined) assertString(value.stderr, `${path}.stderr`);
}

function assertTerminalInfo(value: Record<string, unknown>, phase: TerminalJobPhase): void {
  assertAllowedKeys(value, TERMINAL_KEYS, "terminal");
  if (value.phase !== phase) throw invariant("terminal.phase must match job phase");
  if (!TERMINAL_REASONS.has(value.reason as string)) throw invariant(`invalid terminal.reason ${String(value.reason)}`);
  assertNonNegativeFinite(value.finishedAt, "terminal.finishedAt");
  if (value.exitCode !== undefined) assertInteger(value.exitCode, "terminal.exitCode");
  if (value.signal !== undefined) assertString(value.signal, "terminal.signal");
  if (value.message !== undefined) assertString(value.message, "terminal.message");
  if (value.error !== undefined) assertString(value.error, "terminal.error");
}

function assertPendingTerminalInfo(value: unknown): void {
  if (!isRecord(value)) throw invariant("pendingTerminal must be an object");
  assertAllowedKeys(value, PENDING_TERMINAL_KEYS, "pendingTerminal");
  if (!PENDING_TERMINAL_REASONS.has(value.reason as string)) {
    throw invariant(`invalid pendingTerminal.reason ${String(value.reason)}`);
  }
  if (value.requestedAt !== undefined) assertNonNegativeFinite(value.requestedAt, "pendingTerminal.requestedAt");
  if (value.observedAt !== undefined) assertNonNegativeFinite(value.observedAt, "pendingTerminal.observedAt");
  if (value.exitCode !== undefined) assertInteger(value.exitCode, "pendingTerminal.exitCode");
  if (value.signal !== undefined) assertString(value.signal, "pendingTerminal.signal");
  if (value.message !== undefined) assertString(value.message, "pendingTerminal.message");
  if (value.error !== undefined) assertString(value.error, "pendingTerminal.error");
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invariant(`${path}.${key} is not a durable JobRecord field`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") throw invariant(`${path} must be a string`);
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (!value) throw invariant(`${path} must be non-empty`);
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) throw invariant(`${path} must be an array`);
  value.forEach((item, index) => assertString(item, `${path}.${index}`));
}

function assertNonNegativeFinite(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invariant(`${path} must be a non-negative finite number`);
  }
}

function assertInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw invariant(`${path} must be an integer`);
}

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  assertNonNegativeFinite(value, path);
  if (!Number.isInteger(value)) throw invariant(`${path} must be an integer`);
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  assertNonNegativeInteger(value, path);
  if (value <= 0) throw invariant(`${path} must be positive`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invariant(message: string): JobRecordInvariantError {
  return new JobRecordInvariantError(message);
}

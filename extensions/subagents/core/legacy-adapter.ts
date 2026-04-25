import { assertDurableJobRecord, isTerminalPhase } from "./invariants.js";
import {
  JOB_RECORD_SCHEMA_VERSION,
  emptyUsageStats,
  initialLogCursor,
  type CleanupPhase,
  type DurableSupervisorInfo,
  type DurableWorktreeInfo,
  type JobPhase,
  type JobRecord,
  type SupervisorKind,
  type TerminalInfo,
  type UsageStats,
  type WorktreeKeepMode,
  type DurableWorktreeScriptResult,
} from "./types.js";

export type LegacyJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface LegacyAgentJobSnapshot {
  id: string;
  label: string;
  agent?: string;
  task: string;
  cwd: string;
  sourceCwd: string;
  status: LegacyJobStatus;
  supervisor: SupervisorKind;
  tmuxSession?: string;
  pid?: number;
  command?: string;
  args?: string[];
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: string;
  stopReason?: string;
  errorMessage?: string;
  timeoutAt?: number;
  worktree?: DurableWorktreeInfo;
  cleanupPending?: boolean;
  cleanupError?: string;
  stdoutOffset: number;
  stderrOffset: number;
  nextSeq: number;
  usage: UsageStats;
}

export interface LegacyAdapterOptions {
  fallbackCwd: string;
  now?: number;
  id?: string;
}

export interface RecordToLegacyOptions {
  includeEmptyLogs?: boolean;
}

export function legacyJobToRecord(input: unknown, options: LegacyAdapterOptions): JobRecord {
  const legacy = asRecord(input);
  const now = options.now ?? Date.now();

  const id = coerceNonEmptyString(legacy.id, options.id ?? "unknown");
  const cwd = coerceNonEmptyString(legacy.cwd, coerceNonEmptyString(legacy.sourceCwd, options.fallbackCwd));
  const sourceCwd = coerceNonEmptyString(legacy.sourceCwd, cwd);
  const status = normalizeLegacyStatus(legacy.status);
  const phase = legacyStatusToJobPhase(status);
  const createdAt = coerceTimestamp(legacy.startedAt, coerceTimestamp(legacy.createdAt, now));
  const updatedAt = Math.max(createdAt, coerceTimestamp(legacy.updatedAt, coerceTimestamp(legacy.finishedAt, createdAt)));
  const supervisor = normalizeSupervisor(legacy.supervisor);
  const worktree = normalizeWorktree(legacy.worktree);
  const terminal = isTerminalPhase(phase) ? legacyTerminalInfo(phase, legacy, updatedAt) : undefined;

  const record: JobRecord = {
    schemaVersion: JOB_RECORD_SCHEMA_VERSION,
    id,
    label: coerceString(legacy.label, coerceString(legacy.agent, id)),
    task: coerceString(legacy.task, ""),
    sourceCwd,
    cwd,
    phase,
    cleanupPhase: legacyCleanupPhase(phase, legacy, worktree),
    supervisor,
    supervisorInfo: legacySupervisorInfo(supervisor, legacy),
    createdAt,
    updatedAt,
    startedAt: coerceOptionalTimestamp(legacy.startedAt),
    timeoutAt: coerceOptionalTimestamp(legacy.timeoutAt),
    terminal,
    worktree,
    logCursor: {
      stdoutOffset: coerceNonNegativeInteger(legacy.stdoutOffset, 0),
      stderrOffset: coerceNonNegativeInteger(legacy.stderrOffset, 0),
      nextSeq: Math.max(1, coerceNonNegativeInteger(legacy.nextSeq, inferNextSeq(legacy.logs))),
    },
    usage: normalizeUsage(legacy.usage),
  };

  if (record.startedAt === undefined && phase === "running") record.startedAt = createdAt;

  assertDurableJobRecord(record);
  return record;
}

export function recordToLegacySnapshot(record: JobRecord, options: RecordToLegacyOptions = {}): LegacyAgentJobSnapshot & { logs?: [] } {
  assertDurableJobRecord(record);
  const status = jobPhaseToLegacyStatus(record.phase);
  const terminal = record.terminal;
  const supervisorInfo = record.supervisorInfo;
  const legacy: LegacyAgentJobSnapshot & { logs?: [] } = {
    id: record.id,
    label: record.label,
    task: record.task,
    cwd: record.cwd,
    sourceCwd: record.sourceCwd,
    status,
    supervisor: record.supervisor,
    command: supervisorInfo?.command,
    args: supervisorInfo?.args,
    pid: supervisorInfo?.pid,
    tmuxSession: supervisorInfo?.tmuxSession,
    startedAt: record.startedAt ?? record.createdAt,
    updatedAt: record.updatedAt,
    finishedAt: terminal?.finishedAt,
    exitCode: terminal?.exitCode,
    signal: terminal?.signal,
    stopReason: terminal?.reason === "stop" ? terminal.message : undefined,
    errorMessage: status === "failed" ? terminal?.error ?? terminal?.message : undefined,
    timeoutAt: record.timeoutAt,
    worktree: record.worktree,
    cleanupPending: isTerminalPhase(record.phase) && (record.cleanupPhase === "pending" || record.cleanupPhase === "running" || record.cleanupPhase === "failed"),
    stdoutOffset: record.logCursor.stdoutOffset,
    stderrOffset: record.logCursor.stderrOffset,
    nextSeq: record.logCursor.nextSeq,
    usage: { ...record.usage },
  };
  if (options.includeEmptyLogs) legacy.logs = [];
  return legacy;
}

export function legacyStatusToJobPhase(status: unknown): JobPhase {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
    default:
      return "failed";
  }
}

export function jobPhaseToLegacyStatus(phase: JobPhase): LegacyJobStatus {
  switch (phase) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "created":
    case "preparing":
    case "starting":
    case "running":
    case "stopping":
    case "draining":
      return "running";
  }
}

function legacyTerminalInfo(phase: "completed" | "failed" | "cancelled", legacy: Record<string, unknown>, fallbackFinishedAt: number): TerminalInfo {
  const finishedAt = coerceTimestamp(legacy.finishedAt, fallbackFinishedAt);
  const exitCode = coerceOptionalInteger(legacy.exitCode);
  const signal = coerceOptionalString(legacy.signal);
  const stopReason = coerceOptionalString(legacy.stopReason);
  const errorMessage = coerceOptionalString(legacy.errorMessage);

  if (phase === "completed") {
    return { phase, reason: "natural-exit", finishedAt, exitCode, signal };
  }
  if (phase === "cancelled") {
    return { phase, reason: "stop", finishedAt, exitCode, signal, message: stopReason ?? errorMessage };
  }
  if (exitCode !== undefined || signal !== undefined) {
    return { phase, reason: "natural-exit", finishedAt, exitCode, signal, message: errorMessage, error: errorMessage };
  }
  if (looksLikeTimeout(stopReason) || looksLikeTimeout(errorMessage)) {
    return { phase, reason: "timeout", finishedAt, message: stopReason ?? errorMessage, error: errorMessage };
  }
  return { phase, reason: "error", finishedAt, message: errorMessage ?? stopReason, error: errorMessage };
}

function legacyCleanupPhase(phase: JobPhase, legacy: Record<string, unknown>, worktree: DurableWorktreeInfo | undefined): CleanupPhase {
  if (!isTerminalPhase(phase)) return "none";
  if (worktree?.retained) return "retained";
  if (legacy.cleanupError !== undefined) return "failed";
  if (legacy.cleanupPending === true) return "pending";
  return "none";
}

function legacySupervisorInfo(supervisor: SupervisorKind, legacy: Record<string, unknown>): DurableSupervisorInfo {
  const info: DurableSupervisorInfo = { kind: supervisor };
  const pid = coerceOptionalInteger(legacy.pid);
  if (pid !== undefined && pid >= 0) info.pid = pid;
  const command = coerceOptionalString(legacy.command);
  if (command !== undefined) info.command = command;
  if (Array.isArray(legacy.args)) info.args = legacy.args.map(String);
  const tmuxSession = coerceOptionalString(legacy.tmuxSession);
  if (tmuxSession !== undefined) info.tmuxSession = tmuxSession;
  const stdoutPath = coerceOptionalString(legacy.stdoutPath);
  if (stdoutPath !== undefined) info.stdoutPath = stdoutPath;
  const stderrPath = coerceOptionalString(legacy.stderrPath);
  if (stderrPath !== undefined) info.stderrPath = stderrPath;
  const exitCodePath = coerceOptionalString(legacy.exitCodePath);
  if (exitCodePath !== undefined) info.exitCodePath = exitCodePath;
  return info;
}

function normalizeWorktree(input: unknown): DurableWorktreeInfo | undefined {
  if (!isRecord(input)) return undefined;
  const root = coerceOptionalString(input.root);
  if (!root) return undefined;
  return {
    root,
    tempParent: coerceOptionalString(input.tempParent),
    originalRoot: coerceOptionalString(input.originalRoot),
    originalCwd: coerceOptionalString(input.originalCwd),
    configPath: coerceOptionalString(input.configPath),
    base: coerceOptionalString(input.base) ?? "HEAD",
    copied: Array.isArray(input.copied) ? input.copied.map(String) : [],
    postCopy: Array.isArray(input.postCopy)
      ? input.postCopy.flatMap((script) => normalizePostCopy(script))
      : [],
    keepWorktree: normalizeKeepWorktree(input.keepWorktree),
    retained: typeof input.retained === "boolean" ? input.retained : undefined,
  };
}

function normalizePostCopy(input: unknown): DurableWorktreeScriptResult[] {
  if (typeof input === "string") return [{ command: input }];
  if (!isRecord(input)) return [];
  const command = coerceOptionalString(input.command);
  if (!command) return [];
  return [{
    command,
    cwd: coerceOptionalString(input.cwd),
    optional: typeof input.optional === "boolean" ? input.optional : undefined,
    timeoutMs: coerceOptionalTimestamp(input.timeoutMs),
    failed: typeof input.failed === "boolean" ? input.failed : undefined,
    stdout: coerceOptionalString(input.stdout),
    stderr: coerceOptionalString(input.stderr),
  }];
}

function normalizeUsage(input: unknown): UsageStats {
  const usage = emptyUsageStats();
  if (!isRecord(input)) return usage;
  for (const key of Object.keys(usage) as Array<keyof UsageStats>) {
    const value = input[key];
    usage[key] = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return usage;
}

function inferNextSeq(logs: unknown): number {
  if (!Array.isArray(logs)) return initialLogCursor().nextSeq;
  let maxSeq = 0;
  for (const log of logs) {
    if (isRecord(log) && typeof log.seq === "number" && Number.isInteger(log.seq)) maxSeq = Math.max(maxSeq, log.seq);
  }
  return Math.max(1, maxSeq + 1);
}

function normalizeLegacyStatus(value: unknown): LegacyJobStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled" ? value : "failed";
}

function normalizeSupervisor(value: unknown): SupervisorKind {
  return value === "process" || value === "tmux" ? value : "tmux";
}

function normalizeKeepWorktree(value: unknown): WorktreeKeepMode {
  if (value === "always" || value === true) return "always";
  if (value === "onFailure") return "onFailure";
  return "never";
}

function looksLikeTimeout(value: string | undefined): boolean {
  return Boolean(value && /timeout|timed out/i.test(value));
}

function coerceTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function coerceOptionalTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function coerceNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function coerceOptionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function coerceNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function coerceOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

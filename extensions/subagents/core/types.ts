export const JOB_RECORD_SCHEMA_VERSION = 2 as const;

export type JobId = string;

export interface JobOwnerInfo {
  version: 1;
  id: string;
  instanceId: string;
  sessionId: string;
  sessionFile?: string;
  parentPid: number;
  cwd: string;
}

export const JOB_PHASE_VALUES = ["created", "preparing", "starting", "running", "stopping", "draining", "completed", "failed", "cancelled"] as const;
export type JobPhase = typeof JOB_PHASE_VALUES[number];

export const TERMINAL_JOB_PHASE_VALUES = ["completed", "failed", "cancelled"] as const;
export type TerminalJobPhase = typeof TERMINAL_JOB_PHASE_VALUES[number];

export const CLEANUP_PHASE_VALUES = ["none", "pending", "running", "complete", "retained", "failed"] as const;
export type CleanupPhase = typeof CLEANUP_PHASE_VALUES[number];

export const SUPERVISOR_KIND_VALUES = ["process", "tmux"] as const;
export type SupervisorKind = typeof SUPERVISOR_KIND_VALUES[number];

export const TERMINAL_REASON_VALUES = ["natural-exit", "stop", "timeout", "prepare-failed", "supervisor-failed", "error"] as const;
export type TerminalReason = typeof TERMINAL_REASON_VALUES[number];
export interface TerminalInfo {
  phase: TerminalJobPhase;
  reason: TerminalReason;
  finishedAt: number;
  exitCode?: number;
  signal?: string;
  message?: string;
  error?: string;
}

export interface PendingTerminalInfo {
  reason: "natural-exit" | "stop" | "timeout" | "supervisor-failed" | "error";
  requestedAt?: number;
  observedAt?: number;
  exitCode?: number;
  signal?: string;
  message?: string;
  error?: string;
}

export interface LogCursor {
  stdoutOffset: number;
  stderrOffset: number;
  nextSeq: number;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export const USAGE_STAT_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"] as const satisfies ReadonlyArray<keyof UsageStats>;
export const WORKTREE_KEEP_MODE_VALUES = ["never", "always", "onFailure"] as const;
export type WorktreeKeepMode = typeof WORKTREE_KEEP_MODE_VALUES[number];
export interface DurableWorktreeScriptResult {
  command: string;
  cwd?: string;
  optional?: boolean;
  timeoutMs?: number;
  failed?: boolean;
  stdout?: string;
  stderr?: string;
}

export interface DurableWorktreeInfo {
  root: string;
  tempParent?: string;
  originalRoot?: string;
  originalCwd?: string;
  configPath?: string;
  base?: string;
  copied?: string[];
  postCopy?: DurableWorktreeScriptResult[];
  keepWorktree: WorktreeKeepMode;
  retained?: boolean;
}

export interface DurableSupervisorInfo {
  kind?: SupervisorKind;
  pid?: number;
  command?: string;
  args?: string[];
  tmuxSession?: string;
  stdoutPath?: string;
  stderrPath?: string;
  exitCodePath?: string;
}

export const DURABLE_LOG_LEVEL_VALUES = ["info", "assistant", "tool", "stdout", "stderr", "error"] as const;
export type DurableLogLevel = typeof DURABLE_LOG_LEVEL_VALUES[number];
export interface DurableLogEntry {
  seq: number;
  timestamp: number;
  level: DurableLogLevel;
  text: string;
  eventType?: string;
}

export interface DurableObservabilityState {
  finalOutput?: string;
  latestAssistantText?: string;
  logs?: DurableLogEntry[];
  messageCount?: number;
  lastLogAt?: number;
}

export interface JobRecord {
  schemaVersion: typeof JOB_RECORD_SCHEMA_VERSION;

  id: JobId;
  owner: JobOwnerInfo;
  label: string;
  task: string;

  sourceCwd: string;
  cwd: string;

  phase: JobPhase;
  cleanupPhase: CleanupPhase;

  supervisor: SupervisorKind;
  supervisorInfo?: DurableSupervisorInfo;

  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  timeoutAt?: number;

  terminal?: TerminalInfo;
  pendingTerminal?: PendingTerminalInfo;

  worktree?: DurableWorktreeInfo;

  logCursor: LogCursor;
  usage: UsageStats;
  observability?: DurableObservabilityState;
}

export type JobEvent =
  | { type: "PrepareRequested" }
  | { type: "PrepareSucceeded"; cwd: string; worktree?: DurableWorktreeInfo }
  | { type: "PrepareFailed"; error: string }
  | { type: "SupervisorStarted"; handle: DurableSupervisorInfo }
  | { type: "SupervisorFailed"; error: string }
  | { type: "OutputChunkRead"; stream: "stdout" | "stderr"; bytes: number; offsetAfter: number }
  | { type: "LogEntriesAppended"; firstSeq: number; count: number }
  | { type: "UsageUpdated"; usage: Partial<UsageStats> }
  | { type: "StopRequested"; reason: string }
  | { type: "TimeoutElapsed"; message?: string }
  | { type: "ChildExitObserved"; exitCode?: number; signal?: string }
  | { type: "SupervisorGoneObserved"; message?: string }
  | { type: "DrainComplete" }
  | { type: "CleanupRequested" }
  | { type: "CleanupSucceeded" }
  | { type: "CleanupFailed"; error: string };

export type JobTransitionEffect =
  | { type: "terminal-entered"; terminal: TerminalInfo }
  | { type: "cleanup-run-requested" }
  | { type: "cleanup-retained" }
  | { type: "supervisor-stop-requested"; reason: string }
  | { type: "supervisor-timeout-kill-requested"; reason: string };

export interface ReduceOptions {
  now?: number;
}

export interface JobTransition {
  previous: JobRecord;
  next: JobRecord;
  event: JobEvent;
  effects: JobTransitionEffect[];
  changed: boolean;
}

export interface RuntimeTimers {
  timeout?: unknown;
  killTimer?: unknown;
  monitorTimer?: unknown;
}

export interface StreamDecoders {
  stdoutDecoder?: unknown;
  stderrDecoder?: unknown;
}

export interface StreamBuffers {
  stdout: string;
  stderr: string;
}

export interface SupervisorHandle {
  kind: SupervisorKind;
  handle?: unknown;
}

export interface Waiter {
  predicate(record: JobRecord): boolean;
  resolve(record: JobRecord): void;
  reject(error: unknown): void;
  cleanup(): void;
}

export interface JobRuntimeState {
  waiters: Set<Waiter>;
  timers: RuntimeTimers;
  decoders: StreamDecoders;
  supervisorHandle?: SupervisorHandle;
  pendingBuffers: StreamBuffers;
}

export function emptyUsageStats(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

export function initialLogCursor(): LogCursor {
  return { stdoutOffset: 0, stderrOffset: 0, nextSeq: 1 };
}

export function createEmptyJobRuntimeState(): JobRuntimeState {
  return {
    waiters: new Set<Waiter>(),
    timers: {},
    decoders: {},
    pendingBuffers: { stdout: "", stderr: "" },
  };
}

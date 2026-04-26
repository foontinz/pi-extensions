import type { LogWindow } from "../output/log-window.js";
import { compactPreview } from "../output/preview.js";
import { formatUsage } from "../output/usage.js";
import { truncateOneLine } from "../platform/text.js";
import { truncateForTool } from "./truncate.js";
import type { UsageStats } from "../core/types.js";

export interface PollLogEntryView {
  seq: number;
  timestamp: number;
  level: string;
  text: string;
}

export interface PollJobView<TLog extends PollLogEntryView = PollLogEntryView> {
  id: string;
  label: string;
  agent?: string;
  agentSource?: string;
  task: string;
  effectiveTools: string[];
  cwd: string;
  sourceCwd: string;
  worktree?: {
    root: string;
    originalRoot: string;
    originalCwd: string;
    configPath?: string;
    base?: string;
    copied?: string[];
    postCopy?: unknown;
    keepWorktree?: string;
    retained?: boolean;
  };
  pid?: number;
  supervisor: string;
  tmuxSession?: string;
  stdoutPath?: string;
  stderrPath?: string;
  rawLogLimitExceeded?: boolean;
  status: "running" | "completed" | "failed" | "cancelled";
  phase?: string;
  cleanupPhase?: string;
  terminal?: unknown;
  pendingTerminal?: unknown;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: string;
  stopReason?: string;
  errorMessage?: string;
  cleanupPending?: boolean;
  cleanupError?: string;
  usage: UsageStats;
  messageCount: number;
  finalOutput?: string;
  latestAssistantText?: string;
  nextSeq: number;
  logs: TLog[];
}

export interface PollFormatOptions {
  suggestedPollIntervalMs: number;
  rawLogLimitBytes: number;
  rawLogSizes: { stdout?: number; stderr?: number; total: number };
}

export interface PollJobSummary {
  id: string;
  label: string;
  agent?: string;
  agentSource?: string;
  task: string;
  effectiveTools: string[];
  cwd: string;
  sourceCwd: string;
  worktree?: {
    root: string;
    originalRoot: string;
    originalCwd: string;
    configPath?: string;
    base?: string;
    copied?: string[];
    postCopy?: unknown;
    keepWorktree?: string;
    retained?: boolean;
  };
  pid?: number;
  supervisor: string;
  tmuxSession?: string;
  stdoutPath?: string;
  stderrPath?: string;
  rawLogBytes: { stdout?: number; stderr?: number; total: number };
  rawLogLimitBytes: number;
  rawLogLimitExceeded?: boolean;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: string;
  cleanupPhase?: string;
  terminal?: unknown;
  pendingTerminal?: unknown;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: string;
  stopReason?: string;
  errorMessage?: string;
  cleanupPending?: boolean;
  cleanupError?: string;
  usage: UsageStats;
  messageCount: number;
  finalOutputPreview?: string;
  nextSeq: number;
}

export function summarizeJob<TLog extends PollLogEntryView>(job: PollJobView<TLog>, options: PollFormatOptions): PollJobSummary {
  return {
    id: job.id,
    label: job.label,
    agent: job.agent,
    agentSource: job.agentSource,
    task: job.task,
    effectiveTools: job.effectiveTools,
    cwd: job.cwd,
    sourceCwd: job.sourceCwd,
    worktree: job.worktree
      ? {
          root: job.worktree.root,
          originalRoot: job.worktree.originalRoot,
          originalCwd: job.worktree.originalCwd,
          configPath: job.worktree.configPath,
          base: job.worktree.base,
          copied: job.worktree.copied,
          postCopy: job.worktree.postCopy,
          keepWorktree: job.worktree.keepWorktree,
          retained: job.worktree.retained,
        }
      : undefined,
    pid: job.pid,
    supervisor: job.supervisor,
    tmuxSession: job.tmuxSession,
    stdoutPath: job.stdoutPath,
    stderrPath: job.stderrPath,
    rawLogBytes: options.rawLogSizes,
    rawLogLimitBytes: options.rawLogLimitBytes,
    rawLogLimitExceeded: job.rawLogLimitExceeded,
    status: job.status,
    phase: job.phase ?? job.status,
    cleanupPhase: job.cleanupPhase,
    terminal: job.terminal,
    pendingTerminal: job.pendingTerminal,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    stopReason: job.stopReason,
    errorMessage: job.errorMessage,
    cleanupPending: job.cleanupPending,
    cleanupError: job.cleanupError,
    usage: job.usage,
    messageCount: job.messageCount,
    finalOutputPreview: job.finalOutput ? truncateOneLine(job.finalOutput, 1_000) : undefined,
    nextSeq: job.nextSeq - 1,
  };
}

export function formatJobSummaryLine(job: PollJobSummary): string {
  const age = job.finishedAt ? `${Math.round((job.finishedAt - job.startedAt) / 1000)}s` : `${Math.round((Date.now() - job.startedAt) / 1000)}s`;
  const usage = formatUsage(job.usage);
  return [
    job.id,
    `[${job.status}]`,
    job.agent ? `${job.agent}(${job.agentSource})` : "adhoc",
    `age=${age}`,
    usage || undefined,
    `label=${job.label}`,
  ].filter(Boolean).join(" ");
}

export function formatCompactPollResult<TLog extends PollLogEntryView>(
  job: PollJobView<TLog>,
  sinceSeq: number,
  nextSeq: number,
  logWindow: LogWindow<TLog>,
  options: PollFormatOptions,
): string {
  const newEventCount = job.logs.filter((entry) => entry.seq > sinceSeq).length;
  const windowText = logWindow.logWindowStartSeq === undefined
    ? "empty"
    : `${logWindow.logWindowStartSeq}-${logWindow.logWindowEndSeq}`;
  const lines = [formatJobSummaryLine(summarizeJob(job, options)), `nextSeq: ${nextSeq}; newEvents: ${newEventCount}; logWindow: ${windowText}`];
  if (logWindow.cursorExpired) {
    lines.push(`warning: sinceSeq ${sinceSeq} predates retained logs; older events are no longer available. Restart from logWindowStartSeq ${logWindow.logWindowStartSeq}.`);
  }

  if (job.status === "running") {
    const latest = job.latestAssistantText || latestLogPreview(job) || "waiting for output";
    lines.push(`progress: ${compactPreview(latest, 220, 2)}`);
    lines.push(`next: poll again in ~15-30s or use waitMs:${options.suggestedPollIntervalMs}; verbosity:"logs" for details.`);
    return lines.join("\n");
  }

  if (job.errorMessage) lines.push(`error: ${compactPreview(job.errorMessage, 220, 2)}`);
  lines.push(`result: ${job.finalOutput ? compactPreview(job.finalOutput, 260, 3) : "(no final assistant output)"}`);
  if (job.finalOutput && job.finalOutput.length > 260) lines.push(`full: poll_agent({ id: "${job.id}", verbosity: "full" })`);
  return lines.join("\n");
}

export function formatPollResult<TLog extends PollLogEntryView>(
  job: PollJobView<TLog>,
  logs: TLog[],
  nextSeq: number,
  includeFullOutput: boolean,
  logWindow: LogWindow<TLog>,
  options: PollFormatOptions,
): string {
  const lines: string[] = [];
  lines.push(formatJobSummaryLine(summarizeJob(job, options)));
  const windowText = logWindow.logWindowStartSeq === undefined
    ? "empty"
    : `${logWindow.logWindowStartSeq}-${logWindow.logWindowEndSeq}`;
  lines.push(`nextSeq: ${nextSeq}${logWindow.logsTruncated ? " (more logs available; poll again with this sinceSeq)" : ""}; logWindow: ${windowText}`);
  if (logWindow.cursorExpired) {
    lines.push(`warning: sinceSeq predates retained logs; cursor expired and older events are no longer available. Restart from logWindowStartSeq ${logWindow.logWindowStartSeq}.`);
  }
  if (job.errorMessage && job.status !== "running") lines.push(`error: ${job.errorMessage}`);
  lines.push("");
  lines.push(logs.length === 0 ? "(no new logs)" : logs.map(formatLogEntry).join("\n"));

  if (job.status === "running" && job.latestAssistantText) {
    lines.push("", "Latest assistant text:", compactPreview(job.latestAssistantText, 1_000, 8));
  }

  if (job.status !== "running") {
    lines.push(
      "",
      includeFullOutput ? "Final output:" : "Final output preview:",
      job.finalOutput
        ? includeFullOutput
          ? truncateForTool(job.finalOutput)
          : compactPreview(job.finalOutput, 1_000, 8)
        : "(no final assistant output)",
    );
    if (!includeFullOutput && job.finalOutput && job.finalOutput.length > 1_000) {
      lines.push(`Use poll_agent({ id: "${job.id}", verbosity: "full" }) for the full final output.`);
    }
  }

  return lines.join("\n");
}

export function latestLogPreview<TLog extends PollLogEntryView>(job: Pick<PollJobView<TLog>, "logs">): string | undefined {
  for (let i = job.logs.length - 1; i >= 0; i--) {
    const entry = job.logs[i];
    if (entry.level === "assistant" && entry.text.startsWith("assistant:")) continue;
    return entry.text;
  }
  return undefined;
}

export function formatLogEntry(entry: PollLogEntryView): string {
  const time = new Date(entry.timestamp).toISOString().slice(11, 19);
  return `${entry.seq.toString().padStart(4, " ")} ${time} ${entry.level.padEnd(9)} ${entry.text}`;
}

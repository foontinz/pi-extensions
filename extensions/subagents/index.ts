/**
 * Background subagents for Pi.
 *
 * run_agent starts a separate `pi --mode json -p --no-session` process and
 * returns immediately with a job id. poll_agent reads the live event log and
 * final result later. stop_agent terminates a running job.
 */

import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { AssistantMessage, Message, ToolResultMessage } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const MAX_STORED_LOG_ENTRIES = 5_000;
const MAX_STORED_STDERR_CHARS = 100_000;
const MAX_PARTIAL_BUFFER_CHARS = 1_000_000;
const MAX_LOG_READ_BYTES = 1_000_000;
const MAX_RETAINED_FINISHED_JOBS = 50;
const DEFAULT_POLL_LOG_ENTRIES = 20;
const MAX_POLL_LOG_ENTRIES = 200;
const SUGGESTED_POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 60_000;
const FINISHED_STATUS_VISIBLE_MS = 15 * 1000;
const ASSISTANT_DELTA_LOG_INTERVAL_MS = 1_250;
const ASSISTANT_DELTA_LOG_CHARS = 1_200;
const TMUX_STATUS_INTERVAL_MS = 2_000;
const JOB_STORE_DIR = path.join(os.homedir(), ".pi", "agent", "subagents");
const JOBS_DIR = path.join(JOB_STORE_DIR, "jobs");
const LOGS_DIR = path.join(JOB_STORE_DIR, "logs");
const JOB_LOCK_STALE_MS = 5 * 60_000;
const JOB_LOCK_WAIT_MS = 2_000;
const WORKTREE_CONFIG_PATH = path.join(".pi", "worktree.env");

const execFileAsync = promisify(execFile);

type JobStatus = "running" | "completed" | "failed" | "cancelled";
type LogLevel = "info" | "assistant" | "tool" | "stdout" | "stderr" | "error";
type PollVerbosity = "summary" | "logs" | "full";

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface AgentLogEntry {
  seq: number;
  timestamp: number;
  level: LogLevel;
  text: string;
  eventType?: string;
}

interface WorktreeCopyObject {
  from: string;
  to?: string;
  optional?: boolean;
}

interface WorktreePostCopyObject {
  command: string;
  cwd?: string;
  optional?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
}

type WorktreeKeepMode = "never" | "always" | "onFailure";

interface WorktreeEnvConfig {
  enabled?: boolean;
  base?: string;
  copy?: Array<string | WorktreeCopyObject>;
  exclude?: string[];
  exclusions?: string[];
  postCopy?: Array<string | WorktreePostCopyObject>;
  postCopyScripts?: Array<string | WorktreePostCopyObject>;
  keepWorktree?: boolean | WorktreeKeepMode;
}

interface WorktreeScriptResult {
  command: string;
  cwd: string;
  optional: boolean;
  timeoutMs: number;
  stdout?: string;
  stderr?: string;
  failed?: boolean;
}

interface WorktreeInfo {
  root: string;
  tempParent: string;
  originalRoot: string;
  originalCwd: string;
  configPath?: string;
  base: string;
  copied: string[];
  postCopy: WorktreeScriptResult[];
  keepWorktree: WorktreeKeepMode;
  retained?: boolean;
}

interface AgentJob {
  id: string;
  label: string;
  agent?: string;
  agentSource?: "user" | "project" | "adhoc";
  task: string;
  cwd: string;
  sourceCwd: string;
  worktree?: WorktreeInfo;
  command: string;
  args: string[];
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  status: JobStatus;
  exitCode?: number;
  signal?: NodeJS.Signals;
  pid?: number;
  proc?: ChildProcess;
  messageCount: number;
  logs: AgentLogEntry[];
  nextSeq: number;
  stderr: string;
  stdoutBuffer: string;
  stderrBuffer: string;
  latestAssistantText: string;
  pendingAssistantDelta: string;
  lastAssistantDeltaLogAt: number;
  finalOutput?: string;
  stopReason?: string;
  errorMessage?: string;
  usage: UsageStats;
  tmpPromptDir?: string;
  tmpPromptPath?: string;
  timeout?: NodeJS.Timeout;
  timeoutAt?: number;
  killTimer?: NodeJS.Timeout;
  supervisor: "process" | "tmux";
  tmuxSession?: string;
  stdoutPath?: string;
  stderrPath?: string;
  exitCodePath?: string;
  stdoutOffset: number;
  stderrOffset: number;
  monitorTimer?: NodeJS.Timeout;
  stdoutDecoder?: StringDecoder;
  stderrDecoder?: StringDecoder;
  cleanupPending?: boolean;
  cleanupError?: string;
  waiters: Set<() => void>;
  closeWaiters: Set<() => void>;
}

interface PollDetails {
  id?: string;
  jobs?: Array<ReturnType<typeof summarizeJob>>;
  job?: ReturnType<typeof summarizeJob>;
  logs?: AgentLogEntry[];
  nextSeq?: number;
  finalOutput?: string;
  latestAssistantText?: string;
}

const jobs = new Map<string, AgentJob>();
let statusContext: ExtensionContext | undefined;
let statusRefreshTimer: NodeJS.Timeout | undefined;

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which markdown agent directories to use. Default: "user". Use "both" to include project-local .pi/agents.',
  default: "user",
});

const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
  description: "Optional Pi thinking level for the subagent process.",
});

const PollVerbositySchema = StringEnum(["summary", "logs", "full"] as const, {
  description:
    'How much poll_agent should return. Default "summary" is a few-line status. Use "logs" for recent summarized logs or "full" for final assistant output up to tool output limits.',
  default: "summary",
});

const RunAgentParams = Type.Object({
  task: Type.String({ description: "Task/prompt to send to the background subagent." }),
  agent: Type.Optional(
    Type.String({
      description:
        "Optional named markdown agent from ~/.pi/agent/agents/*.md or, if enabled, project .pi/agents/*.md.",
    }),
  ),
  label: Type.Optional(Type.String({ description: "Optional human-readable label for this background job." })),
  systemPrompt: Type.Optional(
    Type.String({ description: "Optional ad-hoc system prompt appended after any named agent prompt." }),
  ),
  model: Type.Optional(Type.String({ description: "Optional explicit model pattern/id. Omit unless the user specifically requested a model; omitted lets the child Pi use its normal/default model configuration." })),
  thinking: Type.Optional(ThinkingSchema),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional allowlist of active tools for the subagent, e.g. [\"read\",\"grep\",\"find\",\"ls\"]. Defaults to Pi's normal active tools.",
      maxItems: 64,
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for the subagent. Relative paths resolve from current cwd." })),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: `Kill the subagent after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS}. Use 0 to disable.`,
      minimum: 0,
      maximum: MAX_TIMEOUT_MS,
    }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
});

const PollAgentParams = Type.Object({
  id: Type.Optional(
    Type.String({ description: "Job id returned by run_agent. Omit to list known jobs and their statuses." }),
  ),
  sinceSeq: Type.Optional(
    Type.Integer({
      description: "Only return log entries with seq greater than this value. Use nextSeq from the previous poll.",
      minimum: 0,
    }),
  ),
  verbosity: Type.Optional(PollVerbositySchema),
  maxLogEntries: Type.Optional(
    Type.Integer({
      description: `Maximum log entries to return when verbosity is "logs" or "full". Default ${DEFAULT_POLL_LOG_ENTRIES}, max ${MAX_POLL_LOG_ENTRIES}.`,
      minimum: 1,
      maximum: MAX_POLL_LOG_ENTRIES,
    }),
  ),
  waitMs: Type.Optional(
    Type.Integer({
      description: `Long-poll up to this many milliseconds when the job is still running and no new logs are available. Max ${MAX_WAIT_MS}.`,
      minimum: 0,
      maximum: MAX_WAIT_MS,
    }),
  ),
});

const StopAgentParams = Type.Object({
  id: Type.String({ description: "Job id returned by run_agent." }),
  reason: Type.Optional(Type.String({ description: "Optional cancellation reason." })),
});

export default function subagentsExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    statusContext = ctx;
    loadPersistedJobs();
    refreshRunningTmuxJobs();
    scheduleRunningJobTimeouts();
    refreshSubagentStatus();
  });

  pi.registerTool({
    name: "run_agent",
    label: "Run Agent",
    description: [
      "Start a tmux-supervised background Pi subagent in a separate --no-session process and return immediately with a job id.",
      "Use poll_agent with that id to retrieve compact status; request summarized logs/full output only when needed.",
      "When started inside a git repo, the child runs in a temporary detached worktree; .pi/worktree.env controls copied files, post-copy setup scripts, and retention.",
      "Can run a named markdown agent or an ad-hoc subagent with optional systemPrompt/tools and an explicit model override only when requested.",
    ].join(" "),
    promptSnippet: "Start a non-blocking background Pi subagent job and return a job id for poll_agent.",
    promptGuidelines: [
      "Use run_agent for long-running or parallelizable investigation/implementation tasks that should not block the main agent turn.",
      "After run_agent returns an id, poll sparingly. Prefer poll_agent waitMs around 10000-30000 and avoid tight polling loops.",
      "Use poll_agent's default summary verbosity for routine checks; request verbosity \"logs\" or \"full\" only when needed.",
      "Remember run_agent uses a temporary git worktree when inside a repo; uncommitted/untracked files are visible only if copied by .pi/worktree.env, and dependencies may need postCopy setup.",
      "Use run_agent tools to restrict subagents to read-only tools when delegating review or reconnaissance tasks.",
      "Do not set the model parameter unless the user explicitly requests a specific model/provider; omit it to use the child Pi default and avoid provider/API-key mismatches.",
      "Subagents do not inherit the parent conversation; include all necessary context in the task, systemPrompt, named agent, files, or repo context.",
    ],
    parameters: RunAgentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.hasUI) statusContext = ctx;
      refreshSubagentStatus();
      const agentScope: AgentScope = params.agentScope ?? "user";
      const sourceCwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
      const discovery = discoverAgents(sourceCwd, agentScope);
      const agents = discovery.agents;
      const namedAgent = params.agent ? agents.find((agent) => agent.name === params.agent) : undefined;

      if (params.agent && !namedAgent) {
        const available = formatAgentList(agents);
        return {
          content: [
            {
              type: "text",
              text: `Unknown agent "${params.agent}". Available agents for scope "${agentScope}":\n${available}\n\nRun without agent for an ad-hoc subagent, or set agentScope to "both"/"project" if needed.`,
            },
          ],
          details: { availableAgents: agents.map((a) => ({ name: a.name, source: a.source, description: a.description })) },
        };
      }

      if (namedAgent?.source === "project") {
        if (!ctx.hasUI) {
          return {
            content: [
              {
                type: "text",
                text: "Canceled: project-local agents require interactive confirmation. Use agentScope: \"user\" or run from an interactive Pi session.",
              },
            ],
            details: { cancelled: true, reason: "project-agent-confirmation-required" },
          };
        }
        const ok = await ctx.ui.confirm(
          "Run project-local agent?",
          `Agent: ${namedAgent.name}\nSource: ${namedAgent.filePath}\n\nProject agents are repo-controlled prompts. Only continue for trusted repositories.`,
        );
        if (!ok) {
          return {
            content: [{ type: "text", text: "Canceled: project-local agent not approved." }],
            details: { cancelled: true },
          };
        }
      }

      const toolSelection = validateToolSelection(pi.getActiveTools(), params.tools ?? namedAgent?.tools);
      if (!toolSelection.ok) {
        return {
          content: [{ type: "text", text: toolSelection.message }],
          details: { requestedTools: toolSelection.requestedTools, activeTools: toolSelection.activeTools },
        };
      }

      const job = await startAgentJob(sourceCwd, params, namedAgent, toolSelection.tools, ctx);
      const details = summarizeJob(job);
      const text = formatRunAgentStartResult(job);

      return {
        content: [{ type: "text", text }],
        details,
      };
    },

    renderCall(args, theme) {
      const agent = args.agent ?? "adhoc";
      const task = args.task.length > 80 ? `${args.task.slice(0, 80)}…` : args.task;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("run_agent "))}${theme.fg("accent", agent)}\n  ${theme.fg("dim", task)}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as ReturnType<typeof summarizeJob> | undefined;
      const contentText = textContent(result.content);
      if (!details || typeof details.id !== "string") return new Text(contentText, 0, 0);
      return new Text(
        `${theme.fg("success", "↗")} ${theme.fg("toolTitle", theme.bold(details.id))} ${theme.fg("muted", details.status)}\n${theme.fg("dim", contentText)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "poll_agent",
    label: "Poll Agent",
    description:
      "Poll a background subagent started by run_agent. By default returns a compact few-line status. Set verbosity to \"logs\" for recent summarized logs or \"full\" to retrieve the final assistant output up to tool output limits. Omit id to list jobs.",
    promptSnippet: "Poll a background subagent's compact status and final result by job id.",
    promptGuidelines: [
      "Use poll_agent after run_agent. Pass sinceSeq from the previous poll's nextSeq to avoid rereading old events.",
      "Poll sparingly: if poll_agent reports status running, wait roughly 10-30 seconds before polling again, or pass waitMs around 10000-30000.",
      "Use poll_agent's default verbosity for routine status. Use verbosity \"logs\" only for debugging summarized events, and verbosity \"full\" only when the final output is needed.",
    ],
    parameters: PollAgentParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx?.hasUI) statusContext = ctx;
      loadPersistedJobs();
      refreshRunningTmuxJobs();
      retryPendingWorktreeCleanups();
      refreshSubagentStatus();
      if (!params.id) {
        const summaries = [...jobs.values()].map(summarizeJob).sort((a, b) => b.startedAt - a.startedAt);
        const text = summaries.length === 0
          ? "No background agent jobs are known in this Pi session."
          : summaries.map(formatJobSummaryLine).join("\n");
        return { content: [{ type: "text", text }], details: { jobs: summaries } satisfies PollDetails };
      }

      const job = jobs.get(params.id);
      if (!job) {
        const known = [...jobs.keys()].join(", ") || "none";
        return {
          content: [{ type: "text", text: `Unknown agent job id: ${params.id}. Known ids: ${known}` }],
          details: { id: params.id, jobs: [...jobs.values()].map(summarizeJob) } satisfies PollDetails,
        };
      }

      refreshTmuxJob(job);
      const sinceSeq = params.sinceSeq ?? 0;
      const verbosity: PollVerbosity = params.verbosity ?? "summary";
      const maxLogEntries = Math.min(params.maxLogEntries ?? DEFAULT_POLL_LOG_ENTRIES, MAX_POLL_LOG_ENTRIES);
      const waitMs = Math.min(params.waitMs ?? 0, MAX_WAIT_MS);

      if (verbosity !== "summary") flushAssistantDelta(job);
      if (waitMs > 0 && job.status === "running" && getLogsSince(job, sinceSeq, maxLogEntries).length === 0) {
        await waitForJobUpdate(job, waitMs, signal);
        refreshTmuxJob(job);
      }

      if (verbosity !== "summary") flushAssistantDelta(job);
      const logs = verbosity === "summary" ? [] : getLogsSince(job, sinceSeq, maxLogEntries);
      const nextSeq = job.nextSeq - 1;
      const summary = summarizeJob(job);
      const details: PollDetails = {
        id: job.id,
        job: summary,
        logs: verbosity === "summary" ? undefined : logs,
        nextSeq,
        latestAssistantText: job.latestAssistantText ? compactPreview(job.latestAssistantText, 600, 3) : undefined,
        finalOutput: job.finalOutput ? (verbosity === "full" ? truncateForTool(job.finalOutput) : compactPreview(job.finalOutput, 1_000, 6)) : undefined,
      };

      const text = verbosity === "summary"
        ? formatCompactPollResult(job, sinceSeq, nextSeq)
        : formatPollResult(job, logs, nextSeq, verbosity === "full");
      return {
        content: [{ type: "text", text: truncateForTool(text) }],
        details,
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("poll_agent "))}${theme.fg("accent", args.id ?? "list")}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as PollDetails | undefined;
      const contentText = textContent(result.content);
      if (!details?.job) return new Text(contentText, 0, 0);
      const color = details.job.status === "completed" ? "success" : details.job.status === "running" ? "warning" : "error";
      return new Text(`${theme.fg(color, details.job.status)} ${theme.fg("toolTitle", details.job.id)}\n${contentText}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "stop_agent",
    label: "Stop Agent",
    description: "Terminate a background subagent process started by run_agent.",
    promptSnippet: "Stop/cancel a running background subagent by job id.",
    promptGuidelines: ["Use stop_agent to cancel run_agent jobs that are no longer needed or appear stuck."],
    parameters: StopAgentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx?.hasUI) statusContext = ctx;
      loadPersistedJobs();
      const job = jobs.get(params.id);
      if (!job) {
        const known = [...jobs.keys()].join(", ") || "none";
        return { content: [{ type: "text", text: `Unknown agent job id: ${params.id}. Known ids: ${known}` }], details: {} };
      }

      refreshTmuxJob(job);
      if (job.status !== "running") {
        return {
          content: [{ type: "text", text: `Agent ${job.id} is already ${job.status}.` }],
          details: summarizeJob(job),
        };
      }

      const previousStatus = job.status;
      const stopped = terminateJob(job, params.reason ?? "cancelled by stop_agent");
      refreshSubagentStatus();
      const currentStatus = job.status as JobStatus;
      const text = stopped
        ? currentStatus === "cancelled"
          ? `Stopped agent ${job.id}.`
          : `Agent ${job.id} is ${currentStatus}; it appears to have finished before stop completed.`
        : `Failed to stop agent ${job.id}; it is still marked ${currentStatus}. Check logs and tmux session ${job.tmuxSession ?? "(unknown)"}.`;
      return {
        content: [{ type: "text", text: previousStatus === "running" ? text : `Agent ${job.id} is already ${currentStatus}.` }],
        details: summarizeJob(job),
      };
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Subagents are supervised by tmux so they intentionally survive /reload,
    // session switches, and parent Pi exits. Use stop_agent to terminate them.
    for (const job of jobs.values()) {
      if (job.monitorTimer) clearInterval(job.monitorTimer);
      job.monitorTimer = undefined;
    }
    clearStatusRefreshTimer();
    if (ctx.hasUI) ctx.ui.setStatus("subagents", undefined);
    if (ctx.hasUI) ctx.ui.setWidget("subagents", undefined);
    if (statusContext === ctx) statusContext = undefined;
  });
}

function formatRunAgentStartResult(job: AgentJob): string {
  const lines = [
    job.status === "running" ? `Started background agent ${job.id}.` : `Failed to start background agent ${job.id}.`,
    `Status: ${job.status}`,
    `Label: ${job.label}`,
    `Supervisor: ${job.supervisor}${job.tmuxSession ? ` (${job.tmuxSession})` : ""}`,
  ];
  if (job.status === "running") {
    lines.push(job.tmuxSession ? `Attach: tmux attach -t ${job.tmuxSession}` : `PID: ${job.pid ?? "(spawn pending)"}`);
  } else if (job.errorMessage) {
    lines.push(`Error: ${compactPreview(job.errorMessage, 500, 3)}`);
  }
  lines.push(`CWD: ${job.cwd}`, "", `Poll later with: poll_agent({ id: "${job.id}", sinceSeq: 0, waitMs: ${SUGGESTED_POLL_INTERVAL_MS} })`);
  return lines.join("\n");
}

function validateToolSelection(
  activeTools: string[],
  requestedTools: string[] | undefined,
): { ok: true; tools: string[]; activeTools: string[]; requestedTools: string[] } | { ok: false; message: string; activeTools: string[]; requestedTools: string[] } {
  const active = [...new Set(activeTools)].sort();
  const requested = [...new Set(requestedTools ?? active)].sort();
  const activeSet = new Set(active);
  const disallowed = requested.filter((tool) => !activeSet.has(tool));
  if (disallowed.length > 0) {
    return {
      ok: false,
      activeTools: active,
      requestedTools: requested,
      message: `Refusing to start subagent with tools not active in the parent session: ${disallowed.join(", ")}. Active tools: ${active.join(", ") || "none"}.`,
    };
  }
  return { ok: true, tools: requested, activeTools: active, requestedTools: requested };
}

async function startAgentJob(
  sourceCwd: string,
  params: Static<typeof RunAgentParams>,
  agent: AgentConfig | undefined,
  effectiveTools: string[],
  ctx: ExtensionContext,
): Promise<AgentJob> {
  const id = createJobId();
  let worktreePrep: { cwd: string; worktree?: WorktreeInfo };
  try {
    worktreePrep = await prepareWorktreeForSpawn(sourceCwd, id, ctx);
  } catch (error) {
    return createFailedPreStartJob(id, sourceCwd, params, agent, error instanceof Error ? error.message : String(error));
  }
  const cwd = worktreePrep.cwd;
  const label = params.label?.trim() || agent?.name || `agent-${id}`;
  const promptParts = [agent?.systemPrompt, params.systemPrompt].filter((part): part is string => Boolean(part?.trim()));
  const model = params.model ?? agent?.model;
  const thinking = params.thinking ?? agent?.thinking;
  const timeoutMs = params.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : params.timeoutMs;

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (effectiveTools.length > 0) args.push("--tools", effectiveTools.join(","));
  else args.push("--no-tools");

  let tmpPromptDir: string | undefined;
  let tmpPromptPath: string | undefined;
  try {
    if (promptParts.length > 0) {
      const tmp = await writePromptToTempFile(id, promptParts.join("\n\n"));
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }
  } catch (error) {
    cleanupPromptFiles(tmpPromptPath, tmpPromptDir);
    cleanupWorktreeInfo(worktreePrep.worktree);
    throw error;
  }

  args.push(`Task: ${params.task}`);
  const invocation = getPiInvocation(args);

  const job: AgentJob = {
    id,
    label,
    agent: agent?.name,
    agentSource: agent?.source ?? "adhoc",
    task: params.task,
    cwd,
    sourceCwd,
    worktree: worktreePrep.worktree,
    command: invocation.command,
    args: invocation.args,
    startedAt: Date.now(),
    updatedAt: Date.now(),
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
    tmpPromptDir,
    tmpPromptPath,
    timeoutAt: timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : undefined,
    supervisor: "tmux",
    tmuxSession: tmuxSessionName(id),
    stdoutPath: path.join(LOGS_DIR, `${id}.stdout.jsonl`),
    stderrPath: path.join(LOGS_DIR, `${id}.stderr.log`),
    exitCodePath: path.join(LOGS_DIR, `${id}.exit`),
    stdoutOffset: 0,
    stderrOffset: 0,
    waiters: new Set(),
    closeWaiters: new Set(),
  };

  jobs.set(job.id, job);
  if (job.worktree) {
    addLog(job, "info", `created git worktree ${job.worktree.root} from ${job.worktree.base}`, "worktree");
    if (job.worktree.copied.length > 0) {
      addLog(job, "info", `copied into worktree: ${job.worktree.copied.join(", ")}`, "worktree");
    }
    for (const script of job.worktree.postCopy) {
      const output = [script.stdout, script.stderr].filter(Boolean).join(" | ");
      addLog(
        job,
        script.failed ? "error" : "info",
        `postCopy ${script.failed ? "failed (optional)" : "ok"}: ${script.command}${output ? ` (${truncateOneLine(output, 300)})` : ""}`,
        "worktree",
      );
    }
    if (job.worktree.keepWorktree !== "never") {
      addLog(job, "info", `worktree retention mode: ${job.worktree.keepWorktree}`, "worktree");
    }
  }
  addLog(job, "info", `starting: ${displayCommand(invocation.command, invocation.args)} (cwd: ${cwd})`, "start");

  try {
    ensureJobStoreDirs();
    fs.writeFileSync(job.stdoutPath!, "", "utf-8");
    fs.writeFileSync(job.stderrPath!, "", "utf-8");
    fs.rmSync(job.exitCodePath!, { force: true });

    const shell = "/bin/sh";
    const commandLine = displayCommand(invocation.command, invocation.args);
    const script = [
      `${commandLine} > ${shellQuote(job.stdoutPath!)} 2> ${shellQuote(job.stderrPath!)}`,
      `code=$?`,
      `printf '%s\\n' "$code" > ${shellQuote(job.exitCodePath!)}`,
      `exit "$code"`,
    ].join("; ");

    await execFileAsync("tmux", ["new-session", "-d", "-s", job.tmuxSession!, "-c", cwd, shell, "-c", script]);
    addLog(job, "info", `started tmux session ${job.tmuxSession}; attach: tmux attach -t ${job.tmuxSession}`, "start");
    persistJob(job);
    startTmuxMonitor(job);

    scheduleJobTimeout(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finalizeJob(job, "failed", undefined, undefined, `failed to start tmux subagent: ${message}`);
  }

  return job;
}

function createFailedPreStartJob(
  id: string,
  sourceCwd: string,
  params: Static<typeof RunAgentParams>,
  agent: AgentConfig | undefined,
  errorMessage: string,
): AgentJob {
  const now = Date.now();
  const job: AgentJob = {
    id,
    label: params.label?.trim() || agent?.name || `agent-${id}`,
    agent: agent?.name,
    agentSource: agent?.source ?? "adhoc",
    task: params.task,
    cwd: sourceCwd,
    sourceCwd,
    command: "",
    args: [],
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    status: "failed",
    messageCount: 0,
    logs: [],
    nextSeq: 1,
    stderr: "",
    stdoutBuffer: "",
    stderrBuffer: "",
    latestAssistantText: "",
    pendingAssistantDelta: "",
    lastAssistantDeltaLogAt: 0,
    errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    supervisor: "tmux",
    tmuxSession: tmuxSessionName(id),
    stdoutPath: path.join(LOGS_DIR, `${id}.stdout.jsonl`),
    stderrPath: path.join(LOGS_DIR, `${id}.stderr.log`),
    exitCodePath: path.join(LOGS_DIR, `${id}.exit`),
    stdoutOffset: 0,
    stderrOffset: 0,
    waiters: new Set(),
    closeWaiters: new Set(),
  };
  jobs.set(job.id, job);
  addLog(job, "error", `failed before launch: ${errorMessage}`, "start");
  persistJob(job);
  return job;
}

function ensureJobStoreDirs(): void {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function jobStatePath(id: string): string {
  return path.join(JOBS_DIR, `${id}.json`);
}

function tmuxSessionName(id: string): string {
  return `pi-${id}`.replace(/[^A-Za-z0-9_.:-]/g, "-");
}

function persistJob(job: AgentJob): void {
  try {
    ensureJobStoreDirs();
    withJobFileLock(job.id, () => {
      const file = jobStatePath(job.id);
      const current = readPersistedJobFile(file);
      const merged = mergeJobSnapshots(current, toPersistableJob(job));
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        throw error;
      }
    });
  } catch {
    // Best effort: subagents should keep running even if metadata persistence fails.
  }
}

function toPersistableJob(job: AgentJob): Partial<AgentJob> {
  return {
    ...job,
    proc: undefined,
    timeout: undefined,
    killTimer: undefined,
    monitorTimer: undefined,
    stdoutDecoder: undefined,
    stderrDecoder: undefined,
    waiters: undefined as unknown as Set<() => void>,
    closeWaiters: undefined as unknown as Set<() => void>,
  };
}

function readPersistedJobFile(file: string): Partial<AgentJob> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<AgentJob>;
  } catch {
    return undefined;
  }
}

function mergeJobSnapshots(current: Partial<AgentJob> | undefined, next: Partial<AgentJob>): Partial<AgentJob> {
  if (!current?.id) return next;
  const merged: Partial<AgentJob> = { ...current, ...next };
  merged.logs = mergeLogEntries(current.logs, next.logs);
  merged.nextSeq = Math.max(current.nextSeq ?? 1, next.nextSeq ?? 1, (merged.logs?.at(-1)?.seq ?? 0) + 1);
  merged.stdoutOffset = Math.max(current.stdoutOffset ?? 0, next.stdoutOffset ?? 0);
  merged.stderrOffset = Math.max(current.stderrOffset ?? 0, next.stderrOffset ?? 0);

  const currentTerminal = current.status && current.status !== "running";
  const nextTerminal = next.status && next.status !== "running";
  if (currentTerminal && !nextTerminal) {
    merged.status = current.status;
    merged.finishedAt = current.finishedAt;
    merged.exitCode = current.exitCode;
    merged.signal = current.signal;
    merged.errorMessage = current.errorMessage;
    merged.finalOutput = current.finalOutput;
  } else if (currentTerminal && nextTerminal && (current.updatedAt ?? 0) > (next.updatedAt ?? 0)) {
    merged.status = current.status;
    merged.finishedAt = current.finishedAt;
    merged.exitCode = current.exitCode;
    merged.signal = current.signal;
    merged.errorMessage = current.errorMessage;
    merged.finalOutput = current.finalOutput;
  }
  merged.updatedAt = Math.max(current.updatedAt ?? 0, next.updatedAt ?? 0);
  return merged;
}

function mergeLogEntries(a: AgentLogEntry[] | undefined, b: AgentLogEntry[] | undefined): AgentLogEntry[] {
  const byKey = new Map<string, AgentLogEntry>();
  for (const entry of [...(a ?? []), ...(b ?? [])]) {
    if (!isValidLogEntry(entry)) continue;
    byKey.set(`${entry.seq}:${entry.timestamp}:${entry.level}:${entry.eventType ?? ""}:${entry.text}`, entry);
  }
  return [...byKey.values()].sort((x, y) => x.seq - y.seq).slice(-MAX_STORED_LOG_ENTRIES);
}

function isValidLogEntry(entry: unknown): entry is AgentLogEntry {
  return Boolean(entry && typeof entry === "object" && typeof (entry as AgentLogEntry).seq === "number" && typeof (entry as AgentLogEntry).timestamp === "number" && typeof (entry as AgentLogEntry).level === "string" && typeof (entry as AgentLogEntry).text === "string");
}

function withJobFileLock<T>(jobId: string, action: () => T): T {
  const lockPath = `${jobStatePath(jobId)}.lock`;
  const started = Date.now();
  while (true) {
    let fd: number | undefined;
    let acquired = false;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      acquired = true;
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, "utf-8");
      return action();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (acquired || code !== "EEXIST") throw error;
      maybeRemoveStaleLock(lockPath);
      if (Date.now() - started > JOB_LOCK_WAIT_MS) throw error;
      sleepSync(25);
      continue;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      if (acquired) {
        try { fs.rmSync(lockPath, { force: true }); } catch {}
      }
    }
  }
}

function maybeRemoveStaleLock(lockPath: string): void {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8").trim().split(/\r?\n/);
    const pid = Number.parseInt(raw[0] ?? "", 10);
    const timestamp = Number.parseInt(raw[1] ?? "", 10);
    if (!Number.isFinite(pid) || !Number.isFinite(timestamp)) return;
    if (Date.now() - timestamp < JOB_LOCK_STALE_MS) return;
    if (isProcessAlive(pid)) return;
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Ignore: another process may have removed/recreated the lock.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadPersistedJobs(): void {
  try {
    ensureJobStoreDirs();
  } catch {
    return;
  }

  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(JOBS_DIR);
  } catch {
    return;
  }

  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(JOBS_DIR, fileName), "utf-8");
      const parsed = JSON.parse(raw) as Partial<AgentJob> & { id?: string };
      const job = normalizePersistedJob(parsed, fileName);
      if (!job) continue;
      const existing = jobs.get(job.id);
      if (existing) {
        mergePersistedIntoLiveJob(existing, job);
        if (existing.status === "running") startTmuxMonitor(existing);
        if (existing.cleanupPending) void retryWorktreeCleanup(existing);
        continue;
      }
      jobs.set(job.id, job);
      if (job.status === "running") startTmuxMonitor(job);
      if (job.cleanupPending) void retryWorktreeCleanup(job);
      if (job.status !== parsed.status || job.errorMessage !== parsed.errorMessage) persistJob(job);
    } catch {
      // Skip only the corrupt/unreadable job file; other jobs may still be valid.
      continue;
    }
  }
  pruneFinishedJobs();
}

function normalizePersistedJob(parsed: Partial<AgentJob> & { id?: string }, fileName: string): AgentJob | undefined {
  if (!parsed.id || !/^agent_[A-Za-z0-9_]+$/.test(parsed.id)) return undefined;
  if (fileName !== `${parsed.id}.json`) return undefined;
  const status = parsed.status === "running" || parsed.status === "completed" || parsed.status === "failed" || parsed.status === "cancelled" ? parsed.status : "failed";
  const now = Date.now();
  const job = parsed as AgentJob;
  job.id = parsed.id;
  job.label = typeof job.label === "string" ? job.label : job.id;
  job.task = typeof job.task === "string" ? job.task : "";
  job.cwd = typeof job.cwd === "string" ? job.cwd : process.cwd();
  job.sourceCwd = typeof job.sourceCwd === "string" ? job.sourceCwd : job.cwd;
  job.command = typeof job.command === "string" ? job.command : "";
  job.args = Array.isArray(job.args) ? job.args.filter((arg) => typeof arg === "string") : [];
  job.startedAt = typeof job.startedAt === "number" ? job.startedAt : now;
  job.updatedAt = typeof job.updatedAt === "number" ? job.updatedAt : now;
  job.status = status;
  job.finishedAt = typeof job.finishedAt === "number" ? job.finishedAt : status === "running" ? undefined : now;
  job.proc = undefined;
  job.timeout = undefined;
  job.killTimer = undefined;
  job.monitorTimer = undefined;
  job.stdoutDecoder = undefined;
  job.stderrDecoder = undefined;
  job.waiters = new Set();
  job.closeWaiters = new Set();
  job.logs = Array.isArray(job.logs) ? job.logs.filter(isValidLogEntry).slice(-MAX_STORED_LOG_ENTRIES) : [];
  job.nextSeq = typeof job.nextSeq === "number" ? Math.max(job.nextSeq, (job.logs.at(-1)?.seq ?? 0) + 1) : job.logs.length + 1;
  job.stderr = typeof job.stderr === "string" ? job.stderr : "";
  job.stdoutBuffer = typeof job.stdoutBuffer === "string" ? job.stdoutBuffer : "";
  job.stderrBuffer = typeof job.stderrBuffer === "string" ? job.stderrBuffer : "";
  job.pendingAssistantDelta = typeof job.pendingAssistantDelta === "string" ? job.pendingAssistantDelta : "";
  job.latestAssistantText = typeof job.latestAssistantText === "string" ? job.latestAssistantText : "";
  job.usage = job.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
  if (job.supervisor === "process" && job.status === "running") {
    job.errorMessage = job.errorMessage ?? "process-supervised job cannot be reattached after reload";
    job.status = "failed";
    job.finishedAt = job.finishedAt ?? now;
  } else {
    job.supervisor = job.supervisor ?? "tmux";
  }
  job.tmuxSession = typeof job.tmuxSession === "string" ? job.tmuxSession : tmuxSessionName(job.id);
  job.stdoutPath = normalizeStorePath(job.stdoutPath, path.join(LOGS_DIR, `${job.id}.stdout.jsonl`));
  job.stderrPath = normalizeStorePath(job.stderrPath, path.join(LOGS_DIR, `${job.id}.stderr.log`));
  job.exitCodePath = normalizeStorePath(job.exitCodePath, path.join(LOGS_DIR, `${job.id}.exit`));
  job.stdoutOffset = typeof job.stdoutOffset === "number" ? Math.max(0, job.stdoutOffset) : inferExistingOffset(job.stdoutPath, job.logs.length > 0);
  job.stderrOffset = typeof job.stderrOffset === "number" ? Math.max(0, job.stderrOffset) : inferExistingOffset(job.stderrPath, job.logs.length > 0);
  job.cleanupPending = Boolean(job.cleanupPending);
  return job;
}

function normalizeStorePath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const resolved = path.resolve(value);
  const relative = path.relative(JOB_STORE_DIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return fallback;
  return resolved;
}

function mergePersistedIntoLiveJob(live: AgentJob, persisted: AgentJob): void {
  const timeout = live.timeout;
  const monitorTimer = live.monitorTimer;
  const waiters = live.waiters;
  const closeWaiters = live.closeWaiters;
  const merged = mergeJobSnapshots(toPersistableJob(live), toPersistableJob(persisted));
  Object.assign(live, merged);
  live.proc = undefined;
  live.timeout = timeout;
  live.killTimer = undefined;
  live.monitorTimer = monitorTimer;
  live.stdoutDecoder = undefined;
  live.stderrDecoder = undefined;
  live.waiters = waiters ?? new Set();
  live.closeWaiters = closeWaiters ?? new Set();
}

function inferExistingOffset(filePath: string | undefined, hasParsedLogs: boolean): number {
  if (!filePath || !hasParsedLogs) return 0;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function scheduleRunningJobTimeouts(): void {
  for (const job of jobs.values()) {
    if (job.status === "running") scheduleJobTimeout(job);
  }
}

function scheduleJobTimeout(job: AgentJob): void {
  if (job.timeout || job.status !== "running" || !job.timeoutAt) return;
  const remaining = job.timeoutAt - Date.now();
  const timeoutReason = `timeout at ${new Date(job.timeoutAt).toISOString()}`;
  if (remaining <= 0) {
    refreshTmuxJob(job);
    if (job.status === "running") terminateJob(job, timeoutReason);
    return;
  }
  job.timeout = setTimeout(() => {
    job.timeout = undefined;
    refreshTmuxJob(job);
    if (job.status === "running") terminateJob(job, timeoutReason);
  }, remaining);
  job.timeout.unref?.();
}

function startTmuxMonitor(job: AgentJob): void {
  if (job.supervisor !== "tmux" || job.monitorTimer || job.status !== "running") return;
  job.monitorTimer = setInterval(() => {
    refreshTmuxJob(job);
    refreshSubagentStatus();
  }, TMUX_STATUS_INTERVAL_MS);
  job.monitorTimer.unref?.();
}

function refreshRunningTmuxJobs(): void {
  for (const job of jobs.values()) refreshTmuxJob(job);
}

function refreshTmuxJob(job: AgentJob): void {
  if (job.supervisor !== "tmux") return;
  refreshTmuxJobOutput(job);
  if (job.status !== "running") return;

  const exitCode = readExitCode(job.exitCodePath);
  if (exitCode !== undefined) {
    const inferredStatus = exitCode === 0 && job.stopReason !== "error" && job.stopReason !== "aborted" ? "completed" : "failed";
    finalizeJob(job, inferredStatus, exitCode, undefined);
    return;
  }

  startTmuxMonitor(job);
  if (!isTmuxAvailable()) {
    if (!latestLogPreview(job)?.includes("tmux unavailable")) addLog(job, "error", "tmux unavailable; cannot refresh subagent status", "tmux");
    return;
  }
  if (tmuxSessionExists(job.tmuxSession)) return;

  finalizeJob(job, "failed", undefined, undefined, "tmux session ended before writing exit code");
}

function refreshTmuxJobOutput(job: AgentJob): void {
  if (job.stdoutPath) {
    const result = readFileFromOffset(job.stdoutPath, job.stdoutOffset);
    if (result.buffer.length > 0) {
      job.stdoutDecoder ??= new StringDecoder("utf8");
      processStdout(job, job.stdoutDecoder.write(result.buffer));
    }
    job.stdoutOffset = result.offset;
  }
  if (job.stderrPath) {
    const result = readFileFromOffset(job.stderrPath, job.stderrOffset);
    if (result.buffer.length > 0) {
      job.stderrDecoder ??= new StringDecoder("utf8");
      processStderr(job, job.stderrDecoder.write(result.buffer));
    }
    job.stderrOffset = result.offset;
  }
  persistJob(job);
}

function readFileFromOffset(filePath: string, offset: number): { buffer: Buffer; offset: number } {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.min(offset, stat.size);
    if (stat.size <= start) return { buffer: Buffer.alloc(0), offset: start };
    const fd = fs.openSync(filePath, "r");
    try {
      const length = Math.min(stat.size - start, MAX_LOG_READ_BYTES);
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
      return { buffer: buffer.subarray(0, bytesRead), offset: start + bytesRead };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { buffer: Buffer.alloc(0), offset };
  }
}

function isTmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function tmuxSessionExists(sessionName: string | undefined): boolean {
  if (!sessionName) return false;
  try {
    execFileSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readExitCode(filePath: string | undefined): number | undefined {
  if (!filePath) return undefined;
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return undefined;
    const code = Number.parseInt(raw, 10);
    return Number.isFinite(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function processStdout(job: AgentJob, chunk: string): void {
  job.stdoutBuffer += chunk;
  if (job.stdoutBuffer.length > MAX_PARTIAL_BUFFER_CHARS) {
    addLog(job, "error", `stdout partial JSON line exceeded ${MAX_PARTIAL_BUFFER_CHARS} chars; dropping buffered partial output`, "stdout");
    job.stdoutBuffer = job.stdoutBuffer.slice(-MAX_PARTIAL_BUFFER_CHARS / 2);
  }
  const lines = job.stdoutBuffer.split("\n");
  job.stdoutBuffer = lines.pop() ?? "";
  for (const line of lines) processJsonLine(job, line);
}

function processStderr(job: AgentJob, chunk: string): void {
  job.stderr = appendCappedText(job.stderr, chunk, MAX_STORED_STDERR_CHARS);
  job.stderrBuffer = (job.stderrBuffer ?? "") + chunk;
  if (job.stderrBuffer.length > MAX_PARTIAL_BUFFER_CHARS) {
    addLog(job, "error", `stderr partial line exceeded ${MAX_PARTIAL_BUFFER_CHARS} chars; dropping buffered partial output`, "stderr");
    job.stderrBuffer = job.stderrBuffer.slice(-MAX_PARTIAL_BUFFER_CHARS / 2);
  }
  const lines = job.stderrBuffer.split(/\r?\n/);
  job.stderrBuffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim()) addLog(job, "stderr", line, "stderr");
  }
}

function processJsonLine(job: AgentJob, line: string): void {
  if (!line.trim()) return;
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    addLog(job, "stdout", line, "stdout");
    return;
  }
  processEvent(job, event);
}

function processEvent(job: AgentJob, event: any): void {
  switch (event.type) {
    case "session": {
      addLog(job, "info", `session ${event.id ?? "unknown"}`, "session");
      break;
    }
    case "agent_start": {
      addLog(job, "info", "agent started", event.type);
      break;
    }
    case "agent_end": {
      addLog(job, "info", "agent ended", event.type);
      break;
    }
    case "turn_start": {
      addLog(job, "info", "turn started", event.type);
      break;
    }
    case "turn_end": {
      // message_end carries the assistant message and usage; avoid double-counting here.
      if (event.message?.role === "assistant") {
        const text = getAssistantText(event.message as AssistantMessage);
        if (text) job.latestAssistantText = text;
      }
      addLog(job, "info", "turn ended", event.type);
      break;
    }
    case "message_update": {
      if (event.message?.role === "assistant") {
        job.latestAssistantText = getAssistantText(event.message as AssistantMessage) || job.latestAssistantText;
        const msgEvent = event.assistantMessageEvent;
        if (msgEvent?.type === "text_delta" && typeof msgEvent.delta === "string") {
          recordAssistantDelta(job, msgEvent.delta);
        } else {
          touchJob(job);
        }
      }
      break;
    }
    case "message_end": {
      if (event.message) {
        const msg = event.message as Message;
        job.messageCount++;
        if (msg.role === "assistant") {
          flushAssistantDelta(job);
          updateFromAssistantMessage(job, msg);
          const chars = getAssistantText(msg).length;
          addLog(job, "assistant", `assistant message complete (${chars} chars, stopReason: ${msg.stopReason})`, event.type);
        } else if (msg.role === "toolResult") {
          // tool_execution_end already logs current Pi tool results; keep messageCount
          // without emitting a duplicate log entry. Older JSON streams can still use
          // tool_result_end below.
          touchJob(job);
        }
      }
      break;
    }
    case "tool_execution_start": {
      addLog(job, "tool", `→ ${formatToolCall(event.toolName, event.args)}`, event.type);
      break;
    }
    case "tool_execution_update": {
      const preview = previewToolResult(event.partialResult);
      if (preview) addLog(job, "tool", `↻ ${event.toolName}: ${preview}`, event.type);
      else touchJob(job);
      break;
    }
    case "tool_execution_end": {
      addLog(job, event.isError ? "error" : "tool", `${event.isError ? "✗" : "✓"} ${event.toolName}: ${previewToolResult(event.result) || "done"}`, event.type);
      break;
    }
    case "auto_retry_start": {
      addLog(job, "error", `auto retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`, event.type);
      break;
    }
    case "auto_retry_end": {
      addLog(job, event.success ? "info" : "error", `auto retry ${event.success ? "succeeded" : "failed"}`, event.type);
      break;
    }
    case "compaction_start":
    case "compaction_end": {
      addLog(job, "info", event.type, event.type);
      break;
    }
    case "tool_result_end": {
      // Older Pi JSON mode emitted this event. Keep compatibility.
      if (event.message) {
        const msg = event.message as ToolResultMessage;
        job.messageCount++;
        addLog(job, msg.isError ? "error" : "tool", formatToolResultMessage(msg), event.type);
      }
      break;
    }
    default: {
      touchJob(job);
      break;
    }
  }
}

function updateFromAssistantMessage(job: AgentJob, msg: AssistantMessage): void {
  job.latestAssistantText = getAssistantText(msg) || job.latestAssistantText;
  if (job.latestAssistantText) job.finalOutput = job.latestAssistantText;
  job.stopReason = msg.stopReason;
  job.errorMessage = msg.errorMessage;
  if (msg.usage) {
    job.usage.turns += 1;
    job.usage.input += msg.usage.input || 0;
    job.usage.output += msg.usage.output || 0;
    job.usage.cacheRead += msg.usage.cacheRead || 0;
    job.usage.cacheWrite += msg.usage.cacheWrite || 0;
    job.usage.cost += msg.usage.cost?.total || 0;
    job.usage.contextTokens = msg.usage.totalTokens || job.usage.contextTokens;
  }
  touchJob(job);
}

function recordAssistantDelta(job: AgentJob, delta: string): void {
  job.pendingAssistantDelta += delta;
  const now = Date.now();
  if (
    job.pendingAssistantDelta.length >= ASSISTANT_DELTA_LOG_CHARS ||
    job.lastAssistantDeltaLogAt === 0 ||
    now - job.lastAssistantDeltaLogAt >= ASSISTANT_DELTA_LOG_INTERVAL_MS
  ) {
    flushAssistantDelta(job);
  } else {
    touchJob(job);
  }
}

function flushAssistantDelta(job: AgentJob): void {
  const text = job.pendingAssistantDelta;
  if (!text) return;
  job.pendingAssistantDelta = "";
  job.lastAssistantDeltaLogAt = Date.now();
  addLog(job, "assistant", `assistant: ${squashWhitespace(text)}`, "message_update");
}

function addLog(job: AgentJob, level: LogLevel, text: string, eventType?: string): void {
  const entry: AgentLogEntry = {
    seq: job.nextSeq++,
    timestamp: Date.now(),
    level,
    text: truncateOneLine(text, 1_500),
    eventType,
  };
  job.logs.push(entry);
  if (job.logs.length > MAX_STORED_LOG_ENTRIES) {
    job.logs.splice(0, job.logs.length - MAX_STORED_LOG_ENTRIES);
  }
  job.updatedAt = Date.now();
  persistJob(job);
  notifyWaiters(job);
  refreshSubagentStatus();
}

function touchJob(job: AgentJob): void {
  job.updatedAt = Date.now();
  notifyWaiters(job);
  refreshSubagentStatus();
}

function notifyWaiters(job: AgentJob): void {
  if (job.waiters.size === 0) return;
  const waiters = [...job.waiters];
  job.waiters.clear();
  for (const wake of waiters) wake();
}

function refreshSubagentStatus(): void {
  clearStatusRefreshTimer();

  const ctx = statusContext;
  if (!ctx?.hasUI) return;

  const now = Date.now();
  const visibleJobs = [...jobs.values()]
    .filter((job) => job.status === "running" || now - (job.finishedAt ?? job.updatedAt) < FINISHED_STATUS_VISIBLE_MS)
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));

  if (visibleJobs.length === 0) {
    ctx.ui.setStatus("subagents", undefined);
    ctx.ui.setWidget("subagents", undefined);
    return;
  }

  const runningCount = visibleJobs.filter((job) => job.status === "running").length;
  ctx.ui.setStatus("subagents", runningCount > 0 ? `agents: ${runningCount} running` : `agents: ${visibleJobs.length} recent`);
  ctx.ui.setWidget("subagents", formatStatusTable(visibleJobs, ctx), { placement: "belowEditor" });
  scheduleFinishedStatusExpiry(visibleJobs, now);
}

function scheduleFinishedStatusExpiry(visibleJobs: AgentJob[], now: number): void {
  const nextExpiryAt = visibleJobs
    .filter((job) => job.status !== "running")
    .map((job) => (job.finishedAt ?? job.updatedAt) + FINISHED_STATUS_VISIBLE_MS)
    .reduce<number | undefined>((earliest, expiryAt) => earliest === undefined ? expiryAt : Math.min(earliest, expiryAt), undefined);
  if (nextExpiryAt === undefined) return;

  statusRefreshTimer = setTimeout(refreshSubagentStatus, Math.max(0, nextExpiryAt - now) + 100);
  statusRefreshTimer.unref?.();
}

function clearStatusRefreshTimer(): void {
  if (!statusRefreshTimer) return;
  clearTimeout(statusRefreshTimer);
  statusRefreshTimer = undefined;
}

function formatStatusTable(jobs: AgentJob[], ctx: ExtensionContext): string[] {
  const visibleRows = jobs.slice(0, 8);
  const labelWidth = Math.min(20, Math.max("agent".length, ...visibleRows.map((job) => compactStatusLabel(job).length)));
  const statusWidth = Math.max("status".length, ...visibleRows.map((job) => job.status.length));
  const timeWidth = "start".length;
  const durationWidth = "runtime".length;
  const header = `${padCell("agent", labelWidth)}  ${padCell("start", timeWidth)}  ${padCell("runtime", durationWidth)}  ${padCell("status", statusWidth)}  state`;
  const separator = `${"─".repeat(labelWidth)}  ${"─".repeat(timeWidth)}  ${"─".repeat(durationWidth)}  ${"─".repeat(statusWidth)}  ${"─".repeat(32)}`;
  const rows = visibleRows.map((job) => formatStatusRow(job, ctx, labelWidth, timeWidth, durationWidth, statusWidth));
  if (jobs.length > visibleRows.length) rows.push(ctx.ui.theme.fg("dim", `… ${jobs.length - visibleRows.length} more`));
  return [ctx.ui.theme.fg("muted", "subagents"), ctx.ui.theme.fg("dim", header), ctx.ui.theme.fg("dim", separator), ...rows];
}

function formatStatusRow(job: AgentJob, ctx: ExtensionContext, labelWidth: number, timeWidth: number, durationWidth: number, statusWidth: number): string {
  const color = job.status === "completed" ? "success" : job.status === "running" ? "accent" : job.status === "cancelled" ? "muted" : "warning";
  const label = ctx.ui.theme.fg("muted", padCell(compactStatusLabel(job), labelWidth));
  const started = ctx.ui.theme.fg("muted", padCell(formatStatusTime(job.startedAt), timeWidth));
  const duration = ctx.ui.theme.fg("muted", padCell(formatJobRuntime(job), durationWidth));
  const status = ctx.ui.theme.fg(color, padCell(job.status, statusWidth));
  const state = ctx.ui.theme.fg(color, compactJobState(job));
  return `${label}  ${started}  ${duration}  ${status}  ${state}`;
}

function formatStatusTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function formatJobRuntime(job: AgentJob): string {
  const elapsedMs = (job.finishedAt ?? Date.now()) - job.startedAt;
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}:${remainingMinutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function padCell(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function compactStatusLabel(job: AgentJob): string {
  const raw = (job.label || job.agent || job.id).replace(/\s+/g, "-");
  return raw.length <= 20 ? raw : `${raw.slice(0, 19)}…`;
}

function compactJobState(job: AgentJob): string {
  const statusWord = job.status === "completed" ? "done" : job.status === "cancelled" ? "stopped" : job.status;
  const fallback = job.status === "running"
    ? ["background", "task", "active"]
    : job.status === "completed"
      ? ["final", "output", "ready"]
      : job.status === "cancelled"
        ? ["by", "request", "stopped"]
        : ["check", "logs", "failed"];
  const source = job.status === "running"
    ? job.latestAssistantText || latestLogPreview(job)
    : job.status === "completed"
      ? job.finalOutput
      : job.errorMessage || job.stopReason || latestLogPreview(job);
  const words = extractStatusWords(source).filter((word) => word !== statusWord).slice(0, 3);
  while (words.length < 3) words.push(fallback[words.length] ?? "task");
  return [statusWord, ...words].slice(0, 4).join(" ");
}

function extractStatusWords(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .replace(/\x1b\[[0-9;]*m/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STATUS_STOP_WORDS.has(word));
}

const STATUS_STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was", "were", "has", "have", "had",
  "assistant", "message", "complete", "tool", "bash", "read", "write", "edit", "turn", "started", "ended", "output", "chars",
]);

async function waitForJobUpdate(job: AgentJob, waitMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout;
    const onAbort = () => done();
    const done = () => {
      clearTimeout(timer);
      job.waiters.delete(done);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    timer = setTimeout(done, waitMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    job.waiters.add(done);
  });
}

function terminateJob(job: AgentJob, reason: string): boolean {
  if (job.status !== "running") return true;
  addLog(job, "error", `terminating: ${reason}`, "terminate");

  if (job.supervisor === "tmux" && job.tmuxSession) {
    refreshTmuxJob(job);
    if (job.status !== "running") return true;

    let killError: string | undefined;
    try {
      execFileSync("tmux", ["kill-session", "-t", job.tmuxSession], { stdio: "ignore" });
    } catch (error) {
      killError = error instanceof Error ? error.message : String(error);
    }

    refreshTmuxJobOutput(job);
    const exitCode = readExitCode(job.exitCodePath);
    if (exitCode !== undefined) {
      const inferredStatus = exitCode === 0 && job.stopReason !== "error" && job.stopReason !== "aborted" ? "completed" : "failed";
      finalizeJob(job, inferredStatus, exitCode, undefined);
      return true;
    }

    const tmuxAvailable = isTmuxAvailable();
    if (tmuxAvailable && tmuxSessionExists(job.tmuxSession)) {
      addLog(job, "error", `tmux kill-session failed; job is still running${killError ? `: ${truncateOneLine(killError, 300)}` : ""}`, "terminate");
      return false;
    }

    if (killError && !tmuxAvailable) {
      addLog(job, "error", `tmux unavailable while stopping job: ${truncateOneLine(killError, 300)}`, "terminate");
      return false;
    }

    if (killError) {
      addLog(job, "error", `tmux kill-session failed but session is gone without final state: ${truncateOneLine(killError, 300)}`, "terminate");
      return false;
    }

    if (job.timeout) clearTimeout(job.timeout);
    if (job.monitorTimer) clearInterval(job.monitorTimer);
    finalizeJob(job, "cancelled", undefined, undefined, reason);
    return true;
  }

  job.status = "cancelled";
  job.errorMessage = reason;
  if (job.timeout) clearTimeout(job.timeout);
  if (job.monitorTimer) clearInterval(job.monitorTimer);
  if (job.proc && !job.proc.killed) {
    signalJob(job, "SIGTERM");
    job.killTimer = setTimeout(() => {
      if (!job.finishedAt) signalJob(job, "SIGKILL");
    }, 5_000);
    return true;
  }
  finalizeJob(job, "cancelled", undefined, undefined, reason);
  return true;
}

function signalJob(job: AgentJob, signal: NodeJS.Signals): void {
  if (!job.proc || !job.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-job.pid, signal);
    else job.proc.kill(signal);
  } catch {
    try {
      job.proc.kill(signal);
    } catch {
      // ignore
    }
  }
}

async function waitForJobCloseOrCleanup(job: AgentJob, timeoutMs: number, reason: string): Promise<void> {
  if (job.finishedAt) return;
  await waitForJobClose(job, timeoutMs);
  if (job.finishedAt) return;
  signalJob(job, "SIGKILL");
  finalizeJob(job, "cancelled", undefined, undefined, reason);
}

async function waitForJobClose(job: AgentJob, timeoutMs: number): Promise<void> {
  if (job.finishedAt) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      job.closeWaiters.delete(done);
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    job.closeWaiters.add(done);
  });
}

function finalizeJob(
  job: AgentJob,
  status: JobStatus,
  exitCode?: number,
  signal?: NodeJS.Signals,
  errorMessage?: string,
): void {
  if (job.finishedAt) return;
  flushAssistantDelta(job);
  if (job.timeout) clearTimeout(job.timeout);
  if (job.killTimer) clearTimeout(job.killTimer);
  if (job.monitorTimer) clearInterval(job.monitorTimer);
  refreshTmuxJobOutput(job);
  if (job.stdoutDecoder) processStdout(job, job.stdoutDecoder.end());
  if (job.stderrDecoder) processStderr(job, job.stderrDecoder.end());
  if (job.stdoutBuffer.trim()) processJsonLine(job, job.stdoutBuffer);
  job.stdoutBuffer = "";
  if (job.stderrBuffer?.trim()) addLog(job, "stderr", job.stderrBuffer, "stderr");
  job.stderrBuffer = "";
  cleanupTempPrompt(job);

  if (!job.finalOutput && job.latestAssistantText) job.finalOutput = job.latestAssistantText;
  job.status = status;
  job.exitCode = exitCode;
  job.signal = signal;
  job.finishedAt = Date.now();
  if (errorMessage) job.errorMessage = errorMessage;
  if (job.status === "failed" && !job.errorMessage && job.stderr.trim()) job.errorMessage = job.stderr.trim();
  cleanupWorktree(job, status);

  const parts = [`finished: ${status}`];
  if (exitCode !== undefined) parts.push(`exitCode=${exitCode}`);
  if (signal) parts.push(`signal=${signal}`);
  if (job.errorMessage) parts.push(`error=${truncateOneLine(job.errorMessage, 500)}`);
  if (job.worktree?.retained) parts.push(`retainedWorktree=${job.worktree.root}`);
  addLog(job, status === "completed" ? "info" : "error", parts.join(" "), "finish");
  persistJob(job);
  notifyCloseWaiters(job);
  pruneFinishedJobs();
}

function notifyCloseWaiters(job: AgentJob): void {
  if (job.closeWaiters.size === 0) return;
  const waiters = [...job.closeWaiters];
  job.closeWaiters.clear();
  for (const wake of waiters) wake();
}

function cleanupTempPrompt(job: AgentJob): void {
  cleanupPromptFiles(job.tmpPromptPath, job.tmpPromptDir);
}

function cleanupPromptFiles(tmpPromptPath: string | undefined, tmpPromptDir: string | undefined): void {
  if (tmpPromptPath) {
    try {
      fs.unlinkSync(tmpPromptPath);
    } catch {
      // ignore
    }
  }
  if (tmpPromptDir) {
    try {
      fs.rmdirSync(tmpPromptDir);
    } catch {
      // ignore
    }
  }
}

async function prepareWorktreeForSpawn(sourceCwd: string, jobId: string, ctx: ExtensionContext): Promise<{ cwd: string; worktree?: WorktreeInfo }> {
  const repoRoot = await getGitRoot(sourceCwd);
  if (!repoRoot) return { cwd: sourceCwd };

  const config = await readWorktreeEnv(repoRoot);
  if (config.enabled === false) return { cwd: sourceCwd };

  const tempParent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-worktree-"));
  const worktreeRoot = path.join(tempParent, "worktree");
  const base = config.base ?? "HEAD";
  const keepWorktree = normalizeKeepWorktree(config.keepWorktree);

  try {
    await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "--detach", "--quiet", worktreeRoot, base]);

    const copied = await copyConfiguredFiles(repoRoot, worktreeRoot, config.copy ?? [], config.exclude ?? config.exclusions ?? []);
    const postCopySpecs = config.postCopy ?? config.postCopyScripts ?? [];
    await confirmTrustedPostCopyIfNeeded(config.configPath, postCopySpecs, ctx);
    const postCopy = await runPostCopyScripts(worktreeRoot, postCopySpecs);
    const relativeCwd = path.relative(repoRoot, sourceCwd);
    const childCwd = relativeCwd ? path.resolve(worktreeRoot, relativeCwd) : worktreeRoot;
    assertInside(worktreeRoot, childCwd, "cwd");
    await fs.promises.mkdir(childCwd, { recursive: true });

    return {
      cwd: childCwd,
      worktree: {
        root: worktreeRoot,
        tempParent,
        originalRoot: repoRoot,
        originalCwd: sourceCwd,
        configPath: config.configPath,
        base,
        copied,
        postCopy,
        keepWorktree,
      },
    };
  } catch (error) {
    if ((keepWorktree === "always" || keepWorktree === "onFailure") && fs.existsSync(worktreeRoot)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nRetained failed-prep worktree for inspection: ${worktreeRoot}`);
    }
    try {
      execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreeRoot], { stdio: "ignore" });
    } catch {
      // ignore cleanup failures
    }
    try {
      fs.rmSync(tempParent, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
    throw error;
  }
}

async function getGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const root = stdout.trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

async function readWorktreeEnv(repoRoot: string): Promise<WorktreeEnvConfig & { configPath?: string }> {
  const configPath = path.join(repoRoot, WORKTREE_CONFIG_PATH);
  try {
    const raw = await fs.promises.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${WORKTREE_CONFIG_PATH} must contain a JSON object.`);
    }
    const config = parsed as WorktreeEnvConfig;
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
      throw new Error(`${WORKTREE_CONFIG_PATH}: enabled must be a boolean.`);
    }
    if (config.base !== undefined && typeof config.base !== "string") {
      throw new Error(`${WORKTREE_CONFIG_PATH}: base must be a string.`);
    }
    if (config.copy !== undefined && !Array.isArray(config.copy)) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: copy must be an array.`);
    }
    if (config.exclude !== undefined && !Array.isArray(config.exclude)) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: exclude must be an array.`);
    }
    if (config.exclusions !== undefined && !Array.isArray(config.exclusions)) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: exclusions must be an array.`);
    }
    if (config.exclude !== undefined && config.exclusions !== undefined) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: use either exclude or exclusions, not both.`);
    }
    if ((config.exclude ?? config.exclusions)?.some((entry) => typeof entry !== "string")) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: exclude entries must be strings.`);
    }
    if (config.postCopy !== undefined && !Array.isArray(config.postCopy)) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy must be an array.`);
    }
    if (config.postCopyScripts !== undefined && !Array.isArray(config.postCopyScripts)) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: postCopyScripts must be an array.`);
    }
    if (config.postCopy !== undefined && config.postCopyScripts !== undefined) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: use either postCopy or postCopyScripts, not both.`);
    }
    normalizeKeepWorktree(config.keepWorktree);
    return { ...config, configPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function confirmTrustedPostCopyIfNeeded(
  configPath: string | undefined,
  scripts: Array<string | WorktreePostCopyObject>,
  ctx: ExtensionContext,
): Promise<void> {
  if (scripts.length === 0) return;
  const commands = scripts.map((entry) => typeof entry === "string" ? entry : entry.command).join("\n");
  if (!ctx.hasUI) {
    throw new Error(
      `${WORKTREE_CONFIG_PATH}: postCopy contains repo-controlled shell commands but this session cannot ask for confirmation. ` +
      `Remove postCopy or run from an interactive trusted Pi session. Commands:\n${commands}`,
    );
  }
  const ok = await ctx.ui.confirm(
    "Run subagent worktree postCopy commands?",
    `Source: ${configPath ?? WORKTREE_CONFIG_PATH}\n\nThese repo-controlled commands run before the subagent starts and are not limited by the subagent tool allowlist. Only continue for trusted repositories.\n\n${commands}`,
  );
  if (!ok) throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy commands were not approved.`);
}

async function copyConfiguredFiles(
  repoRoot: string,
  worktreeRoot: string,
  copy: Array<string | WorktreeCopyObject>,
  exclusions: string[],
): Promise<string[]> {
  const copied: string[] = [];
  const excludeMatcher = createExcludeMatcher(exclusions);
  for (const entry of copy) {
    const spec = normalizeCopySpec(entry);

    if (hasGlobMagic(spec.from)) {
      const matches = await expandCopyGlob(repoRoot, spec.from, excludeMatcher);
      if (matches.length === 0) {
        if (spec.optional) continue;
        throw new Error(`${WORKTREE_CONFIG_PATH}: copy glob matched no files: ${spec.from}`);
      }

      const base = globStaticBase(spec.from);
      for (const match of matches) {
        const relativeToBase = base === "." ? match : path.posix.relative(base, match);
        const destinationRelative = spec.to ? path.posix.join(spec.to, relativeToBase) : match;
        await copyOneRepoPath(repoRoot, worktreeRoot, match, destinationRelative, excludeMatcher);
      }
      copied.push(spec.to && spec.to !== spec.from ? `${spec.from} -> ${spec.to}` : spec.from);
      continue;
    }

    const from = resolveRepoPath(repoRoot, spec.from, "copy.from");
    const to = resolveRepoPath(worktreeRoot, spec.to ?? spec.from, "copy.to");

    try {
      await fs.promises.access(from, fs.constants.F_OK);
    } catch {
      if (spec.optional) continue;
      throw new Error(`${WORKTREE_CONFIG_PATH}: copy source does not exist: ${spec.from}`);
    }

    if (excludeMatcher(spec.from)) {
      if (spec.optional) continue;
      throw new Error(`${WORKTREE_CONFIG_PATH}: copy source is excluded: ${spec.from}`);
    }

    if (samePath(to, worktreeRoot)) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: copy destination may not be the worktree root.`);
    }

    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.rm(to, { recursive: true, force: true });
    await fs.promises.cp(from, to, {
      recursive: true,
      force: true,
      dereference: false,
      filter: (src) => {
        const relative = normalizeRelativePath(path.relative(repoRoot, src));
        return !hasGitMetadataSegment(relative) && !excludeMatcher(relative);
      },
    });
    copied.push(spec.to && spec.to !== spec.from ? `${spec.from} -> ${spec.to}` : spec.from);
  }
  return copied;
}

async function copyOneRepoPath(
  repoRoot: string,
  worktreeRoot: string,
  sourceRelative: string,
  destinationRelative: string,
  excludeMatcher: (relativePath: string) => boolean,
): Promise<void> {
  const from = resolveRepoPath(repoRoot, sourceRelative, "copy.from");
  const to = resolveRepoPath(worktreeRoot, destinationRelative, "copy.to");
  if (samePath(to, worktreeRoot)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy destination may not be the worktree root.`);
  }
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.rm(to, { recursive: true, force: true });
  await fs.promises.cp(from, to, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (src) => {
      const relative = normalizeRelativePath(path.relative(repoRoot, src));
      return !hasGitMetadataSegment(relative) && !excludeMatcher(relative);
    },
  });
}

async function expandCopyGlob(repoRoot: string, pattern: string, excludeMatcher: (relativePath: string) => boolean): Promise<string[]> {
  const matches: string[] = [];
  const start = resolveRepoPathAllowRoot(repoRoot, globStaticBase(pattern), "copy.from");
  if (!fs.existsSync(start)) return matches;

  async function walk(absolutePath: string): Promise<void> {
    const relative = normalizeRelativePath(path.relative(repoRoot, absolutePath));
    if (relative !== "." && (hasGitMetadataSegment(relative) || excludeMatcher(relative))) return;

    const stat = await fs.promises.lstat(absolutePath);
    if (relative !== "." && globMatches(pattern, relative)) matches.push(relative);
    if (!stat.isDirectory()) return;

    const entries = await fs.promises.readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      await walk(path.join(absolutePath, entry.name));
    }
  }

  await walk(start);
  return matches.sort();
}

function createExcludeMatcher(exclusions: string[]): (relativePath: string) => boolean {
  const patterns = exclusions.map((entry) => normalizeRepoRelativePath(entry, "exclude"));
  return (relativePath: string) => {
    const normalized = normalizeRelativePath(relativePath);
    return patterns.some((pattern) => {
      if (globMatches(pattern, normalized) || normalized.startsWith(`${pattern}/`)) return true;
      if (pattern.endsWith("/**")) {
        const directoryPattern = pattern.slice(0, -3);
        return globMatches(directoryPattern, normalized) || normalized.startsWith(`${directoryPattern}/`);
      }
      return false;
    });
  };
}

function hasGlobMagic(input: string): boolean {
  return /[*?]/.test(input);
}

function globStaticBase(pattern: string): string {
  const parts = pattern.split("/");
  const staticParts: string[] = [];
  for (const part of parts) {
    if (hasGlobMagic(part)) break;
    staticParts.push(part);
  }
  return staticParts.length === 0 ? "." : staticParts.join("/");
}

function globMatches(pattern: string, relativePath: string): boolean {
  const regex = globPatternToRegExp(pattern);
  return regex.test(normalizeRelativePath(relativePath));
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      const after = pattern[i + 2];
      if (after === "/") {
        source += "(?:.*\/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(input: string): string {
  return input.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
}

function normalizeRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  return normalized === "" ? "." : normalized;
}

async function runPostCopyScripts(worktreeRoot: string, scripts: Array<string | WorktreePostCopyObject>): Promise<WorktreeScriptResult[]> {
  const results: WorktreeScriptResult[] = [];
  for (const entry of scripts) {
    const spec = normalizePostCopySpec(entry);
    const cwd = spec.cwd ? resolveRepoPathAllowRoot(worktreeRoot, spec.cwd, "postCopy.cwd") : worktreeRoot;
    const result: WorktreeScriptResult = {
      command: spec.command,
      cwd: path.relative(worktreeRoot, cwd) || ".",
      optional: spec.optional,
      timeoutMs: spec.timeoutMs,
    };

    try {
      const shell = getShellInvocation(spec.command);
      const { stdout, stderr } = await execFileAsync(shell.command, shell.args, {
        cwd,
        timeout: spec.timeoutMs,
        maxBuffer: 1_000_000,
        env: spec.env ? { ...process.env, ...spec.env } : process.env,
      });
      result.stdout = compactPreview(stdout.trim(), 600, 4);
      result.stderr = compactPreview(stderr.trim(), 600, 4);
      results.push(result);
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; signal?: string };
      result.stdout = compactPreview((execError.stdout ?? "").trim(), 600, 4);
      result.stderr = compactPreview((execError.stderr ?? execError.message ?? "").trim(), 600, 4);
      result.failed = true;
      results.push(result);
      if (!spec.optional) {
        const reason = [
          `command failed${execError.code !== undefined ? ` (code ${execError.code})` : ""}${execError.signal ? ` (signal ${execError.signal})` : ""}`,
          result.stderr ? `stderr: ${result.stderr}` : undefined,
          result.stdout ? `stdout: ${result.stdout}` : undefined,
        ].filter(Boolean).join("; ");
        throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy failed for ${JSON.stringify(spec.command)}: ${reason}`);
      }
    }
  }
  return results;
}

function getShellInvocation(command: string): { command: string; args: string[] } {
  if (process.platform === "win32") return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  return { command: process.env.SHELL || "/bin/bash", args: ["-lc", command] };
}

function normalizeCopySpec(entry: string | WorktreeCopyObject): Required<Pick<WorktreeCopyObject, "from" | "optional">> & { to?: string } {
  if (typeof entry === "string") return { from: normalizeRepoRelativePath(entry, "copy"), optional: false };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy entries must be strings or objects.`);
  }
  if (typeof entry.from !== "string") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy object requires a non-empty string "from".`);
  }
  if (entry.to !== undefined && typeof entry.to !== "string") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy object "to" must be a non-empty string.`);
  }
  if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy object "optional" must be a boolean.`);
  }
  return {
    from: normalizeRepoRelativePath(entry.from, "copy.from"),
    to: entry.to === undefined ? undefined : normalizeRepoRelativePath(entry.to, "copy.to"),
    optional: entry.optional ?? false,
  };
}

function normalizePostCopySpec(entry: string | WorktreePostCopyObject): Required<Pick<WorktreePostCopyObject, "command" | "optional" | "timeoutMs">> & Pick<WorktreePostCopyObject, "cwd" | "env"> {
  if (typeof entry === "string") return { command: normalizeCommand(entry, "postCopy"), optional: false, timeoutMs: 120_000 };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy entries must be strings or objects.`);
  }
  if (typeof entry.command !== "string") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object requires a non-empty string "command".`);
  }
  if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object "cwd" must be a string.`);
  }
  if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object "optional" must be a boolean.`);
  }
  if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1 || entry.timeoutMs > 30 * 60 * 1000)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object "timeoutMs" must be an integer from 1 to 1800000.`);
  }
  if (entry.env !== undefined) {
    if (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env)) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object "env" must be an object of string values.`);
    }
    for (const [key, value] of Object.entries(entry.env)) {
      if (!key || typeof value !== "string") {
        throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object "env" must be an object of string values.`);
      }
    }
  }
  return {
    command: normalizeCommand(entry.command, "postCopy.command"),
    cwd: entry.cwd === undefined ? undefined : normalizeRepoRelativePathAllowRoot(entry.cwd, "postCopy.cwd"),
    optional: entry.optional ?? false,
    timeoutMs: entry.timeoutMs ?? 120_000,
    env: entry.env,
  };
}

function normalizeCommand(input: string, fieldName: string): string {
  const command = input.trim();
  if (!command) throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must be a non-empty command.`);
  return command;
}

function normalizeKeepWorktree(value: WorktreeEnvConfig["keepWorktree"]): WorktreeKeepMode {
  if (value === undefined || value === false) return "never";
  if (value === true) return "always";
  if (value === "never" || value === "always" || value === "onFailure") return value;
  throw new Error(`${WORKTREE_CONFIG_PATH}: keepWorktree must be a boolean or one of "never", "always", "onFailure".`);
}

function normalizeRepoRelativePath(input: string, fieldName: string): string {
  const raw = input.trim();
  if (!raw) throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must be a non-empty relative path.`);
  if (path.isAbsolute(raw) || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must be relative to the repo root: ${input}`);
  }
  const normalized = path.posix.normalize(raw.replace(/\\/g, "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must stay inside the repo and may not target the repo root: ${input}`);
  }
  if (hasGitMetadataSegment(normalized)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: refusing to copy .git metadata paths: ${input}`);
  }
  return normalized;
}

function normalizeRepoRelativePathAllowRoot(input: string, fieldName: string): string {
  const raw = input.trim();
  if (!raw) throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must be a non-empty relative path.`);
  if (path.isAbsolute(raw) || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must be relative to the repo root: ${input}`);
  }
  const normalized = path.posix.normalize(raw.replace(/\\/g, "/"));
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must stay inside the repo: ${input}`);
  }
  if (hasGitMetadataSegment(normalized)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: refusing to use .git metadata paths: ${input}`);
  }
  return normalized === "." ? "." : normalized;
}

function resolveRepoPath(root: string, relativePath: string, fieldName: string): string {
  const resolved = path.resolve(root, relativePath);
  assertInside(root, resolved, fieldName);
  return resolved;
}

function resolveRepoPathAllowRoot(root: string, relativePath: string, fieldName: string): string {
  const resolved = path.resolve(root, relativePath);
  assertInsideAllowRoot(root, resolved, fieldName);
  return resolved;
}

function assertInside(root: string, candidate: string, fieldName: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} escapes the repo root.`);
}

function assertInsideAllowRoot(root: string, candidate: string, fieldName: string): void {
  assertInside(root, candidate, fieldName);
}

function hasGitMetadataSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some((segment) => segment === ".git");
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function cleanupWorktree(job: AgentJob, status: JobStatus): void {
  const worktree = job.worktree;
  if (!worktree) return;
  if (shouldRetainWorktree(worktree, status)) {
    worktree.retained = true;
    job.cleanupPending = false;
    return;
  }
  job.cleanupPending = true;
  job.cleanupError = undefined;
  persistJob(job);
  void retryWorktreeCleanup(job);
}

function retryPendingWorktreeCleanups(): void {
  for (const job of jobs.values()) {
    if (job.cleanupPending) void retryWorktreeCleanup(job);
  }
}

async function retryWorktreeCleanup(job: AgentJob): Promise<void> {
  const worktree = job.worktree;
  if (!worktree || !job.cleanupPending) return;
  try {
    await cleanupWorktreeAsync(worktree);
    job.cleanupPending = false;
    job.cleanupError = undefined;
    addLog(job, "info", `worktree cleanup ok: ${worktree.root}`, "worktree");
  } catch (error) {
    job.cleanupPending = true;
    job.cleanupError = error instanceof Error ? error.message : String(error);
    addLog(job, "error", `worktree cleanup failed: ${job.cleanupError}`, "worktree");
  } finally {
    persistJob(job);
  }
}

function cleanupWorktreeInfo(worktree: WorktreeInfo | undefined, status: JobStatus = "failed"): void {
  if (!worktree) return;
  if (shouldRetainWorktree(worktree, status)) {
    worktree.retained = true;
    return;
  }
  void cleanupWorktreeAsync(worktree).catch(() => {
    // ignore cleanup failures in pre-job error paths
  });
}

async function cleanupWorktreeAsync(worktree: WorktreeInfo): Promise<void> {
  let gitRemoveError: unknown;
  try {
    await execFileAsync("git", ["-C", worktree.originalRoot, "worktree", "remove", "--force", worktree.root]);
  } catch (error) {
    gitRemoveError = error;
  }
  await fs.promises.rm(worktree.tempParent, { recursive: true, force: true });
  if (gitRemoveError) {
    try {
      await execFileAsync("git", ["-C", worktree.originalRoot, "worktree", "prune"]);
    } catch (pruneError) {
      const removeMessage = gitRemoveError instanceof Error ? gitRemoveError.message : String(gitRemoveError);
      const pruneMessage = pruneError instanceof Error ? pruneError.message : String(pruneError);
      throw new Error(`git worktree remove failed (${removeMessage}); prune also failed (${pruneMessage})`);
    }
  }
}

function shouldRetainWorktree(worktree: WorktreeInfo, status: JobStatus): boolean {
  if (worktree.keepWorktree === "always") return true;
  if (worktree.keepWorktree === "onFailure") return status === "failed" || status === "cancelled";
  return false;
}

async function writePromptToTempFile(jobId: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-bg-agent-"));
  const safeName = jobId.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `system-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

function createJobId(): string {
  return `agent_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function getLogsSince(job: AgentJob, sinceSeq: number, maxLogEntries: number): AgentLogEntry[] {
  return job.logs.filter((entry) => entry.seq > sinceSeq).slice(-maxLogEntries);
}

function summarizeJob(job: AgentJob) {
  return {
    id: job.id,
    label: job.label,
    agent: job.agent,
    agentSource: job.agentSource,
    task: job.task,
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
    status: job.status,
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

function formatJobSummaryLine(job: ReturnType<typeof summarizeJob>): string {
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

function formatCompactPollResult(job: AgentJob, sinceSeq: number, nextSeq: number): string {
  const newEventCount = job.logs.filter((entry) => entry.seq > sinceSeq).length;
  const lines = [formatJobSummaryLine(summarizeJob(job)), `nextSeq: ${nextSeq}; newEvents: ${newEventCount}`];

  if (job.status === "running") {
    const latest = job.latestAssistantText || latestLogPreview(job) || "waiting for output";
    lines.push(`progress: ${compactPreview(latest, 220, 2)}`);
    lines.push(`next: poll again in ~15-30s or use waitMs:${SUGGESTED_POLL_INTERVAL_MS}; verbosity:"logs" for details.`);
    return lines.join("\n");
  }

  if (job.errorMessage) lines.push(`error: ${compactPreview(job.errorMessage, 220, 2)}`);
  lines.push(`result: ${job.finalOutput ? compactPreview(job.finalOutput, 260, 3) : "(no final assistant output)"}`);
  if (job.finalOutput && job.finalOutput.length > 260) lines.push(`full: poll_agent({ id: "${job.id}", verbosity: "full" })`);
  return lines.join("\n");
}

function formatPollResult(job: AgentJob, logs: AgentLogEntry[], nextSeq: number, includeFullOutput: boolean): string {
  const lines: string[] = [];
  lines.push(formatJobSummaryLine(summarizeJob(job)));
  lines.push(`nextSeq: ${nextSeq}`);
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

function latestLogPreview(job: AgentJob): string | undefined {
  for (let i = job.logs.length - 1; i >= 0; i--) {
    const entry = job.logs[i];
    if (entry.level === "assistant" && entry.text.startsWith("assistant:")) continue;
    return entry.text;
  }
  return undefined;
}

function compactPreview(text: string, maxChars: number, maxLines: number): string {
  const joined = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(" / ");
  return truncateOneLine(joined || "(empty)", maxChars);
}

function formatLogEntry(entry: AgentLogEntry): string {
  const time = new Date(entry.timestamp).toISOString().slice(11, 19);
  return `${entry.seq.toString().padStart(4, " ")} ${time} ${entry.level.padEnd(9)} ${entry.text}`;
}

function formatToolCall(toolName: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = String(a.command ?? "...");
      return `$ ${truncateOneLine(command, 160)}`;
    }
    case "read": {
      const filePath = shortenPath(String(a.path ?? a.file_path ?? "..."));
      const offset = typeof a.offset === "number" ? a.offset : undefined;
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      const suffix = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
      return `read ${filePath}${suffix}`;
    }
    case "write":
    case "edit": {
      return `${toolName} ${shortenPath(String(a.path ?? a.file_path ?? "..."))}`;
    }
    case "grep": {
      return `grep /${String(a.pattern ?? "")}/ in ${shortenPath(String(a.path ?? "."))}`;
    }
    case "find": {
      return `find ${String(a.pattern ?? "*")} in ${shortenPath(String(a.path ?? "."))}`;
    }
    case "ls": {
      return `ls ${shortenPath(String(a.path ?? "."))}`;
    }
    default: {
      return `${toolName} ${truncateOneLine(JSON.stringify(a), 200)}`;
    }
  }
}

function previewToolResult(result: any): string {
  if (!result) return "";
  if (Array.isArray(result.content)) {
    return truncateOneLine(
      result.content
        .map((part: any) => (part?.type === "text" ? part.text : part?.type ? `[${part.type}]` : ""))
        .filter(Boolean)
        .join("\n"),
      300,
    );
  }
  if (typeof result === "string") return truncateOneLine(result, 300);
  return truncateOneLine(JSON.stringify(result), 300);
}

function formatToolResultMessage(msg: ToolResultMessage): string {
  const text = msg.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .filter(Boolean)
    .join("\n");
  return `${msg.isError ? "✗" : "✓"} ${msg.toolName}: ${truncateOneLine(text || "done", 300)}`;
}

function getAssistantText(msg: AssistantMessage): string {
  return msg.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function textContent(content: Array<{ type: string; text?: string }>): string {
  return content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
}

function formatUsage(usage: UsageStats): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns}t`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" ");
}

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function appendCappedText(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  if (next.length <= maxChars) return next;
  return next.slice(next.length - maxChars);
}

function pruneFinishedJobs(): void {
  const finished = [...jobs.values()]
    .filter((job) => job.status !== "running")
    .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt));
  for (const job of finished.slice(MAX_RETAINED_FINISHED_JOBS)) {
    jobs.delete(job.id);
    try {
      fs.rmSync(jobStatePath(job.id), { force: true });
    } catch {
      // ignore
    }
  }
}

function truncateForTool(text: string): string {
  const truncation = truncateTail(text || "(empty)", {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return truncation.content;
  return (
    truncation.content +
    `\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines` +
    ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`
  );
}

function truncateOneLine(text: string, maxChars: number): string {
  const oneLine = squashWhitespace(text);
  return oneLine.length > maxChars ? `${oneLine.slice(0, Math.max(0, maxChars - 1))}…` : oneLine;
}

function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function displayCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Background subagents for Pi.
 *
 * run_agent starts a separate `pi --mode json -p --no-session` process and
 * returns immediately with a job id. poll_agent reads the live event log and
 * final result later. stop_agent terminates a running job.
 */

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AssistantMessage, Message, ToolResultMessage } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
const MAX_RETAINED_FINISHED_JOBS = 50;
const DEFAULT_POLL_LOG_ENTRIES = 20;
const MAX_POLL_LOG_ENTRIES = 200;
const SUGGESTED_POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 60_000;
const ASSISTANT_DELTA_LOG_INTERVAL_MS = 1_250;
const ASSISTANT_DELTA_LOG_CHARS = 1_200;
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

interface WorktreeEnvConfig {
  enabled?: boolean;
  base?: string;
  copy?: Array<string | WorktreeCopyObject>;
}

interface WorktreeInfo {
  root: string;
  tempParent: string;
  originalRoot: string;
  originalCwd: string;
  configPath?: string;
  base: string;
  copied: string[];
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
  killTimer?: NodeJS.Timeout;
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

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which markdown agent directories to use. Default: "user". Use "both" to include project-local .pi/agents.',
  default: "user",
});

const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
  description: "Optional Pi thinking level for the subagent process.",
});

const PollVerbositySchema = StringEnum(["summary", "logs", "full"] as const, {
  description:
    'How much poll_agent should return. Default "summary" is a few-line status. Use "logs" for recent raw logs or "full" for final output.',
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
  model: Type.Optional(Type.String({ description: "Optional model pattern/id, e.g. openai/gpt-5.5 or claude-sonnet:high." })),
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
  pi.registerTool({
    name: "run_agent",
    label: "Run Agent",
    description: [
      "Start a background Pi subagent in a separate process and return immediately with a job id.",
      "Use poll_agent with that id to retrieve compact status; request logs/full output only when needed.",
      "When started inside a git repo, the child runs in a temporary detached worktree; .pi/worktree.env controls copied files.",
      "Can run a named markdown agent or an ad-hoc subagent with optional systemPrompt/model/tools.",
    ].join(" "),
    promptSnippet: "Start a non-blocking background Pi subagent job and return a job id for poll_agent.",
    promptGuidelines: [
      "Use run_agent for long-running or parallelizable investigation/implementation tasks that should not block the main agent turn.",
      "After run_agent returns an id, poll sparingly. Prefer poll_agent waitMs around 10000-30000 and avoid tight polling loops.",
      "Use poll_agent's default summary verbosity for routine checks; request verbosity \"logs\" or \"full\" only when needed.",
      "Remember run_agent uses a temporary git worktree when inside a repo; uncommitted/untracked files are visible only if copied by .pi/worktree.env.",
      "Use run_agent tools to restrict subagents to read-only tools when delegating review or reconnaissance tasks.",
    ],
    parameters: RunAgentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

      const job = await startAgentJob(sourceCwd, params, namedAgent, toolSelection.tools);
      const details = summarizeJob(job);
      const text = [
        `Started background agent ${job.id}.`,
        `Status: ${job.status}`,
        `Label: ${job.label}`,
        `PID: ${job.pid ?? "(spawn pending)"}`,
        `CWD: ${job.cwd}`,
        "",
        `Poll later with: poll_agent({ id: "${job.id}", sinceSeq: 0, waitMs: ${SUGGESTED_POLL_INTERVAL_MS} })`,
      ].join("\n");

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
      "Poll a background subagent started by run_agent. By default returns a compact few-line status. Set verbosity to \"logs\" for recent raw logs or \"full\" to retrieve the final output. Omit id to list jobs.",
    promptSnippet: "Poll a background subagent's compact status and final result by job id.",
    promptGuidelines: [
      "Use poll_agent after run_agent. Pass sinceSeq from the previous poll's nextSeq to avoid rereading old events.",
      "Poll sparingly: if poll_agent reports status running, wait roughly 10-30 seconds before polling again, or pass waitMs around 10000-30000.",
      "Use poll_agent's default verbosity for routine status. Use verbosity \"logs\" only for debugging, and verbosity \"full\" only when the final output is needed.",
    ],
    parameters: PollAgentParams,

    async execute(_toolCallId, params) {
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

      const sinceSeq = params.sinceSeq ?? 0;
      const verbosity: PollVerbosity = params.verbosity ?? "summary";
      const maxLogEntries = Math.min(params.maxLogEntries ?? DEFAULT_POLL_LOG_ENTRIES, MAX_POLL_LOG_ENTRIES);
      const waitMs = Math.min(params.waitMs ?? 0, MAX_WAIT_MS);

      if (verbosity !== "summary") flushAssistantDelta(job);
      if (waitMs > 0 && job.status === "running" && getLogsSince(job, sinceSeq, maxLogEntries).length === 0) {
        await waitForJobUpdate(job, waitMs);
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

    async execute(_toolCallId, params) {
      const job = jobs.get(params.id);
      if (!job) {
        const known = [...jobs.keys()].join(", ") || "none";
        return { content: [{ type: "text", text: `Unknown agent job id: ${params.id}. Known ids: ${known}` }], details: {} };
      }

      if (job.status !== "running") {
        return {
          content: [{ type: "text", text: `Agent ${job.id} is already ${job.status}.` }],
          details: summarizeJob(job),
        };
      }

      terminateJob(job, params.reason ?? "cancelled by stop_agent");
      return {
        content: [{ type: "text", text: `Sent termination signal to agent ${job.id}.` }],
        details: summarizeJob(job),
      };
    },
  });

  pi.on("session_shutdown", async () => {
    const running = [...jobs.values()].filter((job) => job.status === "running");
    for (const job of running) terminateJob(job, "Pi session shutting down");
    await Promise.all(running.map((job) => waitForJobCloseOrCleanup(job, 7_000, "Pi session shutting down")));
  });
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
): Promise<AgentJob> {
  const id = createJobId();
  const worktreePrep = await prepareWorktreeForSpawn(sourceCwd, id);
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
    latestAssistantText: "",
    pendingAssistantDelta: "",
    lastAssistantDeltaLogAt: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    tmpPromptDir,
    tmpPromptPath,
    waiters: new Set(),
    closeWaiters: new Set(),
  };

  jobs.set(job.id, job);
  if (job.worktree) {
    addLog(job, "info", `created git worktree ${job.worktree.root} from ${job.worktree.base}`, "worktree");
    if (job.worktree.copied.length > 0) {
      addLog(job, "info", `copied into worktree: ${job.worktree.copied.join(", ")}`, "worktree");
    }
  }
  addLog(job, "info", `starting: ${displayCommand(invocation.command, invocation.args)} (cwd: ${cwd})`, "start");

  try {
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.proc = proc;
    job.pid = proc.pid;

    proc.stdout.on("data", (data) => processStdout(job, data.toString()));
    proc.stderr.on("data", (data) => processStderr(job, data.toString()));
    proc.on("error", (error) => finalizeJob(job, "failed", undefined, undefined, error.message));
    proc.on("close", (code, signal) => {
      if (job.stdoutBuffer.trim()) processJsonLine(job, job.stdoutBuffer);
      job.stdoutBuffer = "";
      const inferredStatus = job.status === "cancelled"
        ? "cancelled"
        : code === 0 && job.stopReason !== "error" && job.stopReason !== "aborted"
          ? "completed"
          : "failed";
      finalizeJob(job, inferredStatus, code ?? undefined, signal ?? undefined);
    });

    if (timeoutMs && timeoutMs > 0) {
      job.timeout = setTimeout(() => terminateJob(job, `timeout after ${timeoutMs}ms`), timeoutMs);
    }
  } catch (error) {
    finalizeJob(job, "failed", undefined, undefined, error instanceof Error ? error.message : String(error));
  }

  // Keep an initial status entry after spawn so the PID is visible if available.
  if (job.status === "running") addLog(job, "info", `started pid ${job.pid ?? "unknown"}`, "start");
  return job;
}

function processStdout(job: AgentJob, chunk: string): void {
  job.stdoutBuffer += chunk;
  const lines = job.stdoutBuffer.split("\n");
  job.stdoutBuffer = lines.pop() ?? "";
  for (const line of lines) processJsonLine(job, line);
}

function processStderr(job: AgentJob, chunk: string): void {
  job.stderr = appendCappedText(job.stderr, chunk, MAX_STORED_STDERR_CHARS);
  for (const line of chunk.split(/\r?\n/)) {
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
          addLog(job, msg.isError ? "error" : "tool", formatToolResultMessage(msg), event.type);
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
  touchJob(job);
}

function touchJob(job: AgentJob): void {
  job.updatedAt = Date.now();
  notifyWaiters(job);
}

function notifyWaiters(job: AgentJob): void {
  if (job.waiters.size === 0) return;
  const waiters = [...job.waiters];
  job.waiters.clear();
  for (const wake of waiters) wake();
}

async function waitForJobUpdate(job: AgentJob, waitMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      job.waiters.delete(done);
      resolve();
    }, waitMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    job.waiters.add(done);
  });
}

function terminateJob(job: AgentJob, reason: string): void {
  if (job.status !== "running") return;
  job.status = "cancelled";
  job.errorMessage = reason;
  addLog(job, "error", `terminating: ${reason}`, "terminate");
  if (job.timeout) clearTimeout(job.timeout);
  if (job.proc && !job.proc.killed) {
    signalJob(job, "SIGTERM");
    job.killTimer = setTimeout(() => {
      if (!job.finishedAt) signalJob(job, "SIGKILL");
    }, 5_000);
  }
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
  cleanupTempPrompt(job);
  cleanupWorktree(job);

  job.status = status;
  job.exitCode = exitCode;
  job.signal = signal;
  job.finishedAt = Date.now();
  if (errorMessage) job.errorMessage = errorMessage;
  if (job.status === "failed" && !job.errorMessage && job.stderr.trim()) job.errorMessage = job.stderr.trim();

  const parts = [`finished: ${status}`];
  if (exitCode !== undefined) parts.push(`exitCode=${exitCode}`);
  if (signal) parts.push(`signal=${signal}`);
  if (job.errorMessage) parts.push(`error=${truncateOneLine(job.errorMessage, 500)}`);
  addLog(job, status === "completed" ? "info" : "error", parts.join(" "), "finish");
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

async function prepareWorktreeForSpawn(sourceCwd: string, jobId: string): Promise<{ cwd: string; worktree?: WorktreeInfo }> {
  const repoRoot = await getGitRoot(sourceCwd);
  if (!repoRoot) return { cwd: sourceCwd };

  const config = await readWorktreeEnv(repoRoot);
  if (config.enabled === false) return { cwd: sourceCwd };

  const tempParent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-worktree-"));
  const worktreeRoot = path.join(tempParent, "worktree");
  const base = config.base ?? "HEAD";

  try {
    await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "--detach", "--quiet", worktreeRoot, base]);

    const copied = await copyConfiguredFiles(repoRoot, worktreeRoot, config.copy ?? []);
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
      },
    };
  } catch (error) {
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
    return { ...config, configPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function copyConfiguredFiles(repoRoot: string, worktreeRoot: string, copy: Array<string | WorktreeCopyObject>): Promise<string[]> {
  const copied: string[] = [];
  for (const entry of copy) {
    const spec = normalizeCopySpec(entry);
    const from = resolveRepoPath(repoRoot, spec.from, "copy.from");
    const to = resolveRepoPath(worktreeRoot, spec.to ?? spec.from, "copy.to");

    try {
      await fs.promises.access(from, fs.constants.F_OK);
    } catch {
      if (spec.optional) continue;
      throw new Error(`${WORKTREE_CONFIG_PATH}: copy source does not exist: ${spec.from}`);
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
      filter: (src) => !hasGitMetadataSegment(path.relative(from, src)),
    });
    copied.push(spec.to && spec.to !== spec.from ? `${spec.from} -> ${spec.to}` : spec.from);
  }
  return copied;
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

function resolveRepoPath(root: string, relativePath: string, fieldName: string): string {
  const resolved = path.resolve(root, relativePath);
  assertInside(root, resolved, fieldName);
  return resolved;
}

function assertInside(root: string, candidate: string, fieldName: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} escapes the repo root.`);
}

function hasGitMetadataSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some((segment) => segment === ".git");
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function cleanupWorktree(job: AgentJob): void {
  cleanupWorktreeInfo(job.worktree);
}

function cleanupWorktreeInfo(worktree: WorktreeInfo | undefined): void {
  if (!worktree) return;
  try {
    execFileSync("git", ["-C", worktree.originalRoot, "worktree", "remove", "--force", worktree.root], {
      stdio: "ignore",
    });
  } catch {
    // ignore; rm below handles leftover files
  }
  try {
    fs.rmSync(worktree.tempParent, { recursive: true, force: true });
  } catch {
    // ignore
  }
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
        }
      : undefined,
    pid: job.pid,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    stopReason: job.stopReason,
    errorMessage: job.errorMessage,
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
  for (const job of finished.slice(MAX_RETAINED_FINISHED_JOBS)) jobs.delete(job.id);
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

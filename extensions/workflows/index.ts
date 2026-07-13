import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type InProcessSubagentOptions, runSubagentInProcess } from "../subagents/core/in-process-runner.js";
import { DEFAULT_RUN_RETENTION_MS, pruneOldRuns } from "../subagents/core/run-archive.js";
import { addUsage, emptyUsageStats, type SubagentResult, type UsageStats } from "../subagents/core/types.js";
import { createWorktree, WorktreeStartupCleanupError } from "../subagents/workspace/create-worktree.js";
import { WorkflowDashboard } from "./ui/dashboard.js";
import { renderWorkflowNotification, type WorkflowNotificationDetails } from "./ui/notification.js";
import { renderWorkflowCall, renderWorkflowResult } from "./ui/tool-render.js";

export type AgentExecutor = (options: InProcessSubagentOptions) => Promise<SubagentResult>;

interface AgentSchema {
  required?: string[];
  description?: string;
}

interface AgentOptions {
  label?: string;
  tools?: string[];
  systemPrompt?: string;
  timeoutMs?: number;
  /** Run this agent in a different working directory (lightweight isolation). */
  cwd?: string;
  /**
   * Run this agent inside a dedicated git worktree (created from the resolved
   * cwd, torn down when the agent finishes). Use for parallel write-heavy
   * agents that must not share a working tree. Requires a git repo.
   *
   * Matches `run_agent`'s `worktree` flag, except the default here is `false`
   * (fan-out shares one working tree) and there is no `auto` mode.
   */
  worktree?: boolean;
  /** Give this agent a shared `mcp` gateway tool (forwards to the process-wide MCP pool). */
  mcp?: boolean;
  schema?: AgentSchema;
  retries?: number;
}

interface Failure {
  index: number;
  label?: string;
  reason: string;
}

interface WorkflowResult {
  runId: string;
  scriptPath: string;
  /** Isolated directory holding this run's event log + per-agent transcripts (read/grep). */
  runDir: string;
  output: unknown;
  usage: UsageStats;
  agents: number;
  failures: Failure[];
}

/** Absolute path to a run's isolated artifact directory under <agentDir>/workflows/runs/<runId>/. */
function runDirFor(runId: string): string {
  return path.join(getAgentDir(), "workflows", "runs", runId);
}

export type WorkflowAgentStatus = "queued" | "running" | "retrying" | "completed" | "failed";

export interface WorkflowAgentView {
  index: number;
  label: string;
  phase?: string;
  status: WorkflowAgentStatus;
  attempt: number;
  maxRetries: number;
  startedAt?: number;
  finishedAt?: number;
  reason?: string;
}

export interface WorkflowSnapshot {
  runId: string;
  origin: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  phase?: string;
  phases: string[];
  agents: WorkflowAgentView[];
  active: number;
  queued: number;
  launched: number;
  usage: UsageStats;
  failures: number;
  rateLimited: boolean;
  lastMessage?: string;
}

const DEFAULT_WORKFLOW_TOOLS = ["read", "bash"];
const MAX_AGENTS = 100;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_WORKFLOW_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_429_RETRIES = 5;
/** Do not let a broken injected/test executor make external cancellation hang forever. */
const EXTERNAL_AGENT_DRAIN_GRACE_MS = 250;
/** Custom message type used for background completion notices (rendered collapsed). */
const WORKFLOW_NOTIFICATION_TYPE = "workflow-notification";
type ToolViewMode = "minimized" | "medium" | "verbose";
/** How long the finished dashboard lingers before it is cleared. */
const FINISHED_WIDGET_VISIBLE_MS = 8_000;

interface RunningWorkflow {
  runId: string;
  controller: AbortController;
  origin: string;
  startedAt: number;
  /** Set when the run was intentionally stopped (tool/command) -> reported as cancelled. */
  stopped?: boolean;
  stopReason?: string;
  /** Set when the overall timeout fired -> reported as failed. */
  timedOut?: boolean;
}

let piApi: ExtensionAPI | undefined;
let deliveryContext: ExtensionContext | undefined;
const runningWorkflows = new Map<string, RunningWorkflow>();

/** Abort one running workflow by id. Returns false when it is unknown/already finished. */
function stopWorkflow(runId: string, reason: string): boolean {
  const run = runningWorkflows.get(runId);
  if (!run) return false;
  run.stopped = true;
  run.stopReason = reason;
  run.controller.abort(new Error(reason));
  return true;
}

/** Abort every running workflow. Returns how many were stopped. */
function stopAllWorkflows(reason: string): number {
  let count = 0;
  for (const run of runningWorkflows.values()) {
    run.stopped = true;
    run.stopReason = reason;
    run.controller.abort(new Error(reason));
    count += 1;
  }
  return count;
}

export default function workflowsExtension(pi: ExtensionAPI) {
  piApi = pi;

  // Collapse background completion notices in the transcript, mirroring the
  // `tool-view` extension and reusing its persisted `mode` flag: minimized /
  // medium => one tinted line; verbose (or an expanded entry) => full body.
  pi.registerMessageRenderer<WorkflowNotificationDetails>(WORKFLOW_NOTIFICATION_TYPE, (message, { expanded }, theme) => {
    const full = expanded || readToolViewMode() === "verbose";
    const content = typeof message.content === "string" ? message.content : "";
    return renderWorkflowNotification(message.details, content, full, theme);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) deliveryContext = ctx;
    // Age out old run artifacts (event logs + per-agent transcripts).
    pruneOldRuns(path.join(getAgentDir(), "workflows", "runs"), DEFAULT_RUN_RETENTION_MS);
  });

  pi.on("session_shutdown", async () => {
    for (const run of runningWorkflows.values()) run.controller.abort(new Error("session shutdown"));
    runningWorkflows.clear();
  });

  pi.registerTool({
    name: "Workflow",
    label: "Workflow",
    description: [
      "Execute a workflow script that orchestrates multiple in-process subagents — your go-to tool for anything that fans out.",
      "REACH FOR THIS FIRST whenever a task splits into independent parts: multi-file edits/reviews, codebase-wide search+analysis, per-package/per-service work, batch refactors, migrations, test generation, doc sweeps, or any 'do X for each of these' request. Parallel subagents finish far faster than doing it yourself sequentially, and each gets its own context window so you avoid bloating this one.",
      "Provide the script via `script` (inline), `scriptPath` (a file), or `name` (a saved workflow).",
      "Inline scripts are persisted to a file; the path is returned so you can edit + re-invoke with `scriptPath`.",
      "Runs in the background by default and delivers a notification on completion. Built-in async hooks: agent, parallel, pipeline, workflow, phase, log, args, failures.",
    ].join("\n"),
    promptSnippet: "Fan work out across parallel subagents — prefer this for any multi-part/parallelizable task.",
    // Collapse the call/result in the transcript unless the shared `tool-view`
    // flag is `verbose` (or the row is expanded), matching the tool minimizer.
    renderShell: "self",
    renderCall(args, theme, ctx) {
      const full = ctx.expanded || readToolViewMode() === "verbose";
      return renderWorkflowCall(args, theme, ctx, full);
    },
    renderResult(result, options, theme, ctx) {
      const full = options.expanded || readToolViewMode() === "verbose";
      return renderWorkflowResult(result, theme, ctx, full);
    },
    promptGuidelines: [
      "Proactively prefer a Workflow whenever a task has independent parts you could split — don't wait to be asked. If you catch yourself about to do the same kind of step repeatedly (per file/module/service/item), fan it out with parallel() instead.",
      "Good fits: parallel code review, repo-wide search+summarize, batch refactors/migrations, generating tests or docs across many files, comparing approaches, multi-step pipelines. A quick planning phase() then parallel() agents usually beats sequential hand work.",
      "It does spawn multiple agents and use tokens, so match the agent count to the work (a handful for small jobs, more for big fan-outs) rather than avoiding it — the parallelism and isolated context windows are the point.",
      "Workflow agents run in-process with minimal tools by default: read,bash. Pass opts.tools to widen.",
      "Hooks (async): agent(task, opts) -> result; parallel(items, fn); pipeline(items, fns); workflow(script). Sync: phase(name); log(...); args(); failures().",
      "agent() returns null on failure (recorded in failures()). Pass opts.schema.required for JSON-shape validation + retry.",
      "Pass opts.worktree:true to run a write-heavy agent in its own git worktree (requires a git repo, auto torn down); opts.cwd sets a lightweight shared-tree subdir.",
      "Pass opts.mcp:true to give an agent a shared `mcp` gateway tool (MCP servers are connected once per process and reused across agents).",
      "Return a value from the script to set the workflow output. Pass background:false to wait for the result inline.",
    ],
    parameters: Type.Object({
      script: Type.Optional(Type.String({ description: "Inline JavaScript workflow script. Top-level await is supported." })),
      scriptPath: Type.Optional(Type.String({ description: "Path to a workflow script file (overrides script)." })),
      name: Type.Optional(Type.String({ description: "Name of a saved workflow under .pi/workflows or <agentDir>/workflows." })),
      args: Type.Optional(Type.Unknown({ description: "JSON value exposed to the script via args()." })),
      timeoutMs: Type.Optional(Type.Integer({ description: `Overall workflow timeout. Default ${DEFAULT_WORKFLOW_TIMEOUT_MS}ms.`, minimum: 1_000 })),
      background: Type.Optional(Type.Boolean({ description: "Run in background and notify on completion (default true)." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (ctx.hasUI) deliveryContext = ctx;
      const resolved = resolveScript(ctx.cwd, params);
      const runId = randomUUID().slice(0, 8);
      const runDir = runDirFor(runId);
      try { fs.mkdirSync(runDir, { recursive: true }); } catch { /* best-effort */ }
      const background = params.background ?? true;
      const timeoutMs = params.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS;

      const controller = new AbortController();
      const runEntry: RunningWorkflow = { runId, controller, origin: resolved.origin, startedAt: Date.now() };
      runningWorkflows.set(runId, runEntry);
      const view = createWorkflowView(ctx, runId, resolved.origin);

      // Classify why a run ended: an explicit stop (tool/command) or a turn abort
      // is "cancelled"; the overall timeout is a "failed"; anything else is a
      // genuine error.
      const classifyFailure = (error: unknown): "failed" | "cancelled" => {
        // Resource cleanup failures are real failures even when cancellation
        // initiated cleanup; reporting only "cancelled" would hide the leak.
        if (error instanceof WorktreeStartupCleanupError) return "failed";
        // Prefer an explicit stop over a racing timeout so a user cancel is never
        // mislabeled as a failure.
        if (runEntry.stopped) return "cancelled";
        if (runEntry.timedOut) return "failed";
        if (!background && signal?.aborted) return "cancelled";
        return "failed";
      };

      // The message to report for a non-cancelled failure (surfaces timeouts distinctly).
      const failureMessage = (error: unknown): string =>
        error instanceof WorktreeStartupCleanupError
          ? error.message
          : runEntry.timedOut
            ? `workflow timed out after ${timeoutMs}ms`
            : error instanceof Error ? error.message : String(error);

      const execRun = async (emit: (message: string) => void): Promise<WorkflowResult> => {
        const linked = linkSignals(background ? undefined : signal, controller.signal);
        const timer = setTimeout(() => {
          runEntry.timedOut = true;
          controller.abort(new Error(`workflow timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const runner = new WorkflowRunner(ctx.cwd, params.args, linked.signal, emit, runSubagentInProcess, view.onState, runId, resolved.origin, runDir, timeoutMs);
        view.start();
        try {
          const output = await runner.run(resolved.script);
          return { runId, scriptPath: resolved.scriptPath, runDir, output, usage: runner.usage, agents: runner.launchedCount, failures: runner.failuresList };
        } catch (error) {
          // The runner's worker deadline also catches loops that prevent the
          // script thread itself from observing cancellation.
          if (isScriptExecutionTimeout(error)) {
            runEntry.timedOut = true;
            controller.abort(new Error(`workflow timed out after ${timeoutMs}ms`));
          }
          throw error;
        } finally {
          clearTimeout(timer);
          // Abort the shared signal so any still-in-flight sibling subagents are
          // cancelled on a terminal error (not just on stop/timeout). No-op on a
          // clean finish (nothing is running).
          controller.abort();
          linked.dispose();
          runningWorkflows.delete(runId);
        }
      };

      if (!background) {
        try {
          const result = await execRun((message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }));
          view.finish("completed", result);
          return { content: [{ type: "text", text: formatSummary(result) }], details: result };
        } catch (error) {
          const outcome = classifyFailure(error);
          view.finish(outcome);
          if (outcome === "cancelled") {
            const message = runEntry.stopReason ?? "workflow cancelled";
            return { content: [{ type: "text", text: `Workflow ${runId} ${message}.` }], details: { runId, status: "cancelled", reason: message } };
          }
          if (runEntry.timedOut && !(error instanceof WorktreeStartupCleanupError)) {
            throw new Error(`workflow timed out after ${timeoutMs}ms`);
          }
          throw error;
        }
      }

      // Background: kick off, return immediately, notify on completion.
      void execRun(() => {})
        .then((result) => {
          view.finish("completed", result);
          deliverCompletion(result, undefined);
        })
        .catch((error) => {
          const outcome = classifyFailure(error);
          view.finish(outcome);
          const message = outcome === "cancelled" ? runEntry.stopReason ?? "workflow cancelled" : failureMessage(error);
          deliverCompletion(undefined, { runId, error: message, cancelled: outcome === "cancelled" });
        });

      const ack = `Workflow ${runId} started in the background (${resolved.origin}). A notification will arrive on completion (or stop it with stop_workflow runId=${runId}). Script: ${resolved.scriptPath}. Live artifacts (read/grep as needed): ${runDir} (events.log timeline + agents/ per-agent transcripts).`;
      return { content: [{ type: "text", text: ack }], details: { runId, status: "running", scriptPath: resolved.scriptPath, runDir } };
    },
  });

  pi.registerTool({
    name: "stop_workflow",
    label: "Stop workflow",
    description: "Stop a running background workflow by runId (or all running workflows). In-flight subagents are aborted.",
    promptSnippet: "Cancel a running background workflow.",
    promptGuidelines: [
      "Use to cancel a running background Workflow the user no longer wants; it aborts in-flight subagents.",
      "Pass runId to stop one run, or omit it (or pass 'all') to stop every running workflow.",
    ],
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "Workflow runId to stop. Omit or pass 'all' to stop every running workflow." })),
      reason: Type.Optional(Type.String({ description: "Optional human-readable reason recorded on the run." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (ctx.hasUI) deliveryContext = ctx;
      const reason = params.reason?.trim() || "stopped by request";
      if (!params.runId || params.runId.trim() === "" || params.runId.trim().toLowerCase() === "all") {
        const count = stopAllWorkflows(reason);
        const text = count > 0 ? `Stopping ${count} running workflow${count === 1 ? "" : "s"}.` : "No running workflows.";
        return { content: [{ type: "text", text }], details: { stopped: count } };
      }
      const id = params.runId.trim();
      const ok = stopWorkflow(id, reason);
      const running = [...runningWorkflows.keys()];
      const text = ok
        ? `Stopping workflow ${id}.`
        : `No running workflow ${id}.${running.length ? ` Running: ${running.join(", ")}.` : ""}`;
      return { content: [{ type: "text", text }], details: { stopped: ok ? 1 : 0, runId: id } };
    },
  });

}

interface ResolvedScript {
  script: string;
  scriptPath: string;
  origin: string;
}

function resolveScript(cwd: string, params: { script?: string; scriptPath?: string; name?: string }): ResolvedScript {
  if (params.scriptPath) {
    const resolvedPath = path.resolve(cwd, params.scriptPath);
    return { script: fs.readFileSync(resolvedPath, "utf8"), scriptPath: resolvedPath, origin: `scriptPath ${params.scriptPath}` };
  }
  if (params.name) {
    const candidates = [
      path.join(cwd, ".pi", "workflows", `${params.name}.js`),
      path.join(getAgentDir(), "workflows", `${params.name}.js`),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) throw new Error(`Workflow "${params.name}" not found in ${candidates.join(" or ")}.`);
    return { script: fs.readFileSync(found, "utf8"), scriptPath: found, origin: `name ${params.name}` };
  }
  if (params.script && params.script.trim()) {
    const scriptPath = persistInlineScript(params.script);
    return { script: params.script, scriptPath, origin: "inline" };
  }
  throw new Error("Workflow requires one of: script, scriptPath, or name.");
}

function persistInlineScript(script: string): string {
  const dir = path.join(getAgentDir(), "workflows", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}.js`);
  fs.writeFileSync(filePath, script, "utf8");
  return filePath;
}

function deliverCompletion(result: WorkflowResult | undefined, failure: { runId: string; error: string; cancelled?: boolean } | undefined): void {
  const cancelled = failure?.cancelled === true;
  const verb = cancelled ? "cancelled" : "failed";
  const content = result
    ? `<workflow-notification>\nWorkflow ${result.runId} completed.\n${formatSummary(result)}\n</workflow-notification>`
    : `<workflow-notification>\nWorkflow ${failure?.runId} ${verb}: ${failure?.error}\n</workflow-notification>`;
  const details: WorkflowNotificationDetails = result
    ? { runId: result.runId, status: "completed", agents: result.agents, failures: result.failures.length, usage: result.usage }
    : { runId: failure?.runId ?? "", status: cancelled ? "cancelled" : "failed", error: failure?.error };
  try {
    // A custom message (not a user message) keeps the full result in LLM context
    // while letting our registered renderer collapse it in the transcript.
    piApi?.sendMessage(
      { customType: WORKFLOW_NOTIFICATION_TYPE, content, display: true, details },
      { deliverAs: deliveryContext?.isIdle() ? "followUp" : "steer", triggerTurn: true },
    );
  } catch {
    // Delivery is best-effort; never throw from a background completion.
  }
}

/** Read the `tool-view` extension's persisted verbosity flag (shared minimize toggle). */
function readToolViewMode(): ToolViewMode {
  try {
    const raw = fs.readFileSync(path.join(getAgentDir(), "tool-view.json"), "utf8");
    const mode = (JSON.parse(raw) as { mode?: string }).mode;
    if (mode === "minimized" || mode === "medium" || mode === "verbose") return mode;
  } catch {
    // Missing/unreadable prefs — default to collapsed (minimized-like).
  }
  return "minimized";
}

interface QueueWaiter {
  resume: () => void;
}

interface SerializedWorkerError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
}

interface WorkerAgentCall {
  type: "agent";
  id: number;
  task: string;
  opts?: AgentOptions;
}

interface WorkerHookCall {
  type: "phase" | "log";
  value: string;
}

interface WorkerResult {
  type: "result";
  output: unknown;
}

interface WorkerFailure {
  type: "failure";
  error: SerializedWorkerError;
}

type WorkflowWorkerMessage = WorkerAgentCall | WorkerHookCall | WorkerResult | WorkerFailure;

type WorkflowWorktreeOptions = Parameters<typeof createWorktree>[1] & { signal?: AbortSignal };
type WorkflowWorktreeFactory = (
  sourceCwd: string,
  options: WorkflowWorktreeOptions,
) => Promise<Awaited<ReturnType<typeof createWorktree>>>;

/**
 * The complete script runtime. It deliberately lives in an eval worker so the
 * parent can terminate JavaScript even when it enters a loop after an await.
 * Hook calls cross the worker boundary; real agents remain in the parent.
 */
const WORKFLOW_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const { AsyncLocalStorage, createHook } = require("node:async_hooks");

const pendingRpc = new Map();
let nextRpcId = 1;
let failureSnapshot = [];

// Promise subclassing only sees chains derived directly from an agent promise;
// native/VM Promise combinators and async functions immediately escape it. Tag
// the whole script's async tree instead. Non-Promise resources are blockers,
// while Promise hook activity tells the stable-turn check that continuations
// are still running. A detached inert Promise is intentionally not a blocker:
// with no handle or RPC capable of resolving it, it has no work left to run.
const workflowScope = new AsyncLocalStorage();
const WORKFLOW_SCOPE = {};
const scriptResources = new Map();
let activityVersion = 0;
let activityWaiters = [];
let hasUnhandledRejection = false;
let firstUnhandledRejection;

function markActivity() {
  activityVersion++;
  const waiters = activityWaiters;
  activityWaiters = [];
  for (const resolve of waiters) resolve();
}

const asyncHook = createHook({
  init(asyncId, type) {
    if (workflowScope.getStore() !== WORKFLOW_SCOPE) return;
    scriptResources.set(asyncId, type);
    markActivity();
  },
  before(asyncId) {
    if (scriptResources.has(asyncId)) markActivity();
  },
  after(asyncId) {
    if (scriptResources.has(asyncId)) markActivity();
  },
  destroy(asyncId) {
    if (scriptResources.delete(asyncId)) markActivity();
  },
  promiseResolve(asyncId) {
    if (scriptResources.get(asyncId) === "PROMISE") {
      scriptResources.delete(asyncId);
      markActivity();
    }
  },
});
asyncHook.enable();

process.on("unhandledRejection", (reason) => {
  if (!hasUnhandledRejection) {
    hasUnhandledRejection = true;
    firstUnhandledRejection = reason;
  }
  markActivity();
});

function serializeError(error) {
  const object = error && (typeof error === "object" || typeof error === "function") ? error : undefined;
  return {
    name: object && typeof object.name === "string" ? object.name : "Error",
    message: object && typeof object.message === "string" ? object.message : String(error),
    stack: object && typeof object.stack === "string" ? object.stack : undefined,
    code: object && (typeof object.code === "string" || typeof object.code === "number") ? object.code : undefined,
  };
}

function deserializeError(error) {
  const result = new Error(error && error.message ? error.message : "workflow hook failed");
  if (error && error.name) result.name = error.name;
  if (error && error.stack) result.stack = error.stack;
  if (error && error.code !== undefined) result.code = error.code;
  return result;
}

function rpcAgent(task, opts) {
  const id = nextRpcId++;
  const promise = new Promise((resolve, reject) => pendingRpc.set(id, { resolve, reject }));
  parentPort.postMessage({ type: "agent", id, task, opts });
  markActivity();
  return promise;
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "agent-result") return;
  const pending = pendingRpc.get(message.id);
  if (!pending) return;
  pendingRpc.delete(message.id);
  if (Array.isArray(message.failures)) failureSnapshot = message.failures;
  markActivity();
  if (message.ok) pending.resolve(message.value);
  else pending.reject(deserializeError(message.error));
});

function stringifyLog(value) {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

const api = {
  agent: (task, opts) => rpcAgent(task, opts),
  parallel: async (items, fn) => Promise.all(items.map((item, index) => fn(item, index))),
  pipeline: async (items, fns) => Promise.all(items.map(async (item, index) => {
    let value = item;
    for (const fn of fns) value = await fn(value, index);
    return value;
  })),
  workflow: (script) => executeScript(script),
  phase: (name) => { parentPort.postMessage({ type: "phase", value: name }); },
  log: (...values) => { parentPort.postMessage({ type: "log", value: values.map(stringifyLog).join(" ") }); },
  args: () => workerData.args,
  failures: () => failureSnapshot.map((failure) => ({ ...failure })),
};

async function executeScript(script) {
  const context = vm.createContext({
    ...api,
    console: { log: api.log, error: api.log },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
  });
  const wrapped = "(async () => {\n" + script + "\n})()";
  return await new vm.Script(wrapped, { filename: "workflow.vm.js" }).runInContext(context);
}

function blockerCount() {
  let count = pendingRpc.size;
  for (const type of scriptResources.values()) {
    if (type !== "PROMISE") count++;
  }
  return count;
}

function nextEventLoopTurn() {
  return workflowScope.exit(() => new Promise((resolve) => setImmediate(resolve)));
}

function waitForActivity(observedVersion) {
  return workflowScope.exit(() => new Promise((resolve) => {
    if (activityVersion !== observedVersion) resolve();
    else activityWaiters.push(resolve);
  }));
}

function throwUnhandledRejection() {
  if (hasUnhandledRejection) throw firstUnhandledRejection;
}

async function waitForQuiescence() {
  let observedVersion = activityVersion;
  let stableTurns = 0;
  while (stableTurns < 2) {
    throwUnhandledRejection();
    if (blockerCount() > 0) {
      stableTurns = 0;
      await waitForActivity(observedVersion);
      observedVersion = activityVersion;
      continue;
    }

    // Promise reactions and unhandledRejection are observable before/around an
    // event-loop turn. Require two turns with no script activity so chains that
    // enqueue more native continuations cannot race the result message.
    await nextEventLoopTurn();
    throwUnhandledRejection();
    const currentVersion = activityVersion;
    if (blockerCount() === 0 && currentVersion === observedVersion) stableTurns++;
    else stableTurns = 0;
    observedVersion = currentVersion;
  }
  throwUnhandledRejection();
}

void (async () => {
  try {
    const execution = workflowScope.run(WORKFLOW_SCOPE, () => executeScript(workerData.script));
    const output = await execution;
    await waitForQuiescence();
    asyncHook.disable();
    parentPort.postMessage({ type: "result", output });
  } catch (error) {
    asyncHook.disable();
    parentPort.postMessage({ type: "failure", error: serializeError(error) });
  }
})();
`;

export class WorkflowRunner {
  launchedCount = 0;
  usage: UsageStats = emptyUsageStats();
  currentPhase?: string;
  rateLimited = false;
  readonly startedAt = Date.now();
  readonly phases: string[] = [];
  private active = 0;
  private lastMessage?: string;
  private readonly queue: QueueWaiter[] = [];
  private readonly failures: Failure[] = [];
  private readonly agentViews = new Map<number, WorkflowAgentView>();
  private readonly agentPromises = new Set<Promise<unknown>>();
  private readonly executorPromises = new Set<Promise<SubagentResult>>();
  private readonly runController = new AbortController();
  private readonly externalSignal: AbortSignal;
  /** Agents are aborted only after the script worker has been terminated. */
  private readonly runSignal: AbortSignal;
  private readonly scriptDeadline: number;
  private hasCallbackFailure = false;
  private callbackFailure: unknown;
  private worktreeStartupCleanupFailure?: WorktreeStartupCleanupError;
  /** Disposal failures may reject an RPC that workflow code catches, but remain terminal. */
  private worktreeDisposalFailure?: Error;

  constructor(
    private readonly cwd: string,
    private readonly workflowArgs: unknown,
    signal: AbortSignal,
    private readonly progress: (message: string) => void,
    private readonly executor: AgentExecutor,
    private readonly onState: (snap: WorkflowSnapshot) => void = () => {},
    private readonly runId: string = "",
    private readonly origin: string = "",
    /** When set, an `events.log` timeline is appended here and agent transcripts land in `<logDir>/agents/`. */
    private readonly logDir?: string,
    /** Bounds all worker execution, including loops entered after an await. */
    scriptTimeoutMs: number = DEFAULT_WORKFLOW_TIMEOUT_MS,
    /** Test seam; production uses the shared worktree implementation. */
    private readonly worktreeFactory: WorkflowWorktreeFactory = createWorktree,
  ) {
    this.externalSignal = signal;
    this.runSignal = this.runController.signal;
    this.scriptDeadline = this.startedAt + Math.max(1, scriptTimeoutMs);
  }

  /** Append one timestamped line to the run's `events.log` (best-effort; file-only). */
  private writeLog(line: string): void {
    if (!this.logDir) return;
    try {
      fs.appendFileSync(path.join(this.logDir, "events.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Logging is best-effort; never let it break a run.
    }
  }

  get failuresList(): Failure[] {
    return [...this.failures];
  }

  /** Structured view of the run for live rendering. */
  snapshot(): WorkflowSnapshot {
    return {
      runId: this.runId,
      origin: this.origin,
      startedAt: this.startedAt,
      status: "running",
      phase: this.currentPhase,
      phases: [...this.phases],
      agents: [...this.agentViews.values()].sort((a, b) => a.index - b.index),
      active: this.active,
      queued: this.queue.length,
      launched: this.launchedCount,
      usage: this.usage,
      failures: this.failures.length,
      rateLimited: this.rateLimited,
      lastMessage: this.lastMessage,
    };
  }

  private captureCallbackFailure(error: unknown): void {
    if (this.hasCallbackFailure) return;
    this.hasCallbackFailure = true;
    this.callbackFailure = error;
  }

  private throwCallbackFailure(): void {
    if (this.hasCallbackFailure) throw this.callbackFailure;
  }

  private touch(): void {
    try {
      this.onState(this.snapshot());
    } catch (error) {
      this.captureCallbackFailure(error);
      throw error;
    }
  }

  /** Emit a human-readable progress line and refresh the live snapshot. */
  private emit(message: string): void {
    this.lastMessage = message;
    try {
      this.progress(message);
    } catch (error) {
      this.captureCallbackFailure(error);
      throw error;
    }
    this.writeLog(message);
    this.touch();
  }

  async run(script: string): Promise<unknown> {
    try {
      this.throwIfAborted();
      const output = await this.executeScriptWorker(script);
      // The worker tracks detached agent chains, while this final parent-side
      // join protects against a response/termination race at the RPC boundary.
      await this.joinAgents();
      if (this.worktreeStartupCleanupFailure) throw this.worktreeStartupCleanupFailure;
      if (this.worktreeDisposalFailure) throw this.worktreeDisposalFailure;
      this.throwCallbackFailure();
      this.throwIfAborted();
      return output;
    } catch (error) {
      // executeScriptWorker does not reject for cancellation until terminate()
      // has completed. Only then do we abort and drain real parent-side agents.
      this.runController.abort(error);
      const forcedTermination = this.externalSignal.aborted || isScriptExecutionTimeout(error);
      // Production agent executions are always fully drained. The bounded path
      // only preserves recoverability for injected executors that ignore abort.
      await this.drainAgents(forcedTermination && this.executor !== runSubagentInProcess);
      // Cancellation is not allowed to hide a failed cleanup that may have left
      // a worktree behind. Callback failures are likewise terminal even if
      // workflow code happened to catch the affected hook/RPC rejection.
      if (this.worktreeStartupCleanupFailure) throw this.worktreeStartupCleanupFailure;
      if (this.worktreeDisposalFailure) throw this.worktreeDisposalFailure;
      this.throwCallbackFailure();
      throw error;
    }
  }

  private async executeScriptWorker(script: string): Promise<unknown> {
    const remainingMs = Math.floor(this.scriptDeadline - Date.now());
    if (remainingMs <= 0) throw scriptExecutionTimeoutError();
    if (this.externalSignal.aborted) throw this.abortError(this.externalSignal);

    return await new Promise<unknown>((resolve, reject) => {
      const worker = new Worker(WORKFLOW_WORKER_SOURCE, {
        eval: true,
        name: this.runId ? `workflow-${this.runId}` : "workflow",
        workerData: { script, args: this.workflowArgs },
      });
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        this.externalSignal.removeEventListener("abort", onAbort);
        worker.removeListener("message", onMessage);
        worker.removeListener("error", onError);
        worker.removeListener("exit", onExit);
      };

      type WorkerOutcome = { ok: true; output: unknown } | { ok: false; error: unknown };
      const finish = (outcome: WorkerOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        void worker.terminate().then(
          () => outcome.ok ? resolve(outcome.output) : reject(outcome.error),
          (terminationError) => reject(outcome.ok ? terminationError : outcome.error),
        );
      };
      const fail = (error: unknown): void => finish({ ok: false, error });

      const onAbort = (): void => fail(this.abortError(this.externalSignal));
      const onError = (error: Error): void => fail(error);
      const onExit = (code: number): void => {
        if (!settled) fail(new Error(`workflow worker exited before returning a result (code ${code})`));
      };
      const onMessage = (message: WorkflowWorkerMessage): void => {
        try {
          if (!message || typeof message !== "object") return;
          if (message.type === "agent") {
            // Callback exceptions inside asynchronous agent state/progress paths
            // are promoted to a worker-fatal error by handleWorkerAgentCall.
            void this.handleWorkerAgentCall(worker, message).catch(fail);
            return;
          }
          if (message.type === "phase") {
            this.currentPhase = message.value;
            if (!this.phases.includes(message.value)) this.phases.push(message.value);
            this.emit(`▸ phase: ${message.value}`);
            return;
          }
          if (message.type === "log") {
            this.emit(message.value);
            return;
          }
          if (message.type === "failure") {
            fail(deserializeWorkerError(message.error));
            return;
          }
          if (message.type === "result") finish({ ok: true, output: message.output });
        } catch (error) {
          // EventEmitter does not turn listener exceptions into worker "error"
          // events. Catch here so hook callback failures reject run() instead of
          // escaping as process-level uncaughtException.
          fail(error);
        }
      };

      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      this.externalSignal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => fail(scriptExecutionTimeoutError()), Math.max(1, Math.min(2_147_483_647, remainingMs)));
      timer.unref?.();
      // Close the race between the pre-construction check and listener setup.
      if (this.externalSignal.aborted) onAbort();
    });
  }

  private async handleWorkerAgentCall(worker: Worker, call: WorkerAgentCall): Promise<void> {
    const promise = this.trackAgent(this.agent(call.task, call.opts));
    try {
      const value = await promise;
      this.postWorkerMessage(worker, { type: "agent-result", id: call.id, ok: true, value, failures: this.failuresList });
    } catch (error) {
      // Progress/state callbacks are runner infrastructure, not workflow RPC
      // failures that script code may suppress with try/catch.
      if (this.hasCallbackFailure) throw this.callbackFailure;
      this.postWorkerMessage(worker, {
        type: "agent-result",
        id: call.id,
        ok: false,
        error: serializeWorkerError(error),
        failures: this.failuresList,
      });
    }
  }

  private postWorkerMessage(worker: Worker, message: unknown): void {
    try {
      worker.postMessage(message);
    } catch {
      // The script may have been terminated while an agent was settling. The
      // parent still owns and drains that agent promise.
    }
  }

  private async joinAgents(): Promise<void> {
    for (;;) {
      const promises = [...this.agentPromises];
      // The worker owns RPC rejection semantics. If workflow code caught an
      // agent rejection, this defensive parent join must not throw it again.
      await Promise.allSettled(promises);
      if (this.agentPromises.size === promises.length) return;
    }
  }

  private async drainAgents(bounded: boolean): Promise<void> {
    const drain = async (): Promise<void> => {
      for (;;) {
        const agents = [...this.agentPromises];
        const executions = [...this.executorPromises];
        await Promise.allSettled([...agents, ...executions]);
        if (this.agentPromises.size === agents.length && this.executorPromises.size === executions.length) return;
      }
    };
    if (!bounded) {
      await drain();
      return;
    }

    // Real executors normally settle promptly after their signal aborts. Keep a
    // finite escape hatch for injected/broken executors that ignore cancellation.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        drain(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, EXTERNAL_AGENT_DRAIN_GRACE_MS); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private trackAgent(promise: Promise<unknown>): Promise<unknown> {
    this.agentPromises.add(promise);
    // The worker receives the rejection over RPC; this parent-side handler also
    // guarantees a detached call can never emit unhandledRejection here.
    void promise.catch(() => {});
    return promise;
  }

  private trackExecution(promise: Promise<SubagentResult>): Promise<SubagentResult> {
    this.executorPromises.add(promise);
    void promise.catch(() => {});
    return promise;
  }

  private withAbort<T>(promise: Promise<T>, signal: AbortSignal = this.runSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(this.abortError(signal));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(this.abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private abortError(signal: AbortSignal = this.runSignal): Error {
    return new Error("workflow aborted", { cause: signal.reason });
  }

  private throwIfAborted(): void {
    if (this.runSignal.aborted) throw this.abortError(this.runSignal);
    if (this.externalSignal.aborted) throw this.abortError(this.externalSignal);
  }

  private async agent(task: string, opts: AgentOptions = {}): Promise<unknown> {
    this.throwIfAborted();
    if (++this.launchedCount > MAX_AGENTS) throw new Error(`workflow agent cap exceeded (${MAX_AGENTS})`);
    const index = this.launchedCount - 1;
    const label = opts.label ?? `#${index}`;
    const maxRetries = Math.max(0, opts.retries ?? 2);
    const baseCwd = opts.cwd ? path.resolve(this.cwd, opts.cwd) : this.cwd;

    const view: WorkflowAgentView = { index, label, phase: this.currentPhase, status: "queued", attempt: 0, maxRetries };
    this.agentViews.set(index, view);
    this.touch();

    await this.acquire();
    let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
    let succeeded = false;
    try {
      // Cancellation may happen while this agent is queued. Do not provision a
      // worktree (or start any other expensive work) after its slot arrives.
      this.throwIfAborted();
      let effectiveCwd = baseCwd;
      if (opts.worktree) {
        try {
          // The shared worktree semaphore/provisioner uses this signal to remove
          // cancelled queue entries and stop in-progress setup.
          worktree = await this.worktreeFactory(baseCwd, { worktreeOverride: true, signal: this.runSignal });
        } catch (error) {
          if (error instanceof WorktreeStartupCleanupError) {
            this.worktreeStartupCleanupFailure ??= error;
            const reason = this.recordFailure(index, opts.label, error.message);
            view.status = "failed";
            view.finishedAt = Date.now();
            view.reason = reason;
            this.emit(`agent ${label} failed: ${reason}`);
            throw error;
          }
          if (this.runSignal.aborted || this.externalSignal.aborted) this.throwIfAborted();
          const detail = error instanceof Error ? error.message : String(error);
          // Non-git cwd is the common case; rephrase around worktree for the workflow author.
          throw new Error(
            /not inside one|requires a git repository/i.test(detail)
              ? `agent ${label}: worktree:true needs a git repository, but "${baseCwd}" is not inside one. Run the workflow from a git repo, or drop worktree to use the shared working directory.`
              : `agent ${label}: could not create a dedicated git worktree: ${detail}`,
          );
        }
        effectiveCwd = worktree.cwd;
        this.throwIfAborted();
      }
      view.status = "running";
      view.startedAt = Date.now();
      this.emit(`agent ${label} started`);
      let lastReason = "no result";
      let prompt = task;
      // Persist each agent's full transcript into <logDir>/agents/ so it can be
      // read/grepped after the fact. Filenames are timestamp-prefixed; the
      // events.log mapping line below ties an agent label/index to its file.
      const sessionDir = this.logDir ? path.join(this.logDir, "agents") : undefined;
      const sessionId = this.logDir ? `${this.runId || "run"}-a${index}` : undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        view.status = "running";
        const result = await this.runWith429Backoff(prompt, opts, effectiveCwd, sessionDir, sessionId);
        this.usage = addUsage(this.usage, result.usage);
        if (result.sessionFile) this.writeLog(`agent ${label} (#${index}) transcript: agents/${path.basename(result.sessionFile)}`);
        // A workflow-level abort (external cancel or the overall timeout) cancels
        // in-flight agents via the shared signal. Surface it as a rejection so the
        // run fails loudly instead of resolving with silent nulls. A *per-agent*
        // timeout (signal not aborted) is a recorded failure, not a workflow abort.
        this.throwIfAborted();
        if (result.error) {
          // opts.retries is exclusively for schema correction. Ordinary executor
          // failures get the separate 429 backoff policy, but are never rerun here.
          lastReason = result.error.message;
          break;
        }
        const value = result.structuredOutput ?? result.output;
        const schemaError = validateSchema(value, opts.schema);
        if (!schemaError) {
          succeeded = true;
          view.status = "completed";
          view.finishedAt = Date.now();
          this.emit(`agent ${label} completed`);
          return value;
        }
        lastReason = schemaError;
        if (attempt >= maxRetries) break;
        prompt = `${task}\n\nYour previous response was rejected: ${schemaError}. Return only valid JSON matching the required shape.`;
        view.status = "retrying";
        view.attempt = attempt + 1;
        this.emit(`agent ${label} retry ${attempt + 1}/${maxRetries}: ${schemaError}`);
      }
      const failureReason = this.recordFailure(index, opts.label, lastReason);
      view.status = "failed";
      view.finishedAt = Date.now();
      view.reason = failureReason;
      this.emit(`agent ${label} failed: ${failureReason}`);
      return null;
    } finally {
      try {
        if (worktree) {
          try {
            await worktree.dispose(succeeded ? "completed" : "failed");
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const reason = this.recordFailure(index, opts.label, `worktree disposal failed: ${detail}`);
            const terminalFailure = new Error(`agent ${label}: ${reason}`, { cause: error });
            // Script code can catch the rejected agent() RPC, but a failed
            // worktree cleanup is runner infrastructure and must still fail
            // the overall workflow after all parent-owned agents are drained.
            this.worktreeDisposalFailure ??= terminalFailure;
            view.status = "failed";
            view.finishedAt = Date.now();
            view.reason = reason;
            this.emit(`agent ${label} failed: ${reason}`);
            throw terminalFailure;
          }
        }
      } finally {
        this.release();
      }
    }
  }

  private recordFailure(index: number, label: string | undefined, reason: string): string {
    const existing = this.failures.find((failure) => failure.index === index);
    if (!existing) {
      this.failures.push({ index, label, reason });
      return reason;
    }
    if (!existing.reason.includes(reason)) existing.reason = `${existing.reason}; ${reason}`;
    return existing.reason;
  }

  private async runWith429Backoff(task: string, opts: AgentOptions, cwd: string, sessionDir?: string, sessionId?: string) {
    for (let attempt = 0; ; attempt++) {
      const execution = this.trackExecution(this.executor({
        task,
        cwd,
        tools: opts.tools ?? DEFAULT_WORKFLOW_TOOLS,
        systemPrompt: opts.systemPrompt,
        timeoutMs: opts.timeoutMs,
        mcp: opts.mcp,
        signal: this.runSignal,
        sessionDir,
        sessionId,
      }));
      const result = await this.withAbort(execution);
      if (result.error && isRateLimit(result.error.message) && attempt < MAX_429_RETRIES) {
        const delayMs = Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        this.rateLimited = true;
        this.emit(`rate-limited; backing off ${delayMs}ms`);
        await delay(delayMs, this.runSignal);
        this.rateLimited = false;
        this.touch();
        continue;
      }
      return result;
    }
  }

  private async acquire(): Promise<void> {
    this.throwIfAborted();
    if (this.active < DEFAULT_CONCURRENCY) {
      this.active++;
      return;
    }
    // Wait for a slot. release() hands its slot directly to the next waiter
    // (without decrementing), so we must NOT increment again on resume —
    // otherwise a fresh acquire() in the handoff window could over-subscribe.
    await new Promise<void>((resolve, reject) => {
      let waiter: QueueWaiter;
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.runSignal.removeEventListener("abort", onAbort);
        try {
          this.touch();
        } catch (error) {
          // AbortSignal listener exceptions are otherwise rethrown by Node on a
          // later tick as uncaughtException. Route this through the waiter.
          reject(error);
          return;
        }
        reject(this.abortError());
      };
      waiter = {
        resume: () => {
          this.runSignal.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      this.queue.push(waiter);
      this.runSignal.addEventListener("abort", onAbort, { once: true });
      // Close the race between the initial check and listener registration.
      if (this.runSignal.aborted) onAbort();
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next.resume(); // transfer the held slot to the waiter; active is unchanged
    } else {
      this.active = Math.max(0, this.active - 1);
    }
    this.touch();
  }
}

function serializeWorkerError(error: unknown): SerializedWorkerError {
  const object = error && (typeof error === "object" || typeof error === "function")
    ? error as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown }
    : undefined;
  return {
    name: typeof object?.name === "string" ? object.name : "Error",
    message: typeof object?.message === "string" ? object.message : String(error),
    stack: typeof object?.stack === "string" ? object.stack : undefined,
    code: typeof object?.code === "string" || typeof object?.code === "number" ? object.code : undefined,
  };
}

function deserializeWorkerError(serialized: SerializedWorkerError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack) error.stack = serialized.stack;
  if (serialized.code !== undefined) (error as NodeJS.ErrnoException).code = String(serialized.code);
  return error;
}

function scriptExecutionTimeoutError(): Error {
  const error = new Error("Script execution timed out");
  (error as NodeJS.ErrnoException).code = "ERR_SCRIPT_EXECUTION_TIMEOUT";
  return error;
}

function isScriptExecutionTimeout(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
}

function validateSchema(value: unknown, schema?: AgentSchema): string | undefined {
  if (!schema) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `expected a JSON object${schema.description ? ` (${schema.description})` : ""}`;
  }
  const missing = (schema.required ?? []).filter((key) => !(key in (value as Record<string, unknown>)));
  if (missing.length > 0) return `missing required keys: ${missing.join(", ")}`;
  return undefined;
}

function isRateLimit(message: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(message);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function linkSignals(a: AbortSignal | undefined, b: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onA = () => controller.abort(a?.reason);
  const onB = () => controller.abort(b.reason);
  if (a?.aborted || b.aborted) controller.abort();
  a?.addEventListener("abort", onA, { once: true });
  b.addEventListener("abort", onB, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      a?.removeEventListener("abort", onA);
      b.removeEventListener("abort", onB);
    },
  };
}

interface WorkflowView {
  onState: (snap: WorkflowSnapshot) => void;
  start: () => void;
  finish: (status: "completed" | "failed" | "cancelled", result?: WorkflowResult) => void;
}

/**
 * Owns the live `belowEditor` dashboard for a single run.
 * Registers its widget once, then mutates the component and requests a render
 * on state/spinner updates. Re-registering would move the widget to the end of
 * pi's insertion-ordered widget map, making concurrent workflows swap places.
 * The finished view remains visible briefly, then is cleared.
 */
export function createWorkflowView(ctx: ExtensionContext, runId: string, origin: string): WorkflowView {
  const key = `workflow:${runId}`;
  let snap: WorkflowSnapshot | undefined;
  let frame = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let finished = false;
  let registered = false;
  let dashboard: WorkflowDashboard | undefined;
  let requestRender: (() => void) | undefined;

  const render = (): void => {
    if (!ctx.hasUI || !snap) return;
    if (dashboard) {
      dashboard.update(snap, frame);
      requestRender?.();
      return;
    }
    if (registered) return;

    registered = true;
    const initial = snap;
    // Dashboard widget only — no footer status line for workflows.
    ctx.ui.setWidget(key, (tui, theme) => {
      dashboard = new WorkflowDashboard(initial, theme, frame);
      requestRender = () => tui.requestRender();
      return dashboard;
    }, { placement: "belowEditor" });
  };

  const clear = (): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(key, undefined);
    registered = false;
    dashboard = undefined;
    requestRender = undefined;
  };

  return {
    onState: (next) => {
      snap = next;
      if (!finished) render();
    },
    start: () => {
      if (!ctx.hasUI || ticker) return;
      ticker = setInterval(() => {
        frame = (frame + 1) % 10;
        if (!finished) render();
      }, 120);
      ticker.unref?.();
    },
    finish: (status, result) => {
      finished = true;
      if (ticker) {
        clearInterval(ticker);
        ticker = undefined;
      }
      const base: WorkflowSnapshot = snap ?? {
        runId,
        origin,
        startedAt: Date.now(),
        status,
        phases: [],
        agents: [],
        active: 0,
        queued: 0,
        launched: result?.agents ?? 0,
        usage: result?.usage ?? emptyUsageStats(),
        failures: result?.failures.length ?? 0,
        rateLimited: false,
      };
      snap = {
        ...base,
        status,
        finishedAt: Date.now(),
        phase: undefined,
        active: 0,
        queued: 0,
        rateLimited: false,
        usage: result?.usage ?? base.usage,
        failures: result?.failures.length ?? base.failures,
      };
      render();
      const expiry = setTimeout(clear, FINISHED_WIDGET_VISIBLE_MS);
      expiry.unref?.();
    },
  };
}

function formatSummary(result: WorkflowResult): string {
  const lines = [
    `agents: ${result.agents}, failures: ${result.failures.length}`,
    `usage: ↑${result.usage.input} ↓${result.usage.output} turns=${result.usage.turns}${result.usage.cost ? ` $${result.usage.cost.toFixed(4)}` : ""}`,
    `artifacts: ${result.runDir} (events.log + agents/*.jsonl — read/grep for details)`,
    "",
    JSON.stringify(result.output, null, 2),
  ];
  return lines.join("\n");
}

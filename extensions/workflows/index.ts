import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type InProcessSubagentOptions, runSubagentInProcess } from "../subagents/core/in-process-runner.js";
import { addUsage, emptyUsageStats, type SubagentResult, type UsageStats } from "../subagents/core/types.js";
import { createWorktree } from "../subagents/workspace/create-worktree.js";
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
   * agents that must not share a working tree.
   */
  isolate?: boolean;
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
  output: unknown;
  usage: UsageStats;
  agents: number;
  failures: Failure[];
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
  status: "running" | "completed" | "failed";
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
/** Custom message type used for background completion notices (rendered collapsed). */
const WORKFLOW_NOTIFICATION_TYPE = "workflow-notification";
type ToolViewMode = "minimized" | "medium" | "verbose";
/** How long the finished dashboard lingers before it is cleared. */
const FINISHED_WIDGET_VISIBLE_MS = 8_000;

interface RunningWorkflow {
  runId: string;
  controller: AbortController;
}

let piApi: ExtensionAPI | undefined;
let deliveryContext: ExtensionContext | undefined;
const runningWorkflows = new Map<string, RunningWorkflow>();

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
  });

  pi.on("session_shutdown", async () => {
    for (const run of runningWorkflows.values()) run.controller.abort(new Error("session shutdown"));
    runningWorkflows.clear();
  });

  pi.registerTool({
    name: "Workflow",
    label: "Workflow",
    description: [
      "Execute a workflow script that orchestrates multiple in-process subagents.",
      "Provide the script via `script` (inline), `scriptPath` (a file), or `name` (a saved workflow).",
      "Inline scripts are persisted to a file; the path is returned so you can edit + re-invoke with `scriptPath`.",
      "Runs in the background by default and delivers a notification on completion. Built-in async hooks: agent, parallel, pipeline, workflow, phase, log, args, failures.",
    ].join("\n"),
    promptSnippet: "Run dynamic multi-agent workflows with an explicit user request.",
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
      "Use only when the user explicitly asks for multi-agent/workflow orchestration; it can spawn many agents and burn tokens.",
      "Workflow agents run in-process with minimal tools by default: read,bash. Pass opts.tools to widen.",
      "Hooks (async): agent(task, opts) -> result; parallel(items, fn); pipeline(items, fns); workflow(script). Sync: phase(name); log(...); args(); failures().",
      "agent() returns null on failure (recorded in failures()). Pass opts.schema.required for JSON-shape validation + retry.",
      "Pass opts.isolate:true to run a write-heavy agent in its own git worktree (auto torn down); opts.cwd sets a lightweight shared-tree subdir.",
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
      const background = params.background ?? true;
      const timeoutMs = params.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS;

      const controller = new AbortController();
      runningWorkflows.set(runId, { runId, controller });
      const view = createWorkflowView(ctx, runId, resolved.origin);

      const execRun = async (emit: (message: string) => void): Promise<WorkflowResult> => {
        const linked = linkSignals(background ? undefined : signal, controller.signal);
        const timer = setTimeout(() => controller.abort(new Error(`workflow timed out after ${timeoutMs}ms`)), timeoutMs);
        const runner = new WorkflowRunner(ctx.cwd, params.args, linked.signal, emit, runSubagentInProcess, view.onState, runId, resolved.origin);
        view.start();
        try {
          const output = await runner.run(resolved.script);
          return { runId, scriptPath: resolved.scriptPath, output, usage: runner.usage, agents: runner.launchedCount, failures: runner.failuresList };
        } finally {
          clearTimeout(timer);
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
          view.finish("failed");
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
          view.finish("failed");
          deliverCompletion(undefined, { runId, error: error instanceof Error ? error.message : String(error) });
        });

      const ack = `Workflow ${runId} started in the background (${resolved.origin}). A notification will arrive on completion. Script: ${resolved.scriptPath}`;
      return { content: [{ type: "text", text: ack }], details: { runId, status: "running", scriptPath: resolved.scriptPath } };
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

function deliverCompletion(result: WorkflowResult | undefined, failure: { runId: string; error: string } | undefined): void {
  const content = result
    ? `<workflow-notification>\nWorkflow ${result.runId} completed.\n${formatSummary(result)}\n</workflow-notification>`
    : `<workflow-notification>\nWorkflow ${failure?.runId} failed: ${failure?.error}\n</workflow-notification>`;
  const details: WorkflowNotificationDetails = result
    ? { runId: result.runId, status: "completed", agents: result.agents, failures: result.failures.length, usage: result.usage }
    : { runId: failure?.runId ?? "", status: "failed", error: failure?.error };
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

export class WorkflowRunner {
  launchedCount = 0;
  usage: UsageStats = emptyUsageStats();
  currentPhase?: string;
  rateLimited = false;
  readonly startedAt = Date.now();
  readonly phases: string[] = [];
  private active = 0;
  private lastMessage?: string;
  private readonly queue: Array<() => void> = [];
  private readonly failures: Failure[] = [];
  private readonly agentViews = new Map<number, WorkflowAgentView>();

  constructor(
    private readonly cwd: string,
    private readonly workflowArgs: unknown,
    private readonly signal: AbortSignal,
    private readonly progress: (message: string) => void,
    private readonly executor: AgentExecutor,
    private readonly onState: (snap: WorkflowSnapshot) => void = () => {},
    private readonly runId: string = "",
    private readonly origin: string = "",
  ) {}

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

  private touch(): void {
    this.onState(this.snapshot());
  }

  /** Emit a human-readable progress line and refresh the live snapshot. */
  private emit(message: string): void {
    this.lastMessage = message;
    this.progress(message);
    this.touch();
  }

  async run(script: string): Promise<unknown> {
    const api = {
      agent: (task: string, opts?: AgentOptions) => this.agent(task, opts),
      parallel: async <T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> =>
        Promise.all(items.map((item, index) => fn(item, index))),
      pipeline: async <T>(items: T[], fns: Array<(value: unknown, index: number) => Promise<unknown>>): Promise<unknown[]> =>
        Promise.all(items.map(async (item, index) => {
          let value: unknown = item;
          for (const fn of fns) value = await fn(value, index);
          return value;
        })),
      workflow: (nestedScript: string) => this.run(nestedScript),
      phase: (name: string) => {
        this.currentPhase = name;
        if (!this.phases.includes(name)) this.phases.push(name);
        this.emit(`▸ phase: ${name}`);
      },
      log: (...values: unknown[]) => this.emit(values.map(stringifyLog).join(" ")),
      args: () => this.workflowArgs,
      failures: () => this.failuresList,
    };
    // NOTE: sandboxing is intentionally out of scope for v1. The script is
    // trusted (model-authored on explicit user opt-in) and runs with codegen
    // available so async/await + closures work normally.
    const context = vm.createContext({ ...api, console: { log: api.log, error: api.log } });
    const wrapped = `(async () => {\n${script}\n})()`;
    return await new vm.Script(wrapped, { filename: "workflow.vm.js" }).runInContext(context);
  }

  private async agent(task: string, opts: AgentOptions = {}): Promise<unknown> {
    if (this.signal.aborted) throw new Error("workflow aborted");
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
      let effectiveCwd = baseCwd;
      if (opts.isolate) {
        worktree = await createWorktree(baseCwd, { worktreeOverride: true });
        effectiveCwd = worktree.cwd;
      }
      view.status = "running";
      view.startedAt = Date.now();
      this.emit(`agent ${label} started`);
      let lastReason = "no result";
      let prompt = task;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        view.status = "running";
        const result = await this.runWith429Backoff(prompt, opts, effectiveCwd);
        this.usage = addUsage(this.usage, result.usage);
        // A workflow-level abort (external cancel or the overall timeout) cancels
        // in-flight agents via the shared signal. Surface it as a rejection so the
        // run fails loudly instead of resolving with silent nulls. A *per-agent*
        // timeout (signal not aborted) is a recorded failure, not a workflow abort.
        if (this.signal.aborted) throw new Error("workflow aborted");
        if (result.error) {
          lastReason = result.error.message;
          if (result.error.reason === "timeout" || result.error.reason === "stop") break;
          continue;
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
        prompt = `${task}\n\nYour previous response was rejected: ${schemaError}. Return only valid JSON matching the required shape.`;
        view.status = "retrying";
        view.attempt = attempt + 1;
        this.emit(`agent ${label} retry ${attempt + 1}/${maxRetries}: ${schemaError}`);
      }
      this.failures.push({ index, label: opts.label, reason: lastReason });
      view.status = "failed";
      view.finishedAt = Date.now();
      view.reason = lastReason;
      this.emit(`agent ${label} failed: ${lastReason}`);
      return null;
    } finally {
      if (worktree) await worktree.dispose(succeeded ? "completed" : "failed").catch(() => {});
      this.release();
    }
  }

  private async runWith429Backoff(task: string, opts: AgentOptions, cwd: string) {
    for (let attempt = 0; ; attempt++) {
      const result = await this.executor({
        task,
        cwd,
        tools: opts.tools ?? DEFAULT_WORKFLOW_TOOLS,
        systemPrompt: opts.systemPrompt,
        timeoutMs: opts.timeoutMs,
        mcp: opts.mcp,
        signal: this.signal,
      });
      if (result.error && isRateLimit(result.error.message) && attempt < MAX_429_RETRIES) {
        const delayMs = Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        this.rateLimited = true;
        this.emit(`rate-limited; backing off ${delayMs}ms`);
        await delay(delayMs, this.signal);
        this.rateLimited = false;
        this.touch();
        continue;
      }
      return result;
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < DEFAULT_CONCURRENCY) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.queue.shift()?.();
    this.touch();
  }
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

function stringifyLog(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface WorkflowView {
  onState: (snap: WorkflowSnapshot) => void;
  start: () => void;
  finish: (status: "completed" | "failed", result?: WorkflowResult) => void;
}

/**
 * Owns the live `belowEditor` dashboard + footer status for a single run.
 * Re-renders on every state change and on a spinner tick while running; keeps
 * the finished view visible briefly, then clears it.
 */
function createWorkflowView(ctx: ExtensionContext, runId: string, origin: string): WorkflowView {
  const key = `workflow:${runId}`;
  let snap: WorkflowSnapshot | undefined;
  let frame = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let finished = false;

  const render = (): void => {
    if (!ctx.hasUI || !snap) return;
    const current = snap;
    ctx.ui.setStatus(key, workflowStatusLine(current));
    ctx.ui.setWidget(key, (_tui, theme) => new WorkflowDashboard(current, theme, frame), { placement: "belowEditor" });
  };

  const clear = (): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(key, undefined);
    ctx.ui.setWidget(key, undefined);
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

function workflowStatusLine(snap: WorkflowSnapshot): string {
  if (snap.status === "completed") return `workflow ${snap.runId}: done (${snap.launched} agents${snap.failures ? `, ${snap.failures} failed` : ""})`;
  if (snap.status === "failed") return `workflow ${snap.runId}: failed`;
  const running = snap.agents.filter((a) => a.status === "running" || a.status === "retrying").length;
  const done = snap.agents.filter((a) => a.status === "completed").length;
  return `workflow ${snap.runId}: ${running} running · ${done}/${snap.launched} done`;
}

function formatSummary(result: WorkflowResult): string {
  const lines = [
    `agents: ${result.agents}, failures: ${result.failures.length}`,
    `usage: ↑${result.usage.input} ↓${result.usage.output} turns=${result.usage.turns}${result.usage.cost ? ` $${result.usage.cost.toFixed(4)}` : ""}`,
    "",
    JSON.stringify(result.output, null, 2),
  ];
  return lines.join("\n");
}

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type InProcessSubagentOptions, runSubagentInProcess } from "../subagents/core/in-process-runner.js";
import { addUsage, emptyUsageStats, type SubagentResult, type UsageStats } from "../subagents/core/types.js";
import { createWorktree } from "../subagents/workspace/create-worktree.js";

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

const DEFAULT_WORKFLOW_TOOLS = ["read", "bash"];
const MAX_AGENTS = 100;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_WORKFLOW_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_429_RETRIES = 5;

interface RunningWorkflow {
  runId: string;
  controller: AbortController;
}

let piApi: ExtensionAPI | undefined;
let deliveryContext: ExtensionContext | undefined;
const runningWorkflows = new Map<string, RunningWorkflow>();

export default function workflowsExtension(pi: ExtensionAPI) {
  piApi = pi;

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

      const execRun = async (emit: (message: string) => void): Promise<WorkflowResult> => {
        const linked = linkSignals(background ? undefined : signal, controller.signal);
        const timer = setTimeout(() => controller.abort(new Error(`workflow timed out after ${timeoutMs}ms`)), timeoutMs);
        const runner = new WorkflowRunner(ctx.cwd, params.args, linked.signal, emit, runSubagentInProcess);
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
        const result = await execRun((message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }));
        return { content: [{ type: "text", text: formatSummary(result) }], details: result };
      }

      // Background: kick off, return immediately, notify on completion.
      void execRun(() => {})
        .then((result) => deliverCompletion(result, undefined))
        .catch((error) => deliverCompletion(undefined, { runId, error: error instanceof Error ? error.message : String(error) }));

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
  const message = result
    ? `<workflow-notification>\nWorkflow ${result.runId} completed.\n${formatSummary(result)}\n</workflow-notification>`
    : `<workflow-notification>\nWorkflow ${failure?.runId} failed: ${failure?.error}\n</workflow-notification>`;
  try {
    piApi?.sendUserMessage(message, { deliverAs: deliveryContext?.isIdle() ? "followUp" : "steer" });
  } catch {
    // Delivery is best-effort; never throw from a background completion.
  }
}

export class WorkflowRunner {
  launchedCount = 0;
  usage: UsageStats = emptyUsageStats();
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly failures: Failure[] = [];

  constructor(
    private readonly cwd: string,
    private readonly workflowArgs: unknown,
    private readonly signal: AbortSignal,
    private readonly progress: (message: string) => void,
    private readonly executor: AgentExecutor,
  ) {}

  get failuresList(): Failure[] {
    return [...this.failures];
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
      phase: (name: string) => this.progress(`▸ phase: ${name}`),
      log: (...values: unknown[]) => this.progress(values.map(stringifyLog).join(" ")),
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

    await this.acquire();
    let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
    let succeeded = false;
    try {
      let effectiveCwd = baseCwd;
      if (opts.isolate) {
        worktree = await createWorktree(baseCwd, { worktreeOverride: true });
        effectiveCwd = worktree.cwd;
      }
      this.progress(`agent ${label} started`);
      let lastReason = "no result";
      let prompt = task;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
          this.progress(`agent ${label} completed`);
          return value;
        }
        lastReason = schemaError;
        prompt = `${task}\n\nYour previous response was rejected: ${schemaError}. Return only valid JSON matching the required shape.`;
        this.progress(`agent ${label} retry ${attempt + 1}/${maxRetries}: ${schemaError}`);
      }
      this.failures.push({ index, label: opts.label, reason: lastReason });
      this.progress(`agent ${label} failed: ${lastReason}`);
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
        this.progress(`rate-limited; backing off ${delayMs}ms`);
        await delay(delayMs, this.signal);
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

function formatSummary(result: WorkflowResult): string {
  const lines = [
    `agents: ${result.agents}, failures: ${result.failures.length}`,
    `usage: ↑${result.usage.input} ↓${result.usage.output} turns=${result.usage.turns}${result.usage.cost ? ` $${result.usage.cost.toFixed(4)}` : ""}`,
    "",
    JSON.stringify(result.output, null, 2),
  ];
  return lines.join("\n");
}

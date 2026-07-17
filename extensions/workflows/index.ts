import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { emptyUsageStats, type UsageStats } from "../subagents/core/types.js";
import { pruneWorkflowRuns, type WorkflowInput, type WorkflowRunRecordV1, type WorkflowRunStatus } from "./core/index.js";
import { WorkflowEngine } from "./engine.js";
import { WorkflowDashboard } from "./ui/dashboard.js";
import { renderWorkflowNotification, type WorkflowNotificationDetails } from "./ui/notification.js";
import { renderWorkflowCall, renderWorkflowResult } from "./ui/tool-render.js";

export type WorkflowAgentStatus = "queued" | "running" | "retrying" | "completed" | "failed" | "cancelled";
export interface WorkflowAgentView {
  index: number; label: string; phase?: string; status: WorkflowAgentStatus; attempt: number; maxRetries: number;
  startedAt?: number; finishedAt?: number; reason?: string; activity?: string;
}
export interface WorkflowSnapshot {
  runId: string; origin: string; startedAt: number; finishedAt?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  phase?: string; phases: string[]; agents: WorkflowAgentView[];
  active: number; queued: number; launched: number;
  usage: Omit<UsageStats, "cost"> & { cost?: number };
  failures: number; rateLimited: boolean; lastMessage?: string;
}

const WORKFLOW_NOTIFICATION_TYPE = "workflow-notification";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_STATUS_LIMIT = 100;
type ToolViewMode = "minimized" | "medium" | "verbose";

export default function workflowsExtension(pi: ExtensionAPI) {
  const engine = new WorkflowEngine(pi, {
    runRoot: path.join(getAgentDir(), "workflows", "runs-v1"),
    workspaceRoot: path.join(getAgentDir(), "workflows", "workspace-v1"),
  });

  pi.registerMessageRenderer<WorkflowNotificationDetails>(WORKFLOW_NOTIFICATION_TYPE, (message, { expanded }, theme) => {
    return renderWorkflowNotification(message.details, typeof message.content === "string" ? message.content : "", expanded || readToolViewMode() === "verbose", theme);
  });

  pi.on("session_start", async (_event, ctx) => {
    engine.owners.bind(ctx);
    await engine.reconcileInterruptedRuns();
    await retryPendingNotifications(pi, engine, ctx);
    await pruneWorkflowRuns(engine.store).catch(() => {});
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await engine.shutdownOwner(ctx);
  });

  const workflowParameters = Type.Object({
    script: Type.Optional(Type.String({ description: "Inline JavaScript workflow source including required export const meta." })),
    scriptPath: Type.Optional(Type.String({ description: "Workflow source path." })),
    name: Type.Optional(Type.String({ description: "Qualified registry ID: builtin:<id>, user:<id>, or project:<id>." })),
    args: Type.Optional(Type.Unknown({ description: "Canonical JSON value exposed as immutable global args." })),
    budgetTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Root output-token dispatch budget." })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: DEFAULT_TIMEOUT_MS })),
    background: Type.Optional(Type.Boolean({ description: "Run in background (default true)." })),
    resumeFromRunId: Type.Optional(Type.String({ description: "Exact prior run UUID; valid only for resumable workflows." })),
  });

  pi.registerTool({
    name: "Workflow",
    label: "Workflow",
    description: [
      "Execute one metadata-declared local workflow with durable ownership and canonical hooks.",
      "Exactly one of script, scriptPath, or qualified name is required.",
      "Hooks: agent(prompt,{id,...}), parallel([thunks]), pipeline(items,...stages), workflow({name|scriptPath},childArgs), phase(id), log(), failures(), immutable args, budget.",
      "Operational leaf failures return null; script/contract/infrastructure failures fail the run.",
    ].join(" "),
    promptSnippet: "Run a durable local workflow using the canonical metadata-declared DSL.",
    promptGuidelines: [
      "Use Workflow only for substantial parallel or multi-stage work; prefer direct tools for focused sequential work.",
      "Every Workflow source must begin with pure-literal export const meta containing name, description, resumable, maxAgents, and capabilities.",
      "Workflow parallel accepts only an array of zero-argument thunks; pipeline accepts items followed by variadic stage functions.",
      "Every Workflow agent call requires a stable unique id and an explicit effects declaration when it writes or accesses external systems.",
      "Workflow args is immutable data, not a function; nested workflows require explicit {name} or {scriptPath} references.",
    ],
    parameters: workflowParameters,
    renderShell: "self",
    renderCall(args, theme, context) { return renderWorkflowCall(args, theme, context, context.expanded || readToolViewMode() === "verbose"); },
    renderResult(result, options, theme, context) { return renderWorkflowResult(result, theme, context, options.expanded || readToolViewMode() === "verbose"); },
    async execute(_id, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw abortReason(signal);
      const background = params.background ?? true;
      let view: WorkflowView | undefined;
      let latest: WorkflowRunRecordV1 | undefined;
      const launch = await engine.launch(params as WorkflowInput, ctx, false, (record) => {
        latest = record;
        view?.onState(projectSnapshot(record));
      });
      view = createWorkflowView(ctx, launch.runId, sourceLabel(params));
      if (latest) view.onState(projectSnapshot(latest));
      view.start();

      const finish = async (record: WorkflowRunRecordV1): Promise<void> => {
        view?.finish(projectSnapshot(record));
        await deliverNotification(pi, engine, record);
      };
      if (background) {
        void launch.completion.then(finish, async (error) => {
          const record = await engine.store.readRun(launch.runId).catch(() => undefined);
          if (record) await finish(record);
          else ctx.ui.notify(`Workflow ${launch.runId} failed: ${errorMessage(error)}`, "error");
        });
        return {
          content: [{ type: "text", text: `Workflow ${launch.runId} started. Durable status: workflow_status({runId:"${launch.runId}"}).` }],
          details: { runId: launch.runId, status: "running", runDir: engine.store.paths(launch.runId).runDir },
        };
      }

      const onAbort = () => { void engine.stop(launch.runId, ctx, "foreground tool call aborted"); };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const record = await launch.completion;
        await finish(record);
        return { content: [{ type: "text", text: formatRunSummary(record) }], details: resultDetails(record) };
      } finally { signal?.removeEventListener("abort", onAbort); }
    },
  });

  pi.registerTool({
    name: "workflow_status",
    label: "Workflow Status",
    description: "Query durable owner-scoped Workflow history. Exact runId returns detail; omission lists runs. scope:all is explicit.",
    promptSnippet: "Query durable Workflow status/history and bounded output previews.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String()),
      scope: Type.Optional(StringEnum(["owner", "all"] as const)),
      statuses: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_STATUS_LIMIT })),
      cursor: Type.Optional(Type.String()),
      include: Type.Optional(Type.Array(StringEnum(["agents", "failures", "artifacts", "output", "notification"] as const), { maxItems: 5 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const owner = engine.owners.bind(ctx);
      if (params.runId) {
        const scanned = (await engine.store.scan()).find((entry) => entry.runId === params.runId);
        if (!scanned) {
          const tombstone = await engine.store.readTombstone(params.runId);
          return tombstone
            ? textResult(`Workflow ${params.runId} expired and was pruned.`, { state: "expired", ...tombstone })
            : textResult(`Unknown workflow run ${params.runId}.`, { state: "unknown", runId: params.runId });
        }
        if (scanned.state !== "ok") return textResult(`Workflow ${params.runId} is ${scanned.state}: ${scanned.error}`, scanned);
        const record = scanned.record!;
        if (params.scope !== "all" && record.owner.sessionId !== owner.sessionId) return textResult(`Unknown workflow run ${params.runId}.`, { state: "unknown", runId: params.runId });
        const detail = statusProjection(record, new Set(params.include ?? []));
        return textResult(JSON.stringify(detail, null, 2), detail);
      }
      const statuses = new Set(params.statuses ?? []);
      const all = (await engine.store.scan())
        .filter((entry) => entry.state !== "ok" || params.scope === "all" || entry.record?.owner.sessionId === owner.sessionId)
        .filter((entry) => entry.state !== "ok" || statuses.size === 0 || statuses.has(entry.record!.status))
        .sort((a, b) => (b.record?.createdAt ?? 0) - (a.record?.createdAt ?? 0));
      const offset = decodeCursor(params.cursor);
      const page = all.slice(offset, offset + (params.limit ?? 20));
      const result = { runs: page.map((entry) => entry.state === "ok" ? statusProjection(entry.record!, new Set()) : entry), nextCursor: offset + page.length < all.length ? encodeCursor(offset + page.length) : undefined };
      return textResult(JSON.stringify(result, null, 2), result);
    },
  });

  pi.registerTool({
    name: "workflow_output",
    label: "Workflow Output",
    description: "Read a bounded encoded output artifact for one exact workflow run UUID.",
    parameters: Type.Object({ runId: Type.String(), maxBytes: Type.Optional(Type.Integer({ minimum: 1_024, maximum: 50_000 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const record = await engine.store.readRun(params.runId);
      if (record.owner.sessionId !== engine.owners.bind(ctx).sessionId) throw new Error("unknown workflow run");
      const output = JSON.stringify(await engine.store.readOutput(params.runId), null, 2);
      const max = params.maxBytes ?? 50_000;
      const bounded = Buffer.byteLength(output) <= max ? output : `${Buffer.from(output).subarray(0, max).toString("utf8")}\n[truncated; full artifact: ${record.output?.path}]`;
      return textResult(bounded, { runId: params.runId, output: record.output, truncated: bounded !== output });
    },
  });

  pi.registerTool({
    name: "workflow_control",
    label: "Workflow Control",
    description: "Reducer-driven Workflow controls. stop/pause target active runs; resume/retry create linked attempts.",
    promptSnippet: "Stop, pause, resume, or retry a durable Workflow run.",
    parameters: Type.Object({
      action: StringEnum(["stop", "pause", "resume", "skip", "retry", "pin", "unpin"] as const),
      runId: Type.String(),
      nodeId: Type.Optional(Type.String({ description: "Stable node ID required for skip/retry targeting." })),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "pin" || params.action === "unpin") {
        const record = await engine.store.readRun(params.runId);
        if (record.owner.sessionId !== engine.owners.bind(ctx).sessionId) throw new Error("unknown workflow run");
        const updated = await engine.applyEvent(params.runId, { type: "RetentionChanged", pinned: params.action === "pin", expiresAt: record.expiresAt });
        return textResult(`Workflow ${params.runId} ${updated.pinned ? "pinned" : "unpinned"}.`, { runId: params.runId, pinned: updated.pinned });
      }
      if (params.action === "stop") {
        const stopped = await engine.stop(params.runId, ctx, params.reason?.trim() || "stopped by request");
        return textResult(stopped ? `Stopping workflow ${params.runId}.` : `No active owner-scoped workflow ${params.runId}.`, { runId: params.runId, stopped });
      }
      if (params.action === "pause") {
        const paused = await engine.pause(params.runId, ctx);
        return textResult(paused ? `Pausing workflow ${params.runId}.` : `No active owner-scoped workflow ${params.runId}.`, { runId: params.runId, paused });
      }
      if (params.action === "skip") {
        if (!params.nodeId) throw new Error("skip requires nodeId");
        const skipped = await engine.skip(params.runId, params.nodeId, ctx);
        return textResult(skipped ? `Skipping ${params.nodeId}.` : `No active node ${params.nodeId} in workflow ${params.runId}.`, { runId: params.runId, nodeId: params.nodeId, skipped });
      }
      if (params.action === "retry" && !params.nodeId) throw new Error("retry requires nodeId");
      const launch = await engine.resume(params.runId, ctx, undefined, params.action === "retry" ? params.nodeId : undefined);
      void launch.completion.then((record) => deliverNotification(pi, engine, record));
      return textResult(`${params.action === "retry" ? "Retry" : "Resume"} started as linked run ${launch.runId}.`, { runId: launch.runId, resumeFromRunId: params.runId, status: "running" });
    },
  });

  pi.registerTool({
    name: "workflow_apply",
    label: "Apply Workflow Artifact",
    description: "Verify and apply one captured workspace artifact into a fresh integration worktree; never mutates the caller's current tree.",
    parameters: Type.Object({ artifactId: Type.String(), repositoryRoot: Type.Optional(Type.String()), targetRef: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const owner = engine.owners.bind(ctx);
      await assertOwnerArtifact(engine, params.artifactId, owner.sessionId);
      const applied = await engine.artifacts.apply(params.artifactId, path.resolve(ctx.cwd, params.repositoryRoot ?? "."), params.targetRef ?? "HEAD", owner.sessionId);
      return textResult(`${applied.state === "applied" ? "Applied" : "Conflicted"} in integration worktree ${applied.root}${applied.conflicts.length ? `\nConflicts: ${applied.conflicts.join(", ")}` : ""}`, applied);
    },
  });

  pi.registerTool({
    name: "workflow_release_workspace",
    label: "Release Workflow Workspace",
    description: "Idempotently release a retained source workspace lease or integration worktree after durable cleanup.",
    parameters: Type.Object({ leaseId: Type.Optional(Type.String()), integrationId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      if ((params.leaseId ? 1 : 0) + (params.integrationId ? 1 : 0) !== 1) throw new Error("exactly one of leaseId or integrationId is required");
      const owner = engine.owners.bind(ctx);
      if (params.leaseId) {
        await assertOwnerLease(engine, params.leaseId, owner.sessionId);
        await engine.artifacts.release(params.leaseId);
      } else await engine.artifacts.releaseApplied(params.integrationId!, owner.sessionId);
      return textResult("Workspace released.", { released: true });
    },
  });

  pi.registerCommand("workflow", {
    description: "Run a qualified workflow explicitly: /workflow run <builtin|user|project:id>",
    handler: async (args, ctx) => {
      const match = /^run\s+(\S+)$/u.exec(args.trim());
      if (!match) { ctx.ui.notify("Usage: /workflow run <qualified-id>", "warning"); return; }
      const launch = await engine.launch({ name: match[1] }, ctx, true);
      void launch.completion.then((record) => deliverNotification(pi, engine, record));
      ctx.ui.notify(`Workflow ${launch.runId} started.`, "info");
    },
  });
  pi.registerCommand("workflows", {
    description: "Show owner-scoped durable Workflow history",
    handler: async (_args, ctx) => {
      const owner = engine.owners.bind(ctx);
      const records = (await engine.store.scan()).filter((entry) => entry.state === "ok" && entry.record?.owner.sessionId === owner.sessionId).slice(0, 50);
      const lines = records.map((entry) => `${entry.record!.runId}  ${entry.record!.status}  ${entry.record!.metadata.name}`);
      ctx.ui.notify(lines.length ? lines.join("\n") : "No Workflow runs.", "info");
    },
  });
}

async function assertOwnerArtifact(engine: WorkflowEngine, artifactId: string, ownerSessionId: string): Promise<void> {
  const owned = (await engine.store.scan()).some((entry) => entry.state === "ok"
    && entry.record!.owner.sessionId === ownerSessionId
    && entry.record!.artifacts.some((artifact) => artifact.artifactId === artifactId));
  if (!owned) throw new Error("unknown owner-scoped workflow artifact");
}
async function assertOwnerLease(engine: WorkflowEngine, leaseId: string, ownerSessionId: string): Promise<void> {
  const owned = (await engine.store.scan()).some((entry) => entry.state === "ok"
    && entry.record!.owner.sessionId === ownerSessionId
    && entry.record!.leaves.some((leaf) => leaf.workspaceLeaseId === leaseId));
  if (!owned) throw new Error("unknown owner-scoped workspace lease");
}

async function deliverNotification(pi: ExtensionAPI, engine: WorkflowEngine, record: WorkflowRunRecordV1): Promise<void> {
  if (!["completed", "failed", "cancelled", "paused", "interrupted", "recovery_required"].includes(record.status)) return;
  const ctx = engine.owners.matchingContext(record.owner);
  if (!ctx) return;
  const details = notificationDetails(record);
  const content = `<workflow-notification>\n${formatRunSummary(record)}\n</workflow-notification>`;
  try {
    pi.sendMessage({ customType: WORKFLOW_NOTIFICATION_TYPE, content, display: true, details }, { deliverAs: ctx.isIdle() ? "followUp" : "steer", triggerTurn: true });
    await engine.applyEvent(record.runId, { type: "NotificationChanged", notification: { state: "delivered", attempts: record.notification.attempts + 1, updatedAt: Date.now(), deliveredAt: Date.now() } });
  } catch (error) {
    await engine.applyEvent(record.runId, { type: "NotificationChanged", notification: { state: "failed", attempts: record.notification.attempts + 1, updatedAt: Date.now(), lastError: errorMessage(error) } }).catch(() => {});
  }
}
async function retryPendingNotifications(pi: ExtensionAPI, engine: WorkflowEngine, ctx: ExtensionContext): Promise<void> {
  const owner = engine.owners.owner(ctx);
  for (const entry of await engine.store.scan()) {
    if (entry.state !== "ok" || entry.record!.owner.sessionId !== owner.sessionId) continue;
    if (entry.record!.notification.state !== "delivered" && isTerminal(entry.record!.status)) await deliverNotification(pi, engine, entry.record!);
  }
}
function isTerminal(status: WorkflowRunStatus): boolean { return ["completed", "failed", "cancelled", "interrupted", "recovery_required"].includes(status); }
function notificationDetails(record: WorkflowRunRecordV1): WorkflowNotificationDetails {
  return {
    runId: record.runId,
    status: record.status === "completed" ? "completed" : record.status === "cancelled" || record.status === "paused" || record.status === "interrupted" ? "cancelled" : "failed",
    agents: record.leaves.length,
    failures: record.failures.length,
    usage: usageStats(record),
    ...(record.error ? { error: record.error.message } : {}),
  };
}
function usageStats(record: WorkflowRunRecordV1): UsageStats {
  return { input: record.usage.input, output: record.usage.output, cacheRead: record.usage.cacheRead, cacheWrite: record.usage.cacheWrite, cost: record.usage.cost ?? 0, contextTokens: record.usage.contextTokens, turns: record.usage.turns };
}
function projectSnapshot(record: WorkflowRunRecordV1): WorkflowSnapshot {
  const status = record.status === "completed" ? "completed" : record.status === "cancelled" || record.status === "paused" || record.status === "interrupted" ? "cancelled" : record.status === "failed" || record.status === "recovery_required" ? "failed" : "running";
  const phases = (record.metadata.phases ?? []).map((phase) => phase.id);
  const current = [...record.leaves].reverse().find((leaf) => leaf.phase)?.phase;
  const agents = record.leaves.map((leaf, index): WorkflowAgentView => ({
    index, label: leaf.label ?? leaf.agentId, ...(leaf.phase ? { phase: leaf.phase } : {}),
    status: leaf.status === "backoff" ? "retrying" : leaf.status === "interrupted" || leaf.status === "skipped" ? "cancelled" : leaf.status === "cached" ? "completed" : leaf.status,
    attempt: Math.max(1, leaf.attempts.length), maxRetries: 0,
    ...(leaf.startedAt ? { startedAt: leaf.startedAt } : {}), ...(leaf.finishedAt ? { finishedAt: leaf.finishedAt } : {}),
    ...(leaf.failure ? { reason: leaf.failure.reason } : {}),
  }));
  return {
    runId: record.runId, origin: record.metadata.name, startedAt: record.startedAt ?? record.createdAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}), status, ...(current ? { phase: current } : {}), phases, agents,
    active: record.leaves.filter((leaf) => leaf.status === "running").length,
    queued: record.leaves.filter((leaf) => leaf.status === "queued").length,
    launched: record.leaves.length,
    usage: { ...usageStats(record), ...(record.usage.cost === null ? { cost: undefined } : { cost: record.usage.cost }) },
    failures: record.failures.length, rateLimited: record.leaves.some((leaf) => leaf.status === "backoff"),
  };
}
interface WorkflowView { onState(snapshot: WorkflowSnapshot): void; start(): void; finish(snapshot: WorkflowSnapshot): void }
export function createWorkflowView(ctx: ExtensionContext, runId: string, origin: string): WorkflowView {
  const key = `workflow:${runId}`;
  let snapshot: WorkflowSnapshot | undefined;
  let dashboard: WorkflowDashboard | undefined;
  let requestRender: (() => void) | undefined;
  let frame = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let registered = false;
  const render = () => {
    if (!ctx.hasUI || !snapshot) return;
    if (dashboard) { dashboard.update(snapshot, frame); requestRender?.(); return; }
    if (registered) return;
    registered = true;
    const initial = snapshot;
    ctx.ui.setWidget(key, (tui, theme) => {
      dashboard = new WorkflowDashboard(initial, theme, frame);
      requestRender = () => tui.requestRender();
      return dashboard;
    }, { placement: "belowEditor" });
  };
  return {
    onState(next) { snapshot = next; render(); },
    start() {
      if (!ctx.hasUI || ticker) return;
      ticker = setInterval(() => { frame = (frame + 1) % 10; render(); }, 120);
      ticker.unref?.();
    },
    finish(next) {
      snapshot = next;
      if (ticker) clearInterval(ticker);
      ticker = undefined;
      render();
      const timer = setTimeout(() => ctx.hasUI && ctx.ui.setWidget(key, undefined), 8_000);
      timer.unref?.();
    },
  };
}
function statusProjection(record: WorkflowRunRecordV1, include: Set<string>) {
  return {
    runId: record.runId, rootRunId: record.rootRunId, parentRunId: record.parentRunId, resumeFromRunId: record.resumeFromRunId,
    status: record.status, name: record.metadata.name, createdAt: record.createdAt, startedAt: record.startedAt, finishedAt: record.finishedAt,
    sourceHash: record.source.sha256, usage: record.usage, budget: record.budget, cleanup: record.cleanup, expiresAt: record.expiresAt, pinned: record.pinned,
    ...(include.has("agents") ? { agents: record.leaves } : {}), ...(include.has("failures") ? { failures: record.failures } : {}),
    ...(include.has("artifacts") ? { artifacts: record.artifacts } : {}), ...(include.has("output") ? { output: record.output } : {}),
    ...(include.has("notification") ? { notification: record.notification } : {}),
    error: record.error,
  };
}
function resultDetails(record: WorkflowRunRecordV1) { return { runId: record.runId, status: record.status, agents: record.leaves.length, failures: record.failures, usage: usageStats(record), runDir: path.dirname(record.source.copiedPath), artifacts: record.artifacts }; }
function formatRunSummary(record: WorkflowRunRecordV1): string { return `Workflow ${record.runId} ${record.status}.\nagents: ${record.leaves.length}, failures: ${record.failures.length}\nusage: ↑${record.usage.input} ↓${record.usage.output} cost=${record.usage.costState}${record.error ? `\nerror: ${record.error.message}` : ""}\nexpires: ${record.expiresAt ?? "not scheduled"}; pin/apply/release via Workflow tools.`; }
function sourceLabel(params: { script?: string; scriptPath?: string; name?: string }): string { return params.name ? `name ${params.name}` : params.scriptPath ? `scriptPath ${params.scriptPath}` : "inline"; }
function textResult(text: string, details: unknown) {
  const max = 50_000;
  const bounded = Buffer.byteLength(text, "utf8") <= max ? text : `${Buffer.from(text).subarray(0, max).toString("utf8")}\n[truncated]`;
  let boundedDetails = details;
  try {
    const encoded = JSON.stringify(details);
    if (Buffer.byteLength(encoded, "utf8") > max) boundedDetails = { truncated: true, preview: bounded };
  } catch { boundedDetails = { truncated: true, preview: bounded }; }
  return { content: [{ type: "text" as const, text: bounded }], details: boundedDetails };
}
function encodeCursor(offset: number): string { return Buffer.from(JSON.stringify({ offset })).toString("base64url"); }
function decodeCursor(cursor?: string): number { if (!cursor) return 0; try { const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); return Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : 0; } catch { throw new Error("invalid workflow status cursor"); } }
function abortReason(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new Error("aborted", { cause: signal.reason }); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function readToolViewMode(): ToolViewMode { try { const mode = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "tool-view.json"), "utf8")).mode; if (mode === "minimized" || mode === "medium" || mode === "verbose") return mode; } catch {} return "minimized"; }

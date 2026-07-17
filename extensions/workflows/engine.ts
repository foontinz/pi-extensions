import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSubagentInProcess } from "../subagents/core/in-process-runner.js";
import { createStructuredOutputCapability } from "../subagents/core/structured-output.js";
import { emptyUsageStats, type SubagentResult } from "../subagents/core/types.js";
import { cleanupWorktreeAsync, prepareWorktree } from "../subagents/workspace/create-worktree.js";
import {
  cloneCanonicalJson,
  createWorkflowRunRecord,
  encodeWorkflowOutput,
  parseWorkflowMetadata,
  validateWorkflowInput,
  WorkflowContractError,
  type JsonValue,
  type WorkflowAgentOptions,
  type WorkflowErrorV1,
  type WorkflowInput,
  type WorkflowLeafFailure,
  type WorkflowLeafRecordV1,
  type WorkflowMeta,
  type WorkflowOutputDescriptorV1,
  type WorkflowRunEvent,
  type WorkflowRunRecordV1,
  WorkflowRunStore,
} from "./core/index.js";
import { WorkflowResolver, type ResolvedWorkflowSource } from "./registry.js";
import { AbsoluteDeadline } from "./runtime/deadline.js";
import { authorizeWorkflow, readWorkflowSettings, type WorkflowSettings } from "./runtime/activation.js";
import { BudgetManager, FairSemaphore, WorkflowPolicyError } from "./runtime/policy.js";
import { resolveAgentExecution, type AvailableTool, type RootExecutionDefaults } from "./runtime/resolution.js";
import { CanonicalWorkflowWorker, type WorkerAgentRequest, type WorkerBudgetSnapshot, type WorkerChildRequest } from "./runtime/worker.js";
import { WorkflowOwnerRegistry, type WorkflowOwnerIdentity } from "./runtime/owners.js";
import { WorkflowJournal, claimWorkflowResume, hasLiveRunExecutionClaim, publishedRunExecutionClaim, type WorkflowReplayEntry } from "./resume/journal.js";
import { WorkspaceArtifactStore } from "./workspace/artifact-store.js";

export interface WorkflowLaunch {
  runId: string;
  record: WorkflowRunRecordV1;
  completion: Promise<WorkflowRunRecordV1>;
}
export interface WorkflowEngineOptions {
  runRoot: string;
  workspaceRoot: string;
  leafExecutor?: typeof runSubagentInProcess;
}
interface PreparedSource { resolved: ResolvedWorkflowSource; parsed: ReturnType<typeof parseWorkflowMetadata> }
interface RootState {
  runId: string;
  cwd: string;
  owner: WorkflowOwnerIdentity;
  deadlineAt: number;
  budget: BudgetManager;
  runSemaphore: FairSemaphore;
  globalSemaphore: FairSemaphore;
  settings: WorkflowSettings;
  defaults: RootExecutionDefaults;
  availableTools: AvailableTool[];
  availableModels: Set<string>;
  controller: AbortController;
  agentsAccepted: number;
  maxAgents: number;
  approvedCapabilities: string[];
  projectTrusted: boolean;
  journal: WorkflowJournal;
  replay: Map<string, WorkflowReplayEntry>;
  leafControllers: Map<string, AbortController>;
  executionControllers: Set<AbortController>;
  lingeringLeafOperations: Set<Promise<unknown>>;
  onRecord?: (record: WorkflowRunRecordV1) => void;
}

export class WorkflowEngine {
  readonly store: WorkflowRunStore;
  readonly resolver: WorkflowResolver;
  readonly owners: WorkflowOwnerRegistry;
  readonly artifacts: WorkspaceArtifactStore;
  private globalSemaphore?: FairSemaphore;
  private globalCapacity?: number;
  private readonly completions = new Map<string, Promise<WorkflowRunRecordV1>>();
  private readonly activeRoots = new Map<string, RootState>();
  readonly leafExecutor: typeof runSubagentInProcess;

  constructor(private readonly pi: ExtensionAPI, options: WorkflowEngineOptions, owners = new WorkflowOwnerRegistry()) {
    this.store = new WorkflowRunStore(options.runRoot);
    this.resolver = new WorkflowResolver();
    this.owners = owners;
    this.artifacts = new WorkspaceArtifactStore(options.workspaceRoot);
    this.leafExecutor = options.leafExecutor ?? runSubagentInProcess;
  }

  async launch(rawInput: WorkflowInput, ctx: ExtensionContext, explicitlyAuthorized = false, onRecord?: (record: WorkflowRunRecordV1) => void, invalidateNodeId?: string): Promise<WorkflowLaunch> {
    const input = validateWorkflowInput(rawInput);
    const settings = readWorkflowSettings();
    const source = this.resolveTopSource(input, ctx);
    const parsed = parseWorkflowMetadata(source.source);
    if (input.resumeFromRunId && !parsed.metadata.resumable) throw new WorkflowContractError("RESUME_NOT_DECLARED", "resumeFromRunId requires meta.resumable:true");
    if (parsed.metadata.maxAgents > settings.maxAgents) throw new WorkflowContractError("AGENT_CAP_POLICY", `metadata maxAgents ${parsed.metadata.maxAgents} exceeds configured maximum ${settings.maxAgents}`);
    const model = ctx.model;
    if (!model) throw new WorkflowContractError("MODEL_UNAVAILABLE", "Workflow requires a concrete active parent model");
    const defaults: RootExecutionDefaults = { provider: model.provider, model: model.id, thinking: this.pi.getThinkingLevel() };
    const availableTools = this.pi.getAllTools().map((tool) => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      sourceInfo: { source: tool.sourceInfo.source, path: tool.sourceInfo.path },
    }));
    const budgetTotal = input.budgetTokens ?? null;
    const activationIdentity = await authorizeWorkflow(ctx, settings, {
      sourceHash: source.sha256,
      provider: defaults.provider,
      model: defaults.model,
      tools: availableTools.map((tool) => tool.name),
      capabilities: parsed.metadata.capabilities,
      maxAgents: parsed.metadata.maxAgents,
      budgetTokens: budgetTotal,
    }, explicitlyAuthorized);

    const runId = randomUUID();
    const owner = this.owners.bind(ctx);
    const args = input.args === undefined ? null : cloneCanonicalJson(input.args);
    const timeoutMs = input.timeoutMs ?? 30 * 60 * 1_000;
    const deadlineAt = Date.now() + timeoutMs;
    const paths = this.store.paths(runId, parsed.metadata.resumable);
    const argsSha256 = hashCanonical(args);
    const fingerprint = hashCanonical({ source: source.sha256, args: argsSha256, metadata: parsed.metadata, defaults, engine: 2 });
    const journal = new WorkflowJournal(this.store);
    let replay = new Map<string, WorkflowReplayEntry>();
    let previousSpent = 0;
    let previousUsage: WorkflowRunRecordV1["usage"] | undefined;
    let releaseResumeClaim: (() => Promise<void>) | undefined;
    if (input.resumeFromRunId) {
      const previous = await this.store.readRun(input.resumeFromRunId);
      if (previous.owner.sessionId !== owner.sessionId) throw new WorkflowContractError("RESUME_OWNER", "resume source belongs to another session owner");
      if (!previous.metadata.resumable) throw new WorkflowContractError("RESUME_NOT_DECLARED", "resume source does not declare resumable:true");
      if (this.activeRoots.has(previous.runId) || await hasLiveRunExecutionClaim(this.store, previous.runId)) {
        throw new WorkflowContractError("RESUME_SOURCE_ACTIVE", "pause and drain the active source run before resume/retry");
      }
      if (previous.source.sha256 !== source.sha256 || previous.argsSha256 !== argsSha256 || previous.executionFingerprint !== fingerprint) {
        throw new WorkflowContractError("RESUME_FINGERPRINT", "resume requires exact copied source, canonical args, metadata, model, tools, prompts, and engine fingerprint");
      }
      previousSpent = previous.budget.spent;
      previousUsage = previous.usage;
      releaseResumeClaim = await claimWorkflowResume(this.store, input.resumeFromRunId);
      try {
        const records = await journal.recover(input.resumeFromRunId);
        const invalidationSequence = invalidateNodeId
          ? records.find((record) => record.type === "node-intent" && record.nodeId === invalidateNodeId)?.sequence
          : undefined;
        replay = journal.replayIndex(invalidationSequence === undefined ? records : records.filter((record) => record.sequence < invalidationSequence));
        await this.mergeDescendantReplay(previous.runId, replay, journal, invalidateNodeId);
      }
      catch (error) { await releaseResumeClaim(); releaseResumeClaim = undefined; throw error; }
    }
    const record = createWorkflowRunRecord({
      runId,
      ...(input.resumeFromRunId ? { resumeFromRunId: input.resumeFromRunId } : {}),
      owner,
      source: {
        kind: input.script !== undefined ? "inline" : input.scriptPath !== undefined ? "path" : "name",
        copiedPath: paths.script,
        ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
        ...(source.qualifiedId ? { qualifiedName: source.qualifiedId } : {}),
        sourceDirectory: source.sourceDirectory,
        sha256: source.sha256,
        resolverIdentity: source.identity,
      },
      metadata: parsed.metadata,
      args,
      argsSha256,
      executionFingerprint: fingerprint,
      activationIdentity,
      deadlineAt,
      cleanupDeadlineAt: deadlineAt + settings.cleanupGraceMs,
      budgetTotal,
      budgetSpent: previousSpent,
      ...(previousUsage ? { initialUsage: previousUsage } : {}),
    });
    try { await this.store.createRun(record, source.source, true); }
    catch (error) { await releaseResumeClaim?.(); throw error; }
    const releaseExecutionClaim = publishedRunExecutionClaim(this.store, runId, owner);

    const controller = new AbortController();
    this.owners.register({ runId, owner, controller });
    const globalSemaphore = this.processSemaphore(settings.globalMaxConcurrency);
    const root: RootState = {
      runId, cwd: ctx.cwd, owner, deadlineAt,
      budget: new BudgetManager(budgetTotal, previousSpent),
      runSemaphore: new FairSemaphore(settings.runMaxConcurrency),
      globalSemaphore, settings, defaults, availableTools,
      availableModels: new Set(ctx.modelRegistry.getAvailable().map((candidate) => `${candidate.provider}/${candidate.id}`)),
      controller,
      agentsAccepted: 0,
      maxAgents: parsed.metadata.maxAgents,
      approvedCapabilities: [...parsed.metadata.capabilities],
      projectTrusted: ctx.isProjectTrusted(),
      journal,
      replay,
      leafControllers: new Map(),
      executionControllers: new Set(),
      lingeringLeafOperations: new Set(),
      ...(onRecord ? { onRecord } : {}),
    };
    const coordinator = new RunCoordinator(this, root, record, { resolved: source, parsed }, 0, "root", [source.identity]);
    this.activeRoots.set(runId, root);
    try { await coordinator.start(); }
    catch (error) {
      this.activeRoots.delete(runId);
      this.owners.finish(runId);
      await releaseExecutionClaim?.();
      await releaseResumeClaim?.();
      throw error;
    }
    const releaseOwnership = async (): Promise<void> => {
      this.activeRoots.delete(runId);
      await releaseExecutionClaim?.();
      await releaseResumeClaim?.();
    };
    const completion = coordinator.execute().finally(async () => {
      this.owners.finish(runId);
      this.completions.delete(runId);
      if (coordinator.isQuiescent()) await releaseOwnership();
      else void coordinator.awaitQuiescence().then(releaseOwnership, releaseOwnership).catch(() => {});
    });
    this.completions.set(runId, completion);
    return { runId, record: coordinator.snapshot(), completion };
  }

  async shutdownOwner(ctx: ExtensionContext, reason = "session shutdown"): Promise<void> {
    const owner = this.owners.owner(ctx);
    const runIds = this.owners.list(owner).map((run) => run.runId);
    this.owners.stopOwned(owner, reason);
    await Promise.allSettled(runIds.map((runId) => this.completions.get(runId)).filter((value): value is Promise<WorkflowRunRecordV1> => Boolean(value)));
    this.owners.unbind(ctx);
  }

  async stop(runId: string, ctx: ExtensionContext, reason: string, scopeAll = false): Promise<boolean> {
    const root = this.activeRoots.get(runId);
    const owner = this.owners.bind(ctx);
    if (!root || (!scopeAll && root.owner.sessionId !== owner.sessionId)) return false;
    await this.applyEvent(runId, { type: "TerminalIntentAccepted", intent: { kind: "cancel", requestedAt: Date.now(), reason } });
    return this.owners.stop(runId, owner, reason, scopeAll);
  }
  async pause(runId: string, ctx: ExtensionContext): Promise<boolean> {
    const root = this.activeRoots.get(runId);
    const owner = this.owners.bind(ctx);
    if (!root || root.owner.sessionId !== owner.sessionId) return false;
    const record = await this.store.readRun(runId);
    if (!record.metadata.resumable) throw new WorkflowContractError("PAUSE_NOT_RESUMABLE", "pause requires meta.resumable:true");
    await this.applyEvent(runId, { type: "TerminalIntentAccepted", intent: { kind: "pause", requestedAt: Date.now(), reason: "pause requested" } });
    const error = new Error("pause requested");
    (error as NodeJS.ErrnoException).code = "WORKFLOW_PAUSE";
    return this.owners.stop(runId, owner, error, false);
  }
  async skip(runId: string, nodeId: string, ctx: ExtensionContext): Promise<boolean> {
    const root = this.activeRoots.get(runId);
    if (!root || root.owner.sessionId !== this.owners.bind(ctx).sessionId) return false;
    const controller = root.leafControllers.get(nodeId);
    if (!controller) return false;
    const record = await this.store.readRun(runId);
    if (!record.metadata.resumable) throw new WorkflowContractError("SKIP_NOT_RESUMABLE", "skip requires meta.resumable:true");
    const leaf = record.leaves.find((item) => item.nodeId === nodeId);
    if (!leaf) return false;
    await this.applyEvent(runId, { type: "LeafStatusChanged", leafId: leaf.leafId, status: "skipped", at: Date.now() });
    const error = new Error(`skip requested for ${nodeId}`);
    (error as NodeJS.ErrnoException).code = "WORKFLOW_SKIP";
    controller.abort(error);
    return true;
  }
  completion(runId: string): Promise<WorkflowRunRecordV1> | undefined { return this.completions.get(runId); }

  async reconcileInterruptedRuns(): Promise<void> {
    for (const entry of await this.store.scan()) {
      if (entry.state !== "ok") continue;
      let record = entry.record!;
      if (["completed", "failed", "cancelled", "interrupted", "recovery_required", "paused"].includes(record.status)) continue;
      if (this.activeRoots.has(record.runId) || await hasLiveRunExecutionClaim(this.store, record.runId)) continue;
      for (const leaf of record.leaves) {
        if (["queued", "running", "backoff"].includes(leaf.status)) {
          record = await this.applyEvent(record.runId, { type: "LeafStatusChanged", leafId: leaf.leafId, status: "interrupted", at: Date.now() });
        }
      }
      const uncertain = record.leaves.some((leaf) =>
        leaf.effects === "external" && leaf.status === "interrupted"
        || leaf.effects === "workspace" && Boolean(leaf.workspaceLeaseId) && leaf.artifactIds.length === 0,
      );
      const error: WorkflowErrorV1 = {
        kind: "recovery",
        code: uncertain ? "UNCERTAIN_EFFECTS" : "OWNER_INTERRUPTED",
        message: uncertain ? "owner process ended with uncertain effectful leaves" : "owner process ended before the run terminalized",
      };
      record = await this.applyEvent(record.runId, { type: "TerminalIntentAccepted", intent: { kind: "interrupt", requestedAt: Date.now(), reason: error.message, error } });
      if (uncertain) await this.applyEvent(record.runId, { type: "CleanupChanged", cleanup: { status: "recovery_required", deadlineAt: record.cleanup.deadlineAt, finishedAt: Date.now(), error } });
      await this.applyEvent(record.runId, { type: "RunStatusChanged", status: uncertain ? "recovery_required" : "interrupted", error });
    }
    await this.artifacts.reconcileCacheIntegrations(async (runId) =>
      this.activeRoots.has(runId) || await hasLiveRunExecutionClaim(this.store, runId));
  }

  async applyEvent(runId: string, event: WorkflowRunEvent): Promise<WorkflowRunRecordV1> {
    const next = await this.store.reduceAndCommit(runId, event);
    if (event.type === "NotificationChanged") await this.store.writeNotification(runId, event.notification);
    return next;
  }

  async resume(runId: string, ctx: ExtensionContext, onRecord?: (record: WorkflowRunRecordV1) => void, invalidateNodeId?: string): Promise<WorkflowLaunch> {
    const previous = await this.store.readRun(runId);
    if (previous.owner.sessionId !== this.owners.bind(ctx).sessionId) throw new WorkflowContractError("RUN_OWNER", "cannot resume another session owner's workflow");
    if (!previous.metadata.resumable) throw new WorkflowContractError("RUN_NOT_RESUMABLE", "workflow metadata does not declare resumable:true");
    const script = await readFile(previous.source.copiedPath, "utf8");
    return this.launch({ script, args: previous.args, budgetTokens: previous.budget.total ?? undefined, timeoutMs: Math.max(1_000, previous.deadlineAt - previous.createdAt), resumeFromRunId: runId }, ctx, true, onRecord, invalidateNodeId);
  }

  private async mergeDescendantReplay(
    rootRunId: string,
    replay: Map<string, WorkflowReplayEntry>,
    journal: WorkflowJournal,
    invalidateNodeId?: string,
  ): Promise<void> {
    const conflicts = new Set<string>();
    const descendants = (await this.store.scan())
      .filter((entry) => entry.state === "ok" && entry.record!.rootRunId === rootRunId && entry.record!.runId !== rootRunId && entry.record!.metadata.resumable)
      .map((entry) => entry.record!)
      .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
    for (const descendant of descendants) {
      const records = await journal.recover(descendant.runId);
      const invalidationSequence = invalidateNodeId
        ? records.find((record) => record.type === "node-intent" && record.nodeId === invalidateNodeId)?.sequence
        : undefined;
      const entries = journal.replayIndex(invalidationSequence === undefined ? records : records.filter((record) => record.sequence < invalidationSequence));
      for (const [nodeId, entry] of entries) {
        if (conflicts.has(nodeId)) continue;
        const existing = replay.get(nodeId);
        if (existing && (existing.fingerprint !== entry.fingerprint || existing.cachePolicy !== entry.cachePolicy)) {
          replay.delete(nodeId);
          conflicts.add(nodeId);
        } else replay.set(nodeId, entry);
      }
    }
  }

  private resolveTopSource(input: WorkflowInput, ctx: ExtensionContext): ResolvedWorkflowSource {
    if (input.script !== undefined) return this.resolver.resolveInline(input.script, ctx.cwd);
    if (input.scriptPath !== undefined) return this.resolver.resolvePath(input.scriptPath, ctx.cwd);
    return this.resolver.resolveName(input.name!, ctx.cwd, ctx.isProjectTrusted());
  }
  private processSemaphore(capacity: number): FairSemaphore {
    if (!this.globalSemaphore || this.globalCapacity !== capacity) {
      if (this.globalSemaphore?.inUse || this.globalSemaphore?.queued) throw new WorkflowPolicyError("GLOBAL_CAP_ACTIVE", "cannot change global Workflow concurrency while runs are active");
      this.globalSemaphore = new FairSemaphore(capacity);
      this.globalCapacity = capacity;
    }
    return this.globalSemaphore;
  }
}

class RunCoordinator {
  private record: WorkflowRunRecordV1;
  private mutation: Promise<void> = Promise.resolve();
  private readonly failures: WorkflowLeafFailure[] = [];
  private readonly ids = new Set<string>();
  private readonly childIds = new Set<string>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private leafMutationsClosed = false;
  private fatal?: unknown;
  private phase?: string;
  private localAgentsAccepted = 0;
  private readonly worker: CanonicalWorkflowWorker;

  constructor(
    private readonly engine: WorkflowEngine,
    private readonly root: RootState,
    initialRecord: WorkflowRunRecordV1,
    private readonly source: PreparedSource,
    private readonly depth: number,
    private readonly scope: string,
    private readonly sourceStack: readonly string[],
  ) {
    this.record = structuredClone(initialRecord);
    this.worker = new CanonicalWorkflowWorker({
      agent: (request) => this.handleAgent(request),
      workflow: (request) => this.handleChild(request),
      phase: (id) => { this.phase = id; },
      log: () => { /* bounded durable logs are added by the UI projection later */ },
    });
  }
  snapshot(): WorkflowRunRecordV1 { return structuredClone(this.record); }

  async start(): Promise<void> {
    await this.transition({
      type: "RunStarted",
      attempt: { attemptId: randomUUID(), runId: this.record.runId, startedAt: Date.now(), status: "running" },
    });
  }

  async execute(): Promise<WorkflowRunRecordV1> {
    const executionController = new AbortController();
    this.root.executionControllers.add(executionController);
    const linked = linkSignals(this.root.controller.signal, executionController.signal);
    try {
      const remaining = this.root.deadlineAt - Date.now();
      if (remaining <= 0) throw deadlineError("workflow root deadline elapsed");
      const output = await this.worker.run({
        bodySource: this.source.parsed.body,
        filename: this.record.source.copiedPath,
        args: this.record.args,
        phaseIds: (this.source.parsed.metadata.phases ?? []).map((phase) => phase.id),
        initialBudget: this.root.budget.snapshot(),
        timeoutMs: remaining,
        resumable: this.source.parsed.metadata.resumable,
      }, linked.signal);
      if (this.fatal) throw this.fatal;
      if (!await this.drainActiveOperations()) throw infrastructure("CLEANUP_DEADLINE", "active workflow operations did not settle within cleanup grace");
      if (this.fatal) throw this.fatal;
      if (this.root.controller.signal.aborted) throw abortError(this.root.controller.signal);
      const encoded = encodeWorkflowOutput(output);
      await this.engine.store.writeOutput(this.record.runId, encoded);
      const outputText = JSON.stringify(encoded);
      const descriptor: WorkflowOutputDescriptorV1 = {
        encoding: "tagged-json-v1",
        path: this.engine.store.paths(this.record.runId).output,
        sha256: createHash("sha256").update(`${outputText}\n`).digest("hex"),
        bytes: Buffer.byteLength(`${outputText}\n`),
        truncated: encoded.truncated,
        preview: boundedPreview(output),
      };
      await this.transition({ type: "OutputRecorded", output: descriptor });
      await this.transition({ type: "TerminalIntentAccepted", intent: { kind: "complete", requestedAt: Date.now() } });
      await this.transition({ type: "CleanupChanged", cleanup: { status: "completed", deadlineAt: this.record.cleanup.deadlineAt, finishedAt: Date.now() } });
      if (this.source.parsed.metadata.resumable) await this.appendJournal("terminal", this.scope, { status: "completed" });
      await this.transition({ type: "RunStatusChanged", status: "completed" });
      await this.transition({ type: "RetentionChanged", pinned: false, expiresAt: Date.now() + this.root.settings.retentionMs });
    } catch (error) {
      executionController.abort(error);
      for (const controller of this.root.executionControllers) controller.abort(error);
      for (const controller of this.root.leafControllers.values()) controller.abort(error);
      let terminalError = error;
      if (!await this.drainActiveOperations()) {
        terminalError = infrastructure("CLEANUP_DEADLINE", "active workflow operations did not settle within cleanup grace");
        this.leafMutationsClosed = true;
      }
      await this.interruptUnsettledLeaves(terminalError);
      const cancellation = this.root.controller.signal.aborted;
      const paused = cancellation && (this.root.controller.signal.reason as NodeJS.ErrnoException | undefined)?.code === "WORKFLOW_PAUSE";
      const workflowError = serializeError(terminalError, cancellation ? "cancellation" : undefined);
      const recoveryRequired = /^(WORKSPACE|ARTIFACT|CLEANUP)/.test(workflowError.code);
      await this.transition({
        type: "TerminalIntentAccepted",
        intent: { kind: paused ? "pause" : cancellation ? "cancel" : workflowError.code === "WORKFLOW_DEADLINE" ? "timeout" : "fail", requestedAt: Date.now(), reason: workflowError.message, error: workflowError },
      }).catch(() => {});
      await this.transition({
        type: "CleanupChanged",
        cleanup: recoveryRequired
          ? { status: "recovery_required", deadlineAt: this.record.cleanup.deadlineAt, finishedAt: Date.now(), error: workflowError }
          : { status: "completed", deadlineAt: this.record.cleanup.deadlineAt, finishedAt: Date.now() },
      }).catch(() => {});
      const finalStatus = recoveryRequired ? "recovery_required" : paused ? "paused" : cancellation ? "cancelled" : "failed";
      if (this.source.parsed.metadata.resumable) {
        await this.appendJournal("terminal", this.scope, { status: finalStatus, error: workflowError.message });
      }
      await this.transition({ type: "RunStatusChanged", status: finalStatus, error: workflowError }).catch(async (transitionError) => {
        const recovery = serializeError(transitionError);
        await this.transition({ type: "RunStatusChanged", status: "recovery_required", error: recovery }).catch(() => {});
      });
      if (finalStatus === "failed" || finalStatus === "cancelled") {
        await this.transition({ type: "RetentionChanged", pinned: false, expiresAt: Date.now() + this.root.settings.retentionMs }).catch(() => {});
      }
    } finally {
      linked.dispose();
      executionController.abort();
      this.root.executionControllers.delete(executionController);
    }
    const durable = await this.engine.store.readRun(this.record.runId);
    if (!["completed", "failed", "cancelled", "paused", "interrupted", "recovery_required"].includes(durable.status)) {
      throw infrastructure("TERMINAL_PERSISTENCE", `workflow completion is not durable (status ${durable.status})`);
    }
    this.record = durable;
    if (this.depth > 0) {
      await this.transition({ type: "NotificationChanged", notification: { state: "delivered", attempts: 0, updatedAt: Date.now(), deliveredAt: Date.now() } }).catch(() => {});
    }
    return this.snapshot();
  }

  private async handleAgent(request: WorkerAgentRequest) {
    try {
      const value = await this.executeAgent(request);
      return { value, failures: [...this.failures], budget: this.root.budget.snapshot() };
    } catch (error) {
      if (isFatal(error)) this.fatal ??= error;
      throw error;
    }
  }

  private async executeAgent(request: WorkerAgentRequest): Promise<unknown> {
    const options = request.options as unknown as WorkflowAgentOptions;
    validateAgentOptions(options, this.source.parsed.metadata, this.ids);
    this.ids.add(options.id);
    this.root.agentsAccepted++;
    this.localAgentsAccepted++;
    if (this.root.agentsAccepted > Math.min(this.root.settings.maxAgents, this.root.maxAgents) || this.localAgentsAccepted > this.source.parsed.metadata.maxAgents) {
      throw new WorkflowContractError("AGENT_CAP", "workflow agent cap exceeded");
    }
    const phase = options.phase ?? this.phase;
    const resolved = resolveAgentExecution(this.root.cwd, options, this.root.defaults, this.root.availableTools, options.schema !== undefined);
    const concreteModel = `${resolved.provider}/${resolved.model}`;
    if (!this.root.availableModels.has(concreteModel)) throw new WorkflowContractError("MODEL_UNKNOWN", `unknown or unavailable concrete model: ${concreteModel}`);
    if (options.schema) createStructuredOutputCapability({ schema: options.schema });
    enforceCapabilityDeclaration(this.source.parsed.metadata, resolved.effects);
    const acceptedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? Math.max(1, this.root.deadlineAt - acceptedAt);
    const deadline = new AbsoluteDeadline(Math.min(timeoutMs, Math.max(1, this.root.deadlineAt - acceptedAt)), acceptedAt);
    const leafId = randomUUID();
    const nodeId = `${this.scope}/agent:${options.id}`;
    const leaf: WorkflowLeafRecordV1 = {
      leafId, nodeId, agentId: options.id,
      ...(options.label ? { label: options.label } : {}), ...(phase ? { phase } : {}),
      status: "queued", acceptedAt, deadlineAt: deadline.deadlineAt,
      effects: resolved.effects, ...(resolved.artifactPolicy ? { artifactPolicy: resolved.artifactPolicy } : {}),
      cachePolicy: resolved.cachePolicy,
      executionFingerprint: hashCanonical({ root: this.record.executionFingerprint, id: options.id, task: request.task, phase, resolved, schema: options.schema ?? null, inputManifest: options.inputManifest ?? null }),
      artifactIds: [],
    };
    await this.transition({ type: "LeafAccepted", leaf });
    if (this.source.parsed.metadata.resumable) {
      await this.appendJournal("node-intent", nodeId, { fingerprint: leaf.executionFingerprint, cachePolicy: leaf.cachePolicy });
    }
    if (leaf.cachePolicy !== "off") {
      await verifyInputManifest(this.root.cwd, options.inputManifest ?? []);
      const cached = this.root.replay.get(nodeId);
      if (cached?.fingerprint === leaf.executionFingerprint && cached.cachePolicy === leaf.cachePolicy) {
        if (leaf.cachePolicy === "workspace-artifact") {
          const restorationDeadline = deadline.signal(this.root.controller.signal);
          let restored: boolean;
          try { restored = await this.restoreCachedWorkspaceArtifacts(leaf, cached.artifactIds ?? [], restorationDeadline.signal); }
          finally { restorationDeadline.dispose(); }
          if (!restored) return await this.executeUncachedAgent(leaf, request.task, options, resolved, deadline);
        }
        await this.transition({ type: "LeafStatusChanged", leafId, status: "cached", at: Date.now(), result: cached.result });
        if (this.source.parsed.metadata.resumable) {
          await this.appendJournal("node-result", nodeId, {
            fingerprint: leaf.executionFingerprint,
            cachePolicy: leaf.cachePolicy,
            result: cached.result,
            ...(cached.artifactIds?.length ? { artifactIds: cached.artifactIds } : {}),
          });
        }
        return cloneCanonicalJson(cached.result);
      }
    }

    return this.executeUncachedAgent(leaf, request.task, options, resolved, deadline);
  }

  private async executeUncachedAgent(
    leaf: WorkflowLeafRecordV1,
    task: string,
    options: WorkflowAgentOptions,
    resolved: ReturnType<typeof resolveAgentExecution>,
    deadline: AbsoluteDeadline,
  ): Promise<unknown> {
    const nodeId = leaf.nodeId;

    const leafController = new AbortController();
    this.root.leafControllers.set(nodeId, leafController);
    const operation = this.runLeaf(leaf, task, options, resolved, deadline, leafController.signal);
    this.activeOperations.add(operation);
    this.root.lingeringLeafOperations.add(operation);
    try { return await operation; }
    finally {
      this.activeOperations.delete(operation);
      this.root.lingeringLeafOperations.delete(operation);
      this.root.leafControllers.delete(nodeId);
    }
  }

  private async runLeaf(
    leaf: WorkflowLeafRecordV1,
    task: string,
    options: WorkflowAgentOptions,
    resolved: ReturnType<typeof resolveAgentExecution>,
    deadline: AbsoluteDeadline,
    leafSignal: AbortSignal,
  ): Promise<unknown> {
    let releaseRun: (() => void) | undefined;
    let releaseGlobal: (() => void) | undefined;
    let prepared: Awaited<ReturnType<typeof prepareWorktree>> | undefined;
    let leaseId: string | undefined;
    const runAndLeaf = linkSignals(this.root.controller.signal, leafSignal);
    const linked = deadline.signal(runAndLeaf.signal);
    const perLeafReservation = this.root.budget.total === null
      ? Math.max(1, Math.ceil((this.source.parsed.metadata.estimatedOutputTokens ?? 8192) / this.source.parsed.metadata.maxAgents))
      : Math.max(1, Math.ceil(this.root.budget.total / this.root.maxAgents));
    const reservation = this.root.budget.reserve(perLeafReservation);
    try {
      await this.transition({ type: "BudgetChanged", budget: this.root.budget.snapshot() });
      releaseRun = await this.root.runSemaphore.acquire(linked.signal);
      releaseGlobal = await this.root.globalSemaphore.acquire(linked.signal);
      deadline.throwIfElapsed();
      let cwd = this.root.cwd;
      if (resolved.effects === "workspace") {
        prepared = await prepareWorktree(this.root.cwd, { worktreeOverride: true, keepWorktree: "always", signal: linked.signal });
        if (!prepared.worktree) throw infrastructure("WORKSPACE_PROVISION", "isolated workspace provisioning returned no worktree");
        const lease = await this.engine.artifacts.register(prepared);
        leaseId = lease.id;
        cwd = prepared.cwd;
        await this.transition({ type: "LeafReferencesChanged", leafId: leaf.leafId, workspaceLeaseId: leaseId });
      }
      if (resolved.cachePolicy === "pure") await verifyInputManifest(cwd, options.inputManifest ?? []);
      await this.transition({ type: "LeafStatusChanged", leafId: leaf.leafId, status: "running", at: Date.now() });
      const result = await this.engine.leafExecutor({
        task,
        cwd,
        tools: resolved.tools,
        model: `${resolved.provider}/${resolved.model}`,
        systemPrompt: resolved.systemPrompt,
        appendSystemPrompt: resolved.appendSystemPrompt,
        thinkingLevel: resolved.thinking,
        timeoutMs: Math.max(1, deadline.remaining()),
        schema: options.schema,
        mcp: resolved.mcp,
        signal: linked.signal,
        sessionDir: this.engine.store.paths(this.record.runId).agents,
        sessionId: leaf.leafId,
      });
      this.root.budget.commit(reservation, result.usage.output);
      await this.recordLeafUsage(leaf, result);
      if (this.root.controller.signal.aborted) throw abortError(this.root.controller.signal);
      if (leafSignal.aborted && (leafSignal.reason as NodeJS.ErrnoException | undefined)?.code === "WORKFLOW_SKIP") {
        await this.finishWorkspace(leaf, resolved, leaseId);
        await this.transition({ type: "LeafStatusChanged", leafId: leaf.leafId, status: "skipped", at: Date.now() });
        if (this.source.parsed.metadata.resumable) await this.appendJournal("node-skip", leaf.nodeId, { reason: "user skip" });
        return null;
      }
      if (leafSignal.aborted) throw abortError(leafSignal);
      if (result.error) {
        const failure = leafFailure(leaf, result.error.reason === "timeout" ? "deadline" : result.structuredOutputOutcome ? "structured-output" : "provider", result.error.message);
        this.failures.push(failure);
        await this.transition({ type: "LeafStatusChanged", leafId: leaf.leafId, status: "failed", at: Date.now(), failure });
        await this.finishWorkspace(leaf, resolved, leaseId);
        return null;
      }
      const value = options.schema ? result.structuredOutput : result.output;
      const canonical = cloneCanonicalJson(value === undefined ? null : value);
      await this.transition({ type: "LeafStatusChanged", leafId: leaf.leafId, status: "completed", at: Date.now(), result: canonical });
      await this.finishWorkspace(leaf, resolved, leaseId);
      if (this.source.parsed.metadata.resumable && resolved.cachePolicy !== "off") {
        const current = this.record.leaves.find((item) => item.leafId === leaf.leafId);
        await this.appendJournal("node-result", leaf.nodeId, {
          fingerprint: leaf.executionFingerprint,
          cachePolicy: resolved.cachePolicy,
          result: canonical,
          ...(current?.artifactIds.length ? { artifactIds: current.artifactIds } : {}),
        });
      }
      return canonical;
    } catch (error) {
      try {
        this.root.budget.refund(reservation);
        await this.transition({ type: "BudgetChanged", budget: this.root.budget.snapshot() });
      } catch { /* already committed or persistence is already fatal */ }
      if (leaseId) {
        try { await this.finishWorkspace(leaf, resolved, leaseId); }
        catch (cleanupError) {
          await this.engine.artifacts.retain(leaseId, `capture/cleanup failed: ${errorMessage(cleanupError)}`).catch(() => {});
          throw infrastructure("WORKSPACE_RECOVERY_REQUIRED", errorMessage(cleanupError));
        }
      } else if (prepared?.worktree) {
        await cleanupWorktreeAsync(prepared.worktree).catch((cleanupError) => { throw infrastructure("WORKSPACE_CLEANUP", errorMessage(cleanupError)); });
      }
      const current = this.record.leaves.find((item) => item.leafId === leaf.leafId);
      if (leafSignal.aborted && (leafSignal.reason as NodeJS.ErrnoException | undefined)?.code === "WORKFLOW_SKIP") {
        if (current && !["completed", "failed", "interrupted", "skipped", "cached"].includes(current.status)) {
          await this.transition({ type: "LeafStatusChanged", leafId: leaf.leafId, status: "skipped", at: Date.now() });
        }
        if (this.source.parsed.metadata.resumable) await this.appendJournal("node-skip", leaf.nodeId, { reason: "user skip" });
        return null;
      }
      if (this.root.controller.signal.aborted) {
        if (current && !["completed", "failed", "interrupted", "skipped", "cached"].includes(current.status)) {
          await this.transition({ type: "LeafStatusChanged", leafId: leaf.leafId, status: "interrupted", at: Date.now() }).catch(() => {});
        }
        throw abortError(this.root.controller.signal);
      }
      if ((linked.signal.reason as any)?.code === "WORKFLOW_LEAF_DEADLINE") {
        const failure = leafFailure(leaf, "deadline", errorMessage(error));
        this.failures.push(failure);
        if (current && !["completed", "failed", "interrupted", "skipped", "cached"].includes(current.status)) {
          await this.transition({ type: "LeafStatusChanged", leafId: leaf.leafId, status: "failed", at: Date.now(), failure });
        }
        return null;
      }
      throw error;
    } finally {
      linked.dispose();
      runAndLeaf.dispose();
      releaseGlobal?.();
      releaseRun?.();
    }
  }

  private async restoreCachedWorkspaceArtifacts(leaf: WorkflowLeafRecordV1, artifactIds: readonly string[], signal: AbortSignal): Promise<boolean> {
    if (artifactIds.length === 0) return false;
    const verified = [];
    try {
      for (const artifactId of artifactIds) verified.push(await this.engine.artifacts.verifyArtifact(artifactId, signal));
    } catch (error) {
      if (signal.aborted) throw infrastructure("WORKSPACE_CACHE_RESTORE", errorMessage(error));
      return false;
    }
    signal.throwIfAborted();
    for (const artifact of verified) {
      let integration;
      try {
        integration = await this.engine.artifacts.apply(
          artifact.id,
          this.root.cwd,
          "HEAD",
          this.root.owner.sessionId,
          signal,
          { runId: this.record.runId, purpose: "cache-replay" },
        );
      } catch (error) {
        if (signal.aborted || (error as NodeJS.ErrnoException).code === "WORKSPACE_INTEGRATION_RECOVERY") {
          throw infrastructure("WORKSPACE_CACHE_RESTORE", `cached artifact restore failed: ${errorMessage(error)}`);
        }
        return false;
      }
      let applied = false;
      try { applied = integration.state === "applied"; }
      finally {
        try {
          await this.engine.artifacts.releaseApplied(integration.integrationId, this.root.owner.sessionId, this.cleanupSignal());
        } catch (error) {
          throw infrastructure("WORKSPACE_CACHE_CLEANUP", `integration ${integration.integrationId} retained: ${errorMessage(error)}`);
        }
      }
      if (!applied) return false;
      const manifestPath = path.join(artifact.directory, "manifest.json");
      const manifest = await readFile(manifestPath);
      if (!this.record.artifacts.some((item) => item.artifactId === artifact.id)) {
        await this.transition({
          type: "ArtifactRecorded",
          artifact: {
            artifactId: artifact.id, kind: "workspace", path: manifestPath,
            sha256: createHash("sha256").update(manifest).digest("hex"), bytes: manifest.length,
            state: "verified", createdAt: Date.now(),
          },
        });
      }
    }
    await this.transition({ type: "LeafReferencesChanged", leafId: leaf.leafId, artifactIds: [...artifactIds] });
    return true;
  }

  private async finishWorkspace(leaf: WorkflowLeafRecordV1, resolved: ReturnType<typeof resolveAgentExecution>, leaseId?: string): Promise<void> {
    if (!leaseId) return;
    const cleanupSignal = this.cleanupSignal();
    if (resolved.artifactPolicy === "discard") {
      await this.engine.artifacts.discard(leaseId, cleanupSignal);
      return;
    }
    const artifact = await this.engine.artifacts.release(leaseId, cleanupSignal);
    if (!artifact) throw infrastructure("ARTIFACT_MISSING", "workspace capture returned no artifact");
    const manifestPath = path.join(artifact.directory, "manifest.json");
    const manifestText = JSON.stringify(artifact.manifest, null, 2) + "\n";
    await this.transition({
      type: "ArtifactRecorded",
      artifact: {
        artifactId: artifact.id, kind: "workspace", path: manifestPath,
        sha256: createHash("sha256").update(manifestText).digest("hex"), bytes: Buffer.byteLength(manifestText), state: "verified", createdAt: Date.now(),
      },
    });
    const current = this.record.leaves.find((item) => item.leafId === leaf.leafId);
    await this.transition({ type: "LeafReferencesChanged", leafId: leaf.leafId, artifactIds: [...(current?.artifactIds ?? []), artifact.id] });
  }

  private cleanupSignal(): AbortSignal {
    const remaining = this.record.cleanup.deadlineAt - Date.now();
    if (remaining <= 0) {
      const error = infrastructure("CLEANUP_DEADLINE", "workflow cleanup grace deadline elapsed");
      return AbortSignal.abort(error);
    }
    return AbortSignal.timeout(remaining);
  }

  private async recordLeafUsage(leaf: WorkflowLeafRecordV1, result: SubagentResult): Promise<void> {
    const usage = {
      input: result.usage.input,
      output: result.usage.output,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      cost: result.usage.cost > 0 ? result.usage.cost : null,
      costState: result.usage.cost > 0 ? "reported" as const : "unavailable" as const,
      contextTokens: result.usage.contextTokens,
      turns: result.usage.turns,
      structuredSubmissions: result.structuredOutputOutcome?.submissions ?? 0,
      leafAttempts: 0,
      cacheHits: 0,
    };
    await this.transition({ type: "UsageAdded", usage });
    await this.transition({ type: "BudgetChanged", budget: this.root.budget.snapshot() });
    if (result.sessionFile) await this.transition({ type: "LeafReferencesChanged", leafId: leaf.leafId, transcriptPath: result.sessionFile });
  }

  private async finishChild(request: WorkerChildRequest): Promise<unknown> {
    if (this.childIds.has(request.reference.id)) throw new WorkflowContractError("CHILD_ID_DUPLICATE", `duplicate child workflow id: ${request.reference.id}`);
    this.childIds.add(request.reference.id);
    if (this.depth >= 4) throw new WorkflowContractError("CHILD_DEPTH", "workflow nesting depth exceeds 4");
    const childArgs = request.args === undefined ? null : cloneCanonicalJson(request.args);
    const resolved = "name" in request.reference
      ? this.engine.resolver.resolveName(request.reference.name, this.source.resolved.sourceDirectory, this.root.projectTrusted)
      : this.engine.resolver.resolvePath(request.reference.scriptPath, this.source.resolved.sourceDirectory);
    if (this.sourceStack.includes(resolved.identity)) throw new WorkflowContractError("CHILD_CYCLE", "workflow reference cycle detected");
    const parsed = parseWorkflowMetadata(resolved.source);
    for (const capability of parsed.metadata.capabilities) {
      if (!this.root.approvedCapabilities.includes(capability)) throw new WorkflowContractError("CHILD_CAPABILITY", `child capability ${capability} was not approved by the root workflow`);
    }
    const runId = randomUUID();
    const paths = this.engine.store.paths(runId, parsed.metadata.resumable);
    const argsSha256 = hashCanonical(childArgs);
    const record = createWorkflowRunRecord({
      runId, rootRunId: this.root.runId, parentRunId: this.record.runId,
      owner: this.root.owner,
      source: {
        kind: "name" in request.reference ? "name" : "path", copiedPath: paths.script,
        ...(resolved.sourcePath ? { sourcePath: resolved.sourcePath } : {}), ...(resolved.qualifiedId ? { qualifiedName: resolved.qualifiedId } : {}),
        sourceDirectory: resolved.sourceDirectory, sha256: resolved.sha256, resolverIdentity: resolved.identity,
      },
      metadata: parsed.metadata, args: childArgs, argsSha256,
      executionFingerprint: hashCanonical({ parent: this.record.executionFingerprint, source: resolved.sha256, args: argsSha256 }),
      activationIdentity: this.record.activationIdentity,
      deadlineAt: this.root.deadlineAt, cleanupDeadlineAt: this.record.cleanup.deadlineAt,
      budgetTotal: this.root.budget.total,
    });
    await this.engine.store.createRun(record, resolved.source, true);
    const releaseExecutionClaim = publishedRunExecutionClaim(this.engine.store, runId, this.root.owner);
    const child = new RunCoordinator(
      this.engine, this.root, record, { resolved, parsed }, this.depth + 1,
      `${this.scope}/workflow:${request.reference.id}`,
      [...this.sourceStack, resolved.identity],
    );
    let finished: WorkflowRunRecordV1;
    try {
      await child.start();
      finished = await child.execute();
    } finally {
      if (child.isQuiescent()) await releaseExecutionClaim();
      else void child.awaitQuiescence().then(releaseExecutionClaim, releaseExecutionClaim).catch(() => {});
    }
    await this.transition({ type: "UsageAdded", usage: finished.usage });
    await this.transition({ type: "BudgetChanged", budget: this.root.budget.snapshot() });
    if (finished.status !== "completed" || !finished.output) throw new Error(finished.error?.message ?? `child workflow ${runId} failed`);
    const encoded = await this.engine.store.readOutput(runId);
    return decodeSimpleOutput(encoded.value);
  }

  private async handleChild(request: WorkerChildRequest) {
    const operation = this.finishChild(request);
    this.activeOperations.add(operation);
    try {
      const value = await operation;
      return { value, failures: [...this.failures], budget: this.root.budget.snapshot() };
    } catch (error) {
      if (isFatal(error)) this.fatal ??= error;
      throw error;
    } finally { this.activeOperations.delete(operation); }
  }

  private async appendJournal(type: "node-intent" | "node-result" | "node-skip" | "terminal", nodeId: string, payload: JsonValue): Promise<void> {
    let complete!: () => void; let reject!: (error: unknown) => void;
    const result = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail; });
    this.mutation = this.mutation.then(async () => {
      try {
        const sequence = this.record.journalSequence + 1;
        const attemptId = this.record.attempts.at(-1)?.attemptId ?? "unknown";
        await this.root.journal.append(this.record.runId, { sequence, attemptId, nodeId, type, payload });
        const event: WorkflowRunEvent = { type: "JournalAdvanced", sequence };
        this.record = await this.engine.store.reduceAndCommit(this.record.runId, event);
        if (this.depth === 0) this.root.onRecord?.(this.snapshot());
        complete();
      } catch (error) { reject(error); throw error; }
    }).catch((error) => { this.fatal ??= error; });
    return result;
  }

  private async transition(event: WorkflowRunEvent, allowAfterLeafSeal = false): Promise<void> {
    if (this.leafMutationsClosed && !allowAfterLeafSeal && ["LeafStatusChanged", "LeafReferencesChanged", "UsageAdded", "BudgetChanged", "ArtifactRecorded"].includes(event.type)) {
      throw infrastructure("LATE_LEAF_MUTATION", "leaf mutation rejected after cleanup grace expired");
    }
    let complete!: () => void; let reject!: (error: unknown) => void;
    const result = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail; });
    this.mutation = this.mutation.then(async () => {
      try {
        const next = await this.engine.store.reduceAndCommit(this.record.runId, event);
        if (next.recordRevision === this.record.recordRevision) { complete(); return; }
        this.record = next;
        if (this.depth === 0) this.root.onRecord?.(this.snapshot());
        complete();
      } catch (error) { reject(error); throw error; }
    }).catch((error) => { this.fatal ??= error; });
    return result;
  }

  isQuiescent(): boolean { return this.activeOperations.size === 0 && this.root.lingeringLeafOperations.size === 0; }
  async awaitQuiescence(): Promise<void> {
    await Promise.allSettled([...new Set([...this.activeOperations, ...this.root.lingeringLeafOperations])]);
  }

  private async drainActiveOperations(): Promise<boolean> {
    const active = [...this.activeOperations];
    if (active.length === 0) return true;
    const remaining = this.record.cleanup.deadlineAt - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled(active).then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async interruptUnsettledLeaves(error: unknown): Promise<void> {
    for (const leaf of this.record.leaves) {
      if (["queued", "running", "backoff"].includes(leaf.status)) {
        await this.transition({ type: "LeafStatusChanged", leafId: leaf.leafId, status: "interrupted", at: Date.now() }, true).catch(() => {});
      }
    }
  }
}

async function verifyInputManifest(cwd: string, manifest: WorkflowAgentOptions["inputManifest"]): Promise<void> {
  const root = await realpath(cwd);
  for (const entry of manifest ?? []) {
    const requested = path.resolve(root, entry.path);
    const relative = path.relative(root, requested);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new WorkflowContractError("INPUT_MANIFEST_ESCAPE", `input path escapes cwd: ${entry.path}`);
    const file = await realpath(requested);
    const info = await stat(file);
    if (!info.isFile()) throw new WorkflowContractError("INPUT_MANIFEST_FILE", `input is not a regular file: ${entry.path}`);
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    if (digest !== entry.sha256) throw new WorkflowContractError("INPUT_MANIFEST_HASH", `input hash mismatch: ${entry.path}`);
  }
}

function validateAgentOptions(options: WorkflowAgentOptions, meta: WorkflowMeta, ids: Set<string>): void {
  if (!options || typeof options !== "object" || Array.isArray(options) || typeof options.id !== "string" || !options.id) throw new WorkflowContractError("AGENT_ID_REQUIRED", "agent requires a non-empty id");
  const allowed = new Set(["id", "label", "phase", "schema", "profile", "model", "thinking", "tools", "systemPrompt", "appendSystemPrompt", "timeoutMs", "effects", "workspace", "artifactPolicy", "cachePolicy", "inputManifest", "mcp"]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new WorkflowContractError("AGENT_OPTION_UNKNOWN", `unknown agent option: ${key}`);
  if (ids.has(options.id)) throw new WorkflowContractError("AGENT_ID_DUPLICATE", `duplicate agent id: ${options.id}`);
  if (options.phase !== undefined && !(meta.phases ?? []).some((phase) => phase.id === options.phase)) throw new WorkflowContractError("PHASE_UNKNOWN", `unknown phase id: ${options.phase}`);
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) throw new WorkflowContractError("AGENT_TIMEOUT", "agent timeoutMs must be positive");
  if (options.inputManifest !== undefined) {
    for (const entry of options.inputManifest) {
      if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new WorkflowContractError("INPUT_MANIFEST", "inputManifest entries require path and sha256");
    }
  }
  if (options.cachePolicy === "pure" && (!options.inputManifest || options.inputManifest.length === 0)) throw new WorkflowContractError("CACHE_INPUTS", "pure cache requires a declared inputManifest");
}
function enforceCapabilityDeclaration(meta: WorkflowMeta, effect: string): void {
  if (effect === "workspace" && !meta.capabilities.includes("workspace")) throw new WorkflowContractError("CAPABILITY_WORKSPACE", "workspace leaf requires metadata capability workspace");
  if (effect === "external" && !meta.capabilities.includes("external")) throw new WorkflowContractError("CAPABILITY_EXTERNAL", "external leaf requires metadata capability external");
}
function leafFailure(leaf: WorkflowLeafRecordV1, kind: WorkflowLeafFailure["kind"], reason: string): WorkflowLeafFailure {
  return { nodeId: leaf.nodeId, agentId: leaf.agentId, ...(leaf.phase ? { phase: leaf.phase } : {}), reason, kind, occurredAt: Date.now() };
}
function serializeError(error: unknown, forcedKind?: WorkflowErrorV1["kind"]): WorkflowErrorV1 {
  const value = error as any;
  return {
    kind: forcedKind ?? (value?.kind === "contract" || value?.name === "WorkflowContractError" || value instanceof WorkflowPolicyError ? "contract" : value?.name === "WorkflowScriptError" ? "script" : "infrastructure"),
    code: typeof value?.code === "string" ? value.code : "WORKFLOW_ERROR",
    message: errorMessage(error),
    ...(typeof value?.stack === "string" ? { stack: value.stack } : {}),
  };
}
function isFatal(error: unknown): boolean {
  const value = error as any;
  return value?.kind === "contract" || value?.kind === "infrastructure" || value?.name === "WorkflowContractError" || value instanceof WorkflowPolicyError;
}
function infrastructure(code: string, message: string): Error { const error = new Error(message); Object.assign(error, { name: "WorkflowInfrastructureError", kind: "infrastructure", code }); return error; }
function deadlineError(message: string): Error { const error = new Error(message); (error as NodeJS.ErrnoException).code = "WORKFLOW_DEADLINE"; return error; }
function abortError(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new Error("workflow aborted", { cause: signal.reason }); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hashCanonical(value: unknown): string { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function boundedPreview(value: unknown): string { try { const text = JSON.stringify(value); return (text ?? String(value)).slice(0, 8_192); } catch { return "[encoded output]"; } }
function linkSignals(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onA = () => controller.abort(a.reason); const onB = () => controller.abort(b.reason);
  a.addEventListener("abort", onA, { once: true }); b.addEventListener("abort", onB, { once: true });
  if (a.aborted) onA(); else if (b.aborted) onB();
  return { signal: controller.signal, dispose: () => { a.removeEventListener("abort", onA); b.removeEventListener("abort", onB); } };
}
function decodeSimpleOutput(value: any): unknown {
  // Child outputs crossing the RPC boundary are canonical JSON in the current
  // engine. Tagged primitives are decoded; complex unsupported values remain a
  // bounded descriptor rather than being silently lossy.
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(decodeSimpleOutput);
  if (value?.$type === "array") return value.values.map(decodeSimpleOutput);
  if (value?.$type === "object") return Object.fromEntries(value.entries.map(([key, item]: any[]) => [typeof key === "string" ? key : JSON.stringify(key), decodeSimpleOutput(item)]));
  if (value?.$type === "undefined") return undefined;
  return value;
}

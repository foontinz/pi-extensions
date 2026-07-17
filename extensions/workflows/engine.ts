import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSubagentInProcess } from "../subagents/core/in-process-runner.js";
import { emptyUsageStats, type SubagentResult } from "../subagents/core/types.js";
import { cleanupWorktreeAsync, prepareWorktree } from "../subagents/workspace/create-worktree.js";
import {
  cloneCanonicalJson,
  createWorkflowRunRecord,
  encodeWorkflowOutput,
  parseWorkflowMetadata,
  reduceWorkflowEvent,
  validateWorkflowInput,
  WorkflowContractError,
  type DurableWorkflowEvent,
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
import { WorkflowJournal, claimWorkflowResume, type WorkflowReplayEntry } from "./resume/journal.js";
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
  controller: AbortController;
  agentsAccepted: number;
  maxAgents: number;
  approvedCapabilities: string[];
  projectTrusted: boolean;
  journal: WorkflowJournal;
  replay: Map<string, WorkflowReplayEntry>;
  leafControllers: Map<string, AbortController>;
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
    const fingerprint = hashCanonical({ source: source.sha256, args: argsSha256, metadata: parsed.metadata, defaults, engine: 1 });
    const journal = new WorkflowJournal(this.store);
    let replay = new Map<string, WorkflowReplayEntry>();
    let releaseResumeClaim: (() => Promise<void>) | undefined;
    if (input.resumeFromRunId) {
      const previous = await this.store.readRun(input.resumeFromRunId);
      if (previous.owner.sessionId !== owner.sessionId) throw new WorkflowContractError("RESUME_OWNER", "resume source belongs to another session owner");
      if (!previous.metadata.resumable) throw new WorkflowContractError("RESUME_NOT_DECLARED", "resume source does not declare resumable:true");
      if (previous.source.sha256 !== source.sha256 || previous.argsSha256 !== argsSha256 || previous.executionFingerprint !== fingerprint) {
        throw new WorkflowContractError("RESUME_FINGERPRINT", "resume requires exact copied source, canonical args, metadata, model, tools, prompts, and engine fingerprint");
      }
      releaseResumeClaim = await claimWorkflowResume(this.store, input.resumeFromRunId);
      try {
        const records = await journal.recover(input.resumeFromRunId);
        const invalidationSequence = invalidateNodeId
          ? records.find((record) => record.type === "node-intent" && record.nodeId === invalidateNodeId)?.sequence
          : undefined;
        replay = journal.replayIndex(invalidationSequence === undefined ? records : records.filter((record) => record.sequence < invalidationSequence));
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
    });
    try { await this.store.createRun(record, source.source); }
    catch (error) { await releaseResumeClaim?.(); throw error; }

    const controller = new AbortController();
    this.owners.register({ runId, owner, controller });
    const globalSemaphore = this.processSemaphore(settings.globalMaxConcurrency);
    const root: RootState = {
      runId, cwd: ctx.cwd, owner, deadlineAt,
      budget: new BudgetManager(budgetTotal),
      runSemaphore: new FairSemaphore(settings.runMaxConcurrency),
      globalSemaphore, settings, defaults, availableTools, controller,
      agentsAccepted: 0,
      maxAgents: parsed.metadata.maxAgents,
      approvedCapabilities: [...parsed.metadata.capabilities],
      projectTrusted: ctx.isProjectTrusted(),
      journal,
      replay,
      leafControllers: new Map(),
      ...(onRecord ? { onRecord } : {}),
    };
    const coordinator = new RunCoordinator(this, root, record, { resolved: source, parsed }, 0, "root", [source.identity]);
    this.activeRoots.set(runId, root);
    try { await coordinator.start(); }
    catch (error) {
      this.activeRoots.delete(runId);
      this.owners.finish(runId);
      await releaseResumeClaim?.();
      throw error;
    }
    const completion = coordinator.execute().finally(async () => {
      this.owners.finish(runId);
      this.completions.delete(runId);
      this.activeRoots.delete(runId);
      await releaseResumeClaim?.();
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

  stop(runId: string, ctx: ExtensionContext, reason: string, scopeAll = false): boolean {
    return this.owners.stop(runId, this.owners.bind(ctx), reason, scopeAll);
  }
  pause(runId: string, ctx: ExtensionContext): boolean {
    const error = new Error("pause requested");
    (error as NodeJS.ErrnoException).code = "WORKFLOW_PAUSE";
    return this.owners.stop(runId, this.owners.bind(ctx), error, false);
  }
  skip(runId: string, nodeId: string, ctx: ExtensionContext): boolean {
    const root = this.activeRoots.get(runId);
    if (!root || root.owner.sessionId !== this.owners.bind(ctx).sessionId) return false;
    const controller = root.leafControllers.get(nodeId);
    if (!controller) return false;
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
      if (this.activeRoots.has(record.runId)) continue;
      for (const leaf of record.leaves) {
        if (["queued", "running", "backoff"].includes(leaf.status)) {
          record = await this.applyEvent(record.runId, { type: "LeafStatusChanged", leafId: leaf.leafId, status: "interrupted", at: Date.now() });
        }
      }
      const uncertain = record.leaves.some((leaf) =>
        leaf.effects === "external" && leaf.status === "interrupted"
        || leaf.effects === "workspace" && leaf.status === "interrupted" && leaf.artifactIds.length === 0,
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
  }

  async applyEvent(runId: string, event: WorkflowRunEvent): Promise<WorkflowRunRecordV1> {
    const current = await this.store.readRun(runId);
    const transition = reduceWorkflowEvent(current, event);
    if (!transition.changed) return current;
    await this.store.appendEvent({ schemaVersion: 1, runId, sequence: transition.next.recordRevision, timestamp: Date.now(), event });
    await this.store.writeRun(transition.next);
    if (event.type === "NotificationChanged") await this.store.writeNotification(runId, event.notification);
    return transition.next;
  }

  async resume(runId: string, ctx: ExtensionContext, onRecord?: (record: WorkflowRunRecordV1) => void, invalidateNodeId?: string): Promise<WorkflowLaunch> {
    const previous = await this.store.readRun(runId);
    if (previous.owner.sessionId !== this.owners.bind(ctx).sessionId) throw new WorkflowContractError("RUN_OWNER", "cannot resume another session owner's workflow");
    if (!previous.metadata.resumable) throw new WorkflowContractError("RUN_NOT_RESUMABLE", "workflow metadata does not declare resumable:true");
    const script = await readFile(previous.source.copiedPath, "utf8");
    return this.launch({ script, args: previous.args, budgetTokens: previous.budget.total ?? undefined, timeoutMs: Math.max(1_000, previous.deadlineAt - previous.createdAt), resumeFromRunId: runId }, ctx, true, onRecord, invalidateNodeId);
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
  private readonly activeLeaves = new Set<Promise<unknown>>();
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
      await Promise.allSettled([...this.activeLeaves]);
      if (this.fatal) throw this.fatal;
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
      await this.transition({ type: "RunStatusChanged", status: "completed" });
      await this.transition({ type: "RetentionChanged", pinned: false, expiresAt: Date.now() + this.root.settings.retentionMs });
    } catch (error) {
      executionController.abort(error);
      await Promise.allSettled([...this.activeLeaves]);
      await this.interruptUnsettledLeaves(error);
      const cancellation = this.root.controller.signal.aborted;
      const paused = cancellation && (this.root.controller.signal.reason as NodeJS.ErrnoException | undefined)?.code === "WORKFLOW_PAUSE";
      const workflowError = serializeError(error, cancellation ? "cancellation" : undefined);
      const recoveryRequired = /^(WORKSPACE|ARTIFACT)/.test(workflowError.code);
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
      await this.transition({ type: "RunStatusChanged", status: finalStatus, error: workflowError }).catch(async (transitionError) => {
        const recovery = serializeError(transitionError);
        await this.transition({ type: "RunStatusChanged", status: "recovery_required", error: recovery }).catch(() => {});
      });
      if (finalStatus === "failed" || finalStatus === "cancelled") {
        await this.transition({ type: "RetentionChanged", pinned: false, expiresAt: Date.now() + this.root.settings.retentionMs }).catch(() => {});
      }
    } finally {
      linked.dispose();
    }
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
      executionFingerprint: hashCanonical({ root: this.record.executionFingerprint, id: options.id, phase, resolved, schema: options.schema ?? null, inputManifest: options.inputManifest ?? null }),
      attempts: [], artifactIds: [],
    };
    await this.transition({ type: "LeafAccepted", leaf });
    if (this.source.parsed.metadata.resumable) {
      await this.appendJournal("node-intent", nodeId, { fingerprint: leaf.executionFingerprint, cachePolicy: leaf.cachePolicy });
    }
    if (leaf.cachePolicy === "pure") {
      await verifyInputManifest(this.root.cwd, options.inputManifest ?? []);
      const cached = this.root.replay.get(nodeId);
      if (cached?.fingerprint === leaf.executionFingerprint) {
        await this.transition({ type: "LeafStatusChanged", leafId, status: "cached", at: Date.now(), result: cached.result });
        if (this.source.parsed.metadata.resumable) {
          await this.appendJournal("node-result", nodeId, { fingerprint: leaf.executionFingerprint, cachePolicy: "pure", result: cached.result });
        }
        return cloneCanonicalJson(cached.result);
      }
    }

    const leafController = new AbortController();
    this.root.leafControllers.set(nodeId, leafController);
    const operation = this.runLeaf(leaf, request.task, options, resolved, deadline, leafController.signal);
    this.activeLeaves.add(operation);
    try { return await operation; }
    finally { this.activeLeaves.delete(operation); this.root.leafControllers.delete(nodeId); }
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
    const reservation = this.root.budget.reserve(Math.max(1, Math.min(8192, this.root.budget.remaining() ?? 8192)));
    try {
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
      if (this.source.parsed.metadata.resumable && resolved.cachePolicy === "pure") {
        await this.appendJournal("node-result", leaf.nodeId, { fingerprint: leaf.executionFingerprint, cachePolicy: "pure", result: canonical });
      }
      return canonical;
    } catch (error) {
      try { this.root.budget.refund(reservation); } catch { /* already committed */ }
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

  private async finishWorkspace(leaf: WorkflowLeafRecordV1, resolved: ReturnType<typeof resolveAgentExecution>, leaseId?: string): Promise<void> {
    if (!leaseId) return;
    if (resolved.artifactPolicy === "discard") {
      await this.engine.artifacts.discard(leaseId);
      return;
    }
    const artifact = await this.engine.artifacts.release(leaseId);
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

  private async recordLeafUsage(leaf: WorkflowLeafRecordV1, result: SubagentResult): Promise<void> {
    const usage = {
      input: result.usage.input,
      output: result.usage.output,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      cost: result.usage.cost,
      costState: "reported" as const,
      contextTokens: result.usage.contextTokens,
      turns: result.usage.turns,
      providerAttempts: 0,
      providerRetries: 0,
      structuredSubmissions: result.structuredOutputOutcome?.submissions ?? 0,
      leafAttempts: 0,
      cacheHits: 0,
    };
    await this.transition({ type: "UsageAdded", usage });
    await this.transition({ type: "BudgetChanged", budget: this.root.budget.snapshot() });
    if (result.sessionFile) await this.transition({ type: "LeafReferencesChanged", leafId: leaf.leafId, transcriptPath: result.sessionFile });
  }

  private async finishChild(request: WorkerChildRequest): Promise<unknown> {
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
    await this.engine.store.createRun(record, resolved.source);
    const child = new RunCoordinator(
      this.engine, this.root, record, { resolved, parsed }, this.depth + 1,
      `${this.scope}/workflow:${resolved.sha256}`,
      [...this.sourceStack, resolved.identity],
    );
    await child.start();
    const finished = await child.execute();
    if (finished.status !== "completed" || !finished.output) throw new Error(finished.error?.message ?? `child workflow ${runId} failed`);
    const encoded = await this.engine.store.readOutput(runId);
    return decodeSimpleOutput(encoded.value);
  }

  private async handleChild(request: WorkerChildRequest) {
    try {
      const value = await this.finishChild(request);
      return { value, failures: [...this.failures], budget: this.root.budget.snapshot() };
    } catch (error) {
      if (isFatal(error)) this.fatal ??= error;
      throw error;
    }
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
        const transition = reduceWorkflowEvent(this.record, event);
        await this.engine.store.appendEvent({ schemaVersion: 1, runId: this.record.runId, sequence: transition.next.recordRevision, timestamp: Date.now(), event });
        await this.engine.store.writeRun(transition.next);
        this.record = transition.next;
        if (this.depth === 0) this.root.onRecord?.(this.snapshot());
        complete();
      } catch (error) { reject(error); throw error; }
    }).catch((error) => { this.fatal ??= error; });
    return result;
  }

  private async transition(event: WorkflowRunEvent): Promise<void> {
    let complete!: () => void; let reject!: (error: unknown) => void;
    const result = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail; });
    this.mutation = this.mutation.then(async () => {
      try {
        const transition = reduceWorkflowEvent(this.record, event);
        if (!transition.changed) { complete(); return; }
        const durable: DurableWorkflowEvent = { schemaVersion: 1, runId: this.record.runId, sequence: transition.next.recordRevision, timestamp: Date.now(), event };
        await this.engine.store.appendEvent(durable);
        await this.engine.store.writeRun(transition.next);
        this.record = transition.next;
        if (this.depth === 0) this.root.onRecord?.(this.snapshot());
        complete();
      } catch (error) { reject(error); throw error; }
    }).catch((error) => { this.fatal ??= error; });
    return result;
  }

  private async interruptUnsettledLeaves(error: unknown): Promise<void> {
    for (const leaf of this.record.leaves) {
      if (["queued", "running", "backoff"].includes(leaf.status)) {
        await this.transition({ type: "LeafStatusChanged", leafId: leaf.leafId, status: "interrupted", at: Date.now() }).catch(() => {});
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

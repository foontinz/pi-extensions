import { isDeepStrictEqual } from "node:util";
import { cloneCanonicalJson } from "./canonical-json.js";
import type {
  WorkflowAttemptRecordV1,
  WorkflowBudgetSnapshot,
  WorkflowCleanupOutcomeV1,
  WorkflowLeafRecordV1,
  WorkflowLeafStatus,
  WorkflowMeta,
  WorkflowOwnerV1,
  WorkflowRunEvent,
  WorkflowRunRecordV1,
  WorkflowRunStatus,
  WorkflowSourceProvenanceV1,
  WorkflowUsage,
  WorkflowTransition,
} from "./contracts.js";
import { emptyWorkflowUsage, WORKFLOW_LEAF_STATUS_VALUES, WORKFLOW_RUN_STATUS_VALUES, WORKFLOW_TERMINAL_STATUS_VALUES } from "./contracts.js";
import { MAX_WORKFLOW_AGENTS } from "./limits.js";

const RUN_STATUSES = new Set<WorkflowRunStatus>(WORKFLOW_RUN_STATUS_VALUES);
const TERMINAL_RUN_STATUSES = new Set<WorkflowRunStatus>(WORKFLOW_TERMINAL_STATUS_VALUES);
const LEAF_STATUSES = new Set<WorkflowLeafStatus>(WORKFLOW_LEAF_STATUS_VALUES);
const TERMINAL_LEAF_STATUSES = new Set<WorkflowLeafStatus>(["completed", "failed", "interrupted", "skipped", "cached"]);
const LEAF_TRANSITIONS: Record<WorkflowLeafStatus, ReadonlySet<WorkflowLeafStatus>> = {
  queued: new Set(["running", "backoff", "failed", "interrupted", "skipped", "cached"]),
  running: new Set(["backoff", "completed", "failed", "interrupted", "skipped"]),
  backoff: new Set(["running", "failed", "interrupted", "skipped"]),
  completed: new Set(), failed: new Set(), interrupted: new Set(), skipped: new Set(), cached: new Set(),
};

export class WorkflowInvariantError extends Error { override name = "WorkflowInvariantError" }

export interface CreateWorkflowRunOptions {
  runId: string;
  rootRunId?: string;
  parentRunId?: string;
  resumeFromRunId?: string;
  owner: WorkflowOwnerV1;
  source: WorkflowSourceProvenanceV1;
  metadata: WorkflowMeta;
  args: unknown;
  argsSha256: string;
  executionFingerprint: string;
  activationIdentity: string;
  deadlineAt: number;
  cleanupDeadlineAt: number;
  budgetTotal?: number | null;
  budgetSpent?: number;
  initialUsage?: WorkflowUsage;
  createdAt?: number;
}
export interface ReduceWorkflowOptions { now?: number }

export function createWorkflowRunRecord(options: CreateWorkflowRunOptions): WorkflowRunRecordV1 {
  const createdAt = options.createdAt ?? Date.now();
  const record: WorkflowRunRecordV1 = {
    schemaVersion: 1,
    recordRevision: 0,
    runId: options.runId,
    rootRunId: options.rootRunId ?? options.runId,
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(options.resumeFromRunId ? { resumeFromRunId: options.resumeFromRunId } : {}),
    owner: structuredClone(options.owner),
    source: structuredClone(options.source),
    metadata: structuredClone(options.metadata),
    args: cloneCanonicalJson(options.args),
    argsSha256: options.argsSha256,
    executionFingerprint: options.executionFingerprint,
    activationIdentity: options.activationIdentity,
    status: "created",
    createdAt,
    deadlineAt: options.deadlineAt,
    cleanup: { status: "pending", deadlineAt: options.cleanupDeadlineAt },
    attempts: [], leaves: [], failures: [], artifacts: [],
    notification: { state: "pending", attempts: 0, updatedAt: createdAt },
    usage: options.initialUsage ? structuredClone(options.initialUsage) : emptyWorkflowUsage(),
    budget: {
      total: options.budgetTotal ?? null,
      spent: options.budgetSpent ?? 0,
      reserved: 0,
      remaining: options.budgetTotal === null || options.budgetTotal === undefined ? null : Math.max(0, options.budgetTotal - (options.budgetSpent ?? 0)),
    },
    pinned: false,
    journalSequence: 0,
  };
  assertWorkflowRunInvariants(record);
  return record;
}

/** Pure canonical reducer. Persistence/UI/runtime are projections of its output. */
export function reduceWorkflowEvent(record: WorkflowRunRecordV1, event: WorkflowRunEvent, options: ReduceWorkflowOptions = {}): WorkflowTransition {
  assertWorkflowRunInvariants(record);
  const now = options.now ?? Date.now();
  finite(now, "now");
  const previous = structuredClone(record);
  const next = structuredClone(record);

  switch (event.type) {
    case "RunStarted":
      if (next.status === "created") {
        if (event.attempt.runId !== next.runId || event.attempt.status !== "running") throw invariant("invalid initial attempt");
        if (next.attempts.some((item) => item.attemptId === event.attempt.attemptId)) throw invariant("duplicate attempt id");
        next.attempts.push(structuredClone(event.attempt));
        next.status = "running";
        next.startedAt = event.attempt.startedAt;
      }
      break;
    case "TerminalIntentAccepted":
      if (!next.firstTerminalIntent && !isTerminalRunStatus(next.status)) {
        next.firstTerminalIntent = structuredClone(event.intent);
        next.status = event.intent.kind === "pause" ? "pausing" : event.intent.kind === "complete" ? "draining" : "stopping";
      }
      break;
    case "RunStatusChanged":
      applyRunStatus(next, event.status, now, event.error);
      break;
    case "LeafAccepted":
      if (next.status !== "running") throw invariant("leaves may be accepted only while running");
      if (next.leaves.length >= Math.min(next.metadata.maxAgents, MAX_WORKFLOW_AGENTS)) throw invariant("workflow agent cap exceeded");
      if (next.leaves.some((leaf) => leaf.leafId === event.leaf.leafId || leaf.nodeId === event.leaf.nodeId || leaf.agentId === event.leaf.agentId)) {
        throw invariant("duplicate leaf/node/agent id in workflow scope");
      }
      if (event.leaf.status !== "queued") throw invariant("accepted leaf must be queued");
      next.leaves.push(structuredClone(event.leaf));
      next.usage.leafAttempts += 1;
      break;
    case "LeafStatusChanged": {
      const leaf = findLeaf(next, event.leafId);
      if (!LEAF_TRANSITIONS[leaf.status].has(event.status)) {
        if (leaf.status === event.status) break;
        throw invariant(`invalid leaf transition ${leaf.status} -> ${event.status}`);
      }
      leaf.status = event.status;
      if (event.status === "running") leaf.startedAt ??= event.at;
      if (TERMINAL_LEAF_STATUSES.has(event.status)) leaf.finishedAt = event.at;
      if (event.failure) {
        leaf.failure = structuredClone(event.failure);
        if (!next.failures.some((failure) => failure.nodeId === event.failure!.nodeId && failure.attemptId === event.failure!.attemptId)) {
          next.failures.push(structuredClone(event.failure));
        }
      }
      if (event.result !== undefined) leaf.result = cloneCanonicalJson(event.result);
      if (event.status === "cached") next.usage.cacheHits += 1;
      break;
    }
    case "LeafReferencesChanged": {
      const leaf = findLeaf(next, event.leafId);
      if (event.transcriptPath !== undefined) leaf.transcriptPath = event.transcriptPath;
      if (event.workspaceLeaseId !== undefined) leaf.workspaceLeaseId = event.workspaceLeaseId;
      if (event.artifactIds !== undefined) leaf.artifactIds = [...event.artifactIds];
      break;
    }
    case "UsageAdded":
      next.usage = addUsage(next.usage, event.usage);
      break;
    case "ArtifactRecorded":
      if (next.artifacts.some((item) => item.artifactId === event.artifact.artifactId)) throw invariant("duplicate artifact id");
      next.artifacts.push(structuredClone(event.artifact));
      break;
    case "ArtifactStateChanged": {
      const artifact = next.artifacts.find((item) => item.artifactId === event.artifactId);
      if (!artifact) throw invariant(`unknown artifact ${event.artifactId}`);
      const allowed = artifact.state === "verified" && (event.state === "applied" || event.state === "released")
        || artifact.state === "applied" && event.state === "released";
      if (!allowed) {
        if (artifact.state === event.state) break;
        throw invariant(`invalid artifact transition ${artifact.state} -> ${event.state}`);
      }
      artifact.state = event.state;
      break;
    }
    case "OutputRecorded":
      if (next.output && !isDeepStrictEqual(next.output, event.output)) throw invariant("workflow output is immutable once recorded");
      next.output = structuredClone(event.output);
      break;
    case "CleanupChanged":
      next.cleanup = structuredClone(event.cleanup);
      if ((event.cleanup.status === "failed" || event.cleanup.status === "recovery_required") && isTerminalRunStatus(next.status)) {
        next.status = event.cleanup.status === "failed" ? "failed" : "recovery_required";
        next.error = event.cleanup.error;
      }
      break;
    case "NotificationChanged":
      next.notification = structuredClone(event.notification);
      break;
    case "BudgetChanged":
      next.budget = structuredClone(event.budget);
      break;
    case "JournalAdvanced":
      if (event.sequence !== next.journalSequence + 1) throw invariant("journal sequence must advance monotonically by one");
      next.journalSequence = event.sequence;
      break;
    case "RetentionChanged":
      next.pinned = event.pinned;
      if (event.expiresAt === undefined) delete next.expiresAt;
      else next.expiresAt = event.expiresAt;
      break;
    default:
      assertNever(event);
  }

  const changed = !isDeepStrictEqual(previous, next);
  if (changed) next.recordRevision = previous.recordRevision + 1;
  assertWorkflowRunInvariants(next);
  if (previous.firstTerminalIntent && !isDeepStrictEqual(previous.firstTerminalIntent, next.firstTerminalIntent)) throw invariant("first terminal intent must win");
  return { previous, next, event: structuredClone(event), changed };
}
export const WorkflowRunReducer = reduceWorkflowEvent;

function applyRunStatus(record: WorkflowRunRecordV1, status: WorkflowRunStatus, now: number, error?: WorkflowRunRecordV1["error"]): void {
  if (record.status === status) return;
  if (isTerminalRunStatus(record.status)) {
    const cleanupUpgrade = (status === "failed" || status === "recovery_required") && (record.cleanup.status === "failed" || record.cleanup.status === "recovery_required");
    if (!cleanupUpgrade) return;
  }
  const allowed: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
    created: ["running", "failed", "cancelled", "interrupted", "recovery_required"],
    running: ["pausing", "stopping", "draining", "completed", "failed", "cancelled", "interrupted", "recovery_required"],
    pausing: ["paused", "failed", "interrupted", "recovery_required"],
    paused: ["stopping", "cancelled", "interrupted", "recovery_required"],
    stopping: ["draining", "failed", "cancelled", "interrupted", "recovery_required"],
    draining: ["completed", "failed", "cancelled", "interrupted", "recovery_required"],
    completed: ["failed", "recovery_required"], cancelled: ["failed", "recovery_required"], interrupted: ["failed", "recovery_required"],
    failed: ["recovery_required"], recovery_required: [],
  };
  if (!allowed[record.status].includes(status)) throw invariant(`invalid run transition ${record.status} -> ${status}`);
  if (status === "paused") {
    const attempt = record.attempts.at(-1);
    if (attempt?.status === "running") {
      attempt.status = "interrupted";
      attempt.finishedAt = now;
      if (error) attempt.error = structuredClone(error);
    }
  }
  if (isTerminalRunStatus(status)) {
    const unsettled = record.leaves.filter((leaf) => !TERMINAL_LEAF_STATUSES.has(leaf.status));
    if (unsettled.length > 0) throw invariant("terminal run requires every accepted leaf to be terminal/interrupted");
    record.finishedAt = now;
    const attempt = record.attempts.at(-1);
    if (attempt && attempt.status === "running") {
      attempt.status = status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : status === "interrupted" ? "interrupted" : "failed";
      attempt.finishedAt = now;
      if (error) attempt.error = structuredClone(error);
    }
  }
  record.status = status;
  if (error) record.error = structuredClone(error);
}

export function assertWorkflowRunInvariants(value: unknown): asserts value is WorkflowRunRecordV1 {
  if (!plain(value)) throw invariant("run aggregate must be a plain object");
  if (value.schemaVersion !== 1) throw invariant("unsupported run schema");
  integer(value.recordRevision, "recordRevision", 0);
  uuid(value.runId, "runId"); uuid(value.rootRunId, "rootRunId");
  if (value.parentRunId !== undefined) uuid(value.parentRunId, "parentRunId");
  if (value.resumeFromRunId !== undefined) uuid(value.resumeFromRunId, "resumeFromRunId");
  assertOwner(value.owner); assertSource(value.source); assertMetadata(value.metadata);
  cloneCanonicalJson(value.args);
  hash(value.argsSha256, "argsSha256"); hash(value.executionFingerprint, "executionFingerprint"); hash(value.activationIdentity, "activationIdentity");
  if (!RUN_STATUSES.has(value.status as WorkflowRunStatus)) throw invariant("invalid run status");
  finite(value.createdAt, "createdAt"); finite(value.deadlineAt, "deadlineAt");
  if (value.startedAt !== undefined) finite(value.startedAt, "startedAt");
  if (value.finishedAt !== undefined) finite(value.finishedAt, "finishedAt");
  if (!Array.isArray(value.attempts) || !Array.isArray(value.leaves) || !Array.isArray(value.failures) || !Array.isArray(value.artifacts)) throw invariant("aggregate collections are invalid");
  assertCleanup(value.cleanup); assertNotification(value.notification); assertBudget(value.budget);
  if (!plain(value.usage)) throw invariant("usage is invalid");
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "contextTokens", "turns", "structuredSubmissions", "leafAttempts", "cacheHits"]) finite(value.usage[key], `usage.${key}`);
  if (value.usage.cost !== null) finite(value.usage.cost, "usage.cost");
  if (!new Set(["reported", "estimated", "unavailable"]).has(value.usage.costState)) throw invariant("usage cost state invalid");
  const leafIds = new Set<string>(); const nodeIds = new Set<string>(); const agentIds = new Set<string>();
  for (const leaf of value.leaves as WorkflowLeafRecordV1[]) {
    if (!plain(leaf) || !LEAF_STATUSES.has(leaf.status)) throw invariant("invalid leaf");
    nonempty(leaf.leafId, "leafId"); nonempty(leaf.nodeId, "nodeId"); nonempty(leaf.agentId, "agentId");
    if (leafIds.has(leaf.leafId) || nodeIds.has(leaf.nodeId) || agentIds.has(leaf.agentId)) throw invariant("duplicate leaf identity");
    leafIds.add(leaf.leafId); nodeIds.add(leaf.nodeId); agentIds.add(leaf.agentId);
    finite(leaf.acceptedAt, "leaf.acceptedAt"); finite(leaf.deadlineAt, "leaf.deadlineAt");
    if (!Array.isArray(leaf.artifactIds)) throw invariant("leaf artifacts invalid");
    if (TERMINAL_LEAF_STATUSES.has(leaf.status) && leaf.finishedAt === undefined) throw invariant("terminal leaf missing finishedAt");
  }
  const artifactIds = new Set<string>();
  for (const artifact of value.artifacts as WorkflowRunRecordV1["artifacts"]) {
    if (!plain(artifact) || !new Set(["pending", "verified", "applied", "released", "recovery_required"]).has(artifact.state)) {
      throw invariant("invalid artifact");
    }
    nonempty(artifact.artifactId, "artifact.artifactId");
    if (artifactIds.has(artifact.artifactId)) throw invariant("duplicate artifact id");
    artifactIds.add(artifact.artifactId);
  }
  if (value.leaves.length > Math.min(value.metadata.maxAgents, MAX_WORKFLOW_AGENTS)) throw invariant("agent cap exceeded");
  if (isTerminalRunStatus(value.status)) {
    if (value.finishedAt === undefined) throw invariant("terminal run missing finishedAt");
    if (value.leaves.some((leaf: WorkflowLeafRecordV1) => !TERMINAL_LEAF_STATUSES.has(leaf.status))) throw invariant("terminal run has unsettled leaves");
  } else if (value.finishedAt !== undefined) throw invariant("nonterminal run has finishedAt");
  if (value.status === "created" && (value.startedAt !== undefined || value.attempts.length > 0)) throw invariant("created run has attempts");
  if (typeof value.pinned !== "boolean") throw invariant("pinned must be boolean");
  integer(value.journalSequence, "journalSequence", 0);
}

export function isWorkflowTerminalStatus(status: WorkflowRunStatus): status is WorkflowRunRecordV1["status"] {
  return TERMINAL_RUN_STATUSES.has(status);
}
export const isTerminalRunStatus = isWorkflowTerminalStatus;

function findLeaf(record: WorkflowRunRecordV1, id: string): WorkflowLeafRecordV1 {
  const leaf = record.leaves.find((item) => item.leafId === id);
  if (!leaf) throw invariant(`unknown leaf ${id}`);
  return leaf;
}
function assertOwner(value: unknown): asserts value is WorkflowOwnerV1 {
  if (!plain(value)) throw invariant("owner invalid");
  nonempty(value.sessionId, "owner.sessionId"); nonempty(value.instanceId, "owner.instanceId"); integer(value.parentPid, "owner.parentPid", 1);
}
function assertSource(value: unknown): asserts value is WorkflowSourceProvenanceV1 {
  if (!plain(value) || !new Set(["inline", "path", "name"]).has(value.kind as string)) throw invariant("source invalid");
  nonempty(value.copiedPath, "source.copiedPath"); nonempty(value.sourceDirectory, "source.sourceDirectory"); hash(value.sha256, "source.sha256"); nonempty(value.resolverIdentity, "source.resolverIdentity");
}
function assertMetadata(value: unknown): asserts value is WorkflowMeta {
  if (!plain(value)) throw invariant("metadata invalid");
  nonempty(value.name, "metadata.name"); nonempty(value.description, "metadata.description");
  if (typeof value.resumable !== "boolean") throw invariant("metadata.resumable invalid");
  integer(value.maxAgents, "metadata.maxAgents", 1);
  if (!Array.isArray(value.capabilities)) throw invariant("metadata.capabilities invalid");
}
function assertCleanup(value: unknown): asserts value is WorkflowCleanupOutcomeV1 {
  if (!plain(value) || !new Set(["pending", "running", "completed", "failed", "recovery_required"]).has(value.status as string)) throw invariant("cleanup invalid");
  finite(value.deadlineAt, "cleanup.deadlineAt");
}
function assertNotification(value: unknown): void {
  if (!plain(value) || !new Set(["pending", "delivered", "failed"]).has(value.state as string)) throw invariant("notification invalid");
  integer(value.attempts, "notification.attempts", 0); finite(value.updatedAt, "notification.updatedAt");
}
function assertBudget(value: unknown): asserts value is WorkflowBudgetSnapshot {
  if (!plain(value)) throw invariant("budget invalid");
  if (value.total !== null) integer(value.total, "budget.total", 1);
  finite(value.spent, "budget.spent"); finite(value.reserved, "budget.reserved");
  if (value.remaining !== null) finite(value.remaining, "budget.remaining");
}
function addUsage(a: WorkflowRunRecordV1["usage"], b: WorkflowRunRecordV1["usage"]): WorkflowRunRecordV1["usage"] {
  return {
    input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0),
    costState: a.costState === "reported" || b.costState === "reported" ? "reported" : a.costState === "estimated" || b.costState === "estimated" ? "estimated" : "unavailable",
    contextTokens: Math.max(a.contextTokens, b.contextTokens), turns: a.turns + b.turns,
    // Leaf-attempt and cache-hit counters are committed by their owning
    // reducer events, never trusted from aggregate usage payloads.
    structuredSubmissions: a.structuredSubmissions + b.structuredSubmissions, leafAttempts: a.leafAttempts, cacheHits: a.cacheHits,
  };
}
function plain(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function nonempty(value: unknown, path: string): asserts value is string { if (typeof value !== "string" || !value) throw invariant(`${path} must be non-empty`); }
function hash(value: unknown, path: string): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invariant(`${path} must be sha256`); }
function uuid(value: unknown, path: string): void { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw invariant(`${path} must be a UUID`); }
function finite(value: unknown, path: string): asserts value is number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invariant(`${path} must be a non-negative finite number`); }
function integer(value: unknown, path: string, min: number): asserts value is number { finite(value, path); if (!Number.isSafeInteger(value) || value < min) throw invariant(`${path} must be an integer >= ${min}`); }
function invariant(message: string): WorkflowInvariantError { return new WorkflowInvariantError(message); }
function assertNever(value: never): never { throw invariant(`unhandled event ${JSON.stringify(value)}`); }

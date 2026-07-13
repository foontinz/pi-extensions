import { createHash, randomUUID } from "node:crypto";

/** Session/custom-message and tool identifiers owned by the goal extension. */
export const GOAL_CHECKPOINT_ENTRY = "goal/checkpoint-v2";
export const GOAL_CHECKPOINT_TOOL = "goal_checkpoint";
export const GOAL_RESUME_TOOL = "goal_resume";
export const GOAL_CONTROL_MESSAGE = "goal-control";
export const LEGACY_GOAL_STATE_ENTRY = "goal-state";

export const GOAL_SCHEMA_VERSION = 2 as const;
export const MAX_GOAL_SNAPSHOT_BYTES = 64 * 1024;

/** Public limits are shared by command, tool, and persistence validation. */
export const GOAL_BOUNDS = Object.freeze({
  snapshotBytes: MAX_GOAL_SNAPSHOT_BYTES,
  id: 160,
  objective: 2_000,
  shortText: 1_000,
  text: 4_000,
  locator: 4_000,
  digest: 256,
  mediaType: 256,
  constraints: 64,
  acceptanceCriteria: 128,
  criterionEvidenceIds: 128,
  phases: 128,
  phaseDependencies: 128,
  phaseCriteria: 128,
  completedPhaseSummaries: 128,
  decisions: 256,
  openQuestions: 128,
  recentProgress: 128,
  evidence: 512,
  artifacts: 256,
  counter: 1_000_000_000,
});

export type GoalCriterionStatus = "pending" | "satisfied" | "unsatisfied" | "waived";

export interface GoalCriterion {
  id: string;
  description: string;
  status: GoalCriterionStatus;
  evidenceIds?: string[];
}

export type GoalPhaseStatus =
  | "pending"
  | "running"
  | "candidate_complete"
  | "verifying"
  | "completed"
  | "blocked"
  | "failed"
  | "skipped";

export interface GoalPhase {
  id: string;
  title: string;
  intent: string;
  status: GoalPhaseStatus;
  dependencies: string[];
  criteria: GoalCriterion[];
  summary?: string;
  nextAction?: string;
}

export interface GoalDecision {
  id: string;
  summary: string;
  rationale?: string;
  madeAt: number;
  runId?: string;
}

export type GoalEvidenceKind = "file" | "command" | "test" | "git" | "session_entry" | "artifact";

export interface GoalEvidence {
  id: string;
  criterionId?: string;
  kind: GoalEvidenceKind;
  description: string;
  locator: string;
  observedAt: number;
  runId: string;
  digest?: string;
}

export interface GoalArtifactRef {
  id: string;
  path: string;
  digest: string;
  description?: string;
  mediaType?: string;
  sizeBytes?: number;
  createdAt: number;
  runId?: string;
}

export interface GoalDispatchIntent {
  dispatchId: string;
  goalId: string;
  epoch: number;
  revision: number;
  runId: string;
  createdAt: number;
  repairAttempt?: number;
}

export interface GoalRunRef {
  runId: string;
  dispatchId: string;
  goalId: string;
  epoch: number;
  revision: number;
  startedAt: number;
  repairAttempt?: number;
  controlEntryId?: string;
}

export type GoalLifecycle =
  | "planning"
  | "running"
  | "verifying_phase"
  | "verifying_goal"
  | "waiting_external"
  | "blocked"
  | "paused"
  | "recovering"
  | "succeeded"
  | "cancelled"
  | "failed";

export type GoalPauseReason =
  | "user"
  | "budget"
  | "stalled"
  | "interrupted"
  | "persistence"
  | "dispatch"
  | "compaction"
  | "corrupt_state";

export type GoalSchedulerState =
  | "idle"
  | "dispatch_pending"
  | "run_in_flight"
  | "compaction_pending"
  | "recovery_required";

export interface GoalCheckpointV2 {
  schemaVersion: 2;

  eventId: string;
  parentEventId?: string;
  revision: number;

  goalId: string;
  epoch: number;
  objective: string;
  createdAt: number;
  updatedAt: number;

  lifecycle: GoalLifecycle;
  pauseReason?: GoalPauseReason;

  constraints: string[];
  acceptanceCriteria: GoalCriterion[];

  planVersion: number;
  phases: GoalPhase[];
  activePhaseId?: string;

  ledger: {
    completedPhaseSummaries: Array<{ phaseId: string; summary: string }>;
    decisions: GoalDecision[];
    openQuestions: string[];
    recentProgress: string[];
    nextAction?: string;
  };

  evidence: GoalEvidence[];
  artifacts: GoalArtifactRef[];

  scheduler: {
    state: GoalSchedulerState;
    dispatch?: GoalDispatchIntent;
    activeRun?: GoalRunRef;
    lastSettledRunId?: string;
    lastSettledLeafId?: string;
  };

  budgets: {
    epochRuns: number;
    maxEpochRuns: number;
    totalRuns: number;
    totalTurns: number;
    compactions: number;
    startedAt: number;
    maxElapsedMs?: number;
    repeatedProgressHashCount: number;
  };

  compaction: {
    generation: number;
    state: "idle" | "pending" | "failed";
    requestedAtRevision?: number;
    tokensBefore?: number;
    contextWindow?: number;
    lastCompactionEntryId?: string;
  };
}

export interface GoalCheckpointToolDetails {
  checkpoint: GoalCheckpointV2;
}

export interface LegacyGoalStateV1 {
  goal: string;
  startedAt: number;
  iterations: number;
  turns: number;
  maxIterations: number;
  active: boolean;
  blockedReason?: string;
}

export type GoalValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type GoalHydrationSourceKind = "checkpoint_entry" | "checkpoint_tool" | "legacy_state";

export interface GoalHydrationSource {
  kind: GoalHydrationSourceKind;
  index: number;
  entryId?: string;
}

export type GoalHydrationResult =
  | { status: "absent"; checkpoint?: undefined; source?: undefined }
  | { status: "cleared"; checkpoint?: undefined; source: GoalHydrationSource }
  | {
      status: "ok";
      checkpoint: GoalCheckpointV2;
      source: GoalHydrationSource;
      migrated: boolean;
    }
  | {
      status: "corrupt";
      checkpoint?: undefined;
      source: GoalHydrationSource;
      error: string;
      /** Exposed for an explicit user-confirmed recovery only; never auto-run it. */
      lastValidCheckpoint?: GoalCheckpointV2;
    };

const LIFECYCLES: readonly GoalLifecycle[] = [
  "planning", "running", "verifying_phase", "verifying_goal", "waiting_external", "blocked",
  "paused", "recovering", "succeeded", "cancelled", "failed",
];
const PAUSE_REASONS: readonly GoalPauseReason[] = [
  "user", "budget", "stalled", "interrupted", "persistence", "dispatch", "compaction", "corrupt_state",
];
const PHASE_STATUSES: readonly GoalPhaseStatus[] = [
  "pending", "running", "candidate_complete", "verifying", "completed", "blocked", "failed", "skipped",
];
const CRITERION_STATUSES: readonly GoalCriterionStatus[] = ["pending", "satisfied", "unsatisfied", "waived"];
const EVIDENCE_KINDS: readonly GoalEvidenceKind[] = ["file", "command", "test", "git", "session_entry", "artifact"];
const SCHEDULER_STATES: readonly GoalSchedulerState[] = [
  "idle", "dispatch_pending", "run_in_flight", "compaction_pending", "recovery_required",
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function boundedString(value: unknown, max: number, nonempty = true): value is string {
  return typeof value === "string" && value.length <= max && (!nonempty || value.trim().length > 0);
}

function optionalString(value: unknown, max: number): value is string | undefined {
  return value === undefined || boundedString(value, max);
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function arrayOf<T>(
  value: unknown,
  max: number,
  validate: (item: unknown, index: number) => item is T,
): value is T[] {
  return Array.isArray(value) && value.length <= max && value.every(validate);
}

function stringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return arrayOf(value, maxItems, (item): item is string => boundedString(item, maxLength));
}

function validateCriterion(value: unknown): value is GoalCriterion {
  if (!record(value) || !ownKeys(value, ["id", "description", "status", "evidenceIds"])) return false;
  return boundedString(value.id, GOAL_BOUNDS.id)
    && boundedString(value.description, GOAL_BOUNDS.text)
    && oneOf(value.status, CRITERION_STATUSES)
    && (value.evidenceIds === undefined
      || stringArray(value.evidenceIds, GOAL_BOUNDS.criterionEvidenceIds, GOAL_BOUNDS.id));
}

function validatePhase(value: unknown): value is GoalPhase {
  if (!record(value) || !ownKeys(value, [
    "id", "title", "intent", "status", "dependencies", "criteria", "summary", "nextAction",
  ])) return false;
  return boundedString(value.id, GOAL_BOUNDS.id)
    && boundedString(value.title, GOAL_BOUNDS.shortText)
    && boundedString(value.intent, GOAL_BOUNDS.text)
    && oneOf(value.status, PHASE_STATUSES)
    && stringArray(value.dependencies, GOAL_BOUNDS.phaseDependencies, GOAL_BOUNDS.id)
    && arrayOf(value.criteria, GOAL_BOUNDS.phaseCriteria, validateCriterion)
    && optionalString(value.summary, GOAL_BOUNDS.text)
    && optionalString(value.nextAction, GOAL_BOUNDS.text);
}

function validateDecision(value: unknown): value is GoalDecision {
  if (!record(value) || !ownKeys(value, ["id", "summary", "rationale", "madeAt", "runId"])) return false;
  return boundedString(value.id, GOAL_BOUNDS.id)
    && boundedString(value.summary, GOAL_BOUNDS.text)
    && optionalString(value.rationale, GOAL_BOUNDS.text)
    && integer(value.madeAt)
    && optionalString(value.runId, GOAL_BOUNDS.id);
}

function validateEvidence(value: unknown): value is GoalEvidence {
  if (!record(value) || !ownKeys(value, [
    "id", "criterionId", "kind", "description", "locator", "observedAt", "runId", "digest",
  ])) return false;
  return boundedString(value.id, GOAL_BOUNDS.id)
    && optionalString(value.criterionId, GOAL_BOUNDS.id)
    && oneOf(value.kind, EVIDENCE_KINDS)
    && boundedString(value.description, GOAL_BOUNDS.text)
    && boundedString(value.locator, GOAL_BOUNDS.locator)
    && integer(value.observedAt)
    && boundedString(value.runId, GOAL_BOUNDS.id)
    && optionalString(value.digest, GOAL_BOUNDS.digest);
}

function validateArtifact(value: unknown): value is GoalArtifactRef {
  if (!record(value) || !ownKeys(value, [
    "id", "path", "digest", "description", "mediaType", "sizeBytes", "createdAt", "runId",
  ])) return false;
  return boundedString(value.id, GOAL_BOUNDS.id)
    && boundedString(value.path, GOAL_BOUNDS.locator)
    && boundedString(value.digest, GOAL_BOUNDS.digest)
    && optionalString(value.description, GOAL_BOUNDS.text)
    && optionalString(value.mediaType, GOAL_BOUNDS.mediaType)
    && (value.sizeBytes === undefined || integer(value.sizeBytes))
    && integer(value.createdAt)
    && optionalString(value.runId, GOAL_BOUNDS.id);
}

function validateDispatch(value: unknown): value is GoalDispatchIntent {
  if (!record(value) || !ownKeys(value, [
    "dispatchId", "goalId", "epoch", "revision", "runId", "createdAt", "repairAttempt",
  ])) return false;
  return boundedString(value.dispatchId, GOAL_BOUNDS.id)
    && boundedString(value.goalId, GOAL_BOUNDS.id)
    && integer(value.epoch, GOAL_BOUNDS.counter)
    && integer(value.revision, GOAL_BOUNDS.counter)
    && boundedString(value.runId, GOAL_BOUNDS.id)
    && integer(value.createdAt)
    && (value.repairAttempt === undefined || integer(value.repairAttempt, 1));
}

function validateRun(value: unknown): value is GoalRunRef {
  if (!record(value) || !ownKeys(value, [
    "runId", "dispatchId", "goalId", "epoch", "revision", "startedAt", "repairAttempt", "controlEntryId",
  ])) return false;
  return boundedString(value.runId, GOAL_BOUNDS.id)
    && boundedString(value.dispatchId, GOAL_BOUNDS.id)
    && boundedString(value.goalId, GOAL_BOUNDS.id)
    && integer(value.epoch, GOAL_BOUNDS.counter)
    && integer(value.revision, GOAL_BOUNDS.counter)
    && integer(value.startedAt)
    && (value.repairAttempt === undefined || integer(value.repairAttempt, 1))
    && optionalString(value.controlEntryId, GOAL_BOUNDS.id);
}

function jsonByteLength(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : Buffer.byteLength(json, "utf8");
  } catch {
    return undefined;
  }
}

export function snapshotByteLength(value: unknown): number | undefined {
  return jsonByteLength(value);
}

export function isSnapshotWithinBounds(value: unknown): boolean {
  const bytes = jsonByteLength(value);
  return bytes !== undefined && bytes <= MAX_GOAL_SNAPSHOT_BYTES;
}

export function validateGoalCheckpointV2(value: unknown): GoalValidationResult<GoalCheckpointV2> {
  const bytes = jsonByteLength(value);
  if (bytes === undefined) return { ok: false, error: "checkpoint is not JSON serializable" };
  if (bytes > MAX_GOAL_SNAPSHOT_BYTES) {
    return { ok: false, error: `checkpoint exceeds ${MAX_GOAL_SNAPSHOT_BYTES} bytes` };
  }
  if (!record(value)) return { ok: false, error: "checkpoint must be an object" };
  if (!ownKeys(value, [
    "schemaVersion", "eventId", "parentEventId", "revision", "goalId", "epoch", "objective", "createdAt",
    "updatedAt", "lifecycle", "pauseReason", "constraints", "acceptanceCriteria", "planVersion", "phases",
    "activePhaseId", "ledger", "evidence", "artifacts", "scheduler", "budgets", "compaction",
  ])) return { ok: false, error: "checkpoint contains unknown fields" };

  if (value.schemaVersion !== GOAL_SCHEMA_VERSION) return { ok: false, error: "unsupported schemaVersion" };
  if (!boundedString(value.eventId, GOAL_BOUNDS.id)) return { ok: false, error: "invalid eventId" };
  if (!optionalString(value.parentEventId, GOAL_BOUNDS.id)) return { ok: false, error: "invalid parentEventId" };
  if (!integer(value.revision, GOAL_BOUNDS.counter)) return { ok: false, error: "invalid revision" };
  if (!boundedString(value.goalId, GOAL_BOUNDS.id)) return { ok: false, error: "invalid goalId" };
  if (!integer(value.epoch, GOAL_BOUNDS.counter) || value.epoch === 0) return { ok: false, error: "invalid epoch" };
  if (!boundedString(value.objective, GOAL_BOUNDS.objective)) return { ok: false, error: "invalid objective" };
  if (!integer(value.createdAt) || !integer(value.updatedAt) || value.updatedAt < value.createdAt) {
    return { ok: false, error: "invalid checkpoint timestamps" };
  }
  if (!oneOf(value.lifecycle, LIFECYCLES)) return { ok: false, error: "invalid lifecycle" };
  if (value.pauseReason !== undefined && !oneOf(value.pauseReason, PAUSE_REASONS)) {
    return { ok: false, error: "invalid pauseReason" };
  }
  if (!stringArray(value.constraints, GOAL_BOUNDS.constraints, GOAL_BOUNDS.text)) {
    return { ok: false, error: "invalid constraints" };
  }
  if (!arrayOf(value.acceptanceCriteria, GOAL_BOUNDS.acceptanceCriteria, validateCriterion)) {
    return { ok: false, error: "invalid acceptanceCriteria" };
  }
  if (!integer(value.planVersion, GOAL_BOUNDS.counter)) return { ok: false, error: "invalid planVersion" };
  if (!arrayOf(value.phases, GOAL_BOUNDS.phases, validatePhase)) return { ok: false, error: "invalid phases" };
  if (!optionalString(value.activePhaseId, GOAL_BOUNDS.id)) return { ok: false, error: "invalid activePhaseId" };
  if (value.activePhaseId !== undefined && !(value.phases as GoalPhase[]).some((phase) => phase.id === value.activePhaseId)) {
    return { ok: false, error: "activePhaseId does not name a phase" };
  }

  if (!record(value.ledger) || !ownKeys(value.ledger, [
    "completedPhaseSummaries", "decisions", "openQuestions", "recentProgress", "nextAction",
  ])) return { ok: false, error: "invalid ledger" };
  const summaryValid = (item: unknown): item is { phaseId: string; summary: string } =>
    record(item) && ownKeys(item, ["phaseId", "summary"])
      && boundedString(item.phaseId, GOAL_BOUNDS.id) && boundedString(item.summary, GOAL_BOUNDS.text);
  if (!arrayOf(value.ledger.completedPhaseSummaries, GOAL_BOUNDS.completedPhaseSummaries, summaryValid)
    || !arrayOf(value.ledger.decisions, GOAL_BOUNDS.decisions, validateDecision)
    || !stringArray(value.ledger.openQuestions, GOAL_BOUNDS.openQuestions, GOAL_BOUNDS.text)
    || !stringArray(value.ledger.recentProgress, GOAL_BOUNDS.recentProgress, GOAL_BOUNDS.text)
    || !optionalString(value.ledger.nextAction, GOAL_BOUNDS.text)) {
    return { ok: false, error: "invalid ledger contents" };
  }
  if (!arrayOf(value.evidence, GOAL_BOUNDS.evidence, validateEvidence)) return { ok: false, error: "invalid evidence" };
  if (!arrayOf(value.artifacts, GOAL_BOUNDS.artifacts, validateArtifact)) return { ok: false, error: "invalid artifacts" };

  if (!record(value.scheduler) || !ownKeys(value.scheduler, [
    "state", "dispatch", "activeRun", "lastSettledRunId", "lastSettledLeafId",
  ]) || !oneOf(value.scheduler.state, SCHEDULER_STATES)
    || (value.scheduler.dispatch !== undefined && !validateDispatch(value.scheduler.dispatch))
    || (value.scheduler.activeRun !== undefined && !validateRun(value.scheduler.activeRun))
    || !optionalString(value.scheduler.lastSettledRunId, GOAL_BOUNDS.id)
    || !optionalString(value.scheduler.lastSettledLeafId, GOAL_BOUNDS.id)) {
    return { ok: false, error: "invalid scheduler" };
  }
  const dispatch = value.scheduler.dispatch as GoalDispatchIntent | undefined;
  const activeRun = value.scheduler.activeRun as GoalRunRef | undefined;
  if (dispatch && (dispatch.goalId !== value.goalId || dispatch.epoch !== value.epoch || dispatch.revision > value.revision)) {
    return { ok: false, error: "dispatch does not belong to checkpoint" };
  }
  if (activeRun && (activeRun.goalId !== value.goalId || activeRun.epoch !== value.epoch || activeRun.revision > value.revision)) {
    return { ok: false, error: "active run does not belong to checkpoint" };
  }
  switch (value.scheduler.state) {
    case "idle":
      if (dispatch || activeRun) return { ok: false, error: "idle scheduler cannot retain a lease" };
      break;
    case "dispatch_pending":
      if (!dispatch || activeRun) return { ok: false, error: "dispatch_pending requires only a dispatch intent" };
      break;
    case "run_in_flight":
      if (!dispatch || !activeRun
        || dispatch.runId !== activeRun.runId || dispatch.dispatchId !== activeRun.dispatchId
        || dispatch.revision !== activeRun.revision) {
        return { ok: false, error: "run_in_flight requires one matching dispatch and active run" };
      }
      break;
    case "compaction_pending":
    case "recovery_required":
      if (dispatch || activeRun) return { ok: false, error: `${value.scheduler.state} cannot retain a run lease` };
      break;
  }
  if (isTerminalLifecycle(value.lifecycle) && (value.scheduler.state !== "idle" || dispatch || activeRun)) {
    return { ok: false, error: "terminal goals cannot retain scheduler leases" };
  }

  if (!record(value.budgets) || !ownKeys(value.budgets, [
    "epochRuns", "maxEpochRuns", "totalRuns", "totalTurns", "compactions", "startedAt", "maxElapsedMs",
    "repeatedProgressHashCount",
  ])) return { ok: false, error: "invalid budgets" };
  for (const key of ["epochRuns", "maxEpochRuns", "totalRuns", "totalTurns", "compactions", "repeatedProgressHashCount"] as const) {
    if (!integer(value.budgets[key], GOAL_BOUNDS.counter)) return { ok: false, error: `invalid budgets.${key}` };
  }
  const budgets = value.budgets as unknown as GoalCheckpointV2["budgets"];
  if (budgets.maxEpochRuns === 0 || budgets.epochRuns > budgets.totalRuns
    || budgets.epochRuns > budgets.maxEpochRuns || !integer(budgets.startedAt)
    || (budgets.maxElapsedMs !== undefined && !integer(budgets.maxElapsedMs))) {
    return { ok: false, error: "inconsistent budgets" };
  }

  if (!record(value.compaction) || !ownKeys(value.compaction, [
    "generation", "state", "requestedAtRevision", "tokensBefore", "contextWindow", "lastCompactionEntryId",
  ]) || !integer(value.compaction.generation, GOAL_BOUNDS.counter)
    || !oneOf(value.compaction.state, ["idle", "pending", "failed"] as const)
    || (value.compaction.requestedAtRevision !== undefined && !integer(value.compaction.requestedAtRevision, GOAL_BOUNDS.counter))
    || (value.compaction.tokensBefore !== undefined && !integer(value.compaction.tokensBefore))
    || (value.compaction.contextWindow !== undefined && !integer(value.compaction.contextWindow))
    || !optionalString(value.compaction.lastCompactionEntryId, GOAL_BOUNDS.id)) {
    return { ok: false, error: "invalid compaction state" };
  }
  if ((value.scheduler.state === "compaction_pending") !== (value.compaction.state === "pending")) {
    return { ok: false, error: "scheduler and compaction state disagree" };
  }

  const phaseIds = (value.phases as GoalPhase[]).map((phase) => phase.id);
  if (new Set(phaseIds).size !== phaseIds.length) return { ok: false, error: "duplicate phase ids" };
  const phaseIdSet = new Set(phaseIds);
  for (const phase of value.phases as GoalPhase[]) {
    if (phase.dependencies.includes(phase.id)
      || phase.dependencies.some((dependency) => !phaseIdSet.has(dependency))) {
      return { ok: false, error: "invalid phase dependency" };
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byPhaseId = new Map((value.phases as GoalPhase[]).map((phase) => [phase.id, phase]));
  const cyclic = (phaseId: string): boolean => {
    if (visiting.has(phaseId)) return true;
    if (visited.has(phaseId)) return false;
    visiting.add(phaseId);
    for (const dependency of byPhaseId.get(phaseId)?.dependencies ?? []) {
      if (cyclic(dependency)) return true;
    }
    visiting.delete(phaseId);
    visited.add(phaseId);
    return false;
  };
  if (phaseIds.some(cyclic)) return { ok: false, error: "cyclic phase dependencies" };

  const criteria = [
    ...(value.acceptanceCriteria as GoalCriterion[]),
    ...(value.phases as GoalPhase[]).flatMap((phase) => phase.criteria),
  ];
  const criterionIds = criteria.map((criterion) => criterion.id);
  if (new Set(criterionIds).size !== criterionIds.length) return { ok: false, error: "duplicate criterion ids" };
  for (const [label, ids] of [
    ["decision", (value.ledger.decisions as GoalDecision[]).map((item) => item.id)],
    ["evidence", (value.evidence as GoalEvidence[]).map((item) => item.id)],
    ["artifact", (value.artifacts as GoalArtifactRef[]).map((item) => item.id)],
  ] as const) {
    if (new Set(ids).size !== ids.length) return { ok: false, error: `duplicate ${label} ids` };
  }

  return { ok: true, value: value as unknown as GoalCheckpointV2 };
}

export function parseGoalCheckpointV2(value: unknown): GoalCheckpointV2 | undefined {
  const result = validateGoalCheckpointV2(value);
  return result.ok ? result.value : undefined;
}

export function isGoalCheckpointV2(value: unknown): value is GoalCheckpointV2 {
  return validateGoalCheckpointV2(value).ok;
}

export function serializeGoalCheckpoint(checkpoint: GoalCheckpointV2): string {
  const validated = validateGoalCheckpointV2(checkpoint);
  if (!validated.ok) throw new RangeError(`Invalid goal checkpoint: ${validated.error}`);
  const serialized = JSON.stringify(checkpoint);
  if (Buffer.byteLength(serialized, "utf8") > MAX_GOAL_SNAPSHOT_BYTES) {
    throw new RangeError(`Goal checkpoint exceeds ${MAX_GOAL_SNAPSHOT_BYTES} bytes`);
  }
  return serialized;
}

function readLegacyGoalState(value: unknown): GoalValidationResult<LegacyGoalStateV1> {
  if (!record(value)) return { ok: false, error: "legacy state must be an object" };
  if (!ownKeys(value, ["goal", "startedAt", "iterations", "turns", "maxIterations", "active", "blockedReason"])) {
    return { ok: false, error: "legacy state contains unknown fields" };
  }
  if (!boundedString(value.goal, GOAL_BOUNDS.objective)) return { ok: false, error: "invalid legacy goal" };
  if (!integer(value.startedAt) || value.startedAt === 0) return { ok: false, error: "invalid legacy startedAt" };
  if (!integer(value.maxIterations, 500) || value.maxIterations === 0) return { ok: false, error: "invalid legacy maxIterations" };
  if (!integer(value.iterations, value.maxIterations)) return { ok: false, error: "invalid legacy iterations" };
  if (!integer(value.turns, 1_000_000)) return { ok: false, error: "invalid legacy turns" };
  if (typeof value.active !== "boolean") return { ok: false, error: "invalid legacy active flag" };
  if (!optionalString(value.blockedReason, GOAL_BOUNDS.text)) return { ok: false, error: "invalid legacy blockedReason" };
  const goal = (value.goal as string).trim();
  const blockedReason = typeof value.blockedReason === "string" ? value.blockedReason.trim() : undefined;
  return {
    ok: true,
    value: {
      goal,
      startedAt: value.startedAt as number,
      iterations: value.iterations as number,
      turns: value.turns as number,
      maxIterations: value.maxIterations as number,
      active: value.active,
      ...(blockedReason ? { blockedReason } : {}),
    },
  };
}

function deterministicId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

export interface GoalMigrationOptions { now?: number }

export function migrateV1GoalState(value: unknown, options: GoalMigrationOptions = {}): GoalValidationResult<GoalCheckpointV2> {
  const legacy = readLegacyGoalState(value);
  if (!legacy.ok) return legacy;
  const old = legacy.value;
  const now = options.now ?? Math.max(old.startedAt, Date.now());
  if (!integer(now) || now < old.startedAt) return { ok: false, error: "invalid migration time" };
  const exhausted = old.iterations >= old.maxIterations;
  const blocked = old.blockedReason !== undefined;
  const pauseReason: GoalPauseReason = blocked ? "interrupted" : exhausted ? "budget" : old.active ? "interrupted" : "user";
  const seed = [old.goal, old.startedAt, old.maxIterations];
  const goalId = deterministicId("goal", seed);
  const phaseId = deterministicId("phase", [...seed, "legacy-recovery"]);
  const checkpoint: GoalCheckpointV2 = {
    schemaVersion: GOAL_SCHEMA_VERSION,
    eventId: deterministicId("event", [...seed, old.iterations, old.turns, old.active, old.blockedReason ?? ""]),
    revision: 1,
    goalId,
    epoch: 1,
    objective: old.goal,
    createdAt: old.startedAt,
    updatedAt: now,
    lifecycle: blocked ? "blocked" : "paused",
    pauseReason,
    constraints: [],
    acceptanceCriteria: [],
    planVersion: 1,
    phases: [{
      id: phaseId,
      title: "Reconcile migrated goal",
      intent: "Inspect current files and evidence before continuing the migrated v1 goal.",
      status: blocked ? "blocked" : "pending",
      dependencies: [],
      criteria: [],
      ...(blocked ? { summary: old.blockedReason } : {}),
      nextAction: blocked ? "Obtain the user's answer, then reconcile current state." : "Reconcile current files and create a bounded plan.",
    }],
    activePhaseId: phaseId,
    ledger: {
      completedPhaseSummaries: [],
      decisions: [],
      openQuestions: blocked ? [old.blockedReason!] : [],
      recentProgress: old.iterations > 0 ? [`Migrated after ${old.iterations} legacy run(s).`] : [],
      nextAction: blocked ? "Obtain the user's answer, then reconcile current state." : "Reconcile current files and create a bounded plan.",
    },
    evidence: [],
    artifacts: [],
    scheduler: { state: "recovery_required" },
    budgets: {
      epochRuns: old.iterations,
      maxEpochRuns: old.maxIterations,
      totalRuns: old.iterations,
      totalTurns: old.turns,
      compactions: 0,
      startedAt: old.startedAt,
      repeatedProgressHashCount: 0,
    },
    compaction: { generation: 0, state: "idle" },
  };
  return validateGoalCheckpointV2(checkpoint);
}

function sourceFor(kind: GoalHydrationSourceKind, entry: Record<string, unknown>, index: number): GoalHydrationSource {
  return {
    kind,
    index,
    ...(boundedString(entry.id, GOAL_BOUNDS.id) ? { entryId: entry.id } : {}),
  };
}

function isLegacyTombstone(value: unknown): boolean {
  return record(value) && value.active === false && value.goal === undefined;
}

function isV2Tombstone(value: unknown): boolean {
  if (!record(value) || value.tombstone !== true) return false;
  return ownKeys(value, ["schemaVersion", "tombstone", "goalId", "eventId", "clearedAt"])
    && (value.schemaVersion === undefined || value.schemaVersion === GOAL_SCHEMA_VERSION)
    && optionalString(value.goalId, GOAL_BOUNDS.id)
    && optionalString(value.eventId, GOAL_BOUNDS.id)
    && (value.clearedAt === undefined || integer(value.clearedAt))
    && isSnapshotWithinBounds(value);
}

function toolResultMessage(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  if (entry.type === "message" && record(entry.message) && entry.message.role === "toolResult") return entry.message;
  // Useful for pure tests while still matching Pi's installed ToolResultMessage shape.
  if (entry.role === "toolResult") return entry;
  return undefined;
}

function checkpointFromToolDetails(details: unknown): unknown {
  if (record(details) && Object.hasOwn(details, "checkpoint")) return details.checkpoint;
  return details;
}

function validateCheckpointSuccessor(
  previous: GoalCheckpointV2,
  next: GoalCheckpointV2,
  source: GoalHydrationSourceKind,
  allowMigrationMaterialization: boolean,
): string | undefined {
  if (allowMigrationMaterialization && JSON.stringify(previous) === JSON.stringify(next)) return undefined;
  if (next.goalId !== previous.goalId) {
    if (!isTerminalLifecycle(previous) || next.revision !== 1 || next.parentEventId !== undefined) {
      return "new goal does not follow a terminal checkpoint";
    }
    return undefined;
  }
  if (next.eventId === previous.eventId) return "checkpoint eventId was reused";
  if (next.revision !== previous.revision + 1) return "checkpoint revision is not monotonic";
  if (next.parentEventId !== previous.eventId) return "checkpoint parentEventId does not match the prior event";
  if (next.objective !== previous.objective || next.createdAt !== previous.createdAt) {
    return "checkpoint changed immutable goal identity";
  }
  if (next.epoch < previous.epoch
    || (next.epoch === previous.epoch && next.budgets.epochRuns < previous.budgets.epochRuns)
    || next.updatedAt < previous.updatedAt
    || next.planVersion < previous.planVersion
    || next.budgets.totalRuns < previous.budgets.totalRuns
    || next.budgets.totalTurns < previous.budgets.totalTurns
    || next.budgets.compactions < previous.budgets.compactions
    || next.budgets.startedAt !== previous.budgets.startedAt
    || next.budgets.maxEpochRuns !== previous.budgets.maxEpochRuns
    || next.budgets.maxElapsedMs !== previous.budgets.maxElapsedMs) {
    return "checkpoint regressed monotonic lifetime state";
  }
  if (isTerminalLifecycle(previous) && next.lifecycle !== previous.lifecycle) {
    return "checkpoint reactivated a terminal goal";
  }
  if (source === "checkpoint_tool") {
    const before = previous.scheduler.activeRun;
    const after = next.scheduler.activeRun;
    if (previous.scheduler.state !== "run_in_flight" || next.scheduler.state !== "run_in_flight"
      || !before || !after || before.goalId !== after.goalId || before.epoch !== after.epoch
      || before.runId !== after.runId || before.dispatchId !== after.dispatchId) {
      return "tool checkpoint is not owned by the preceding active run";
    }
  }
  return undefined;
}

/**
 * Reconstruct only from the supplied active branch, in branch order. Every
 * recognized authority supersedes earlier authorities, including corruption
 * and tombstones. Thus an older active state can never be revived by fallback.
 */
export function hydrateGoalState(branch: readonly unknown[], options: GoalMigrationOptions = {}): GoalHydrationResult {
  let result: GoalHydrationResult = { status: "absent" };
  let lastValidCheckpoint: GoalCheckpointV2 | undefined;
  let lastValidSource: GoalHydrationSourceKind | undefined;

  const accept = (
    checkpoint: GoalCheckpointV2,
    source: GoalHydrationSource,
    migrated: boolean,
  ): GoalHydrationResult => {
    const lineageError = lastValidCheckpoint
      ? validateCheckpointSuccessor(
          lastValidCheckpoint,
          checkpoint,
          source.kind,
          lastValidSource === "legacy_state" && source.kind === "checkpoint_entry",
        )
      : undefined;
    if (lineageError) {
      return { status: "corrupt", source, error: lineageError, ...(lastValidCheckpoint ? { lastValidCheckpoint } : {}) };
    }
    lastValidCheckpoint = checkpoint;
    lastValidSource = source.kind;
    return { status: "ok", checkpoint, source, migrated };
  };

  for (let index = 0; index < branch.length; index++) {
    const rawEntry = branch[index];
    if (!record(rawEntry)) continue;

    if (rawEntry.type === "custom" && rawEntry.customType === GOAL_CHECKPOINT_ENTRY) {
      const source = sourceFor("checkpoint_entry", rawEntry, index);
      if (isV2Tombstone(rawEntry.data)) {
        result = { status: "cleared", source };
        lastValidCheckpoint = undefined;
        lastValidSource = undefined;
        continue;
      }
      const parsed = validateGoalCheckpointV2(rawEntry.data);
      if (parsed.ok) {
        result = accept(parsed.value, source, false);
      } else {
        result = { status: "corrupt", source, error: parsed.error, ...(lastValidCheckpoint ? { lastValidCheckpoint } : {}) };
      }
      continue;
    }

    if (rawEntry.type === "custom" && rawEntry.customType === LEGACY_GOAL_STATE_ENTRY) {
      const source = sourceFor("legacy_state", rawEntry, index);
      if (isLegacyTombstone(rawEntry.data)) {
        result = { status: "cleared", source };
        lastValidCheckpoint = undefined;
        lastValidSource = undefined;
        continue;
      }
      const migrated = migrateV1GoalState(rawEntry.data, options);
      if (migrated.ok) {
        // V1 emitted mutable full snapshots without revision/event lineage.
        // Each newer legacy entry supersedes the prior one, but remains paused;
        // the first materialized V2 snapshot then starts strict lineage.
        lastValidCheckpoint = migrated.value;
        lastValidSource = "legacy_state";
        result = { status: "ok", checkpoint: migrated.value, source, migrated: true };
      } else {
        result = { status: "corrupt", source, error: migrated.error, ...(lastValidCheckpoint ? { lastValidCheckpoint } : {}) };
      }
      continue;
    }

    const message = toolResultMessage(rawEntry);
    if (!message || message.toolName !== GOAL_CHECKPOINT_TOOL || message.isError === true) continue;
    const source = sourceFor("checkpoint_tool", rawEntry, index);
    const parsed = validateGoalCheckpointV2(checkpointFromToolDetails(message.details));
    if (parsed.ok) {
      // A user pause/cancel command can supersede a tool execution just before
      // Pi appends that tool's result. Reject such stale updates without
      // letting them revive state or turn an explicit safe-boundary command
      // into corruption.
      if (lastValidCheckpoint && parsed.value.goalId === lastValidCheckpoint.goalId
        && parsed.value.revision <= lastValidCheckpoint.revision) continue;
      result = accept(parsed.value, source, false);
    } else {
      result = { status: "corrupt", source, error: parsed.error, ...(lastValidCheckpoint ? { lastValidCheckpoint } : {}) };
    }
  }
  return result;
}

function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export const newGoalId = (): string => prefixedId("goal");
export const newEventId = (): string => prefixedId("event");
export const newDispatchId = (): string => prefixedId("dispatch");
export const newRunId = (): string => prefixedId("run");

export interface InitialGoalCheckpointOptions {
  now?: number;
  goalId?: string;
  eventId?: string;
  epoch?: number;
  constraints?: string[];
  acceptanceCriteria?: GoalCriterion[];
  maxEpochRuns?: number;
  maxElapsedMs?: number;
}

export function createInitialCheckpoint(
  objective: string,
  options: InitialGoalCheckpointOptions = {},
): GoalCheckpointV2 {
  const now = options.now ?? Date.now();
  const checkpoint: GoalCheckpointV2 = {
    schemaVersion: GOAL_SCHEMA_VERSION,
    eventId: options.eventId ?? newEventId(),
    revision: 1,
    goalId: options.goalId ?? newGoalId(),
    epoch: options.epoch ?? 1,
    objective,
    createdAt: now,
    updatedAt: now,
    lifecycle: "planning",
    constraints: [...(options.constraints ?? [])],
    acceptanceCriteria: cloneJson(options.acceptanceCriteria ?? []),
    planVersion: 0,
    phases: [],
    ledger: {
      completedPhaseSummaries: [],
      decisions: [],
      openQuestions: [],
      recentProgress: [],
      nextAction: "Create a bounded rolling-horizon plan.",
    },
    evidence: [],
    artifacts: [],
    scheduler: { state: "idle" },
    budgets: {
      epochRuns: 0,
      maxEpochRuns: options.maxEpochRuns ?? 30,
      totalRuns: 0,
      totalTurns: 0,
      compactions: 0,
      startedAt: now,
      ...(options.maxElapsedMs !== undefined ? { maxElapsedMs: options.maxElapsedMs } : {}),
      repeatedProgressHashCount: 0,
    },
    compaction: { generation: 0, state: "idle" },
  };
  const valid = validateGoalCheckpointV2(checkpoint);
  if (!valid.ok) throw new RangeError(`Cannot create goal checkpoint: ${valid.error}`);
  return checkpoint;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneCheckpoint(checkpoint: GoalCheckpointV2): GoalCheckpointV2 {
  const valid = validateGoalCheckpointV2(checkpoint);
  if (!valid.ok) throw new TypeError(`Cannot clone invalid goal checkpoint: ${valid.error}`);
  return cloneJson(checkpoint);
}

export interface AdvanceCheckpointOptions {
  now?: number;
  eventId?: string;
}

export type GoalCheckpointMutation =
  | Partial<GoalCheckpointV2>
  | ((draft: GoalCheckpointV2) => void);

/** Clone and create the next immutable revision. Metadata is always derived. */
export function advanceCheckpoint(
  checkpoint: GoalCheckpointV2,
  mutation: GoalCheckpointMutation = {},
  options: AdvanceCheckpointOptions = {},
): GoalCheckpointV2 {
  const previous = cloneCheckpoint(checkpoint);
  if (previous.revision >= GOAL_BOUNDS.counter) throw new RangeError("goal revision limit reached");
  const draft = cloneJson(previous);
  if (typeof mutation === "function") mutation(draft);
  else {
    // Detach nested values supplied by a partial mutation while preserving an
    // explicit `undefined`, which callers use to clear optional fields.
    for (const [key, value] of Object.entries(mutation)) {
      (draft as unknown as Record<string, unknown>)[key] = value === undefined
        ? undefined
        : cloneJson(value);
    }
  }

  if (draft.goalId !== previous.goalId || draft.objective !== previous.objective
    || draft.createdAt !== previous.createdAt || draft.schemaVersion !== GOAL_SCHEMA_VERSION) {
    throw new TypeError("goal identity, objective, creation time, and schema are immutable");
  }
  if (isTerminalLifecycle(previous.lifecycle) && draft.lifecycle !== previous.lifecycle) {
    throw new TypeError("terminal goal lifecycle is sticky");
  }
  draft.parentEventId = previous.eventId;
  draft.eventId = options.eventId ?? newEventId();
  draft.revision = previous.revision + 1;
  draft.updatedAt = options.now ?? Date.now();
  if (draft.updatedAt < previous.updatedAt) throw new RangeError("updatedAt cannot move backwards");

  const valid = validateGoalCheckpointV2(draft);
  if (!valid.ok) throw new RangeError(`Invalid next goal checkpoint: ${valid.error}`);
  return draft;
}

/** Hash bounded, material progress; revision metadata, leases, counters, and timestamps are excluded. */
export function goalProgressHash(checkpoint: GoalCheckpointV2): string {
  const valid = validateGoalCheckpointV2(checkpoint);
  if (!valid.ok) throw new TypeError(`Cannot hash invalid goal checkpoint: ${valid.error}`);
  const criterionProgress = (criterion: GoalCriterion) => ({
    id: criterion.id,
    status: criterion.status,
    evidenceIds: criterion.evidenceIds ?? [],
  });
  const material = {
    objective: checkpoint.objective,
    lifecycle: checkpoint.lifecycle,
    pauseReason: checkpoint.pauseReason,
    acceptanceCriteria: checkpoint.acceptanceCriteria.map(criterionProgress),
    phases: checkpoint.phases.map((phase) => ({
      id: phase.id,
      status: phase.status,
      dependencies: phase.dependencies,
      criteria: phase.criteria.map(criterionProgress),
    })),
    activePhaseId: checkpoint.activePhaseId,
    evidence: checkpoint.evidence.map((item) => ({
      id: item.id,
      criterionId: item.criterionId,
      kind: item.kind,
      locator: item.locator,
      digest: item.digest,
    })),
    artifacts: checkpoint.artifacts.map((item) => ({ id: item.id, path: item.path, digest: item.digest })),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function isTerminalLifecycle(value: GoalLifecycle | GoalCheckpointV2): boolean {
  const lifecycle = typeof value === "string" ? value : value.lifecycle;
  return lifecycle === "succeeded" || lifecycle === "cancelled" || lifecycle === "failed";
}

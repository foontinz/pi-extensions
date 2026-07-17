import { createHash } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  GOAL_BOUNDS,
  GOAL_SNAPSHOT_SOFT_LIMIT,
  advanceCheckpoint,
  isTerminalLifecycle,
  type GoalCheckpointV2,
  type GoalCriterion,
  type GoalDecision,
  type GoalEvidence,
  type GoalPhase,
} from "./state.ts";

const StrictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const NonEmptyId = Type.String({ minLength: 1, maxLength: GOAL_BOUNDS.id });
const ShortText = Type.String({ minLength: 1, maxLength: GOAL_BOUNDS.shortText });
const Text = Type.String({ minLength: 1, maxLength: GOAL_BOUNDS.text });

const CriterionInput = StrictObject({
  id: NonEmptyId,
  description: Text,
  status: Type.Optional(StringEnum(["pending", "satisfied", "unsatisfied", "waived"] as const)),
  evidenceIds: Type.Optional(Type.Array(NonEmptyId, { maxItems: GOAL_BOUNDS.criterionEvidenceIds })),
});

const PhaseInput = StrictObject({
  id: NonEmptyId,
  title: ShortText,
  intent: Text,
  status: Type.Optional(StringEnum([
    "pending", "running", "candidate_complete", "verifying", "completed", "blocked", "failed", "skipped",
  ] as const)),
  dependencies: Type.Optional(Type.Array(NonEmptyId, { maxItems: GOAL_BOUNDS.phaseDependencies })),
  criteria: Type.Optional(Type.Array(CriterionInput, { maxItems: GOAL_BOUNDS.phaseCriteria })),
  summary: Type.Optional(Text),
  nextAction: Type.Optional(Text),
});

const DecisionInput = StrictObject({
  id: NonEmptyId,
  summary: Text,
  rationale: Type.Optional(Text),
});

const EvidenceInput = StrictObject({
  id: NonEmptyId,
  criterionId: Type.Optional(NonEmptyId),
  kind: StringEnum(["file", "command", "test", "git", "session_entry", "artifact"] as const),
  description: Text,
  locator: Type.String({ minLength: 1, maxLength: GOAL_BOUNDS.locator }),
  digest: Type.Optional(Type.String({ minLength: 1, maxLength: GOAL_BOUNDS.digest })),
});

const WaitForInput = StrictObject({
  kind: StringEnum(["background_task", "workflow", "subagent"] as const),
  id: NonEmptyId,
});

/** Strict, provider-compatible parameters for the model-facing goal_checkpoint tool. */
export const GoalCheckpointParams = StrictObject({
  action: StringEnum([
    "set_plan",
    "progress",
    "phase_candidate_complete",
    "goal_candidate_complete",
    "blocked",
    "waiting_external",
  ] as const, { description: "The checkpoint transition being reported." }),
  expectedRevision: Type.Integer({ minimum: 0, maximum: GOAL_BOUNDS.counter }),
  phaseId: Type.Optional(NonEmptyId),
  summary: Text,
  nextAction: Type.Optional(Text),
  waitFor: Type.Optional(WaitForInput),
  decisions: Type.Optional(Type.Array(DecisionInput, { maxItems: GOAL_BOUNDS.decisions })),
  evidence: Type.Optional(Type.Array(EvidenceInput, { maxItems: GOAL_BOUNDS.evidence })),
  phases: Type.Optional(Type.Array(PhaseInput, { maxItems: GOAL_BOUNDS.phases })),
  acceptanceCriteria: Type.Optional(
    Type.Array(CriterionInput, { maxItems: GOAL_BOUNDS.acceptanceCriteria }),
  ),
  constraints: Type.Optional(
    Type.Array(Text, { maxItems: GOAL_BOUNDS.constraints }),
  ),
  openQuestions: Type.Optional(
    Type.Array(Text, { maxItems: GOAL_BOUNDS.openQuestions }),
  ),
});

/** Input inferred directly from {@link GoalCheckpointParams}. */
export type GoalCheckpointParams = Static<typeof GoalCheckpointParams>;

/** Identity of the run currently leased by the checkpoint scheduler. */
export interface GoalCheckpointRunIdentity {
  goalId: string;
  epoch: number;
  runId: string;
  dispatchId: string;
  /** The revision on which this run was dispatched. */
  revision: number;
  /** Run start time supplies a deterministic lower bound for updatedAt. */
  startedAt?: number;
  /** Adapter-supplied clock value. Keeping it explicit makes application pure. */
  now?: number;
  /** Adapter-supplied event ID. A deterministic ID is derived when omitted. */
  eventId?: string;
}

function fail(message: string): never {
  throw new Error(`goal_checkpoint rejected: ${message}`);
}

function cleanText(value: string): string {
  return value.trim();
}

function uniqueStrings(values: readonly string[], limit: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = cleanText(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length === limit) break;
  }
  return result;
}

function keepNewestById<T extends { id: string }>(values: readonly T[], limit: number): T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    // A later report for an ID is the current report, without duplicating the
    // ledger entry. Delete first so its insertion order is also the newest.
    byId.delete(value.id);
    byId.set(value.id, value);
  }
  return [...byId.values()].slice(-limit);
}

function keepEvidenceWithActiveProof(
  checkpoint: GoalCheckpointV2,
  values: readonly GoalEvidence[],
): GoalEvidence[] {
  const byId = new Map<string, GoalEvidence>();
  for (const value of values) {
    byId.delete(value.id);
    byId.set(value.id, value);
  }
  const deduplicated = [...byId.values()];
  const protectedCriteria = [
    ...checkpoint.acceptanceCriteria,
    ...checkpoint.phases
      .filter((phase) => phase.id === checkpoint.activePhaseId
        || (phase.status !== "completed" && phase.status !== "skipped"))
      .flatMap((phase) => phase.criteria),
  ];
  const protectedCriterionIds = new Set(protectedCriteria.map((criterion) => criterion.id));
  const protectedEvidenceIds = new Set(protectedCriteria.flatMap((criterion) => criterion.evidenceIds ?? []));
  for (const evidence of deduplicated) {
    if (evidence.criterionId && protectedCriterionIds.has(evidence.criterionId)) {
      protectedEvidenceIds.add(evidence.id);
    }
  }
  const protectedCount = deduplicated.filter((item) => protectedEvidenceIds.has(item.id)).length;
  if (protectedCount > GOAL_BOUNDS.evidence) {
    fail("active acceptance evidence exceeds the bounded evidence ledger");
  }
  const historicalSlots = GOAL_BOUNDS.evidence - protectedCount;
  const retainedHistorical = new Set(
    historicalSlots === 0 ? []
      : deduplicated.filter((item) => !protectedEvidenceIds.has(item.id))
        .slice(-historicalSlots)
        .map((item) => item.id),
  );
  return deduplicated.filter((item) => protectedEvidenceIds.has(item.id) || retainedHistorical.has(item.id));
}

function criteriaFromInput(
  values: readonly Static<typeof CriterionInput>[],
  limit: number,
): GoalCriterion[] {
  return keepNewestById(values.map((criterion) => ({
    id: cleanText(criterion.id),
    description: cleanText(criterion.description),
    status: criterion.status ?? "pending",
    ...(criterion.evidenceIds
      ? { evidenceIds: uniqueStrings(criterion.evidenceIds, GOAL_BOUNDS.criterionEvidenceIds) }
      : {}),
  })), limit);
}

function phasesFromInput(values: readonly Static<typeof PhaseInput>[]): GoalPhase[] {
  return keepNewestById(values.map((phase) => ({
    id: cleanText(phase.id),
    title: cleanText(phase.title),
    intent: cleanText(phase.intent),
    status: phase.status ?? "pending",
    dependencies: uniqueStrings(phase.dependencies ?? [], GOAL_BOUNDS.phaseDependencies),
    criteria: criteriaFromInput(phase.criteria ?? [], GOAL_BOUNDS.phaseCriteria),
    ...(phase.summary !== undefined ? { summary: cleanText(phase.summary) } : {}),
    ...(phase.nextAction !== undefined ? { nextAction: cleanText(phase.nextAction) } : {}),
  })), GOAL_BOUNDS.phases);
}

function deterministicEventId(
  checkpoint: GoalCheckpointV2,
  params: GoalCheckpointParams,
  run: GoalCheckpointRunIdentity,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      checkpoint.eventId,
      checkpoint.revision,
      run.goalId,
      run.epoch,
      run.runId,
      run.dispatchId,
      params,
    ]))
    .digest("hex")
    .slice(0, 32);
  return `event_${digest}`;
}

function validateRunOwnership(checkpoint: GoalCheckpointV2, run: GoalCheckpointRunIdentity): void {
  const active = checkpoint.scheduler.activeRun;
  if (checkpoint.scheduler.state !== "run_in_flight" || !active) fail("no run is in flight");
  if (run.goalId !== checkpoint.goalId || run.epoch !== checkpoint.epoch
    || active.goalId !== run.goalId || active.epoch !== run.epoch
    || active.runId !== run.runId || active.dispatchId !== run.dispatchId) {
    fail("update is not owned by the current goal run");
  }
  if (run.revision !== active.revision) fail("run revision does not match the scheduler lease");
}

function phaseIndex(checkpoint: GoalCheckpointV2, phaseId: string): number {
  const index = checkpoint.phases.findIndex((phase) => phase.id === phaseId);
  if (index < 0) fail(`unknown phaseId ${JSON.stringify(phaseId)}`);
  return index;
}

export function goalCandidateRejection(
  checkpoint: GoalCheckpointV2,
  suppliedEvidence: readonly { criterionId?: string }[] = [],
): string | undefined {
  if (checkpoint.activePhaseId !== undefined) {
    return "goal completion requires no active phase; finish or replan the current rolling horizon first";
  }
  const unfinished = checkpoint.phases.filter((phase) => phase.status !== "completed" && phase.status !== "skipped");
  if (unfinished.length > 0) {
    return `goal completion requires every phase completed or skipped; unresolved: ${unfinished.map((phase) => phase.id).join(", ")}`;
  }
  const suppliedCriterionIds = new Set(
    suppliedEvidence
      .map((evidence) => evidence.criterionId === undefined ? undefined : cleanText(evidence.criterionId))
      .filter((id): id is string => id !== undefined),
  );
  if (checkpoint.acceptanceCriteria.length === 0) {
    return "goal completion requires explicit acceptance criteria";
  }
  const unreadyCriteria = checkpoint.acceptanceCriteria.filter((criterion) =>
    criterion.status !== "satisfied"
    || ((criterion.evidenceIds?.length ?? 0) === 0 && !suppliedCriterionIds.has(criterion.id)));
  if (unreadyCriteria.length > 0) {
    return `goal completion requires every acceptance criterion satisfied with evidence; unresolved: ${unreadyCriteria.map((criterion) => criterion.id).join(", ")}`;
  }
  return undefined;
}

function validateAction(checkpoint: GoalCheckpointV2, params: GoalCheckpointParams): void {
  const changesPlan = params.phases !== undefined
    || params.acceptanceCriteria !== undefined
    || params.constraints !== undefined;
  if (params.action === "set_plan") {
    if (!params.phases?.length) fail("set_plan requires at least one phase");
    if (!params.acceptanceCriteria?.length) fail("set_plan requires explicit acceptance criteria");
    if (params.phases.some((phase) => !phase.criteria?.length)) {
      fail("every phase requires explicit verification criteria");
    }
    const phaseIds = params.phases.map((phase) => cleanText(phase.id));
    if (new Set(phaseIds).size !== phaseIds.length) fail("set_plan contains duplicate phase ids");
    const phaseIdSet = new Set(phaseIds);
    for (const phase of params.phases) {
      for (const dependency of phase.dependencies ?? []) {
        if (dependency === phase.id || !phaseIdSet.has(dependency)) fail("set_plan contains an invalid phase dependency");
      }
    }
    const criterionIds = [
      ...params.acceptanceCriteria.map((criterion) => cleanText(criterion.id)),
      ...params.phases.flatMap((phase) => (phase.criteria ?? []).map((criterion) => cleanText(criterion.id))),
    ];
    if (new Set(criterionIds).size !== criterionIds.length) fail("set_plan contains duplicate criterion ids");
  } else if (changesPlan) {
    fail("phases, acceptanceCriteria, and constraints may only be changed by set_plan");
  }
  if (params.action !== "set_plan" && checkpoint.planVersion === 0) {
    fail("set_plan is required before other checkpoint actions");
  }

  if (params.action === "phase_candidate_complete" && params.phaseId === undefined) {
    fail("phase_candidate_complete requires phaseId");
  }
  if (params.action === "goal_candidate_complete") {
    if (params.phaseId !== undefined) fail("goal_candidate_complete must not specify phaseId");
    const rejection = goalCandidateRejection(checkpoint, params.evidence ?? []);
    if (rejection) fail(`goal_candidate_complete rejected: ${rejection}`);
  }
  if (params.action === "blocked") {
    const hasQuestion = params.openQuestions?.some((question) => cleanText(question).length > 0) ?? false;
    const hasNextAction = params.nextAction !== undefined && cleanText(params.nextAction).length > 0;
    if (!hasQuestion && !hasNextAction) {
      fail("blocked requires a concrete user question in openQuestions or nextAction");
    }
  }
  if (params.action === "waiting_external" && params.waitFor === undefined
    && (params.nextAction === undefined || !cleanText(params.nextAction))) {
    fail("untyped waiting_external requires nextAction naming the dependency and completion condition");
  }
  if (params.waitFor !== undefined && params.action !== "waiting_external") {
    fail("waitFor may only be used with waiting_external");
  }
  if (params.waitFor !== undefined && !cleanText(params.waitFor.id)) {
    fail("waitFor.id must be non-empty after trimming");
  }
  if (params.waitFor?.kind === "subagent") {
    fail("waitFor.kind subagent is unavailable until subagents emit typed completion metadata");
  }

  if (params.phaseId !== undefined && params.action !== "set_plan") {
    phaseIndex(checkpoint, params.phaseId);
    if (checkpoint.activePhaseId !== undefined && params.phaseId !== checkpoint.activePhaseId) {
      fail("phaseId is not the active phase");
    }
  }
}

function attachEvidenceIds(checkpoint: GoalCheckpointV2, evidence: readonly GoalEvidence[]): void {
  const additions = new Map<string, string[]>();
  for (const item of evidence) {
    if (!item.criterionId) continue;
    const ids = additions.get(item.criterionId) ?? [];
    ids.push(item.id);
    additions.set(item.criterionId, ids);
  }
  if (additions.size === 0) return;

  const update = (criterion: GoalCriterion): void => {
    const ids = additions.get(criterion.id);
    if (!ids) return;
    criterion.evidenceIds = uniqueStrings(
      [...(criterion.evidenceIds ?? []), ...ids],
      GOAL_BOUNDS.criterionEvidenceIds,
    );
  };
  checkpoint.acceptanceCriteria.forEach(update);
  checkpoint.phases.forEach((phase) => phase.criteria.forEach(update));
}

/**
 * Validate and apply one model-authored checkpoint to an owned run.
 *
 * This function has no clock, UUID, persistence, or registration side effects.
 * Invalid, stale, unowned, and terminal updates throw and leave both inputs
 * untouched. The returned value is the complete snapshot to place at
 * `toolResult.details.checkpoint`.
 */
export function applyGoalCheckpoint(
  checkpoint: GoalCheckpointV2,
  params: GoalCheckpointParams,
  currentRun: GoalCheckpointRunIdentity,
): GoalCheckpointV2 {
  if (Array.isArray((params as { waitFor?: unknown }).waitFor)) {
    fail("waiting_external accepts one waitFor; wait on one task at a time or consolidate owned work");
  }
  if (!Check(GoalCheckpointParams, params)) fail("parameters do not match the strict schema");
  if (isTerminalLifecycle(checkpoint)) fail("terminal goals cannot be updated");
  if (params.expectedRevision !== checkpoint.revision) {
    fail(`stale revision (expected ${checkpoint.revision}, received ${params.expectedRevision})`);
  }
  validateRunOwnership(checkpoint, currentRun);
  validateAction(checkpoint, params);

  const startedAt = currentRun.startedAt ?? checkpoint.updatedAt;
  const now = currentRun.now ?? Math.max(checkpoint.updatedAt, startedAt);
  if (!Number.isSafeInteger(now) || now < checkpoint.updatedAt) fail("invalid update time");
  if (currentRun.eventId !== undefined
    && (typeof currentRun.eventId !== "string"
      || !currentRun.eventId.trim()
      || currentRun.eventId.length > GOAL_BOUNDS.id)) {
    fail("invalid eventId");
  }
  const eventId = currentRun.eventId ?? deterministicEventId(checkpoint, params, currentRun);
  if (eventId === checkpoint.eventId) fail("eventId must identify a new checkpoint");

  try {
    return advanceCheckpoint(checkpoint, (draft) => {
    const summary = cleanText(params.summary);
    const phaseId = params.phaseId === undefined ? undefined : cleanText(params.phaseId);

    if (params.action === "waiting_external" && params.waitFor !== undefined) {
      draft.waitFor = { kind: params.waitFor.kind, id: cleanText(params.waitFor.id) };
    } else {
      delete draft.waitFor;
    }

    if (params.action === "set_plan") {
      draft.constraints = params.constraints === undefined
        ? draft.constraints
        : uniqueStrings(params.constraints, GOAL_BOUNDS.constraints);
      draft.acceptanceCriteria = params.acceptanceCriteria === undefined
        ? draft.acceptanceCriteria
        : criteriaFromInput(params.acceptanceCriteria, GOAL_BOUNDS.acceptanceCriteria);
      draft.phases = phasesFromInput(params.phases!);
      draft.planVersion += 1;

      const requested = phaseId === undefined ? undefined : draft.phases.find((phase) => phase.id === phaseId);
      if (phaseId !== undefined && !requested) fail(`unknown phaseId ${JSON.stringify(phaseId)}`);
      if (requested && ["completed", "failed", "skipped"].includes(requested.status)) {
        fail("active phase cannot already be terminal");
      }
      const active = requested
        ?? draft.phases.find((phase) => phase.status === "running")
        ?? draft.phases.find((phase) => phase.status === "pending");
      draft.activePhaseId = active?.id;
      if (active?.status === "pending") active.status = "running";
      draft.lifecycle = "running";
    } else if (phaseId !== undefined) {
      const phase = draft.phases[phaseIndex(draft, phaseId)]!;
      if (params.action === "phase_candidate_complete") {
        phase.status = "candidate_complete";
        phase.summary = summary;
      } else if (params.action === "blocked") {
        phase.status = "blocked";
        phase.summary = summary;
      } else if (params.action === "progress" && phase.status === "pending") {
        phase.status = "running";
      }
      if (params.nextAction !== undefined) phase.nextAction = cleanText(params.nextAction);
    }

    const newDecisions: GoalDecision[] = (params.decisions ?? []).map((decision) => ({
      id: cleanText(decision.id),
      summary: cleanText(decision.summary),
      ...(decision.rationale !== undefined ? { rationale: cleanText(decision.rationale) } : {}),
      madeAt: now,
      runId: currentRun.runId,
    }));
    draft.ledger.decisions = keepNewestById(
      [...draft.ledger.decisions, ...newDecisions],
      GOAL_BOUNDS.decisions,
    );

    const newEvidence: GoalEvidence[] = (params.evidence ?? []).map((evidence) => ({
      id: cleanText(evidence.id),
      ...(evidence.criterionId !== undefined ? { criterionId: cleanText(evidence.criterionId) } : {}),
      kind: evidence.kind,
      description: cleanText(evidence.description),
      locator: cleanText(evidence.locator),
      observedAt: now,
      runId: currentRun.runId,
      ...(evidence.digest !== undefined ? { digest: cleanText(evidence.digest) } : {}),
    }));
    draft.evidence = keepEvidenceWithActiveProof(draft, [...draft.evidence, ...newEvidence]);
    attachEvidenceIds(draft, newEvidence.filter((item) => draft.evidence.some((kept) => kept.id === item.id)));

    if (params.openQuestions !== undefined) {
      draft.ledger.openQuestions = uniqueStrings(params.openQuestions, GOAL_BOUNDS.openQuestions);
    }
    draft.ledger.recentProgress = uniqueStrings(
      [...draft.ledger.recentProgress, summary].slice(-GOAL_BOUNDS.recentProgress),
      GOAL_BOUNDS.recentProgress,
    );
    if (params.nextAction !== undefined) draft.ledger.nextAction = cleanText(params.nextAction);

    switch (params.action) {
      case "set_plan":
      case "progress":
        draft.lifecycle = "running";
        break;
      case "phase_candidate_complete":
        draft.lifecycle = "verifying_phase";
        break;
      case "goal_candidate_complete":
        // A model may claim completion, but only a separate verifier/user can
        // move this checkpoint to succeeded.
        draft.lifecycle = "verifying_goal";
        break;
      case "blocked":
        draft.lifecycle = "blocked";
        break;
      case "waiting_external":
        draft.lifecycle = "waiting_external";
        break;
    }
      draft.pauseReason = undefined;
    }, { now, eventId, compactSnapshotToBytes: GOAL_SNAPSHOT_SOFT_LIMIT });
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes(`checkpoint exceeds ${GOAL_BOUNDS.snapshotBytes} bytes`)) {
      fail(`checkpoint exceeds ${GOAL_BOUNDS.snapshotBytes} bytes after deterministic compaction; essential active state cannot be removed safely`);
    }
    throw cause;
  }
}

import { createHash } from "node:crypto";

import {
  GOAL_BOUNDS,
  GOAL_SNAPSHOT_SOFT_LIMIT,
  advanceCheckpoint,
  isTerminalLifecycle,
  validateGoalCheckpointV2,
  type GoalCheckpointV2,
  type GoalDispatchIntent,
  type GoalExternalWaitKind,
  type GoalLifecycle,
  type GoalPauseReason,
  type GoalRunRef,
} from "./state.ts";

/** Number of consecutive materially-identical checkpoints allowed by default. */
export const DEFAULT_GOAL_STAGNATION_LIMIT = 3;

export type GoalEffect =
  | { type: "persist"; checkpoint: GoalCheckpointV2 }
  | { type: "dispatch"; intent: GoalDispatchIntent }
  | { type: "compact"; generation: number; instructions: string }
  | { type: "notify"; level: "info" | "warning" | "error"; message: string };

export type GoalReducerErrorCode =
  | "invalid_state"
  | "invalid_action"
  | "terminal"
  | "lifecycle_not_executable"
  | "scheduler_not_idle"
  | "correlation_mismatch"
  | "invalid_transition";

export interface GoalReducerError {
  code: GoalReducerErrorCode;
  message: string;
}

export type GoalReducerResult =
  | {
      ok: true;
      state: GoalCheckpointV2;
      effects: readonly GoalEffect[];
      changed: boolean;
    }
  | {
      ok: false;
      state: GoalCheckpointV2;
      effects: readonly [];
      changed: false;
      error: GoalReducerError;
    };

export interface RevisionAction {
  now: number;
  eventId: string;
}

export interface GoalDispatchAction extends RevisionAction {
  type: "dispatch";
  dispatchId: string;
  runId: string;
}

export interface GoalControlObservationAction extends RevisionAction {
  type: "observe_goal_control";
  goalId: string;
  epoch: number;
  revision: number;
  dispatchId: string;
  runId: string;
  controlEntryId?: string;
  startedAt?: number;
}

export interface GoalRepairDispatch {
  dispatchId: string;
  runId: string;
}

export interface GoalSettleRunAction extends RevisionAction {
  type: "settle_run";
  runId: string;
  dispatchId?: string;
  goalId?: string;
  epoch?: number;
  leafId?: string;
  /** LLM turns attributable to this run. */
  turns?: number;
  /** If omitted, the reducer infers this from revisions after run observation. */
  checkpointRecorded?: boolean;
  /** Required to schedule the one allowed checkpoint-repair run. */
  repair?: GoalRepairDispatch;
}

export interface GoalExternalCompletedAction extends RevisionAction {
  type: "external_completed";
  kind: GoalExternalWaitKind;
  id: string;
  outcome: "succeeded" | "failed";
  detail?: string;
}

export interface GoalAnswerReceivedAction extends RevisionAction {
  type: "answer_received";
  nextAction: string;
}

export interface GoalResumeAction extends RevisionAction {
  type: "resume";
  nextAction?: string;
}

export interface GoalPauseAction extends RevisionAction {
  type: "pause";
  reason?: GoalPauseReason;
  message?: string;
}

export interface GoalCancelAction extends RevisionAction {
  type: "cancel";
}

export interface GoalRequestCompactionAction extends RevisionAction {
  type: "request_compaction";
  instructions: string;
  tokensBefore?: number;
  contextWindow?: number;
}

export interface GoalCompactionSucceededAction extends RevisionAction {
  type: "compaction_succeeded";
  generation: number;
  entryId?: string;
}

export interface GoalCompactionFailedAction extends RevisionAction {
  type: "compaction_failed";
  generation: number;
  message?: string;
}

export interface GoalInterruptRestoredAction extends RevisionAction {
  type: "interrupt_restored";
}

export interface GoalRetryUndeliveredDispatchAction extends RevisionAction {
  type: "retry_undelivered_dispatch";
}

export interface GoalEnforceLimitsAction extends RevisionAction {
  type: "enforce_limits";
  stagnationLimit?: number;
}

export interface GoalMarkSucceededAction extends RevisionAction {
  type: "mark_succeeded";
}

export type GoalAction =
  | GoalDispatchAction
  | GoalControlObservationAction
  | GoalSettleRunAction
  | GoalExternalCompletedAction
  | GoalAnswerReceivedAction
  | GoalResumeAction
  | GoalPauseAction
  | GoalCancelAction
  | GoalRequestCompactionAction
  | GoalCompactionSucceededAction
  | GoalCompactionFailedAction
  | GoalInterruptRestoredAction
  | GoalRetryUndeliveredDispatchAction
  | GoalEnforceLimitsAction
  | GoalMarkSucceededAction;

const EXECUTABLE_LIFECYCLES: ReadonlySet<GoalLifecycle> = new Set([
  "planning",
  "running",
  "verifying_phase",
  "verifying_goal",
  "recovering",
]);

function error(
  state: GoalCheckpointV2,
  code: GoalReducerErrorCode,
  message: string,
): GoalReducerResult {
  return { ok: false, state, effects: [], changed: false, error: { code, message } };
}

function unchanged(state: GoalCheckpointV2): GoalReducerResult {
  return { ok: true, state, effects: [], changed: false };
}

function changed(state: GoalCheckpointV2, effects: GoalEffect[] = []): GoalReducerResult {
  return { ok: true, state, effects: [{ type: "persist", checkpoint: state }, ...effects], changed: true };
}

function validMeta(action: RevisionAction): boolean {
  return Number.isSafeInteger(action.now) && action.now >= 0
    && typeof action.eventId === "string" && action.eventId.trim().length > 0
    && action.eventId.length <= GOAL_BOUNDS.id;
}

function next(
  state: GoalCheckpointV2,
  action: RevisionAction,
  mutate: (draft: GoalCheckpointV2) => void,
): GoalCheckpointV2 | GoalReducerError {
  if (!validMeta(action)) return { code: "invalid_action", message: "action requires a valid now and eventId" };
  try {
    return advanceCheckpoint(state, mutate, {
      now: action.now,
      eventId: action.eventId,
      compactSnapshotToBytes: GOAL_SNAPSHOT_SOFT_LIMIT,
    });
  } catch (cause) {
    return {
      code: "invalid_transition",
      message: cause instanceof Error ? cause.message : "invalid goal transition",
    };
  }
}

function isTransitionError(value: GoalCheckpointV2 | GoalReducerError): value is GoalReducerError {
  return !Object.hasOwn(value, "schemaVersion");
}

function apply(
  state: GoalCheckpointV2,
  action: RevisionAction,
  mutate: (draft: GoalCheckpointV2) => void,
  effects: (checkpoint: GoalCheckpointV2) => GoalEffect[] = () => [],
): GoalReducerResult {
  const checkpoint = next(state, action, mutate);
  if (isTransitionError(checkpoint)) return error(state, checkpoint.code, checkpoint.message);
  return changed(checkpoint, effects(checkpoint));
}

function executable(state: GoalCheckpointV2): boolean {
  return EXECUTABLE_LIFECYCLES.has(state.lifecycle);
}

function elapsedExceeded(state: GoalCheckpointV2, now: number): boolean {
  return state.budgets.maxElapsedMs !== undefined
    && now - state.budgets.startedAt >= state.budgets.maxElapsedMs;
}

function budgetExceeded(state: GoalCheckpointV2, now: number): boolean {
  return state.budgets.epochRuns >= state.budgets.maxEpochRuns || elapsedExceeded(state, now);
}

function stagnationLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : DEFAULT_GOAL_STAGNATION_LIMIT;
}

function clearLease(draft: GoalCheckpointV2, schedulerState: "idle" | "recovery_required" = "idle"): void {
  draft.scheduler.state = schedulerState;
  delete draft.scheduler.dispatch;
  delete draft.scheduler.activeRun;
}

function pauseForLimit(draft: GoalCheckpointV2, reason: "budget" | "stalled"): void {
  draft.lifecycle = "paused";
  draft.pauseReason = reason;
  delete draft.waitFor;
}

function makeIntent(
  state: GoalCheckpointV2,
  now: number,
  revision: number,
  ids: GoalRepairDispatch,
  repairAttempt?: number,
): GoalDispatchIntent {
  return {
    dispatchId: ids.dispatchId,
    goalId: state.goalId,
    epoch: state.epoch,
    revision,
    runId: ids.runId,
    createdAt: now,
    ...(repairAttempt === undefined ? {} : { repairAttempt }),
  };
}

function dispatch(state: GoalCheckpointV2, action: GoalDispatchAction): GoalReducerResult {
  if (!executable(state)) {
    return error(state, "lifecycle_not_executable", `lifecycle ${state.lifecycle} cannot dispatch`);
  }
  if (state.scheduler.state !== "idle" || state.scheduler.dispatch || state.scheduler.activeRun
    || state.compaction.state !== "idle") {
    return error(state, "scheduler_not_idle", "dispatch requires an idle scheduler without a lease");
  }
  if (budgetExceeded(state, action.now)) {
    return apply(state, action, (draft) => pauseForLimit(draft, "budget"), () => [{
      type: "notify",
      level: "warning",
      message: "Goal paused because its run or elapsed-time budget was exhausted.",
    }]);
  }
  const revision = state.revision + 1;
  const intent = makeIntent(state, action.now, revision, action);
  return apply(state, action, (draft) => {
    draft.scheduler.state = "dispatch_pending";
    draft.scheduler.dispatch = intent;
    delete draft.scheduler.activeRun;
    draft.budgets.epochRuns += 1;
    draft.budgets.totalRuns += 1;
  }, () => [{ type: "dispatch", intent }]);
}

function observeControl(state: GoalCheckpointV2, action: GoalControlObservationAction): GoalReducerResult {
  const intent = state.scheduler.dispatch;
  if (state.scheduler.state === "run_in_flight" && state.scheduler.activeRun
    && state.scheduler.activeRun.goalId === action.goalId
    && state.scheduler.activeRun.epoch === action.epoch
    && state.scheduler.activeRun.revision === action.revision
    && state.scheduler.activeRun.dispatchId === action.dispatchId
    && state.scheduler.activeRun.runId === action.runId) {
    return unchanged(state);
  }
  if (state.scheduler.state !== "dispatch_pending" || !intent) {
    return error(state, "correlation_mismatch", "no matching pending dispatch exists");
  }
  if (intent.goalId !== action.goalId || intent.epoch !== action.epoch || intent.revision !== action.revision
    || intent.dispatchId !== action.dispatchId || intent.runId !== action.runId) {
    return error(state, "correlation_mismatch", "goal-control message does not match the dispatch intent");
  }
  const activeRun: GoalRunRef = {
    runId: intent.runId,
    dispatchId: intent.dispatchId,
    goalId: intent.goalId,
    epoch: intent.epoch,
    revision: intent.revision,
    startedAt: action.startedAt ?? action.now,
    ...(intent.repairAttempt === undefined ? {} : { repairAttempt: intent.repairAttempt }),
    ...(action.controlEntryId === undefined ? {} : { controlEntryId: action.controlEntryId }),
  };
  return apply(state, action, (draft) => {
    draft.scheduler.state = "run_in_flight";
    draft.scheduler.activeRun = activeRun;
  });
}

function settledMatches(run: GoalRunRef, action: GoalSettleRunAction): boolean {
  return run.runId === action.runId
    && (action.dispatchId === undefined || action.dispatchId === run.dispatchId)
    && (action.goalId === undefined || action.goalId === run.goalId)
    && (action.epoch === undefined || action.epoch === run.epoch);
}

function deterministicRepairIds(action: GoalSettleRunAction): GoalRepairDispatch {
  if (action.repair) return action.repair;
  const digest = createHash("sha256")
    .update(`${action.eventId}\0${action.runId}\0checkpoint-repair`)
    .digest("hex")
    .slice(0, 32);
  return { dispatchId: `dispatch_repair_${digest}`, runId: `run_repair_${digest}` };
}

function settle(state: GoalCheckpointV2, action: GoalSettleRunAction): GoalReducerResult {
  if (state.scheduler.lastSettledRunId === action.runId) return unchanged(state);
  const run = state.scheduler.activeRun;
  // agent_settled carries no identity. Adapters correlate from the active
  // branch; replayed or unrelated settlements must therefore be harmless.
  if (state.scheduler.state !== "run_in_flight" || !run) return unchanged(state);
  if (!settledMatches(run, action)) return unchanged(state);
  if (action.turns !== undefined && (!Number.isSafeInteger(action.turns) || action.turns < 0)) {
    return error(state, "invalid_action", "settled turn count must be a non-negative integer");
  }
  const checkpointRecorded = action.checkpointRecorded ?? state.revision > run.revision + 1;
  const mustPauseForBudget = budgetExceeded(state, action.now);

  if (!checkpointRecorded && (run.repairAttempt ?? 0) === 0 && !mustPauseForBudget) {
    const intent = makeIntent(state, action.now, state.revision + 1, deterministicRepairIds(action), 1);
    return apply(state, action, (draft) => {
      draft.scheduler.lastSettledRunId = run.runId;
      if (action.leafId !== undefined) draft.scheduler.lastSettledLeafId = action.leafId;
      draft.scheduler.state = "dispatch_pending";
      draft.scheduler.dispatch = intent;
      delete draft.scheduler.activeRun;
      draft.budgets.totalTurns += action.turns ?? 0;
      draft.budgets.epochRuns += 1;
      draft.budgets.totalRuns += 1;
    }, () => [
      { type: "notify", level: "warning", message: "Goal run omitted a checkpoint; dispatching its one repair run." },
      { type: "dispatch", intent },
    ]);
  }

  return apply(state, action, (draft) => {
    draft.scheduler.lastSettledRunId = run.runId;
    if (action.leafId !== undefined) draft.scheduler.lastSettledLeafId = action.leafId;
    clearLease(draft);
    draft.budgets.totalTurns += action.turns ?? 0;
    if (!checkpointRecorded) {
      draft.lifecycle = "paused";
      draft.pauseReason = "dispatch";
    } else if (mustPauseForBudget && executable(draft)) {
      pauseForLimit(draft, "budget");
    }
  }, (checkpoint) => {
    if (!checkpointRecorded) return [{
      type: "notify",
      level: "warning",
      message: (run.repairAttempt ?? 0) > 0
        ? "Goal paused because its checkpoint repair run also omitted a checkpoint."
        : "Goal paused because its checkpointless run could not be repaired within budget.",
    }];
    if (checkpoint.lifecycle === "paused" && checkpoint.pauseReason === "budget") return [{
      type: "notify", level: "warning", message: "Goal paused because its run or elapsed-time budget was exhausted.",
    }];
    return [];
  });
}

function externalFailureNextAction(action: GoalExternalCompletedAction): string {
  const prefix = `External dependency ${action.kind} ${action.id} failed (`;
  const suffix = "); diagnose the failure before continuing. Do not mark criteria satisfied from this event.";
  const rawDetail = action.detail?.trim() || "no additional detail";
  const detailBudget = Math.max(0, GOAL_BOUNDS.text - prefix.length - suffix.length);
  return `${prefix}${rawDetail.slice(0, detailBudget)}${suffix}`;
}

function externalCompleted(state: GoalCheckpointV2, action: GoalExternalCompletedAction): GoalReducerResult {
  if (state.lifecycle !== "waiting_external"
    || state.scheduler.state !== "idle"
    || state.compaction.state !== "idle"
    || state.waitFor?.kind !== action.kind
    || state.waitFor.id !== action.id) return unchanged(state);
  if (!(["background_task", "workflow", "subagent"] as const).includes(action.kind)
    || typeof action.id !== "string" || !action.id.trim() || action.id.length > GOAL_BOUNDS.id
    || (action.outcome !== "succeeded" && action.outcome !== "failed")
    || (action.detail !== undefined
      && (typeof action.detail !== "string" || action.detail.length > GOAL_BOUNDS.text))) {
    return error(state, "invalid_action", "external completion metadata is invalid");
  }
  const exhausted = budgetExceeded(state, action.now);
  return apply(state, action, (draft) => {
    delete draft.waitFor;
    delete draft.pauseReason;
    draft.ledger.nextAction = action.outcome === "succeeded"
      ? `External dependency ${action.kind} ${action.id} completed; reconcile its results against the active phase before continuing.`
      : externalFailureNextAction(action);
    if (exhausted) {
      pauseForLimit(draft, "budget");
      return;
    }
    draft.lifecycle = "recovering";
  }, () => exhausted ? [{
    type: "notify",
    level: "warning",
    message: "Goal paused because its run or elapsed-time budget was exhausted while an external dependency completed.",
  }] : []);
}

function answerReceived(state: GoalCheckpointV2, action: GoalAnswerReceivedAction): GoalReducerResult {
  if (state.lifecycle !== "blocked" && state.lifecycle !== "waiting_external") {
    return error(state, "invalid_transition", `lifecycle ${state.lifecycle} cannot receive an answer`);
  }
  if (state.scheduler.state !== "idle") {
    return error(state, "invalid_transition", "answer receipt requires an idle scheduler");
  }
  if (state.compaction.state !== "idle") {
    return error(state, "invalid_transition", "answer receipt requires idle compaction");
  }
  if (typeof action.nextAction !== "string"
    || !action.nextAction.trim()
    || action.nextAction.length > GOAL_BOUNDS.text) {
    return error(state, "invalid_transition", "answer receipt requires a non-empty bounded next action");
  }

  const exhausted = budgetExceeded(state, action.now);
  return apply(state, action, (draft) => {
    delete draft.waitFor;
    delete draft.pauseReason;
    draft.ledger.nextAction = action.nextAction;
    if (exhausted) {
      pauseForLimit(draft, "budget");
      return;
    }
    draft.lifecycle = "recovering";
  }, () => exhausted ? [{
    type: "notify",
    level: "warning",
    message: "User answer recorded, but execution cannot continue because the goal budget is exhausted; explicit recovery is required.",
  }] : []);
}

function resume(state: GoalCheckpointV2, action: GoalResumeAction): GoalReducerResult {
  if (!["paused", "blocked", "waiting_external", "recovering"].includes(state.lifecycle)
    && state.scheduler.state !== "recovery_required") {
    return error(state, "invalid_transition", `lifecycle ${state.lifecycle} does not require resume`);
  }
  if (state.epoch >= GOAL_BOUNDS.counter) return error(state, "invalid_transition", "goal epoch limit reached");
  return apply(state, action, (draft) => {
    draft.epoch += 1;
    draft.lifecycle = "recovering";
    delete draft.pauseReason;
    delete draft.waitFor;
    clearLease(draft);
    draft.budgets.epochRuns = 0;
    if (draft.compaction.state !== "idle") {
      draft.compaction.state = "idle";
      delete draft.compaction.requestedAtRevision;
      delete draft.compaction.tokensBefore;
      delete draft.compaction.contextWindow;
    }
    draft.ledger.nextAction = action.nextAction
      ?? "Reconcile current files, git state, and evidence before repeating work.";
  });
}

function pause(state: GoalCheckpointV2, action: GoalPauseAction): GoalReducerResult {
  return apply(state, action, (draft) => {
    const ambiguous = draft.scheduler.state !== "idle" || draft.compaction.state === "pending";
    draft.lifecycle = "paused";
    draft.pauseReason = action.reason ?? "user";
    delete draft.waitFor;
    clearLease(draft, ambiguous ? "recovery_required" : "idle");
    if (draft.compaction.state === "pending") draft.compaction.state = "failed";
  }, () => action.message ? [{ type: "notify", level: "warning", message: action.message }] : []);
}

function cancel(state: GoalCheckpointV2, action: GoalCancelAction): GoalReducerResult {
  return apply(state, action, (draft) => {
    draft.lifecycle = "cancelled";
    delete draft.pauseReason;
    delete draft.waitFor;
    clearLease(draft);
    if (draft.compaction.state === "pending") draft.compaction.state = "failed";
  });
}

function requestCompaction(state: GoalCheckpointV2, action: GoalRequestCompactionAction): GoalReducerResult {
  if (state.scheduler.state !== "idle" || state.scheduler.dispatch || state.scheduler.activeRun
    || state.compaction.state !== "idle") {
    return error(state, "scheduler_not_idle", "compaction requires an idle scheduler");
  }
  if (!executable(state)) {
    return error(state, "lifecycle_not_executable", `lifecycle ${state.lifecycle} cannot request compaction`);
  }
  if (!action.instructions.trim()) return error(state, "invalid_action", "compaction instructions are required");
  const generation = state.compaction.generation + 1;
  return apply(state, action, (draft) => {
    draft.scheduler.state = "compaction_pending";
    draft.compaction.generation = generation;
    draft.compaction.state = "pending";
    draft.compaction.requestedAtRevision = state.revision + 1;
    if (action.tokensBefore === undefined) delete draft.compaction.tokensBefore;
    else draft.compaction.tokensBefore = action.tokensBefore;
    if (action.contextWindow === undefined) delete draft.compaction.contextWindow;
    else draft.compaction.contextWindow = action.contextWindow;
  }, () => [{ type: "compact", generation, instructions: action.instructions }]);
}

function compactionSucceeded(state: GoalCheckpointV2, action: GoalCompactionSucceededAction): GoalReducerResult {
  if (action.generation !== state.compaction.generation) return unchanged(state);
  if (state.compaction.state === "idle" && state.scheduler.state !== "compaction_pending") return unchanged(state);
  if (state.compaction.state !== "pending" || state.scheduler.state !== "compaction_pending") {
    return error(state, "correlation_mismatch", "compaction success does not match a pending generation");
  }
  return apply(state, action, (draft) => {
    draft.compaction.state = "idle";
    if (action.entryId !== undefined) draft.compaction.lastCompactionEntryId = action.entryId;
    delete draft.compaction.requestedAtRevision;
    clearLease(draft);
    draft.budgets.compactions += 1;
  });
}

function compactionFailed(state: GoalCheckpointV2, action: GoalCompactionFailedAction): GoalReducerResult {
  if (action.generation !== state.compaction.generation) return unchanged(state);
  if (state.compaction.state === "failed" && state.lifecycle === "paused") return unchanged(state);
  if (state.compaction.state !== "pending" || state.scheduler.state !== "compaction_pending") {
    return error(state, "correlation_mismatch", "compaction failure does not match a pending generation");
  }
  return apply(state, action, (draft) => {
    draft.compaction.state = "failed";
    draft.lifecycle = "paused";
    draft.pauseReason = "compaction";
    clearLease(draft, "recovery_required");
  }, () => [{
    type: "notify",
    level: "error",
    message: action.message ?? "Goal paused because compaction failed or was cancelled.",
  }]);
}

function interruptRestored(state: GoalCheckpointV2, action: GoalInterruptRestoredAction): GoalReducerResult {
  const transient = state.scheduler.state === "dispatch_pending"
    || state.scheduler.state === "run_in_flight"
    || state.scheduler.state === "compaction_pending"
    || state.scheduler.dispatch !== undefined
    || state.scheduler.activeRun !== undefined
    || state.compaction.state === "pending";
  if (!transient) return unchanged(state);
  return apply(state, action, (draft) => {
    draft.lifecycle = "paused";
    draft.pauseReason = "interrupted";
    clearLease(draft, "recovery_required");
    if (draft.compaction.state === "pending") draft.compaction.state = "failed";
  }, () => [{
    type: "notify",
    level: "warning",
    message: "Restored goal had an interrupted scheduler lease; explicit resume is required.",
  }]);
}

function retryUndeliveredDispatch(
  state: GoalCheckpointV2,
  action: GoalRetryUndeliveredDispatchAction,
): GoalReducerResult {
  if (state.scheduler.state !== "dispatch_pending" || !state.scheduler.dispatch
    || state.scheduler.activeRun !== undefined || state.compaction.state !== "idle") {
    return error(state, "invalid_transition", "retry requires one pending undelivered dispatch");
  }
  return apply(state, action, (draft) => clearLease(draft));
}

function enforceLimits(state: GoalCheckpointV2, action: GoalEnforceLimitsAction): GoalReducerResult {
  const reason = budgetExceeded(state, action.now)
    ? "budget"
    : state.budgets.repeatedProgressHashCount >= stagnationLimit(action.stagnationLimit)
      ? "stalled"
      : undefined;
  if (!reason || !executable(state)) return unchanged(state);
  return apply(state, action, (draft) => pauseForLimit(draft, reason), () => [{
    type: "notify",
    level: "warning",
    message: reason === "budget" ? "Goal paused after reaching a budget limit." : "Goal paused after stagnating.",
  }]);
}

function terminalGuard(state: GoalCheckpointV2, action: GoalAction): GoalReducerResult | undefined {
  if (!isTerminalLifecycle(state)) return undefined;
  if (action.type === "answer_received") {
    return error(state, "invalid_transition", `terminal lifecycle ${state.lifecycle} cannot receive an answer`);
  }
  // Replayed settlement and callbacks remain harmless after a terminal commit.
  if (action.type === "settle_run"
    || action.type === "external_completed"
    || action.type === "compaction_succeeded"
    || action.type === "compaction_failed"
    || action.type === "interrupt_restored") return unchanged(state);
  return error(state, "terminal", `terminal lifecycle ${state.lifecycle} is sticky`);
}

/**
 * Pure lifecycle/scheduler reducer. It never mutates `state`, reads the clock,
 * allocates IDs, persists, dispatches, or compacts. Callers execute effects in
 * order; in particular, `persist` always precedes an external side effect.
 */
export function reduceGoal(state: GoalCheckpointV2, action: GoalAction): GoalReducerResult {
  const valid = validateGoalCheckpointV2(state);
  if (!valid.ok) return error(state, "invalid_state", valid.error);
  const terminal = terminalGuard(state, action);
  if (terminal) return terminal;

  switch (action.type) {
    case "dispatch": return dispatch(state, action);
    case "observe_goal_control": return observeControl(state, action);
    case "settle_run": return settle(state, action);
    case "external_completed": return externalCompleted(state, action);
    case "answer_received": return answerReceived(state, action);
    case "resume": return resume(state, action);
    case "pause": return pause(state, action);
    case "cancel": return cancel(state, action);
    case "request_compaction": return requestCompaction(state, action);
    case "compaction_succeeded": return compactionSucceeded(state, action);
    case "compaction_failed": return compactionFailed(state, action);
    case "interrupt_restored": return interruptRestored(state, action);
    case "retry_undelivered_dispatch": return retryUndeliveredDispatch(state, action);
    case "enforce_limits": return enforceLimits(state, action);
    case "mark_succeeded":
      if (state.lifecycle !== "verifying_goal") {
        return error(state, "invalid_transition", "success requires a pending goal-verification claim");
      }
      return apply(state, action, (draft) => {
        draft.lifecycle = "succeeded";
        delete draft.pauseReason;
        clearLease(draft);
      });
  }
}

export const isExecutableGoalLifecycle = (lifecycle: GoalLifecycle): boolean => EXECUTABLE_LIFECYCLES.has(lifecycle);

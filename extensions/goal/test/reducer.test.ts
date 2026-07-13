import assert from "node:assert/strict";
import test from "node:test";

import {
  reduceGoal,
  type GoalAction,
  type GoalEffect,
  type GoalReducerResult,
} from "../reducer.ts";
import {
  createInitialCheckpoint,
  type GoalCheckpointV2,
} from "../state.ts";

type SuccessfulResult = Extract<GoalReducerResult, { ok: true }>;
type FailedResult = Extract<GoalReducerResult, { ok: false }>;

function initial(options: { maxEpochRuns?: number; maxElapsedMs?: number } = {}): GoalCheckpointV2 {
  return createInitialCheckpoint("Ship a verified reducer", {
    now: 100,
    goalId: "goal_test",
    eventId: "event_initial",
    maxEpochRuns: options.maxEpochRuns ?? 5,
    ...(options.maxElapsedMs === undefined ? {} : { maxElapsedMs: options.maxElapsedMs }),
  });
}

function expectSuccess(result: GoalReducerResult): asserts result is SuccessfulResult {
  if (!result.ok) assert.fail(`expected success, got ${result.error.code}: ${result.error.message}`);
}

function expectFailure(
  result: GoalReducerResult,
  code: FailedResult["error"]["code"],
): asserts result is FailedResult {
  if (result.ok) assert.fail(`expected ${code}, got success`);
  assert.equal(result.error.code, code);
  assert.equal(result.changed, false);
  assert.deepEqual(result.effects, []);
}

function expectUnchanged(result: GoalReducerResult, state: GoalCheckpointV2): void {
  expectSuccess(result);
  assert.equal(result.changed, false);
  assert.strictEqual(result.state, state);
  assert.deepEqual(result.effects, []);
}

function expectPersistFirst(result: GoalReducerResult): asserts result is SuccessfulResult {
  expectSuccess(result);
  assert.equal(result.changed, true);
  assert.ok(result.effects.length > 0);
  assert.equal(result.effects[0]?.type, "persist");
  const persist = result.effects[0] as Extract<GoalEffect, { type: "persist" }>;
  assert.strictEqual(persist.checkpoint, result.state);
}

function dispatch(state: GoalCheckpointV2, suffix = "one", now = 110): SuccessfulResult {
  const result = reduceGoal(state, {
    type: "dispatch",
    dispatchId: `dispatch_${suffix}`,
    runId: `run_${suffix}`,
    now,
    eventId: `event_dispatch_${suffix}`,
  });
  expectSuccess(result);
  return result;
}

function observePending(state: GoalCheckpointV2, suffix = "one", now = 120): SuccessfulResult {
  const intent = state.scheduler.dispatch;
  assert.ok(intent, "fixture requires a pending dispatch");
  const result = reduceGoal(state, {
    type: "observe_goal_control",
    goalId: intent.goalId,
    epoch: intent.epoch,
    revision: intent.revision,
    dispatchId: intent.dispatchId,
    runId: intent.runId,
    controlEntryId: `control_${suffix}`,
    startedAt: now - 1,
    now,
    eventId: `event_observe_${suffix}`,
  });
  expectSuccess(result);
  return result;
}

function inFlight(suffix = "one", options: { maxEpochRuns?: number; maxElapsedMs?: number } = {}): GoalCheckpointV2 {
  return observePending(dispatch(initial(options), suffix).state, suffix).state;
}

test("dispatch persists its lease before dispatching and never creates a second lease", () => {
  const state = initial();
  const before = structuredClone(state);
  const first = reduceGoal(state, {
    type: "dispatch",
    dispatchId: "dispatch_first",
    runId: "run_first",
    now: 110,
    eventId: "event_dispatch_first",
  });

  expectPersistFirst(first);
  assert.deepEqual(first.effects.map((effect) => effect.type), ["persist", "dispatch"]);
  assert.deepEqual(state, before, "the pure reducer must not mutate its input");
  assert.equal(first.state.scheduler.state, "dispatch_pending");
  assert.equal(first.state.budgets.epochRuns, 1);
  assert.equal(first.state.budgets.totalRuns, 1);
  const emittedIntent = (first.effects[1] as Extract<GoalEffect, { type: "dispatch" }>).intent;
  assert.deepEqual(emittedIntent, first.state.scheduler.dispatch);
  assert.equal(emittedIntent.revision, first.state.revision);

  const whilePending = reduceGoal(first.state, {
    type: "dispatch",
    dispatchId: "dispatch_second",
    runId: "run_second",
    now: 111,
    eventId: "event_dispatch_second",
  });
  expectFailure(whilePending, "scheduler_not_idle");
  assert.strictEqual(whilePending.state, first.state);

  const observed = observePending(first.state, "first", 120);
  assert.equal(observed.state.scheduler.state, "run_in_flight");
  assert.equal(observed.state.scheduler.activeRun?.runId, "run_first");
  const whileRunning = reduceGoal(observed.state, {
    type: "dispatch",
    dispatchId: "dispatch_third",
    runId: "run_third",
    now: 121,
    eventId: "event_dispatch_third",
  });
  expectFailure(whileRunning, "scheduler_not_idle");
});

test("goal-control observation requires exact five-field correlation and dedupes an exact replay", () => {
  const pending = dispatch(initial(), "correlation").state;
  const intent = pending.scheduler.dispatch!;
  const exact = {
    type: "observe_goal_control" as const,
    goalId: intent.goalId,
    epoch: intent.epoch,
    revision: intent.revision,
    dispatchId: intent.dispatchId,
    runId: intent.runId,
    now: 120,
    eventId: "event_control_exact",
  };
  const mismatches = [
    { goalId: "goal_other" },
    { epoch: intent.epoch + 1 },
    { revision: intent.revision + 1 },
    { dispatchId: "dispatch_other" },
    { runId: "run_other" },
  ];

  for (const [index, mismatch] of mismatches.entries()) {
    const result = reduceGoal(pending, {
      ...exact,
      ...mismatch,
      eventId: `event_control_mismatch_${index}`,
    });
    expectFailure(result, "correlation_mismatch");
    assert.strictEqual(result.state, pending);
  }

  const observed = reduceGoal(pending, { ...exact, controlEntryId: "control_exact", startedAt: 119 });
  expectPersistFirst(observed);
  assert.deepEqual(observed.effects.map((effect) => effect.type), ["persist"]);
  assert.deepEqual(observed.state.scheduler.activeRun, {
    runId: intent.runId,
    dispatchId: intent.dispatchId,
    goalId: intent.goalId,
    epoch: intent.epoch,
    revision: intent.revision,
    startedAt: 119,
    controlEntryId: "control_exact",
  });

  const replay = reduceGoal(observed.state, { ...exact, now: 121, eventId: "event_control_replay" });
  expectUnchanged(replay, observed.state);
});

test("an exactly correlated settlement is committed once and then deduplicated", () => {
  const active = inFlight("settle");
  const run = active.scheduler.activeRun!;
  const action = {
    type: "settle_run" as const,
    runId: run.runId,
    dispatchId: run.dispatchId,
    goalId: run.goalId,
    epoch: run.epoch,
    leafId: "leaf_settle",
    checkpointRecorded: true,
    turns: 2,
    now: 131,
    eventId: "event_settle_exact",
  };
  const settled = reduceGoal(active, action);
  expectPersistFirst(settled);
  assert.equal(settled.state.scheduler.state, "idle");
  assert.equal(settled.state.scheduler.lastSettledRunId, run.runId);
  assert.equal(settled.state.scheduler.lastSettledLeafId, "leaf_settle");
  assert.equal(settled.state.budgets.totalTurns, 2);

  const replay = reduceGoal(settled.state, { ...action, now: 132, eventId: "event_settle_replay" });
  expectUnchanged(replay, settled.state);
});

test("an unrelated settlement is harmlessly ignored while another run owns the lease", () => {
  const active = inFlight("settle_unrelated");
  const unrelated = reduceGoal(active, {
    type: "settle_run",
    runId: "run_unrelated",
    dispatchId: "dispatch_unrelated",
    checkpointRecorded: true,
    now: 130,
    eventId: "event_settle_unrelated",
  });
  expectUnchanged(unrelated, active);
});

test("an unrelated settlement is harmlessly ignored when there is no active lease", () => {
  const active = inFlight("settle_before_unrelated_afterward");
  const run = active.scheduler.activeRun!;
  const settled = reduceGoal(active, {
    type: "settle_run",
    runId: run.runId,
    checkpointRecorded: true,
    now: 131,
    eventId: "event_settle_before_unrelated_afterward",
  });
  expectSuccess(settled);
  const unrelatedAfterward = reduceGoal(settled.state, {
    type: "settle_run",
    runId: "run_unrelated_afterward",
    checkpointRecorded: true,
    now: 132,
    eventId: "event_settle_unrelated_afterward",
  });
  expectUnchanged(unrelatedAfterward, settled.state);
});

test("a checkpointless run gets exactly one persisted repair dispatch, then pauses", () => {
  const active = inFlight("missing");
  const run = active.scheduler.activeRun!;
  const firstAction = {
    type: "settle_run" as const,
    runId: run.runId,
    dispatchId: run.dispatchId,
    goalId: run.goalId,
    epoch: run.epoch,
    checkpointRecorded: false,
    turns: 2,
    repair: { dispatchId: "dispatch_repair", runId: "run_repair" },
    now: 130,
    eventId: "event_settle_missing",
  };
  const repair = reduceGoal(active, firstAction);

  expectPersistFirst(repair);
  assert.deepEqual(repair.effects.map((effect) => effect.type), ["persist", "notify", "dispatch"]);
  assert.ok(repair.effects.findIndex((effect) => effect.type === "persist")
    < repair.effects.findIndex((effect) => effect.type === "dispatch"));
  assert.equal(repair.state.scheduler.state, "dispatch_pending");
  assert.deepEqual(repair.state.scheduler.dispatch, {
    dispatchId: "dispatch_repair",
    goalId: active.goalId,
    epoch: active.epoch,
    revision: repair.state.revision,
    runId: "run_repair",
    createdAt: 130,
    repairAttempt: 1,
  });
  assert.equal(repair.state.budgets.epochRuns, 2);
  assert.equal(repair.state.budgets.totalRuns, 2);
  assert.equal(repair.state.budgets.totalTurns, 2);

  const duplicateOriginal = reduceGoal(repair.state, {
    ...firstAction,
    now: 131,
    eventId: "event_settle_missing_replay",
  });
  expectUnchanged(duplicateOriginal, repair.state);

  const repairActive = observePending(repair.state, "repair", 140).state;
  const repairRun = repairActive.scheduler.activeRun!;
  assert.equal(repairRun.repairAttempt, 1);
  const second = reduceGoal(repairActive, {
    type: "settle_run",
    runId: repairRun.runId,
    dispatchId: repairRun.dispatchId,
    goalId: repairRun.goalId,
    epoch: repairRun.epoch,
    checkpointRecorded: false,
    turns: 3,
    now: 150,
    eventId: "event_settle_repair_missing",
  });

  expectPersistFirst(second);
  assert.deepEqual(second.effects.map((effect) => effect.type), ["persist", "notify"]);
  assert.equal(second.state.lifecycle, "paused");
  assert.equal(second.state.pauseReason, "dispatch");
  assert.equal(second.state.scheduler.state, "idle");
  assert.equal(second.state.scheduler.dispatch, undefined);
  assert.equal(second.state.scheduler.activeRun, undefined);
  assert.equal(second.state.budgets.totalRuns, 2, "a second repair was not allocated");
  assert.equal(second.state.budgets.totalTurns, 5);
});

test("resume starts a new epoch while preserving lifetime counters and elapsed origin", () => {
  const state = initial();
  state.lifecycle = "paused";
  state.pauseReason = "compaction";
  state.epoch = 4;
  state.scheduler.state = "compaction_pending";
  state.budgets.epochRuns = 3;
  state.budgets.totalRuns = 11;
  state.budgets.totalTurns = 29;
  state.budgets.compactions = 2;
  state.compaction = { generation: 3, state: "pending", requestedAtRevision: state.revision };

  const resumed = reduceGoal(state, {
    type: "resume",
    nextAction: "Inspect durable evidence before retrying.",
    now: 200,
    eventId: "event_resume",
  });

  expectPersistFirst(resumed);
  assert.equal(resumed.state.epoch, 5);
  assert.equal(resumed.state.lifecycle, "recovering");
  assert.equal(resumed.state.pauseReason, undefined);
  assert.equal(resumed.state.scheduler.state, "idle");
  assert.equal(resumed.state.budgets.epochRuns, 0);
  assert.equal(resumed.state.budgets.totalRuns, 11);
  assert.equal(resumed.state.budgets.totalTurns, 29);
  assert.equal(resumed.state.budgets.compactions, 2);
  assert.equal(resumed.state.budgets.startedAt, 100);
  assert.equal(resumed.state.compaction.state, "idle");
  assert.equal(resumed.state.ledger.nextAction, "Inspect durable evidence before retrying.");
});

test("run and elapsed budgets pause before dispatch without spending another run", () => {
  const runBudgetState = initial({ maxEpochRuns: 1 });
  runBudgetState.budgets.epochRuns = 1;
  runBudgetState.budgets.totalRuns = 1;
  const exhausted = reduceGoal(runBudgetState, {
    type: "dispatch",
    dispatchId: "dispatch_over_budget",
    runId: "run_over_budget",
    now: 140,
    eventId: "event_dispatch_over_budget",
  });
  expectPersistFirst(exhausted);
  assert.deepEqual(exhausted.effects.map((effect) => effect.type), ["persist", "notify"]);
  assert.equal(exhausted.state.lifecycle, "paused");
  assert.equal(exhausted.state.pauseReason, "budget");
  assert.equal(exhausted.state.budgets.epochRuns, 1);
  assert.equal(exhausted.state.budgets.totalRuns, 1);

  const elapsedState = initial({ maxElapsedMs: 50 });
  const elapsed = reduceGoal(elapsedState, {
    type: "dispatch",
    dispatchId: "dispatch_elapsed",
    runId: "run_elapsed",
    now: 150,
    eventId: "event_dispatch_elapsed",
  });
  expectPersistFirst(elapsed);
  assert.deepEqual(elapsed.effects.map((effect) => effect.type), ["persist", "notify"]);
  assert.equal(elapsed.state.lifecycle, "paused");
  assert.equal(elapsed.state.pauseReason, "budget");
  assert.equal(elapsed.state.budgets.epochRuns, 0);
  assert.equal(elapsed.state.budgets.totalRuns, 0);
});

test("terminal lifecycles are sticky while replayed callbacks remain harmless", () => {
  for (const lifecycle of ["succeeded", "cancelled", "failed"] as const) {
    const state = initial();
    state.lifecycle = lifecycle;
    const mutatingActions: GoalAction[] = [
      { type: "dispatch", dispatchId: "dispatch_terminal", runId: "run_terminal", now: 110, eventId: `event_${lifecycle}_dispatch` },
      { type: "pause", now: 110, eventId: `event_${lifecycle}_pause` },
      { type: "resume", now: 110, eventId: `event_${lifecycle}_resume` },
      { type: "cancel", now: 110, eventId: `event_${lifecycle}_cancel` },
      { type: "enforce_limits", now: 110, eventId: `event_${lifecycle}_limits` },
    ];
    for (const action of mutatingActions) {
      const result = reduceGoal(state, action);
      expectFailure(result, "terminal");
      assert.strictEqual(result.state, state);
    }

    expectUnchanged(reduceGoal(state, {
      type: "settle_run", runId: "run_callback", now: 110, eventId: `event_${lifecycle}_settle`,
    }), state);
    expectUnchanged(reduceGoal(state, {
      type: "compaction_succeeded", generation: 99, now: 110, eventId: `event_${lifecycle}_compact_success`,
    }), state);
    expectUnchanged(reduceGoal(state, {
      type: "compaction_failed", generation: 99, now: 110, eventId: `event_${lifecycle}_compact_failure`,
    }), state);
    expectUnchanged(reduceGoal(state, {
      type: "interrupt_restored", now: 110, eventId: `event_${lifecycle}_restore`,
    }), state);
  }
});

test("compaction persists pending state before compacting, accepts exact success, and ignores stale callbacks", () => {
  const state = initial();
  const pending = reduceGoal(state, {
    type: "request_compaction",
    instructions: "Keep only durable goal facts and evidence.",
    tokensBefore: 70_000,
    contextWindow: 100_000,
    now: 110,
    eventId: "event_compaction_pending",
  });

  expectPersistFirst(pending);
  assert.deepEqual(pending.effects.map((effect) => effect.type), ["persist", "compact"]);
  assert.equal(pending.state.scheduler.state, "compaction_pending");
  assert.deepEqual(pending.state.compaction, {
    generation: 1,
    state: "pending",
    requestedAtRevision: pending.state.revision,
    tokensBefore: 70_000,
    contextWindow: 100_000,
  });
  assert.deepEqual(pending.effects[1], {
    type: "compact",
    generation: 1,
    instructions: "Keep only durable goal facts and evidence.",
  });

  expectUnchanged(reduceGoal(pending.state, {
    type: "compaction_succeeded",
    generation: 0,
    now: 111,
    eventId: "event_compaction_stale_success",
  }), pending.state);
  expectUnchanged(reduceGoal(pending.state, {
    type: "compaction_failed",
    generation: 2,
    now: 111,
    eventId: "event_compaction_stale_failure",
  }), pending.state);

  const succeeded = reduceGoal(pending.state, {
    type: "compaction_succeeded",
    generation: 1,
    entryId: "entry_compaction_one",
    now: 112,
    eventId: "event_compaction_success",
  });
  expectPersistFirst(succeeded);
  assert.equal(succeeded.state.scheduler.state, "idle");
  assert.equal(succeeded.state.compaction.state, "idle");
  assert.equal(succeeded.state.compaction.requestedAtRevision, undefined);
  assert.equal(succeeded.state.compaction.lastCompactionEntryId, "entry_compaction_one");
  assert.equal(succeeded.state.budgets.compactions, 1);
  expectUnchanged(reduceGoal(succeeded.state, {
    type: "compaction_succeeded",
    generation: 1,
    now: 113,
    eventId: "event_compaction_success_replay",
  }), succeeded.state);
});

test("an exact compaction failure pauses for recovery and is deduplicated", () => {
  const pending = reduceGoal(initial(), {
    type: "request_compaction",
    instructions: "Compact safely.",
    now: 110,
    eventId: "event_compaction_pending_failure_case",
  });
  expectSuccess(pending);

  const failed = reduceGoal(pending.state, {
    type: "compaction_failed",
    generation: pending.state.compaction.generation,
    message: "compactor was cancelled",
    now: 111,
    eventId: "event_compaction_failure",
  });
  expectPersistFirst(failed);
  assert.deepEqual(failed.effects.map((effect) => effect.type), ["persist", "notify"]);
  assert.equal((failed.effects[1] as Extract<GoalEffect, { type: "notify" }>).message, "compactor was cancelled");
  assert.equal(failed.state.lifecycle, "paused");
  assert.equal(failed.state.pauseReason, "compaction");
  assert.equal(failed.state.scheduler.state, "recovery_required");
  assert.equal(failed.state.compaction.state, "failed");

  expectUnchanged(reduceGoal(failed.state, {
    type: "compaction_failed",
    generation: failed.state.compaction.generation,
    now: 112,
    eventId: "event_compaction_failure_replay",
  }), failed.state);
});

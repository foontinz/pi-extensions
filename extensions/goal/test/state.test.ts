import assert from "node:assert/strict";
import test from "node:test";
import {
  GOAL_BOUNDS,
  GOAL_CHECKPOINT_ENTRY,
  GOAL_CHECKPOINT_TOOL,
  GOAL_SCHEMA_VERSION,
  GOAL_SNAPSHOT_SOFT_LIMIT,
  LEGACY_GOAL_STATE_ENTRY,
  MAX_GOAL_SNAPSHOT_BYTES,
  advanceCheckpoint,
  compactGoalSnapshotDraft,
  cloneCheckpoint,
  createInitialCheckpoint,
  goalProgressHash,
  hydrateGoalState,
  isGoalCheckpointV2,
  isSnapshotWithinBounds,
  isTerminalLifecycle,
  migrateV1GoalState,
  newDispatchId,
  newEventId,
  newGoalId,
  newRunId,
  parseGoalCheckpointV2,
  serializeGoalCheckpoint,
  snapshotByteLength,
  validateGoalCheckpointV2,
  type GoalCheckpointV2,
} from "../state.ts";

function checkpoint(overrides: Partial<GoalCheckpointV2> = {}): GoalCheckpointV2 {
  const value: GoalCheckpointV2 = {
    schemaVersion: 2,
    eventId: "event_7",
    parentEventId: "event_6",
    revision: 7,
    goalId: "goal_1",
    epoch: 2,
    objective: "Ship a verified state layer",
    createdAt: 1_000,
    updatedAt: 2_000,
    lifecycle: "running",
    constraints: ["Keep persistence bounded"],
    acceptanceCriteria: [{
      id: "criterion_1",
      description: "State round-trips",
      status: "satisfied",
      evidenceIds: ["evidence_1"],
    }],
    planVersion: 3,
    phases: [{
      id: "phase_1",
      title: "Implement state",
      intent: "Persist and restore state safely",
      status: "running",
      dependencies: [],
      criteria: [{ id: "phase_criterion_1", description: "Tests pass", status: "pending" }],
      summary: "Persistence is implemented",
      nextAction: "Run tests",
    }],
    activePhaseId: "phase_1",
    ledger: {
      completedPhaseSummaries: [{ phaseId: "phase_0", summary: "Designed the schema" }],
      decisions: [{
        id: "decision_1",
        summary: "Use snapshots",
        rationale: "Hydration remains deterministic",
        madeAt: 1_100,
        runId: "run_0",
      }],
      openQuestions: ["Does the test pass?"],
      recentProgress: ["Implemented validation"],
      nextAction: "Run tests",
    },
    evidence: [{
      id: "evidence_1",
      criterionId: "criterion_1",
      kind: "test",
      description: "The state test passed",
      locator: "test/state.test.ts",
      observedAt: 1_900,
      runId: "run_1",
      digest: "sha256:abc",
    }],
    artifacts: [{
      id: "artifact_1",
      path: "report.json",
      digest: "sha256:def",
      description: "Test report",
      mediaType: "application/json",
      sizeBytes: 123,
      createdAt: 1_950,
      runId: "run_1",
    }],
    scheduler: {
      state: "run_in_flight",
      dispatch: {
        dispatchId: "dispatch_1",
        goalId: "goal_1",
        epoch: 2,
        revision: 6,
        runId: "run_1",
        createdAt: 1_800,
        repairAttempt: 1,
      },
      activeRun: {
        runId: "run_1",
        dispatchId: "dispatch_1",
        goalId: "goal_1",
        epoch: 2,
        revision: 6,
        startedAt: 1_850,
        repairAttempt: 1,
        controlEntryId: "control_1",
      },
      lastSettledRunId: "run_0",
      lastSettledLeafId: "leaf_0",
    },
    budgets: {
      epochRuns: 2,
      maxEpochRuns: 5,
      totalRuns: 4,
      totalTurns: 20,
      compactions: 1,
      startedAt: 1_000,
      maxElapsedMs: 60_000,
      repeatedProgressHashCount: 1,
    },
    compaction: {
      generation: 1,
      state: "idle",
      requestedAtRevision: 5,
      tokensBefore: 10_000,
      contextWindow: 20_000,
      lastCompactionEntryId: "compaction_1",
    },
    ...overrides,
  };
  return value;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function custom(data: unknown, id = "entry_1") {
  return { type: "custom", customType: GOAL_CHECKPOINT_ENTRY, id, data };
}

function legacy(data: unknown, id = "legacy_1") {
  return { type: "custom", customType: LEGACY_GOAL_STATE_ENTRY, id, data };
}

function assertInvalid(value: unknown, error: RegExp): void {
  const result = validateGoalCheckpointV2(value);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, error);
  assert.equal(parseGoalCheckpointV2(value), undefined);
  assert.equal(isGoalCheckpointV2(value), false);
}

/** Fill a valid checkpoint to an exact JSON byte length using bounded strings. */
function checkpointAtByteLength(target: number): GoalCheckpointV2 {
  const value = createInitialCheckpoint("size boundary", {
    now: 1,
    goalId: "goal_size",
    eventId: "event_size",
  });
  const progress = value.ledger.recentProgress;

  while (snapshotByteLength(value)! < target) {
    const current = snapshotByteLength(value)!;
    const separatorCost = progress.length === 0 ? 2 : 3; // quotes, plus a comma after the first item
    const difference = target - current;

    if (difference >= separatorCost + 1) {
      progress.push("x".repeat(Math.min(GOAL_BOUNDS.text, difference - separatorCost)));
      continue;
    }

    // Make room for the smallest valid next item when the remaining one or two
    // bytes cannot themselves encode a non-empty JSON string.
    assert.ok(progress.length > 0);
    const last = progress.length - 1;
    const reduction = separatorCost + 1 - difference;
    assert.ok(progress[last]!.length > reduction);
    progress[last] = progress[last]!.slice(0, -reduction);
  }

  assert.equal(snapshotByteLength(value), target);
  return value;
}

test("accepts and serializes a fully populated valid V2 checkpoint", () => {
  const value = checkpoint();
  const result = validateGoalCheckpointV2(value);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.strictEqual(result.value, value, "validation does not silently rewrite snapshots");
  assert.strictEqual(parseGoalCheckpointV2(value), value);
  assert.equal(isGoalCheckpointV2(value), true);
  assert.deepEqual(JSON.parse(serializeGoalCheckpoint(value)), value);

  const cloned = cloneCheckpoint(value);
  assert.deepEqual(cloned, value);
  assert.notStrictEqual(cloned, value);
  assert.notStrictEqual(cloned.ledger, value.ledger);
  assert.notStrictEqual(cloned.phases[0], value.phases[0]);
});

test("waitFor round-trips strictly, remains optional, and is confined to waiting_external", () => {
  const oldCheckpoint = checkpoint();
  assert.equal(Object.hasOwn(oldCheckpoint, "waitFor"), false);
  assert.equal(validateGoalCheckpointV2(oldCheckpoint).ok, true, "older V2 checkpoints remain valid");

  for (const kind of ["background_task", "workflow", "subagent"] as const) {
    const waiting = checkpoint({ lifecycle: "waiting_external", waitFor: { kind, id: `${kind}_1` } });
    const result = validateGoalCheckpointV2(waiting);
    assert.equal(result.ok, true, kind);
    assert.deepEqual(JSON.parse(serializeGoalCheckpoint(waiting)).waitFor, waiting.waitFor);
  }

  assertInvalid(checkpoint({
    lifecycle: "waiting_external",
    waitFor: { kind: "unknown" as never, id: "job_1" },
  }), /waitFor/);
  assertInvalid(checkpoint({
    lifecycle: "waiting_external",
    waitFor: { kind: "workflow", id: "   " },
  }), /waitFor/);
  assertInvalid(checkpoint({
    lifecycle: "waiting_external",
    waitFor: { kind: "workflow", id: "x".repeat(GOAL_BOUNDS.id + 1) },
  }), /waitFor/);
  assertInvalid(checkpoint({
    lifecycle: "running",
    waitFor: { kind: "workflow", id: "workflow_1" },
  }), /requires waiting_external/);

  const legacyVagueBlocked = checkpoint({ lifecycle: "blocked" });
  legacyVagueBlocked.ledger.openQuestions = [];
  delete legacyVagueBlocked.ledger.nextAction;
  const legacyVagueWait = checkpoint({ lifecycle: "waiting_external" });
  legacyVagueWait.ledger.openQuestions = [];
  delete legacyVagueWait.ledger.nextAction;
  for (const legacy of [legacyVagueBlocked, legacyVagueWait]) {
    assert.equal(validateGoalCheckpointV2(legacy).ok, true, "new actionable-wait validation does not invalidate history");
    const hydrated = hydrateGoalState([{
      type: "custom",
      id: `entry-${legacy.lifecycle}`,
      customType: GOAL_CHECKPOINT_ENTRY,
      data: legacy,
    }]);
    assert.equal(hydrated.status, "ok");
  }

  const paused = advanceCheckpoint(
    checkpoint({ lifecycle: "waiting_external", waitFor: { kind: "background_task", id: "bg_003" } }),
    { lifecycle: "paused", pauseReason: "user" },
    { now: 2_001, eventId: "event_wait_paused" },
  );
  assert.equal(paused.waitFor, undefined, "lifecycle transitions out of waiting clear correlation");
});

test("enforces public string, collection, counter, relationship, and unknown-field bounds", () => {
  const maxStrings = checkpoint({
    eventId: "e".repeat(GOAL_BOUNDS.id),
    objective: "o".repeat(GOAL_BOUNDS.objective),
    constraints: Array.from({ length: GOAL_BOUNDS.constraints }, () => "x"),
  });
  assert.equal(validateGoalCheckpointV2(maxStrings).ok, true, "inclusive public maxima are accepted");

  assertInvalid(checkpoint({ eventId: "e".repeat(GOAL_BOUNDS.id + 1) }), /eventId/);
  assertInvalid(checkpoint({ objective: "o".repeat(GOAL_BOUNDS.objective + 1) }), /objective/);
  assertInvalid(checkpoint({ objective: "   " }), /objective/);
  assertInvalid(checkpoint({ constraints: Array.from({ length: GOAL_BOUNDS.constraints + 1 }, () => "x") }), /constraints/);
  assertInvalid(checkpoint({ revision: GOAL_BOUNDS.counter + 1 }), /revision/);
  assertInvalid(checkpoint({ epoch: 0 }), /epoch/);
  assertInvalid(checkpoint({ activePhaseId: "missing_phase" }), /activePhaseId/);

  const tooManyEvidenceIds = checkpoint();
  tooManyEvidenceIds.acceptanceCriteria[0]!.evidenceIds = Array.from(
    { length: GOAL_BOUNDS.criterionEvidenceIds + 1 },
    (_, index) => `e${index}`,
  );
  assertInvalid(tooManyEvidenceIds, /acceptanceCriteria/);

  const tooManyDependencies = checkpoint();
  tooManyDependencies.phases[0]!.dependencies = Array.from(
    { length: GOAL_BOUNDS.phaseDependencies + 1 },
    (_, index) => `p${index}`,
  );
  assertInvalid(tooManyDependencies, /phases/);

  const foreignDispatch = checkpoint();
  foreignDispatch.scheduler.dispatch!.goalId = "another_goal";
  assertInvalid(foreignDispatch, /dispatch does not belong/);

  const futureRun = checkpoint();
  futureRun.scheduler.activeRun!.revision = futureRun.revision + 1;
  assertInvalid(futureRun, /active run does not belong/);

  const inconsistentBudget = checkpoint();
  inconsistentBudget.budgets.epochRuns = inconsistentBudget.budgets.totalRuns + 1;
  assertInvalid(inconsistentBudget, /inconsistent budgets/);

  const unknownTopLevel = checkpoint() as GoalCheckpointV2 & { surprise: boolean };
  unknownTopLevel.surprise = true;
  assertInvalid(unknownTopLevel, /unknown fields/);

  const unknownNested = checkpoint();
  (unknownNested.ledger as GoalCheckpointV2["ledger"] & { surprise: boolean }).surprise = true;
  assertInvalid(unknownNested, /invalid ledger/);
});

test("measures UTF-8 JSON bytes and enforces the inclusive 64 KiB snapshot ceiling", () => {
  const overhead = snapshotByteLength({ padding: "" })!;
  const exactObject = { padding: "x".repeat(MAX_GOAL_SNAPSHOT_BYTES - overhead) };
  assert.equal(snapshotByteLength(exactObject), MAX_GOAL_SNAPSHOT_BYTES);
  assert.equal(isSnapshotWithinBounds(exactObject), true);
  exactObject.padding += "é";
  assert.equal(snapshotByteLength(exactObject), MAX_GOAL_SNAPSHOT_BYTES + 2);
  assert.equal(isSnapshotWithinBounds(exactObject), false, "the bound is bytes, not JS string length");

  const exactCheckpoint = checkpointAtByteLength(MAX_GOAL_SNAPSHOT_BYTES);
  assert.equal(validateGoalCheckpointV2(exactCheckpoint).ok, true);
  assert.equal(Buffer.byteLength(serializeGoalCheckpoint(exactCheckpoint), "utf8"), MAX_GOAL_SNAPSHOT_BYTES);

  exactCheckpoint.ledger.recentProgress.push("x");
  assert.equal(isSnapshotWithinBounds(exactCheckpoint), false);
  assertInvalid(exactCheckpoint, /exceeds 65536 bytes/);
  assert.throws(() => serializeGoalCheckpoint(exactCheckpoint), /Invalid goal checkpoint: checkpoint exceeds 65536 bytes/);

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.equal(snapshotByteLength(cyclic), undefined);
  assert.equal(isSnapshotWithinBounds(cyclic), false);
  assertInvalid(cyclic, /not JSON serializable/);
});

test("snapshot compaction is deterministic, idempotent, and preserves active proof", () => {
  const underTarget = checkpoint();
  const underJson = JSON.stringify(underTarget);
  const noOp = compactGoalSnapshotDraft(underTarget);
  assert.equal(noOp.changed, false);
  assert.equal(JSON.stringify(underTarget), underJson);

  const conciseOverflow = checkpoint();
  conciseOverflow.ledger.recentProgress = Array.from({ length: GOAL_BOUNDS.recentProgress + 1 }, (_, index) => `p${index}`);
  assert.ok((snapshotByteLength(conciseOverflow) ?? Infinity) < GOAL_SNAPSHOT_SOFT_LIMIT);
  const overflowReport = compactGoalSnapshotDraft(conciseOverflow);
  assert.equal(overflowReport.changed, true);
  assert.ok(conciseOverflow.ledger.recentProgress.length <= 16);
  assert.equal(validateGoalCheckpointV2(conciseOverflow).ok, true);

  const makeLarge = (): GoalCheckpointV2 => {
    const value = checkpoint();
    value.ledger.recentProgress = Array.from({ length: 30 }, (_, index) => `progress-${index}-` + "🙂".repeat(180));
    value.ledger.openQuestions = Array.from({ length: 12 }, (_, index) => `question-${index}-` + "界".repeat(120));
    value.ledger.decisions = Array.from({ length: 40 }, (_, index) => ({
      id: `decision_${index}`,
      summary: `summary-${index}-` + "s".repeat(280),
      rationale: `rationale-${index}-` + "r".repeat(280),
      madeAt: 1_000 + index,
      runId: "run_1",
    }));
    value.acceptanceCriteria[0]!.evidenceIds = ["evidence_accept", "ghost_evidence"];
    value.phases[0]!.criteria[0]!.evidenceIds = ["evidence_active"];
    value.evidence = [
      {
        id: "evidence_accept", criterionId: "criterion_1", kind: "test",
        description: "accept-" + "A".repeat(2_000), locator: "test:acceptance",
        observedAt: 1_900, runId: "run_1",
      },
      {
        id: "evidence_active", criterionId: "phase_criterion_1", kind: "file",
        description: "active-" + "界".repeat(700), locator: "file:/tmp/active.json",
        observedAt: 1_901, runId: "run_1",
      },
      ...Array.from({ length: 16 }, (_, index) => ({
        id: `evidence_unreferenced_${index}`,
        kind: "command" as const,
        description: `old-${index}-` + "x".repeat(900),
        locator: `command:old-${index}`,
        observedAt: 1_000 + index,
        runId: "run_1",
      })),
    ];
    value.artifacts = [
      {
        id: "artifact_active", path: "/tmp/active.json", digest: "sha256:active",
        description: "must survive byte-for-byte", createdAt: 1_900, runId: "run_1",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `artifact_old_${index}`, path: `/tmp/old-${index}`, digest: `sha256:${index}`,
        description: "artifact-history-" + "z".repeat(700), createdAt: 1_000 + index, runId: "run_1",
      })),
    ];
    return value;
  };

  const first = makeLarge();
  const second = makeLarge();
  const protectedAcceptance = structuredClone(first.evidence[0]);
  const protectedActive = structuredClone(first.evidence[1]);
  const protectedArtifact = structuredClone(first.artifacts[0]);
  const identity = {
    schemaVersion: first.schemaVersion,
    eventId: first.eventId,
    parentEventId: first.parentEventId,
    revision: first.revision,
    goalId: first.goalId,
    epoch: first.epoch,
    objective: first.objective,
    lifecycle: first.lifecycle,
    activePhaseId: first.activePhaseId,
    scheduler: structuredClone(first.scheduler),
    budgets: structuredClone(first.budgets),
    compaction: structuredClone(first.compaction),
    nextAction: first.ledger.nextAction,
    latestQuestion: first.ledger.openQuestions.at(-1),
  };
  const target = 24 * 1024;
  const report = compactGoalSnapshotDraft(first, target);
  const secondReport = compactGoalSnapshotDraft(second, target);
  assert.deepEqual(secondReport, report);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(report.changed, true);
  assert.ok((snapshotByteLength(first) ?? Infinity) <= target);
  assert.ok(report.droppedEvidence > 0);
  assert.ok(report.droppedArtifacts > 0);
  assert.ok(report.droppedDecisions > 0);
  assert.ok(report.prunedEvidenceLinks > 0);
  assert.deepEqual(first.evidence.find((item) => item.id === "evidence_accept"), protectedAcceptance);
  assert.deepEqual(first.evidence.find((item) => item.id === "evidence_active"), protectedActive);
  assert.deepEqual(first.artifacts.find((item) => item.id === "artifact_active"), protectedArtifact);
  assert.equal(first.acceptanceCriteria[0]!.evidenceIds?.includes("ghost_evidence"), false);
  assert.equal(first.ledger.openQuestions.at(-1), identity.latestQuestion);
  assert.deepEqual({
    schemaVersion: first.schemaVersion,
    eventId: first.eventId,
    parentEventId: first.parentEventId,
    revision: first.revision,
    goalId: first.goalId,
    epoch: first.epoch,
    objective: first.objective,
    lifecycle: first.lifecycle,
    activePhaseId: first.activePhaseId,
    scheduler: first.scheduler,
    budgets: first.budgets,
    compaction: first.compaction,
    nextAction: first.ledger.nextAction,
    latestQuestion: first.ledger.openQuestions.at(-1),
  }, identity);
  assert.equal(first.ledger.recentProgress.filter((item) => item.startsWith("Snapshot compacted:")).length, 1);
  assert.ok(first.ledger.recentProgress.length <= 16);
  assert.ok(first.ledger.openQuestions.length <= 8);
  assert.doesNotMatch(JSON.stringify(first), /�/);

  const once = JSON.stringify(first);
  const idempotent = compactGoalSnapshotDraft(first, target);
  assert.equal(idempotent.changed, false);
  assert.equal(JSON.stringify(first), once);

  const soft = makeLarge();
  compactGoalSnapshotDraft(soft, GOAL_SNAPSHOT_SOFT_LIMIT);
  assert.ok((snapshotByteLength(soft) ?? Infinity) <= GOAL_SNAPSHOT_SOFT_LIMIT);
});

test("snapshot compaction fails closed when acceptance evidence alone exceeds the hard limit", () => {
  const value = checkpoint();
  value.acceptanceCriteria = Array.from({ length: 24 }, (_, index) => ({
    id: `accept_${index}`,
    description: `Acceptance criterion ${index}`,
    status: "pending" as const,
    evidenceIds: [`protected_${index}`],
  }));
  value.evidence = Array.from({ length: 24 }, (_, index) => ({
    id: `protected_${index}`,
    criterionId: `accept_${index}`,
    kind: "test" as const,
    description: "界".repeat(1_300),
    locator: `test:protected-${index}`,
    observedAt: 1_000 + index,
    runId: "run_1",
  }));
  const protectedJson = JSON.stringify(value.evidence);
  const report = compactGoalSnapshotDraft(value);
  assert.ok(report.bytesAfter > MAX_GOAL_SNAPSHOT_BYTES);
  assert.equal(JSON.stringify(value.evidence), protectedJson);
  assert.equal(validateGoalCheckpointV2(value).ok, false);
});

test("advanceCheckpoint derives immutable revision metadata without mutating or aliasing inputs", () => {
  const previous = createInitialCheckpoint("immutable objective", {
    now: 100,
    goalId: "goal_fixed",
    eventId: "event_old",
  });
  const before = copy(previous);
  const suppliedConstraints = ["new constraint"];
  const next = advanceCheckpoint(previous, {
    eventId: "mutation_cannot_choose_this",
    parentEventId: "mutation_cannot_choose_this_either",
    revision: 999,
    updatedAt: 999,
    constraints: suppliedConstraints,
  }, { now: 101, eventId: "event_new" });

  assert.deepEqual(previous, before, "the prior revision remains unchanged");
  assert.equal(next.parentEventId, "event_old");
  assert.equal(next.eventId, "event_new");
  assert.equal(next.revision, 2);
  assert.equal(next.updatedAt, 101);
  assert.notStrictEqual(next, previous);
  assert.notStrictEqual(next.ledger, previous.ledger);

  suppliedConstraints.push("late mutation");
  assert.deepEqual(next.constraints, ["new constraint"], "the next revision must not alias a partial mutation input");

  const functionNext = advanceCheckpoint(previous, (draft) => {
    draft.ledger.openQuestions.push("new question");
  }, { now: 102, eventId: "event_function" });
  assert.deepEqual(previous.ledger.openQuestions, []);
  assert.deepEqual(functionNext.ledger.openQuestions, ["new question"]);

  for (const mutation of [
    { goalId: "changed" },
    { objective: "changed" },
    { createdAt: 99 },
    { schemaVersion: 3 as never },
  ]) {
    assert.throws(() => advanceCheckpoint(previous, mutation, { now: 101 }), /immutable/);
  }
  assert.throws(() => advanceCheckpoint(previous, {}, { now: 99 }), /cannot move backwards/);

  const atRevisionLimit = checkpoint({ revision: GOAL_BOUNDS.counter });
  assert.throws(() => advanceCheckpoint(atRevisionLimit), /revision limit/);
});

test("all terminal lifecycles are sticky while same-terminal revisions remain possible", () => {
  for (const lifecycle of ["succeeded", "cancelled", "failed"] as const) {
    const terminal = checkpoint({ lifecycle, scheduler: { state: "idle" } });
    assert.equal(isTerminalLifecycle(lifecycle), true);
    assert.equal(isTerminalLifecycle(terminal), true);
    assert.throws(
      () => advanceCheckpoint(terminal, { lifecycle: "running" }, { now: 2_001 }),
      /terminal goal lifecycle is sticky/,
    );

    const next = advanceCheckpoint(terminal, { lifecycle }, {
      now: 2_001,
      eventId: `event_after_${lifecycle}`,
    });
    assert.equal(next.lifecycle, lifecycle);
    assert.equal(next.revision, terminal.revision + 1);
  }
  assert.equal(isTerminalLifecycle("running"), false);
});

test("v1 migration is paused for reconciliation and preserves legacy run/turn counters", () => {
  const legacyState = {
    goal: "  Finish the migrated task  ",
    startedAt: 1_000,
    iterations: 4,
    turns: 23,
    maxIterations: 10,
    active: true,
  };
  const first = migrateV1GoalState(legacyState, { now: 2_000 });
  const second = migrateV1GoalState(legacyState, { now: 2_000 });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value.lifecycle, "paused", "an old active bit must not auto-resume execution");
  assert.equal(first.value.pauseReason, "interrupted");
  assert.equal(first.value.scheduler.state, "recovery_required");
  assert.equal(first.value.objective, "Finish the migrated task");
  assert.equal(first.value.budgets.epochRuns, 4);
  assert.equal(first.value.budgets.totalRuns, 4);
  assert.equal(first.value.budgets.totalTurns, 23);
  assert.equal(first.value.budgets.maxEpochRuns, 10);
  assert.equal(first.value.budgets.startedAt, 1_000);
  assert.equal(first.value.updatedAt, 2_000);
  assert.equal(first.value.eventId, second.value.eventId, "migration identifiers are deterministic");
  assert.equal(first.value.goalId, second.value.goalId);
  assert.match(first.value.goalId, /^goal_[0-9a-f]{32}$/);

  const inactive = migrateV1GoalState({ ...legacyState, active: false }, { now: 2_000 });
  assert.equal(inactive.ok && inactive.value.lifecycle, "paused");
  assert.equal(inactive.ok && inactive.value.pauseReason, "user");

  const exhausted = migrateV1GoalState({ ...legacyState, iterations: 10 }, { now: 2_000 });
  assert.equal(exhausted.ok && exhausted.value.pauseReason, "budget");

  const blocked = migrateV1GoalState({ ...legacyState, blockedReason: "Need a decision" }, { now: 2_000 });
  assert.equal(blocked.ok && blocked.value.lifecycle, "blocked");
  assert.deepEqual(blocked.ok && blocked.value.ledger.openQuestions, ["Need a decision"]);

  assert.equal(migrateV1GoalState({ ...legacyState, iterations: 11 }).ok, false);
  assert.equal(migrateV1GoalState(legacyState, { now: 999 }).ok, false);
});

test("multiple mutable V1 snapshots migrate from the newest legacy authority", () => {
  const base = { goal: "legacy sequence", startedAt: 1, maxIterations: 10, active: true };
  const result = hydrateGoalState([
    legacy({ ...base, iterations: 0, turns: 1 }, "legacy_early"),
    legacy({ ...base, iterations: 3, turns: 9 }, "legacy_latest"),
  ], { now: 20 });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.migrated, true);
  assert.equal(result.checkpoint.lifecycle, "paused");
  assert.equal(result.checkpoint.budgets.totalRuns, 3);
  assert.equal(result.checkpoint.budgets.totalTurns, 9);
  assert.equal(result.source.entryId, "legacy_latest");
});

test("hydrates only the supplied branch and permits divergent branch-local heads", () => {
  const root = checkpoint({
    eventId: "event_root",
    parentEventId: undefined,
    revision: 1,
    scheduler: { state: "idle" },
  });
  const left = advanceCheckpoint(root, (draft) => {
    draft.ledger.recentProgress.push("left branch");
  }, { now: 2_001, eventId: "event_left" });
  const right = advanceCheckpoint(root, (draft) => {
    draft.ledger.recentProgress.push("right branch");
  }, { now: 2_002, eventId: "event_right" });

  const leftResult = hydrateGoalState([custom(root, "root"), custom(left, "left")]);
  const rightResult = hydrateGoalState([custom(root, "root"), custom(right, "right")]);

  assert.equal(leftResult.status, "ok");
  assert.equal(rightResult.status, "ok");
  if (leftResult.status !== "ok" || rightResult.status !== "ok") return;
  assert.equal(leftResult.checkpoint.eventId, "event_left");
  assert.equal(rightResult.checkpoint.eventId, "event_right");
  assert.deepEqual(leftResult.checkpoint.ledger.recentProgress.at(-1), "left branch");
  assert.deepEqual(rightResult.checkpoint.ledger.recentProgress.at(-1), "right branch");
  assert.deepEqual(leftResult.source, { kind: "checkpoint_entry", index: 1, entryId: "left" });
  assert.deepEqual(rightResult.source, { kind: "checkpoint_entry", index: 1, entryId: "right" });
  assert.equal(hydrateGoalState([]).status, "absent");
});

test("a newest malformed authority fails closed and exposes only the prior valid recovery candidate", () => {
  const valid = checkpoint();
  const malformed = { ...copy(valid), revision: -1 };
  const result = hydrateGoalState([
    custom(valid, "valid_entry"),
    { type: "message", message: { role: "assistant", content: [] } },
    custom(malformed, "malformed_entry"),
    { type: "custom", customType: "unrelated", data: valid },
  ]);

  assert.equal(result.status, "corrupt");
  if (result.status !== "corrupt") return;
  assert.deepEqual(result.source, { kind: "checkpoint_entry", index: 2, entryId: "malformed_entry" });
  assert.match(result.error, /revision/);
  assert.strictEqual(result.lastValidCheckpoint, valid);

  const noCandidate = hydrateGoalState([custom(malformed, "only_malformed")]);
  assert.equal(noCandidate.status, "corrupt");
  if (noCandidate.status === "corrupt") assert.equal(noCandidate.lastValidCheckpoint, undefined);
});

test("successful goal tool results are authoritative in both installed and pure-test shapes", () => {
  const persisted = checkpoint({ eventId: "event_persisted" });
  const fromInstalledTool = advanceCheckpoint(persisted, (draft) => {
    draft.ledger.recentProgress.push("installed tool checkpoint");
  }, { now: 2_001, eventId: "event_installed_tool" });
  const fromPureTool = advanceCheckpoint(fromInstalledTool, (draft) => {
    draft.ledger.recentProgress.push("pure tool checkpoint");
  }, { now: 2_002, eventId: "event_pure_tool" });
  const ignored = checkpoint({ eventId: "event_ignored" });

  const branch = [
    custom(persisted, "persisted"),
    {
      type: "message",
      id: "installed_result",
      message: {
        role: "toolResult",
        toolName: GOAL_CHECKPOINT_TOOL,
        isError: false,
        details: { checkpoint: fromInstalledTool },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: GOAL_CHECKPOINT_TOOL,
        isError: true,
        details: { checkpoint: ignored },
      },
    },
    { role: "toolResult", toolName: "another_tool", details: ignored },
  ];

  const installedResult = hydrateGoalState(branch);
  assert.equal(installedResult.status, "ok");
  if (installedResult.status === "ok") {
    assert.strictEqual(installedResult.checkpoint, fromInstalledTool);
    assert.deepEqual(installedResult.source, {
      kind: "checkpoint_tool",
      index: 1,
      entryId: "installed_result",
    });
  }

  const pureResult = hydrateGoalState([
    ...branch,
    { role: "toolResult", id: "pure_result", toolName: GOAL_CHECKPOINT_TOOL, details: fromPureTool },
  ]);
  assert.equal(pureResult.status, "ok");
  if (pureResult.status === "ok") {
    assert.strictEqual(pureResult.checkpoint, fromPureTool);
    assert.deepEqual(pureResult.source, { kind: "checkpoint_tool", index: 4, entryId: "pure_result" });
  }

  const malformedToolResult = hydrateGoalState([
    custom(persisted),
    { role: "toolResult", toolName: GOAL_CHECKPOINT_TOOL, details: { checkpoint: { revision: -1 } } },
  ]);
  assert.equal(malformedToolResult.status, "corrupt", "tool authority also fails closed");
  if (malformedToolResult.status === "corrupt") {
    assert.strictEqual(malformedToolResult.lastValidCheckpoint, persisted);
  }
});

test("hydration rejects rollback, broken lineage, foreign goals, and unowned tool checkpoints", () => {
  const root = createInitialCheckpoint("lineage", {
    now: 10,
    goalId: "goal_lineage",
    eventId: "event_lineage_1",
  });
  const head = advanceCheckpoint(root, (draft) => {
    draft.ledger.recentProgress.push("advanced");
  }, { now: 11, eventId: "event_lineage_2" });

  const rollback = hydrateGoalState([custom(root), custom(head), custom(root, "rollback")]);
  assert.equal(rollback.status, "corrupt");
  if (rollback.status === "corrupt") assert.match(rollback.error, /eventId was reused|revision is not monotonic/);

  const brokenParent = advanceCheckpoint(head, {}, { now: 12, eventId: "event_lineage_3" });
  brokenParent.parentEventId = "event_wrong_parent";
  const broken = hydrateGoalState([custom(root), custom(head), custom(brokenParent, "broken")]);
  assert.equal(broken.status, "corrupt");
  if (broken.status === "corrupt") assert.match(broken.error, /parentEventId/);

  const foreign = createInitialCheckpoint("foreign", {
    now: 12,
    goalId: "goal_foreign",
    eventId: "event_foreign",
  });
  const switched = hydrateGoalState([custom(root), custom(foreign, "foreign")]);
  assert.equal(switched.status, "corrupt");
  if (switched.status === "corrupt") assert.match(switched.error, /terminal/);

  const unownedTool = hydrateGoalState([
    custom(root),
    {
      type: "message",
      id: "forged_tool",
      message: {
        role: "toolResult",
        toolName: GOAL_CHECKPOINT_TOOL,
        isError: false,
        details: { checkpoint: head },
      },
    },
  ]);
  assert.equal(unownedTool.status, "corrupt");
  if (unownedTool.status === "corrupt") assert.match(unownedTool.error, /not owned/);

  const terminal = advanceCheckpoint(root, (draft) => {
    draft.lifecycle = "cancelled";
  }, { now: 11, eventId: "event_terminal" });
  const nextGoal = createInitialCheckpoint("next goal", {
    now: 12,
    goalId: "goal_next",
    eventId: "event_next",
  });
  const allowed = hydrateGoalState([custom(root), custom(terminal), custom(nextGoal)]);
  assert.equal(allowed.status, "ok");
  if (allowed.status === "ok") assert.equal(allowed.checkpoint.goalId, "goal_next");
});

test("V2 and legacy tombstones prevent fallback revival of older checkpoints", () => {
  const valid = checkpoint();
  const v2Tombstone = {
    schemaVersion: GOAL_SCHEMA_VERSION,
    tombstone: true,
    goalId: valid.goalId,
    eventId: "event_clear",
    clearedAt: 3_000,
  };
  const cleared = hydrateGoalState([
    custom(valid, "old_checkpoint"),
    custom(v2Tombstone, "clear_entry"),
    { type: "message", message: { role: "assistant", content: [] } },
  ]);
  assert.equal(cleared.status, "cleared");
  if (cleared.status === "cleared") {
    assert.deepEqual(cleared.source, { kind: "checkpoint_entry", index: 1, entryId: "clear_entry" });
  }

  const afterClearCorruption = hydrateGoalState([
    custom(valid),
    custom(v2Tombstone, "clear_entry"),
    custom({ schemaVersion: 2, eventId: "broken" }, "broken_after_clear"),
  ]);
  assert.equal(afterClearCorruption.status, "corrupt");
  if (afterClearCorruption.status === "corrupt") {
    assert.equal(afterClearCorruption.lastValidCheckpoint, undefined, "pre-tombstone state is not a recovery candidate");
  }

  const migratedThenLegacyClear = hydrateGoalState([
    legacy({ goal: "old", startedAt: 1, iterations: 0, turns: 0, maxIterations: 2, active: true }),
    legacy({ active: false }, "legacy_clear"),
  ], { now: 2 });
  assert.equal(migratedThenLegacyClear.status, "cleared");
  if (migratedThenLegacyClear.status === "cleared") {
    assert.deepEqual(migratedThenLegacyClear.source, { kind: "legacy_state", index: 1, entryId: "legacy_clear" });
  }
});

test("generated IDs are prefixed UUIDs and progress hashes include only material progress", () => {
  const factories = [
    ["goal", newGoalId],
    ["event", newEventId],
    ["dispatch", newDispatchId],
    ["run", newRunId],
  ] as const;
  const ids = factories.map(([prefix, factory]) => {
    const id = factory();
    assert.match(id, new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "i"));
    assert.ok(id.length <= GOAL_BOUNDS.id);
    return id;
  });
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(newGoalId(), newGoalId());

  const original = checkpoint();
  const hash = goalProgressHash(original);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(goalProgressHash(copy(original)), hash, "equivalent material state hashes identically");

  const metadataOnly = copy(original);
  metadataOnly.eventId = "event_different";
  metadataOnly.parentEventId = "event_other_parent";
  metadataOnly.revision += 1;
  metadataOnly.epoch += 1;
  metadataOnly.updatedAt += 1;
  metadataOnly.scheduler.dispatch!.epoch = metadataOnly.epoch;
  metadataOnly.scheduler.activeRun!.epoch = metadataOnly.epoch;
  metadataOnly.scheduler.lastSettledLeafId = "leaf_different";
  metadataOnly.budgets.totalTurns += 100;
  metadataOnly.budgets.totalRuns += 1;
  metadataOnly.compaction.generation += 1;
  assert.equal(validateGoalCheckpointV2(metadataOnly).ok, true);
  assert.equal(goalProgressHash(metadataOnly), hash, "revision metadata, leases, timestamps, and counters are excluded");

  const proseOnly = copy(original);
  proseOnly.ledger.recentProgress.push("different prose without observed progress");
  proseOnly.ledger.nextAction = "Reword the same action";
  assert.equal(goalProgressHash(proseOnly), hash, "narrative churn does not defeat stagnation detection");

  const materialChange = copy(original);
  materialChange.evidence.push({
    id: "evidence_2",
    criterionId: "criterion_1",
    kind: "test",
    description: "Another observed test",
    locator: "test:call_2",
    observedAt: 2_000,
    runId: "run_1",
  });
  assert.notEqual(goalProgressHash(materialChange), hash);

  assert.throws(() => goalProgressHash({ ...original, revision: -1 }), /Cannot hash invalid goal checkpoint/);
});

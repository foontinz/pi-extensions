import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import {
  GoalCheckpointParams,
  applyGoalCheckpoint,
  type GoalCheckpointRunIdentity,
} from "../checkpoint-tool.ts";
import {
  GOAL_WORKING_PACKET_MAX_BYTES,
  buildGoalWorkingPacket,
} from "../prompt.ts";
import {
  areAllCriteriaVerifiablySatisfied,
  areCriteriaVerifiablySatisfied,
  evaluateDispatchEligibility,
  evaluateProactiveCompaction,
  locateDescendantAssistantEntry,
  locateGoalControlEntry,
  locateGoalRunEntries,
  parseGoalControlEntry,
  reconcileSuccessfulEvidence,
  type GoalControlDetails,
} from "../scheduler.ts";
import {
  formatGoalStatusLine,
  formatGoalWidgetLines,
  getGoalNextAction,
  isInterruptedGoal,
} from "../render.ts";
import {
  GOAL_CHECKPOINT_TOOL,
  GOAL_CONTROL_MESSAGE,
  createInitialCheckpoint,
  type GoalCheckpointV2,
  type GoalCriterion,
  type GoalEvidence,
} from "../state.ts";

const controlDetails: GoalControlDetails = {
  goalId: "goal-protocol",
  epoch: 1,
  runId: "run-1",
  revision: 1,
  dispatchId: "dispatch-1",
};

function checkpointInFlight(): GoalCheckpointV2 {
  const checkpoint = createInitialCheckpoint("Ship the protocol safely", {
    now: 100,
    goalId: controlDetails.goalId,
    eventId: "event-1",
    maxEpochRuns: 4,
  });
  checkpoint.scheduler = {
    state: "run_in_flight",
    dispatch: {
      ...controlDetails,
      createdAt: 100,
    },
    activeRun: {
      ...controlDetails,
      startedAt: 101,
      controlEntryId: "control-1",
    },
  };
  checkpoint.budgets.epochRuns = 1;
  checkpoint.budgets.totalRuns = 1;
  return checkpoint;
}

function run(now: number, eventId?: string): GoalCheckpointRunIdentity {
  return { ...controlDetails, startedAt: 101, now, ...(eventId ? { eventId } : {}) };
}

function params(
  checkpoint: GoalCheckpointV2,
  overrides: Partial<GoalCheckpointParams> = {},
): GoalCheckpointParams {
  return {
    action: "progress",
    expectedRevision: checkpoint.revision,
    summary: "Made material progress",
    ...overrides,
  } as GoalCheckpointParams;
}

function control(id = "control-1", details: GoalControlDetails = controlDetails) {
  return {
    type: "custom_message" as const,
    id,
    parentId: null,
    customType: GOAL_CONTROL_MESSAGE,
    details,
    display: false,
    content: "opaque adapter content",
  };
}

function assistant(id: string, content: unknown[]) {
  return { type: "message", id, message: { role: "assistant", content } };
}

function toolResult(
  id: string,
  toolCallId: string,
  toolName: string,
  options: { isError?: boolean; exitCode?: number } = {},
) {
  return {
    type: "message",
    id,
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      isError: options.isError ?? false,
      content: [{ type: "text", text: "bounded result" }],
      details: options.exitCode === undefined ? {} : { exitCode: options.exitCode },
    },
  };
}

function evidence(
  id: string,
  criterionId: string,
  locator: string,
  runId = controlDetails.runId,
): GoalEvidence {
  return {
    id,
    criterionId,
    kind: "test",
    description: `Observed ${id}`,
    locator,
    observedAt: 120,
    runId,
  };
}

test("goal_checkpoint has a strict schema and rejects stale, unowned, and semantically invalid applications", () => {
  const checkpoint = checkpointInFlight();
  const valid = params(checkpoint);
  assert.equal(Check(GoalCheckpointParams, valid), true);
  assert.equal(Check(GoalCheckpointParams, { ...valid, surprise: true }), false);
  assert.equal(Check(GoalCheckpointParams, {
    ...valid,
    decisions: [{ id: "decision-1", summary: "Use strict parsing", surprise: true }],
  }), false, "nested objects are strict too");
  assert.equal(Check(GoalCheckpointParams, { action: "progress", expectedRevision: 1 }), false);

  const before = structuredClone(checkpoint);
  assert.throws(
    () => applyGoalCheckpoint(checkpoint, { ...valid, surprise: true } as GoalCheckpointParams, run(110)),
    /strict schema/,
  );
  assert.throws(
    () => applyGoalCheckpoint(checkpoint, { ...valid, expectedRevision: 0 }, run(110)),
    /stale revision/,
  );
  assert.throws(
    () => applyGoalCheckpoint(checkpoint, valid, { ...run(110), runId: "somebody-else" }),
    /not owned/,
  );
  assert.throws(
    () => applyGoalCheckpoint(checkpoint, {
      ...valid,
      phases: [{ id: "phase-1", title: "Phase", intent: "Do work" }],
    } as GoalCheckpointParams, run(110)),
    /may only be changed by set_plan/,
  );
  assert.deepEqual(checkpoint, before, "rejections do not mutate durable state");
});

test("goal_checkpoint applies plan, progress, and completion-claim transitions without self-verifying", () => {
  const initial = checkpointInFlight();
  const plan = applyGoalCheckpoint(initial, {
    action: "set_plan",
    expectedRevision: 1,
    phaseId: "phase-1",
    summary: "Established a bounded plan",
    nextAction: "Implement phase one",
    constraints: ["No implementation edits"],
    acceptanceCriteria: [{ id: "accept-1", description: "Tests pass" }],
    phases: [
      {
        id: "phase-1",
        title: "Protocol tests",
        intent: "Add focused protocol coverage",
        criteria: [{ id: "phase-criterion-1", description: "Coverage exists" }],
      },
      {
        id: "phase-2",
        title: "Verification",
        intent: "Run checks",
        criteria: [{ id: "phase-criterion-2", description: "Checks pass" }],
      },
    ],
  }, run(110, "event-plan"));

  assert.equal(plan.revision, 2);
  assert.equal(plan.planVersion, 1);
  assert.equal(plan.lifecycle, "running");
  assert.equal(plan.activePhaseId, "phase-1");
  assert.equal(plan.phases[0]?.status, "running");
  assert.equal(plan.phases[1]?.status, "pending");
  assert.equal(initial.phases.length, 0, "application is immutable");

  const progress = applyGoalCheckpoint(plan, params(plan, {
    phaseId: "phase-1",
    summary: "Tests implemented",
    nextAction: "Run the test suite",
    decisions: [{ id: "decision-1", summary: "Use pure fixtures" }],
  }), run(120, "event-progress"));
  assert.equal(progress.lifecycle, "running");
  assert.equal(progress.ledger.nextAction, "Run the test suite");
  assert.equal(progress.ledger.decisions[0]?.runId, controlDetails.runId);

  const phaseClaim = applyGoalCheckpoint(progress, params(progress, {
    action: "phase_candidate_complete",
    phaseId: "phase-1",
    summary: "Phase appears complete",
  }), run(130, "event-phase-claim"));
  assert.equal(phaseClaim.lifecycle, "verifying_phase");
  assert.equal(phaseClaim.phases[0]?.status, "candidate_complete");

  const goalClaim = applyGoalCheckpoint(phaseClaim, params(phaseClaim, {
    action: "goal_candidate_complete",
    summary: "Goal appears complete",
  }), run(140, "event-goal-claim"));
  assert.equal(goalClaim.lifecycle, "verifying_goal");
  assert.notEqual(goalClaim.lifecycle as string, "succeeded", "a model completion claim is not verification");
  assert.equal(goalClaim.phases[0]?.status, "candidate_complete");
});

test("goal_checkpoint records one typed external wait and clears it on every other action", () => {
  const initial = checkpointInFlight();
  const plan = applyGoalCheckpoint(initial, {
    action: "set_plan",
    expectedRevision: initial.revision,
    phaseId: "phase-1",
    summary: "Established the wait test plan",
    acceptanceCriteria: [{ id: "accept-1", description: "The dependency is reconciled" }],
    phases: [{
      id: "phase-1",
      title: "Wait safely",
      intent: "Wait for one typed dependency",
      criteria: [{ id: "phase-criterion-1", description: "Typed completion is observed" }],
    }],
  }, run(110, "event-wait-plan"));

  const waitingParams: GoalCheckpointParams = {
    action: "waiting_external",
    expectedRevision: plan.revision,
    phaseId: "phase-1",
    summary: "Started the owned background task",
    nextAction: "Wait for its typed completion",
    waitFor: { kind: "background_task", id: "  bg_003  " },
  };
  assert.equal(Check(GoalCheckpointParams, waitingParams), true);
  const waiting = applyGoalCheckpoint(plan, waitingParams, run(120, "event-waiting"));
  assert.equal(waiting.lifecycle, "waiting_external");
  assert.deepEqual(waiting.waitFor, { kind: "background_task", id: "bg_003" });
  const packet = buildGoalWorkingPacket(waiting);
  assert.match(packet, /waitFor\.kind=background_task waitFor\.id="bg_003"/);
  assert.match(packet, /Matching typed terminal metadata after the checkpoint wakes the goal automatically/);
  assert.match(packet, /do not poll, sleep/);

  const resumedProgress = applyGoalCheckpoint(waiting, {
    action: "progress",
    expectedRevision: waiting.revision,
    phaseId: "phase-1",
    summary: "Reconciled the dependency",
  }, run(130, "event-after-wait"));
  assert.equal(resumedProgress.lifecycle, "running");
  assert.equal(resumedProgress.waitFor, undefined);

  assert.throws(() => applyGoalCheckpoint(plan, {
    ...params(plan),
    waitFor: { kind: "workflow", id: "workflow-1" },
  }, run(121)), /only be used with waiting_external/);
  assert.throws(() => applyGoalCheckpoint(plan, {
    ...waitingParams,
    waitFor: { kind: "background_task", id: "   " },
  }, run(121)), /non-empty after trimming/);
  assert.throws(() => applyGoalCheckpoint(plan, {
    ...waitingParams,
    waitFor: { kind: "subagent", id: "agent-1" },
  }, run(121)), /subagent is unavailable/);
  const multipleWaits = {
    ...waitingParams,
    waitFor: [{ kind: "background_task", id: "bg_1" }, { kind: "workflow", id: "wf_1" }],
  };
  assert.equal(Check(GoalCheckpointParams, multipleWaits), false, "the strict schema permits only one wait correlation");
  assert.throws(
    () => applyGoalCheckpoint(plan, multipleWaits as unknown as GoalCheckpointParams, run(121)),
    /wait on one task at a time or consolidate/,
  );
});

test("working packets are deterministic, bounded, complete, and exclude artifact contents", () => {
  const checkpoint = createInitialCheckpoint("Validate a deterministic packet " + "α".repeat(1_500), {
    now: 10,
    goalId: "goal-packet",
    eventId: "event-packet",
  });
  checkpoint.lifecycle = "running";
  checkpoint.planVersion = 2;
  checkpoint.phases = [{
    id: "phase-packet",
    title: "Build packet",
    intent: "Keep only bounded durable references " + "x".repeat(3_000),
    status: "running",
    dependencies: [],
    criteria: Array.from({ length: 20 }, (_, index) => ({
      id: `criterion-${index}`,
      description: "Criterion details " + "y".repeat(700),
      status: "pending" as const,
    })),
    nextAction: "Render it twice",
  }];
  checkpoint.activePhaseId = "phase-packet";
  checkpoint.ledger.nextAction = "Render it twice and compare bytes";
  checkpoint.ledger.recentProgress = ["RECENT_TRANSCRIPT_SECRET_SHOULD_NOT_APPEAR"];
  const artifactSecret = "RAW_ARTIFACT_CONTENTS_SHOULD_NOT_APPEAR";
  checkpoint.artifacts = [{
    id: "artifact-1",
    path: "/tmp/report.bin",
    digest: "sha256:abc",
    createdAt: 10,
    runId: "run-packet",
    contents: artifactSecret,
  } as GoalCheckpointV2["artifacts"][number]];

  const first = buildGoalWorkingPacket(checkpoint, { maxBytes: 4 * 1024 });
  const second = buildGoalWorkingPacket(structuredClone(checkpoint), { maxBytes: 4 * 1024 });
  const defaultSized = buildGoalWorkingPacket(checkpoint);
  assert.equal(first, second);
  assert.ok(Buffer.byteLength(first, "utf8") <= 4 * 1024);
  assert.ok(Buffer.byteLength(defaultSized, "utf8") <= GOAL_WORKING_PACKET_MAX_BYTES);
  assert.match(first, /<goal_working_packet>/);
  assert.match(first, /goalId=goal-packet epoch=1 revision=1 planVersion=2/);
  assert.match(first, /lifecycle=running/);
  assert.match(first, /scheduler=idle/);
  assert.match(first, /objective="Validate a deterministic packet/);
  assert.match(first, /activePhase=phase-packet/);
  assert.match(first, /## Exact next action/);
  assert.match(first, /nextAction="Render it twice and compare bytes"/);
  assert.match(first, /## Strict goal_checkpoint protocol/);
  assert.match(first, /expectedRevision=1/);
  assert.match(first, /<\/goal_working_packet>$/);
  assert.ok(!first.includes(artifactSecret));
  assert.ok(!first.includes("RECENT_TRANSCRIPT_SECRET_SHOULD_NOT_APPEAR"));
  assert.throws(() => buildGoalWorkingPacket(checkpoint, { maxBytes: 4 * 1024 - 1 }), /between 4096 and 8192/);
});

test("control parsing is strict, exact correlation fails closed on duplicates, and assistants stay in their run interval", () => {
  const parsed = parseGoalControlEntry(control());
  assert.deepEqual(parsed?.details, controlDetails);
  assert.equal(parseGoalControlEntry({ ...control(), display: true }), undefined);
  assert.equal(parseGoalControlEntry({
    ...control(),
    details: { ...controlDetails, extra: "not allowed" },
  }), undefined);
  assert.equal(parseGoalControlEntry({
    type: "message",
    id: "fake",
    message: { role: "user", content: JSON.stringify(control()) },
  }), undefined, "ordinary/model text is never control authority");

  const secondDetails = { ...controlDetails, runId: "run-2", dispatchId: "dispatch-2" };
  const branch = [
    assistant("before", [{ type: "text", text: "before control" }]),
    control(),
    { type: "message", id: "user-1", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    assistant("assistant-1", [{ type: "text", text: "first" }]),
    toolResult("result-1", "call-1", "bash"),
    assistant("assistant-2", [{ type: "text", text: "last in run" }]),
    control("control-2", secondDetails),
    assistant("assistant-outside", [{ type: "text", text: "belongs to run two" }]),
  ];
  assert.equal(locateGoalControlEntry(branch, controlDetails)?.index, 1);
  assert.equal(locateDescendantAssistantEntry(branch, controlDetails)?.index, 5);
  const locatedRun = locateGoalRunEntries(branch, controlDetails);
  assert.equal(locatedRun?.assistant?.entry.id, "assistant-2");
  assert.equal(locatedRun?.leaf.entry.id, "assistant-2");

  const duplicate = [control(), control("control-duplicate")];
  assert.equal(locateGoalControlEntry(duplicate, controlDetails), undefined);
  assert.equal(locateGoalRunEntries(duplicate, controlDetails), undefined);
});

test("autonomous dispatch is fail-closed across lifecycle, lease, runtime, queue, budget, wait, and compaction gates", () => {
  const base = createInitialCheckpoint("Dispatch safely", {
    now: 1_000,
    goalId: "goal-dispatch",
    eventId: "event-dispatch",
    maxEpochRuns: 3,
    maxElapsedMs: 1_000,
  });
  const environment = { idle: true, pendingMessages: false, now: 1_500 };
  assert.deepEqual(evaluateDispatchEligibility(base, environment), { eligible: true });

  const cases: Array<{
    name: string;
    mutate?: (checkpoint: GoalCheckpointV2) => void;
    environment?: Record<string, unknown>;
    reason: string;
  }> = [
    { name: "external checkpoint wait", mutate: (value) => { value.lifecycle = "waiting_external"; }, reason: "external_wait" },
    { name: "external runtime wait", environment: { externalWait: true }, reason: "external_wait" },
    { name: "non-executable lifecycle", mutate: (value) => { value.lifecycle = "paused"; }, reason: "lifecycle" },
    {
      name: "compaction",
      mutate: (value) => {
        value.scheduler.state = "compaction_pending";
        value.compaction.state = "pending";
      },
      reason: "compaction",
    },
    {
      name: "scheduler lease",
      mutate: (value) => {
        value.scheduler.state = "dispatch_pending";
        value.scheduler.dispatch = {
          dispatchId: "dispatch-pending", goalId: value.goalId, epoch: value.epoch,
          revision: value.revision, runId: "run-pending", createdAt: 1_100,
        };
      },
      reason: "scheduler_lease",
    },
    { name: "busy runtime", environment: { idle: false }, reason: "runtime_busy" },
    { name: "unknown runtime", environment: { idle: undefined }, reason: "runtime_busy" },
    { name: "pending queue", environment: { pendingMessages: true }, reason: "pending_messages" },
    { name: "unknown queue", environment: { pendingMessages: undefined }, reason: "pending_messages" },
    {
      name: "run budget",
      mutate: (value) => { value.budgets.epochRuns = value.budgets.maxEpochRuns; },
      reason: "epoch_budget",
    },
    { name: "unknown time", environment: { now: undefined }, reason: "time_unknown" },
    { name: "elapsed budget boundary", environment: { now: 2_000 }, reason: "elapsed_budget" },
  ];

  for (const fixture of cases) {
    const checkpoint = structuredClone(base);
    fixture.mutate?.(checkpoint);
    const actual = evaluateDispatchEligibility(checkpoint, { ...environment, ...fixture.environment });
    assert.deepEqual(actual, { eligible: false, reason: fixture.reason }, fixture.name);
  }
});

test("proactive compaction observes exact thresholds and never retriggers for tokens: null", () => {
  assert.deepEqual(
    evaluateProactiveCompaction({ tokens: null, contextWindow: 100_000, percent: 99 }),
    { compact: false },
  );
  assert.equal(evaluateProactiveCompaction({ tokens: 67_999, contextWindow: 100_000 }).compact, false);
  assert.deepEqual(
    evaluateProactiveCompaction({ tokens: 68_000, contextWindow: 100_000 }),
    { compact: true, reason: "soft_watermark", ratio: 0.68, headroom: 32_000 },
  );
  assert.equal(
    evaluateProactiveCompaction({ tokens: 84_000, contextWindow: 100_000 }, { softWatermark: 90 }).compact,
    true,
    "the minimum-headroom boundary independently triggers",
  );
  assert.deepEqual(
    evaluateProactiveCompaction(
      { tokens: 50_000, contextWindow: 100_000 },
      { softWatermark: 0.9, minHeadroomTokens: 0, phaseFinished: true },
    ),
    { compact: true, reason: "phase_finished", ratio: 0.5, headroom: 50_000 },
  );

  const leased = checkpointInFlight();
  assert.equal(
    evaluateProactiveCompaction(
      { tokens: 90_000, contextWindow: 100_000 },
      { checkpoint: leased },
    ).compact,
    false,
    "active scheduler leases suppress compaction",
  );
});

test("evidence requires a successful correlated tool result and criteria require verified evidence", () => {
  const ok = evidence("e-ok", "criterion-ok", "tool:call-ok");
  const nonzero = evidence("e-nonzero", "criterion-nonzero", "tool:call-nonzero");
  const errored = evidence("e-error", "criterion-error", "tool:call-error");
  const checkpointResult = evidence("e-checkpoint", "criterion-checkpoint", "tool:call-checkpoint");
  const missing = evidence("e-missing", "criterion-missing", "assistant-prose");
  const outsideRun = evidence("e-outside", "criterion-outside", "tool:call-outside");
  const uncorrelated = evidence("e-other-run", "criterion-other", "tool:call-ok", "run-other");

  const branch = [
    control(),
    assistant("assistant-tools", [
      { type: "toolCall", id: "call-ok", name: "bash", arguments: { command: "npm test" } },
      { type: "toolCall", id: "call-nonzero", name: "bash", arguments: { command: "npm run broken" } },
      { type: "toolCall", id: "call-error", name: "read", arguments: { path: "missing" } },
      { type: "toolCall", id: "call-checkpoint", name: GOAL_CHECKPOINT_TOOL, arguments: {} },
    ]),
    toolResult("result-ok", "call-ok", "bash", { exitCode: 0 }),
    toolResult("result-nonzero", "call-nonzero", "bash", { exitCode: 1 }),
    toolResult("result-error", "call-error", "read", { isError: true }),
    toolResult("result-checkpoint", "call-checkpoint", GOAL_CHECKPOINT_TOOL),
    assistant("assistant-prose", [{ type: "text", text: "I claim everything passed" }]),
    control("control-other", { ...controlDetails, runId: "run-next", dispatchId: "dispatch-next" }),
    assistant("assistant-outside", [
      { type: "toolCall", id: "call-outside", name: "bash", arguments: { command: "npm test" } },
    ]),
    toolResult("result-outside", "call-outside", "bash", { exitCode: 0 }),
  ];
  const reconciliation = reconcileSuccessfulEvidence(
    [ok, nonzero, errored, checkpointResult, missing, outsideRun, uncorrelated],
    branch,
    { goalId: controlDetails.goalId },
  );
  assert.deepEqual(reconciliation.verified.map(({ evidence: item }) => item.id), ["e-ok"]);
  assert.deepEqual(
    Object.fromEntries(reconciliation.rejected.map(({ evidence: item, reason }) => [item.id, reason])),
    {
      "e-nonzero": "tool_failed",
      "e-error": "tool_failed",
      "e-checkpoint": "checkpoint_is_not_evidence",
      "e-missing": "source_missing",
      "e-outside": "source_missing",
      "e-other-run": "uncorrelated_run",
    },
  );

  const supported: GoalCriterion = {
    id: "criterion-ok",
    description: "Successful tests exist",
    status: "pending",
    evidenceIds: ["e-ok"],
  };
  const unsupportedButClaimed: GoalCriterion = {
    id: "criterion-claimed",
    description: "A prose claim is not proof",
    status: "satisfied",
  };
  assert.equal(areCriteriaVerifiablySatisfied([supported], reconciliation), true);
  assert.equal(areCriteriaVerifiablySatisfied([supported, unsupportedButClaimed], reconciliation), false);
  assert.equal(
    areCriteriaVerifiablySatisfied([supported, unsupportedButClaimed], reconciliation, {
      explicitlyAcceptedCriterionIds: ["criterion-claimed"],
    }),
    true,
  );

  const checkpoint = createInitialCheckpoint("Verify all criteria", {
    now: 100,
    goalId: controlDetails.goalId,
    eventId: "event-criteria",
    acceptanceCriteria: [supported],
  });
  checkpoint.phases = [{
    id: "phase-criteria",
    title: "Criteria",
    intent: "Verify phase criteria",
    status: "running",
    dependencies: [],
    criteria: [unsupportedButClaimed],
  }];
  checkpoint.activePhaseId = "phase-criteria";
  assert.equal(areAllCriteriaVerifiablySatisfied(checkpoint, reconciliation), false);
  assert.equal(
    areAllCriteriaVerifiablySatisfied(checkpoint, reconciliation, {
      explicitlyAcceptedCriterionIds: ["criterion-claimed"],
    }),
    true,
  );
});

test("evidence kind semantics and artifact verification are fail-closed", () => {
  const branch = [
    control(),
    assistant("assistant-read", [
      { type: "toolCall", id: "call-read", name: "read", arguments: { path: "package.json" } },
    ]),
    toolResult("result-read", "call-read", "read"),
  ];
  const fakeTest = evidence("e-fake-test", "criterion-test", "tool:call-read");
  const rejected = reconcileSuccessfulEvidence([fakeTest], branch, { goalId: controlDetails.goalId });
  assert.equal(rejected.verified.length, 0);
  assert.equal(rejected.rejected[0]?.reason, "tool_failed");

  const artifactEvidence: GoalEvidence = {
    id: "e-artifact",
    criterionId: "criterion-artifact",
    kind: "artifact",
    description: "A report exists",
    locator: "artifact:artifact-report",
    observedAt: 120,
    runId: controlDetails.runId,
    digest: "sha256:report",
  };
  const artifact = {
    id: "artifact-report",
    path: "/tmp/report.json",
    digest: "sha256:report",
    createdAt: 120,
    runId: controlDetails.runId,
  };
  assert.equal(reconcileSuccessfulEvidence([artifactEvidence], branch, {
    goalId: controlDetails.goalId,
    artifacts: [artifact],
  }).verified.length, 0, "model-style artifact references are not observations");
  assert.equal(reconcileSuccessfulEvidence([artifactEvidence], branch, {
    goalId: controlDetails.goalId,
    artifacts: [{ ...artifact, verified: true }],
  }).verified.length, 1, "an adapter-observed digest may support evidence");
});

test("interrupted rendering stays compact and makes reconciliation explicit with unknown context", () => {
  const checkpoint = createInitialCheckpoint("Recover interrupted work", {
    now: 100,
    goalId: "goal-interrupted",
    eventId: "event-interrupted",
  });
  checkpoint.lifecycle = "paused";
  checkpoint.pauseReason = "interrupted";
  checkpoint.scheduler.state = "recovery_required";
  delete checkpoint.ledger.nextAction;

  assert.equal(isInterruptedGoal(checkpoint), true);
  assert.equal(
    getGoalNextAction(checkpoint),
    "Reconcile current files, git state, and evidence before repeating work.",
  );
  const status = formatGoalStatusLine(checkpoint, {
    contextUsage: { tokens: null, contextWindow: 128_000, percent: 95 },
  });
  assert.match(status, /🎯 interrupted/);
  assert.match(status, /ctx \?/);

  const lines = formatGoalWidgetLines(checkpoint, {
    maxWidth: 100,
    contextUsage: { tokens: null, contextWindow: 128_000 },
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /🎯 interrupted/);
  assert.match(lines[0]!, /reconcile: Reconcile current files/);
  assert.ok(lines.every((line) => Array.from(line).length <= 100));
});

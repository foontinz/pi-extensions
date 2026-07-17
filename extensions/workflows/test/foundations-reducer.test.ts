import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowAgentRecord, WorkflowFailure } from "../core/contracts.js";
import { emptyWorkflowUsage } from "../core/contracts.js";
import { assertWorkflowRunInvariants, createWorkflowRunRecord, reduceWorkflowEvent, WorkflowInvariantError } from "../core/reducer.js";

const failure: WorkflowFailure = { kind: "runtime", message: "boom" };
const queued = (index: number): WorkflowAgentRecord => ({
  index, label: `agent-${index}`, status: "queued", attempt: 0, maxRetries: 2, queuedAt: 2,
});

function startedRecord() {
  const created = createWorkflowRunRecord({ id: "run-1", input: { source: { kind: "inline", script: "return 1" } }, createdAt: 1 });
  return reduceWorkflowEvent(created, { type: "RunStarted" }, { now: 2 }).next;
}

test("reducer is pure and follows the explicit lifecycle", () => {
  const running = startedRecord();
  const before = structuredClone(running);
  const queuedTransition = reduceWorkflowEvent(running, { type: "AgentQueued", agent: queued(0) }, { now: 3 });
  assert.deepEqual(running, before);
  assert.equal(queuedTransition.next.agents[0]?.status, "queued");
  assert.equal(queuedTransition.next.nextEventSequence, running.nextEventSequence + 1);

  const active = reduceWorkflowEvent(queuedTransition.next, { type: "AgentStarted", index: 0, attempt: 1 }, { now: 4 }).next;
  assert.equal(active.agents[0]?.startedAt, 4);
  const done = reduceWorkflowEvent(active, {
    type: "AgentCompleted",
    index: 0,
    result: { index: 0, output: { ok: true }, usage: { ...emptyWorkflowUsage(), input: 2, contextTokens: 7 } },
  }, { now: 5 }).next;
  assert.equal(done.usage.input, 2);

  const stopping = reduceWorkflowEvent(done, { type: "CompletionRequested" }, { now: 6 }).next;
  assert.equal(stopping.status, "stopping");
  const terminal = reduceWorkflowEvent(stopping, { type: "RunFinalized" }, { now: 7 }).next;
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.result?.finishedAt, 7);
  assert.doesNotThrow(() => assertWorkflowRunInvariants(terminal));
});

test("first terminal intent wins all stop/timeout/completion races", () => {
  const running = startedRecord();
  const stopped = reduceWorkflowEvent(running, { type: "CancellationRequested", reason: "user" }, { now: 10 }).next;
  const timedOut = reduceWorkflowEvent(stopped, { type: "TimeoutElapsed", reason: "late" }, { now: 11 }).next;
  const completed = reduceWorkflowEvent(timedOut, { type: "CompletionRequested" }, { now: 12 }).next;
  assert.equal(completed.terminalIntent?.kind, "cancel");
  assert.equal(completed.terminalIntent?.reason, "user");
  assert.equal(reduceWorkflowEvent(completed, { type: "RunFinalized" }, { now: 13 }).next.status, "cancelled");

  const timeoutFirst = reduceWorkflowEvent(running, { type: "TimeoutElapsed" }, { now: 20 }).next;
  const ignoredStop = reduceWorkflowEvent(timeoutFirst, { type: "CancellationRequested", reason: "late" }, { now: 21 }).next;
  assert.equal(reduceWorkflowEvent(ignoredStop, { type: "RunFinalized" }, { now: 22 }).next.status, "failed");
});

test("terminal state is sticky and malformed records/budget breaches fail centrally", () => {
  const failed = reduceWorkflowEvent(startedRecord(), { type: "FailureRequested", failure }, { now: 3 }).next;
  const terminal = reduceWorkflowEvent(failed, { type: "RunFinalized" }, { now: 4 }).next;
  const late = reduceWorkflowEvent(terminal, { type: "RunStarted" }, { now: 5 });
  assert.equal(late.changed, false);
  assert.deepEqual(late.next.result, terminal.result);

  assert.throws(() => createWorkflowRunRecord({
    id: "too-wide", input: { source: { kind: "inline", script: "1" } }, budget: { maxConcurrency: 9 },
  }), WorkflowInvariantError);

  const corrupt = structuredClone(terminal);
  corrupt.status = "running";
  assert.throws(() => assertWorkflowRunInvariants(corrupt), WorkflowInvariantError);
});

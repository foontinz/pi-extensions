import assert from "node:assert/strict";
import test from "node:test";
import { AbsoluteDeadline, deadlineDelay } from "../runtime/deadline.js";

test("absolute deadline does not reset across queue/backoff slices", () => {
  const deadline = new AbsoluteDeadline(100, 1_000);
  assert.equal(deadline.remaining(1_025), 75);
  assert.equal(deadline.remaining(1_090), 10);
  assert.throws(() => deadline.throwIfElapsed(1_100), (error: any) => error?.code === "WORKFLOW_LEAF_DEADLINE");
});

test("deadline signal inherits parent cancellation", async () => {
  const parent = new AbortController();
  const linked = new AbsoluteDeadline(5_000).signal(parent.signal);
  parent.abort(new Error("parent stop"));
  assert.equal(linked.signal.aborted, true);
  assert.match(String(linked.signal.reason), /parent stop/);
  linked.dispose();
});

test("deadline delay refuses to sleep beyond remaining allowance", async () => {
  const deadline = new AbsoluteDeadline(15);
  const started = Date.now();
  await assert.rejects(deadlineDelay(10_000, deadline), (error: any) => error?.code === "WORKFLOW_LEAF_DEADLINE");
  assert.ok(Date.now() - started < 250);
});

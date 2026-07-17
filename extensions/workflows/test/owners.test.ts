import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowOwnerRegistry } from "../runtime/owners.js";

function context(id: string) {
  return { sessionManager: { getSessionId: () => id, getSessionFile: () => `/tmp/${id}.jsonl` } } as any;
}

test("owner registry binds contexts and scopes cancellation by durable session identity", () => {
  const registry = new WorkflowOwnerRegistry();
  const firstContext = context("first");
  const secondContext = context("second");
  const first = registry.bind(firstContext);
  const second = registry.bind(secondContext);
  const firstController = new AbortController();
  const secondController = new AbortController();
  registry.register({ runId: "a", owner: first, controller: firstController });
  registry.register({ runId: "b", owner: second, controller: secondController });

  assert.equal(registry.stop("b", first, "no"), false);
  assert.equal(secondController.signal.aborted, false);
  assert.equal(registry.stop("a", first, "stop"), true);
  assert.equal(firstController.signal.aborted, true);
  assert.deepEqual(registry.list(second).map((run) => run.runId), ["b"]);
  assert.equal(registry.matchingContext(second), secondContext);
});

test("session shutdown stops only that owner and stale unbind cannot erase replacement context", () => {
  const registry = new WorkflowOwnerRegistry();
  const oldContext = context("same");
  const nextContext = context("same");
  const owner = registry.bind(oldContext);
  registry.bind(nextContext);
  registry.unbind(oldContext);
  assert.equal(registry.matchingContext(owner), nextContext);

  const owned = new AbortController();
  const other = new AbortController();
  registry.register({ runId: "owned", owner, controller: owned });
  registry.register({ runId: "other", owner: registry.owner(context("other")), controller: other });
  assert.equal(registry.stopOwned(owner, "shutdown"), 1);
  assert.equal(owned.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
});

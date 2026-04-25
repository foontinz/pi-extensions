import assert from "node:assert/strict";
import test from "node:test";
import { JobActor } from "../../core/job-actor.js";
import type { JobRecord, JobTransition } from "../../core/types.js";
import { makeRecord } from "./helpers.js";

test("concurrent dispatches serialize through one per-job queue", async () => {
  const persisted: number[] = [];
  const actor = new JobActor(makeRecord({ phase: "running" }), {
    persist: async (record) => {
      await new Promise((resolve) => setTimeout(resolve, record.logCursor.nextSeq === 2 ? 20 : 0));
      persisted.push(record.logCursor.nextSeq);
    },
  });

  const [first, second] = await Promise.all([
    actor.dispatch({ type: "LogEntriesAppended", firstSeq: 1, count: 1 }, { now: 2_000 }),
    actor.dispatch({ type: "LogEntriesAppended", firstSeq: 2, count: 1 }, { now: 2_100 }),
  ]);

  assert.equal(first.logCursor.nextSeq, 2);
  assert.equal(second.logCursor.nextSeq, 3);
  assert.equal(actor.snapshot().logCursor.nextSeq, 3);
  assert.deepEqual(persisted, [2, 3]);
});

test("actor persists before committing memory", async () => {
  let snapshotDuringPersist: JobRecord | undefined;
  const actor = new JobActor(makeRecord({ phase: "running" }), {
    persist: async () => {
      snapshotDuringPersist = actor.snapshot();
    },
  });

  await actor.dispatch({ type: "LogEntriesAppended", firstSeq: 1, count: 1 }, { now: 2_000 });

  assert.equal(snapshotDuringPersist?.logCursor.nextSeq, 1);
  assert.equal(actor.snapshot().logCursor.nextSeq, 2);
});

test("persistence failure leaves snapshot unchanged and observers silent", async () => {
  let observed = 0;
  const actor = new JobActor(makeRecord({ phase: "running" }), {
    persist: async () => {
      throw new Error("disk full");
    },
  });
  actor.subscribe(() => observed++);

  await assert.rejects(
    actor.dispatch({ type: "LogEntriesAppended", firstSeq: 1, count: 1 }, { now: 2_000 }),
    /disk full/,
  );

  assert.equal(actor.snapshot().logCursor.nextSeq, 1);
  assert.equal(observed, 0);
});

test("observers see committed transitions and observer errors do not break dispatch", async () => {
  const actor = new JobActor(makeRecord({ phase: "running" }));
  const seen: JobTransition[] = [];
  actor.subscribe((transition) => {
    seen.push(transition);
    assert.equal(actor.snapshot().logCursor.nextSeq, transition.next.logCursor.nextSeq);
  });
  actor.subscribe(() => {
    throw new Error("observer failed");
  });

  const record = await actor.dispatch({ type: "LogEntriesAppended", firstSeq: 1, count: 1 }, { now: 2_000 });

  assert.equal(record.logCursor.nextSeq, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.next.logCursor.nextSeq, 2);
});

test("waiters resolve against committed snapshots and unregister", async () => {
  const actor = new JobActor(makeRecord({ phase: "running" }));
  const waiter = actor.waitFor((record) => record.phase === "draining", { timeoutMs: 1_000 });

  assert.equal(actor.waiterCount(), 1);
  await actor.dispatch({ type: "ChildExitObserved", exitCode: 0 }, { now: 2_000 });

  const resolved = await waiter;
  assert.equal(resolved.phase, "draining");
  assert.equal(actor.waiterCount(), 0);
});

test("waiters reject and unregister on abort", async () => {
  const actor = new JobActor(makeRecord({ phase: "running" }));
  const controller = new AbortController();
  const waiter = actor.waitFor((record) => record.phase === "completed", { signal: controller.signal });

  assert.equal(actor.waiterCount(), 1);
  controller.abort();
  await assert.rejects(waiter, /operation aborted/);
  assert.equal(actor.waiterCount(), 0);
});

test("effects are enqueued after committed transitions", async () => {
  const actor = new JobActor(makeRecord({ phase: "running" }));
  const observed: string[] = [];
  actor.subscribeEffects((effect) => observed.push(effect.type));

  await actor.dispatch({ type: "StopRequested", reason: "test" }, { now: 2_000 });

  assert.deepEqual(observed, ["supervisor-stop-requested"]);
  assert.deepEqual(actor.drainEffects(), [{ type: "supervisor-stop-requested", reason: "test" }]);
  assert.deepEqual(actor.drainEffects(), []);
});

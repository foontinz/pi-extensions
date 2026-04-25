import assert from "node:assert/strict";
import test from "node:test";
import { JobRegistry } from "../../core/job-registry.js";
import { makeRecord } from "./helpers.js";

test("registry upsert creates one actor and does not replace a live actor", () => {
  const registry = new JobRegistry();
  const first = registry.upsert(makeRecord({ id: "job-a", label: "first" }));
  first.runtime.pendingBuffers.stdout = "live buffer";

  const second = registry.upsert(makeRecord({ id: "job-a", label: "replacement" }));

  assert.equal(second, first);
  assert.equal(second.snapshot().label, "first");
  assert.equal(second.runtime.pendingBuffers.stdout, "live buffer");
});

test("registry hydrate parses records but preserves existing actors", () => {
  const registry = new JobRegistry();
  const existing = registry.upsert(makeRecord({ id: "job-a", label: "live" }));

  const [hydratedExisting, hydratedNew] = registry.hydrate([
    JSON.stringify(makeRecord({ id: "job-a", label: "from disk" })),
    JSON.stringify(makeRecord({ id: "job-b", label: "new" })),
  ]);

  assert.equal(hydratedExisting, existing);
  assert.equal(hydratedExisting?.snapshot().label, "live");
  assert.equal(hydratedNew?.snapshot().label, "new");
  assert.deepEqual(registry.ids(), ["job-a", "job-b"]);
});

test("registry dispatch delegates through the owning actor", async () => {
  const registry = new JobRegistry();
  registry.upsert(makeRecord({ id: "job-a", phase: "running" }));

  const record = await registry.dispatch("job-a", { type: "LogEntriesAppended", firstSeq: 1, count: 1 }, { now: 2_000 });

  assert.equal(record.logCursor.nextSeq, 2);
  assert.equal(registry.require("job-a").snapshot().logCursor.nextSeq, 2);
  assert.throws(() => registry.require("missing"), /unknown job missing/);
});

test("hydrated actors receive fresh runtime state", () => {
  const registry = new JobRegistry();
  const [first, second] = registry.hydrate([
    JSON.stringify(makeRecord({ id: "job-a" })),
    JSON.stringify(makeRecord({ id: "job-b" })),
  ]);

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.runtime.waiters, second.runtime.waiters);
  assert.equal(first.runtime.waiters.size, 0);
  assert.equal(second.runtime.pendingBuffers.stdout, "");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  hydrateJobRecord,
  hydrateRuntimeState,
  serializeJobRecord,
  stripRuntimeFieldsForPersistence,
  UnsupportedJobRecordSchemaError,
} from "../../core/hydration.js";
import { JobRecordHydrationError } from "../../core/invariants.js";
import { makeRecord } from "../core/helpers.js";

test("serialize and hydrate current compact JobRecord", () => {
  const record = makeRecord({ phase: "running", startedAt: 1_000 });
  const serialized = serializeJobRecord(record);
  const hydrated = hydrateJobRecord(serialized);

  assert.deepEqual(hydrated, record);
});

test("unsupported future schemas are reported", () => {
  assert.throws(
    () => hydrateJobRecord(JSON.stringify({ ...makeRecord(), schemaVersion: 999 })),
    UnsupportedJobRecordSchemaError,
  );
});

test("unknown compact-record fields are rejected during hydration", () => {
  assert.throws(
    () => hydrateJobRecord({ ...makeRecord(), logs: [] }),
    /\$\.logs is not a durable JobRecord field/,
  );
});

test("runtime-only fields are rejected during hydration", () => {
  assert.throws(
    () => hydrateJobRecord({ ...makeRecord(), waiters: [] }),
    JobRecordHydrationError,
  );
  assert.throws(
    () => hydrateJobRecord("{not json"),
    /failed to parse job record JSON/,
  );
});

test("stripRuntimeFieldsForPersistence removes runtime keys but rejects non-runtime collections", () => {
  const stripped = stripRuntimeFieldsForPersistence({
    id: "job",
    proc: { pid: 1 },
    nested: { waiters: new Set([1]), durable: true },
    values: [1, undefined, { timeout: 1, ok: "yes" }],
  });

  assert.deepEqual(stripped, {
    id: "job",
    nested: { durable: true },
    values: [1, null, { ok: "yes" }],
  });

  assert.throws(
    () => stripRuntimeFieldsForPersistence({ durableButBad: new Map() }),
    /runtime collection/,
  );
});

test("hydrateRuntimeState recreates fresh runtime handles", () => {
  const first = hydrateRuntimeState(makeRecord());
  const second = hydrateRuntimeState(makeRecord());

  assert.notEqual(first.waiters, second.waiters);
  assert.notEqual(first.pendingBuffers, second.pendingBuffers);
  assert.deepEqual(first.pendingBuffers, { stdout: "", stderr: "" });
});

test("schema-less pre-S2 records are rejected after S2 cutover", () => {
  assert.throws(
    () => hydrateJobRecord({ id: "pre-s2", status: "running", startedAt: 1_000, updatedAt: 1_000 }),
    /missing job record schemaVersion/,
  );
});

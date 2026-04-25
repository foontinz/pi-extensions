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
import { legacyJobToRecord, recordToLegacySnapshot } from "../../core/legacy-adapter.js";
import { makeRecord, terminalRecord, worktree } from "../core/helpers.js";

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

test("legacy adapter normalizes permissive legacy jobs to strict records", () => {
  const record = legacyJobToRecord({
    id: "legacy-1",
    label: "legacy",
    task: "task",
    cwd: "/repo/sub",
    sourceCwd: "/repo",
    status: "failed",
    supervisor: "tmux",
    tmuxSession: "pi-agent-1",
    startedAt: 1_000,
    updatedAt: 2_000,
    finishedAt: 2_000,
    errorMessage: "timed out",
    nextSeq: 0,
    stdoutOffset: -1,
    stderrOffset: 4,
    usage: { input: 10, output: -3, cacheRead: Number.NaN },
    worktree: { root: "/tmp/wt", keepWorktree: "onFailure" },
    cleanupPending: true,
  }, { fallbackCwd: "/fallback", now: 3_000 });

  assert.equal(record.schemaVersion, 1);
  assert.equal(record.phase, "failed");
  assert.equal(record.terminal?.reason, "timeout");
  assert.equal(record.logCursor.nextSeq, 1);
  assert.equal(record.logCursor.stdoutOffset, 0);
  assert.equal(record.logCursor.stderrOffset, 4);
  assert.equal(record.usage.input, 10);
  assert.equal(record.usage.output, 0);
  assert.equal(record.worktree?.postCopy?.length, 0);
  assert.equal(record.cleanupPhase, "pending");
  assert.equal(record.supervisorInfo?.tmuxSession, "pi-agent-1");
});

test("hydrate legacy records without process.cwd by using explicit fallback", () => {
  const record = hydrateJobRecord({
    id: "legacy-2",
    status: "running",
    startedAt: 1_000,
    updatedAt: 1_000,
  }, { fallbackCwd: "/explicit" });

  assert.equal(record.cwd, "/explicit");
  assert.equal(record.sourceCwd, "/explicit");
  assert.equal(record.phase, "running");
  assert.equal(record.logCursor.nextSeq, 1);
});

test("recordToLegacySnapshot preserves public legacy status mapping without runtime fields", () => {
  const cancelled = terminalRecord("cancelled");
  cancelled.worktree = worktree({ keepWorktree: "always", retained: true });
  cancelled.cleanupPhase = "retained";

  const legacy = recordToLegacySnapshot(cancelled, { includeEmptyLogs: true });

  assert.equal(legacy.status, "cancelled");
  assert.equal(legacy.cleanupPending, false);
  assert.equal(legacy.worktree?.retained, true);
  assert.deepEqual(legacy.logs, []);
  assert.equal("waiters" in legacy, false);
});

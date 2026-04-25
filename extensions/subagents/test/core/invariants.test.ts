import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDurableJobRecord,
  assertJobRecordInvariants,
  assertNoRuntimeFields,
  JobRecordHydrationError,
  JobRecordInvariantError,
  shouldRetainWorktree,
} from "../../core/invariants.js";
import { makeRecord, terminalRecord, worktree } from "./helpers.js";

test("terminal phase requires matching terminal info and no pending terminal", () => {
  assert.throws(
    () => assertJobRecordInvariants(makeRecord({ phase: "completed" })),
    /terminal phase must include terminal info/,
  );

  assert.throws(
    () => assertJobRecordInvariants({
      ...terminalRecord("completed"),
      terminal: { phase: "failed", reason: "natural-exit", finishedAt: 2_000 },
    }),
    /terminal\.phase must match job phase/,
  );

  assert.throws(
    () => assertJobRecordInvariants({
      ...terminalRecord("failed"),
      pendingTerminal: { reason: "timeout" },
    }),
    /terminal record cannot retain pendingTerminal/,
  );
});

test("non-terminal phase cannot have terminal info", () => {
  assert.throws(
    () => assertJobRecordInvariants({
      ...makeRecord({ phase: "running" }),
      terminal: { phase: "completed", reason: "natural-exit", finishedAt: 2_000 },
    }),
    /non-terminal phase cannot include terminal info/,
  );
});

test("cursors, sequence numbers, and usage must be non-negative and monotonic-ready", () => {
  assert.throws(
    () => assertJobRecordInvariants(makeRecord({ logCursor: { stdoutOffset: -1, stderrOffset: 0, nextSeq: 1 } })),
    /stdoutOffset/,
  );
  assert.throws(
    () => assertJobRecordInvariants(makeRecord({ logCursor: { stdoutOffset: 0, stderrOffset: 0, nextSeq: 0 } })),
    /nextSeq must be positive/,
  );
  assert.throws(
    () => assertJobRecordInvariants(makeRecord({ usage: { input: 0, output: -1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } })),
    /usage\.output/,
  );
});

test("unknown durable fields are rejected to keep JobRecord compact", () => {
  assert.throws(
    () => assertDurableJobRecord({ ...makeRecord(), logs: [] }),
    /\$\.logs is not a durable JobRecord field/,
  );
  assert.throws(
    () => assertDurableJobRecord({ ...makeRecord(), supervisorInfo: { kind: "tmux", rawStdout: "nope" } }),
    /supervisorInfo\.rawStdout is not a durable JobRecord field/,
  );
});

test("runtime-only fields and non-serializable runtime collections are rejected", () => {
  assert.throws(
    () => assertDurableJobRecord({ ...makeRecord(), waiters: [] }),
    JobRecordHydrationError,
  );
  assert.throws(
    () => assertNoRuntimeFields({ durable: true, nested: { supervisorHandle: { pid: 1 } } }),
    /runtime-only/,
  );
  assert.throws(
    () => assertNoRuntimeFields({ durable: true, nested: new Set() }),
    /runtime collection/,
  );

  const circular: Record<string, unknown> = { durable: true };
  circular.self = circular;
  assert.throws(
    () => assertNoRuntimeFields(circular),
    /circular or shared reference/,
  );
});

test("retained worktrees never enter cleanup running", () => {
  assert.equal(shouldRetainWorktree({ ...terminalRecord("failed"), worktree: worktree({ keepWorktree: "onFailure" }) }), true);
  assert.equal(shouldRetainWorktree({ ...terminalRecord("completed"), worktree: worktree({ keepWorktree: "onFailure" }) }), false);
  assert.equal(shouldRetainWorktree({ ...makeRecord({ phase: "running" }), worktree: worktree({ keepWorktree: "always" }) }), true);

  assert.throws(
    () => assertJobRecordInvariants({
      ...terminalRecord("failed"),
      cleanupPhase: "running",
      worktree: worktree({ keepWorktree: "always" }),
    }),
    /retained worktree cannot enter cleanup running/,
  );
});

test("invalid durable shapes fail with invariant errors", () => {
  assert.throws(
    () => assertJobRecordInvariants({ ...makeRecord(), schemaVersion: 999 }),
    JobRecordInvariantError,
  );
  assert.throws(
    () => assertJobRecordInvariants({ ...makeRecord(), updatedAt: 999 }),
    /updatedAt cannot be before createdAt/,
  );
});

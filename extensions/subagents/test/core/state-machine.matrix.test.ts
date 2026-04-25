import assert from "node:assert/strict";
import test from "node:test";
import { JobRecordInvariantError } from "../../core/invariants.js";
import { reduceJobEvent } from "../../core/state-machine.js";
import { makeRecord, reduceAll, terminalRecord, worktree } from "./helpers.js";

test("normal start path is explicit", () => {
  const created = makeRecord();

  const preparing = reduceJobEvent(created, { type: "PrepareRequested" }, { now: 1_100 });
  assert.equal(preparing.next.phase, "preparing");
  assert.equal(preparing.changed, true);

  const starting = reduceJobEvent(preparing.next, { type: "PrepareSucceeded", cwd: "/tmp/wt", worktree: worktree() }, { now: 1_200 });
  assert.equal(starting.next.phase, "starting");
  assert.equal(starting.next.cwd, "/tmp/wt");
  assert.equal(starting.next.worktree?.root, "/tmp/worktree");

  const running = reduceJobEvent(starting.next, { type: "SupervisorStarted", handle: { kind: "tmux", tmuxSession: "s" } }, { now: 1_300 });
  assert.equal(running.next.phase, "running");
  assert.equal(running.next.startedAt, 1_300);
  assert.equal(running.next.supervisorInfo?.tmuxSession, "s");
  assert.deepEqual(running.effects, []);
});

test("out-of-order startup events are explicit no-ops", () => {
  const created = makeRecord();
  assert.equal(reduceJobEvent(created, { type: "PrepareSucceeded", cwd: "/tmp" }, { now: 1_100 }).changed, false);
  assert.equal(reduceJobEvent(created, { type: "SupervisorStarted", handle: { kind: "tmux" } }, { now: 1_200 }).changed, false);
  assert.equal(reduceJobEvent(makeRecord({ phase: "preparing" }), { type: "SupervisorStarted", handle: { kind: "tmux" } }, { now: 1_300 }).changed, false);
});

test("prepare failure terminalizes directly because no child needs draining", () => {
  const transition = reduceJobEvent(makeRecord({ phase: "preparing" }), { type: "PrepareFailed", error: "copy failed" }, { now: 2_000 });

  assert.equal(transition.next.phase, "failed");
  assert.equal(transition.next.terminal?.reason, "prepare-failed");
  assert.equal(transition.next.terminal?.error, "copy failed");
  assert.equal(transition.effects[0]?.type, "terminal-entered");
});

test("natural exit drains before terminal success or failure", () => {
  const running = makeRecord({ phase: "running", startedAt: 1_000 });

  const observedSuccess = reduceJobEvent(running, { type: "ChildExitObserved", exitCode: 0 }, { now: 2_000 });
  assert.equal(observedSuccess.next.phase, "draining");
  assert.equal(observedSuccess.next.pendingTerminal?.reason, "natural-exit");
  assert.equal(observedSuccess.next.pendingTerminal?.exitCode, 0);

  const completed = reduceJobEvent(observedSuccess.next, { type: "DrainComplete" }, { now: 2_100 });
  assert.equal(completed.next.phase, "completed");
  assert.equal(completed.next.terminal?.reason, "natural-exit");
  assert.equal(completed.effects[0]?.type, "terminal-entered");

  const failed = reduceAll(running, [
    [{ type: "ChildExitObserved", exitCode: 2 }, { now: 3_000 }],
    [{ type: "DrainComplete" }, { now: 3_100 }],
  ]);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.terminal?.reason, "natural-exit");
  assert.equal(failed.terminal?.exitCode, 2);
});

test("stop before exit wins and terminalizes as cancelled only after drain", () => {
  const running = makeRecord({ phase: "running" });
  const stopping = reduceJobEvent(running, { type: "StopRequested", reason: "not needed" }, { now: 2_000 });

  assert.equal(stopping.next.phase, "stopping");
  assert.equal(stopping.next.pendingTerminal?.reason, "stop");
  assert.deepEqual(stopping.effects, [{ type: "supervisor-stop-requested", reason: "not needed" }]);

  const final = reduceAll(stopping.next, [
    [{ type: "ChildExitObserved", exitCode: 0 }, { now: 2_100 }],
    [{ type: "DrainComplete" }, { now: 2_200 }],
  ]);
  assert.equal(final.phase, "cancelled");
  assert.equal(final.terminal?.reason, "stop");
  assert.equal(final.terminal?.exitCode, 0);
});

test("exit before stop keeps natural terminal intent", () => {
  const final = reduceAll(makeRecord({ phase: "running" }), [
    [{ type: "ChildExitObserved", exitCode: 0 }, { now: 2_000 }],
    [{ type: "StopRequested", reason: "too late" }, { now: 2_100 }],
    [{ type: "DrainComplete" }, { now: 2_200 }],
  ]);

  assert.equal(final.phase, "completed");
  assert.equal(final.terminal?.reason, "natural-exit");
});

test("timeout before exit fails as timeout only after child exit and drain", () => {
  const timeout = reduceJobEvent(makeRecord({ phase: "running" }), { type: "TimeoutElapsed", message: "deadline" }, { now: 2_000 });

  assert.equal(timeout.next.phase, "stopping");
  assert.equal(timeout.next.pendingTerminal?.reason, "timeout");
  assert.equal(timeout.next.terminal, undefined);
  assert.deepEqual(timeout.effects, [{ type: "supervisor-timeout-kill-requested", reason: "deadline" }]);

  const final = reduceAll(timeout.next, [
    [{ type: "ChildExitObserved", exitCode: 0 }, { now: 2_100 }],
    [{ type: "DrainComplete" }, { now: 2_200 }],
  ]);
  assert.equal(final.phase, "failed");
  assert.equal(final.terminal?.reason, "timeout");
});

test("exit before timeout keeps natural terminal intent", () => {
  const final = reduceAll(makeRecord({ phase: "running" }), [
    [{ type: "ChildExitObserved", exitCode: 0 }, { now: 2_000 }],
    [{ type: "TimeoutElapsed", message: "too late" }, { now: 2_100 }],
    [{ type: "DrainComplete" }, { now: 2_200 }],
  ]);

  assert.equal(final.phase, "completed");
  assert.equal(final.terminal?.reason, "natural-exit");
});

test("stop/timeout race follows first-terminal-intent policy", () => {
  const stopping = reduceJobEvent(makeRecord({ phase: "running" }), { type: "StopRequested", reason: "user" }, { now: 2_000 }).next;
  const timeoutAfterStop = reduceJobEvent(stopping, { type: "TimeoutElapsed", message: "deadline" }, { now: 2_100 });
  assert.deepEqual(timeoutAfterStop.effects, [{ type: "supervisor-timeout-kill-requested", reason: "deadline" }]);

  const stopThenTimeout = reduceAll(timeoutAfterStop.next, [
    [{ type: "ChildExitObserved", exitCode: 137 }, { now: 2_200 }],
    [{ type: "DrainComplete" }, { now: 2_300 }],
  ]);
  assert.equal(stopThenTimeout.phase, "cancelled");
  assert.equal(stopThenTimeout.terminal?.reason, "stop");

  const timeoutThenStop = reduceAll(makeRecord({ phase: "running" }), [
    [{ type: "TimeoutElapsed", message: "deadline" }, { now: 2_000 }],
    [{ type: "StopRequested", reason: "user" }, { now: 2_100 }],
    [{ type: "ChildExitObserved", exitCode: 0 }, { now: 2_200 }],
    [{ type: "DrainComplete" }, { now: 2_300 }],
  ]);
  assert.equal(timeoutThenStop.phase, "failed");
  assert.equal(timeoutThenStop.terminal?.reason, "timeout");
});

test("duplicate lifecycle observations are idempotent and terminal metadata is sticky", () => {
  const draining = reduceJobEvent(makeRecord({ phase: "running" }), { type: "ChildExitObserved", exitCode: 0 }, { now: 2_000 }).next;
  const duplicateExit = reduceJobEvent(draining, { type: "ChildExitObserved", exitCode: 2, signal: "SIGTERM" }, { now: 2_100 }).next;
  assert.equal(duplicateExit.pendingTerminal?.exitCode, 0);
  assert.equal(duplicateExit.pendingTerminal?.signal, undefined);

  const completed = reduceJobEvent(duplicateExit, { type: "DrainComplete" }, { now: 2_200 }).next;
  const duplicateDrain = reduceJobEvent(completed, { type: "DrainComplete" }, { now: 2_300 });
  assert.equal(duplicateDrain.changed, false);

  const lateStop = reduceJobEvent(completed, { type: "StopRequested", reason: "late" }, { now: 2_400 });
  assert.equal(lateStop.next.phase, "completed");
  assert.deepEqual(lateStop.next.terminal, completed.terminal);
});

test("output cursors and log sequences are monotonic", () => {
  const running = makeRecord({ phase: "running" });
  const output = reduceJobEvent(running, { type: "OutputChunkRead", stream: "stdout", bytes: 10, offsetAfter: 10 }, { now: 2_000 }).next;
  assert.equal(output.logCursor.stdoutOffset, 10);
  assert.throws(
    () => reduceJobEvent(output, { type: "OutputChunkRead", stream: "stdout", bytes: 1, offsetAfter: 9 }, { now: 2_100 }),
    JobRecordInvariantError,
  );

  const logs = reduceJobEvent(output, { type: "LogEntriesAppended", firstSeq: 1, count: 2 }, { now: 2_200 }).next;
  assert.equal(logs.logCursor.nextSeq, 3);
  assert.equal(reduceJobEvent(logs, { type: "LogEntriesAppended", firstSeq: 1, count: 1 }, { now: 2_300 }).changed, false);
  assert.throws(
    () => reduceJobEvent(logs, { type: "LogEntriesAppended", firstSeq: 2, count: 2 }, { now: 2_350 }),
    /log append overlap/,
  );
  assert.throws(
    () => reduceJobEvent(logs, { type: "LogEntriesAppended", firstSeq: 5, count: 1 }, { now: 2_400 }),
    /log append gap/,
  );
});

test("late output after terminal may advance cursors without changing terminal metadata", () => {
  const completed = terminalRecord("completed");
  const transition = reduceJobEvent(completed, { type: "OutputChunkRead", stream: "stderr", bytes: 4, offsetAfter: 4 }, { now: 3_000 });

  assert.equal(transition.next.phase, "completed");
  assert.deepEqual(transition.next.terminal, completed.terminal);
  assert.equal(transition.next.logCursor.stderrOffset, 4);
});

test("cleanup retention is enforced centrally", () => {
  const failedWithRetainedWorktree = terminalRecord("failed");
  failedWithRetainedWorktree.worktree = worktree({ keepWorktree: "onFailure" });

  const retained = reduceJobEvent(failedWithRetainedWorktree, { type: "CleanupRequested" }, { now: 3_000 });
  assert.equal(retained.next.cleanupPhase, "retained");
  assert.equal(retained.next.worktree?.retained, true);
  assert.deepEqual(retained.effects, [{ type: "cleanup-retained" }]);

  const completedWithWorktree = terminalRecord("completed");
  completedWithWorktree.worktree = worktree({ keepWorktree: "onFailure" });
  const cleanup = reduceJobEvent(completedWithWorktree, { type: "CleanupRequested" }, { now: 3_100 });
  assert.equal(cleanup.next.cleanupPhase, "running");
  assert.deepEqual(cleanup.effects, [{ type: "cleanup-run-requested" }]);

  const done = reduceJobEvent(cleanup.next, { type: "CleanupSucceeded" }, { now: 3_200 });
  assert.equal(done.next.cleanupPhase, "complete");
});

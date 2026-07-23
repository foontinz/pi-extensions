import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowLeafRecordV1, WorkflowTerminalIntentV1 } from "../core/contracts.js";
import { assertWorkflowRunInvariants, createWorkflowRunRecord, reduceWorkflowEvent, WorkflowInvariantError } from "../core/reducer.js";

const runId = "11111111-1111-4111-8111-111111111111";
const hash = "a".repeat(64);
function created() {
  return createWorkflowRunRecord({
    runId,
    owner: { sessionId: "s", instanceId: "i", parentPid: 1 },
    source: { kind: "inline", copiedPath: `/runs/${runId}/script.js`, sourceDirectory: "/tmp", sha256: hash, resolverIdentity: `inline:${hash}` },
    metadata: { name: "test", description: "test", resumable: false, maxAgents: 4, capabilities: ["read"] },
    args: { value: 1 }, argsSha256: hash, executionFingerprint: hash, activationIdentity: hash,
    deadlineAt: 1000, cleanupDeadlineAt: 1100, createdAt: 1,
  });
}
function running() {
  return reduceWorkflowEvent(created(), {
    type: "RunStarted",
    attempt: { attemptId: "attempt-1", runId, startedAt: 2, status: "running" },
  }, { now: 2 }).next;
}
function leaf(): WorkflowLeafRecordV1 {
  return {
    leafId: "leaf-1", nodeId: "root/agent:scan", agentId: "scan", status: "queued", acceptedAt: 3, deadlineAt: 100,
    effects: "none", cachePolicy: "off", executionFingerprint: hash, artifactIds: [],
  };
}

test("run and leaf transitions are pure, revisioned, and terminalize every accepted leaf", () => {
  const base = running();
  const accepted = reduceWorkflowEvent(base, { type: "LeafAccepted", leaf: leaf() }, { now: 3 });
  assert.equal(base.leaves.length, 0);
  assert.equal(accepted.next.recordRevision, base.recordRevision + 1);
  const active = reduceWorkflowEvent(accepted.next, { type: "LeafStatusChanged", leafId: "leaf-1", status: "running", at: 4 }, { now: 4 }).next;
  const done = reduceWorkflowEvent(active, { type: "LeafStatusChanged", leafId: "leaf-1", status: "completed", at: 5, result: { answer: 42 } }, { now: 5 }).next;
  const intent: WorkflowTerminalIntentV1 = { kind: "complete", requestedAt: 6 };
  const draining = reduceWorkflowEvent(done, { type: "TerminalIntentAccepted", intent }, { now: 6 }).next;
  const terminal = reduceWorkflowEvent(draining, { type: "RunStatusChanged", status: "completed" }, { now: 7 }).next;
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.finishedAt, 7);
  assert.doesNotThrow(() => assertWorkflowRunInvariants(terminal));
});

test("first terminal intent wins and terminal status is sticky", () => {
  const base = running();
  const cancel = reduceWorkflowEvent(base, { type: "TerminalIntentAccepted", intent: { kind: "cancel", requestedAt: 3, reason: "user" } }, { now: 3 }).next;
  const late = reduceWorkflowEvent(cancel, { type: "TerminalIntentAccepted", intent: { kind: "fail", requestedAt: 4 } }, { now: 4 }).next;
  assert.deepEqual(late.firstTerminalIntent, cancel.firstTerminalIntent);
  const terminal = reduceWorkflowEvent(late, { type: "RunStatusChanged", status: "cancelled" }, { now: 5 }).next;
  assert.equal(reduceWorkflowEvent(terminal, { type: "RunStatusChanged", status: "completed" }, { now: 6 }).next.status, "cancelled");
});

test("cleanup can upgrade terminal outcome without erasing original intent", () => {
  const intent = reduceWorkflowEvent(running(), { type: "TerminalIntentAccepted", intent: { kind: "complete", requestedAt: 3 } }, { now: 3 }).next;
  const complete = reduceWorkflowEvent(intent, { type: "RunStatusChanged", status: "completed" }, { now: 4 }).next;
  const error = { kind: "infrastructure" as const, code: "CLEANUP", message: "capture failed" };
  const upgraded = reduceWorkflowEvent(complete, { type: "CleanupChanged", cleanup: { status: "recovery_required", deadlineAt: 100, finishedAt: 5, error } }, { now: 5 }).next;
  assert.equal(upgraded.status, "recovery_required");
  assert.equal(upgraded.firstTerminalIntent?.kind, "complete");
});

test("workspace artifact lifecycle is monotonic and explicit", () => {
  const verified = reduceWorkflowEvent(running(), {
    type: "ArtifactRecorded",
    artifact: {
      artifactId: "artifact-1",
      kind: "workspace",
      path: "/artifacts/manifest.json",
      sha256: hash,
      bytes: 100,
      state: "verified",
      createdAt: 3,
    },
  }, { now: 3 }).next;
  const explicitlyReleased = reduceWorkflowEvent(verified, { type: "ArtifactStateChanged", artifactId: "artifact-1", state: "released" }, { now: 4 }).next;
  assert.equal(explicitlyReleased.artifacts[0]?.state, "released");
  const applied = reduceWorkflowEvent(verified, { type: "ArtifactStateChanged", artifactId: "artifact-1", state: "applied" }, { now: 4 }).next;
  assert.equal(applied.artifacts[0]?.state, "applied");
  const released = reduceWorkflowEvent(applied, { type: "ArtifactStateChanged", artifactId: "artifact-1", state: "released" }, { now: 5 }).next;
  assert.equal(released.artifacts[0]?.state, "released");
  assert.throws(() => reduceWorkflowEvent(released, { type: "ArtifactStateChanged", artifactId: "artifact-1", state: "applied" }, { now: 6 }), /invalid artifact transition/);
  assert.throws(() => reduceWorkflowEvent(verified, { type: "ArtifactStateChanged", artifactId: "missing", state: "released" }, { now: 6 }), /unknown artifact/);
});

test("notification delivery cannot alter execution outcome", () => {
  const base = running();
  const changed = reduceWorkflowEvent(base, { type: "NotificationChanged", notification: { state: "failed", attempts: 1, updatedAt: 3, lastError: "offline" } }, { now: 3 }).next;
  assert.equal(changed.status, "running");
  assert.equal(changed.notification.state, "failed");
});

test("leaf identities remain unique", () => {
  const accepted = reduceWorkflowEvent(running(), { type: "LeafAccepted", leaf: leaf() }, { now: 3 }).next;
  assert.throws(() => reduceWorkflowEvent(accepted, { type: "LeafAccepted", leaf: { ...leaf(), leafId: "other", nodeId: "other" } }, { now: 3 }), /duplicate.*agent/i);
});

test("terminalization rejects unsettled leaves and future/invalid records", () => {
  const accepted = reduceWorkflowEvent(running(), { type: "LeafAccepted", leaf: leaf() }, { now: 3 }).next;
  assert.throws(() => reduceWorkflowEvent(accepted, { type: "RunStatusChanged", status: "failed" }, { now: 4 }), WorkflowInvariantError);
  assert.throws(() => assertWorkflowRunInvariants({ ...created(), schemaVersion: 999 }), /unsupported/);
});

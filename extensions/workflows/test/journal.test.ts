import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createWorkflowRunRecord } from "../core/reducer.js";
import { WorkflowRunStore } from "../core/run-store.js";
import { claimWorkflowResume, WorkflowJournal } from "../resume/journal.js";

const runId = "33333333-3333-4333-8333-333333333333";
const hash = "a".repeat(64);
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-journal-"));
  const store = new WorkflowRunStore(path.join(root, "runs"));
  const source = "source";
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const record = createWorkflowRunRecord({
    runId, owner: { sessionId: "s", instanceId: "i", parentPid: 1 },
    source: { kind: "inline", copiedPath: store.paths(runId, true).script, sourceDirectory: root, sha256: sourceHash, resolverIdentity: `inline:${sourceHash}` },
    metadata: { name: "x", description: "x", resumable: true, maxAgents: 1, capabilities: ["read"] },
    args: null, argsSha256: hash, executionFingerprint: hash, activationIdentity: hash, deadlineAt: 100, cleanupDeadlineAt: 200,
  });
  await store.createRun(record, source);
  return { root, store, journal: new WorkflowJournal(store) };
}

test("journal records are checksummed, monotonic, and build pure replay cache", async () => {
  const value = await fixture();
  try {
    await value.journal.append(runId, { sequence: 1, attemptId: "a", nodeId: "root/agent:x", type: "node-intent", payload: { fingerprint: hash } });
    await value.journal.append(runId, { sequence: 2, attemptId: "a", nodeId: "root/agent:x", type: "node-result", payload: { fingerprint: hash, cachePolicy: "pure", result: { answer: 1 } } });
    const records = await value.journal.recover(runId);
    assert.equal(records.length, 2);
    assert.deepEqual(value.journal.replayIndex(records).get("root/agent:x")?.result, { answer: 1 });
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("one torn final record is truncated but interior corruption is rejected", async () => {
  const value = await fixture();
  try {
    await value.journal.append(runId, { sequence: 1, attemptId: "a", nodeId: "x", type: "node-intent", payload: null });
    const file = value.store.paths(runId, true).journal!;
    await fs.appendFile(file, "{torn");
    assert.equal((await value.journal.recover(runId)).length, 1);
    await fs.writeFile(file, `{bad}\n${await fs.readFile(file, "utf8")}`);
    await assert.rejects(value.journal.recover(runId), /interior journal corruption/);
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

test("resume claims reject concurrent claimants and release idempotently", async () => {
  const value = await fixture();
  try {
    const release = await claimWorkflowResume(value.store, runId);
    await assert.rejects(claimWorkflowResume(value.store, runId), /active resume claim/);
    await release(); await release();
    const releaseAgain = await claimWorkflowResume(value.store, runId);
    await releaseAgain();
  } finally { await fs.rm(value.root, { recursive: true, force: true }); }
});

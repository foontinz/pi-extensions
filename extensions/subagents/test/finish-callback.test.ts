import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { __subagentsTest } from "../index.js";

function makeFinishedJob(overrides: Record<string, unknown> = {}) {
  const id = `agent_callback_test_${process.pid}_${Math.random().toString(16).slice(2)}`;
  return {
    id,
    label: "reviewer",
    task: "review code",
    cwd: "/repo",
    sourceCwd: "/repo",
    command: "pi",
    args: [],
    startedAt: Date.now() - 2_000,
    updatedAt: Date.now(),
    finishedAt: Date.now(),
    status: "completed",
    exitCode: 0,
    messageCount: 1,
    logs: [],
    nextSeq: 1,
    stderr: "",
    stdoutBuffer: "",
    stderrBuffer: "",
    latestAssistantText: "Looks good.",
    pendingAssistantDelta: "",
    lastAssistantDeltaLogAt: 0,
    finalOutput: "Looks good.",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    supervisor: "tmux",
    stdoutOffset: 0,
    stderrOffset: 0,
    waiters: new Set(),
    closeWaiters: new Set(),
    ...overrides,
  } as any;
}

function makeHarness(isIdle: boolean, hasUI = true, sendError?: Error) {
  const sent: Array<{ content: string; options: unknown }> = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const api = {
    sendUserMessage(content: string, options?: unknown) {
      if (sendError) throw sendError;
      sent.push({ content, options });
    },
  } as any;
  const ctx = {
    hasUI,
    isIdle: () => isIdle,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  } as any;
  return { api, ctx, sent, notifications };
}

test("finish callback sends a follow-up user message when the main agent is idle", () => {
  const job = makeFinishedJob();
  const harness = makeHarness(true);
  try {
    __subagentsTest.setCallbackHarness(harness.api, harness.ctx);

    __subagentsTest.notifyMainAgentOfFinishedJob(job);

    assert.equal(harness.sent.length, 1);
    assert.deepEqual(harness.sent[0]!.options, { deliverAs: "followUp" });
    assert.match(harness.sent[0]!.content, /^\[subagent-finished\]/);
    assert.match(harness.sent[0]!.content, /Status: completed/);
    assert.match(harness.sent[0]!.content, /Looks good\./);
  } finally {
    __subagentsTest.removeCallbackMarker(job.id);
    __subagentsTest.setCallbackHarness(undefined, undefined);
  }
});

test("finish callback queues as follow-up while the main agent is busy and deduplicates by marker", () => {
  const job = makeFinishedJob();
  const harness = makeHarness(false);
  try {
    __subagentsTest.setCallbackHarness(harness.api, harness.ctx);

    __subagentsTest.notifyMainAgentOfFinishedJob(job);
    __subagentsTest.notifyMainAgentOfFinishedJob(job);

    assert.equal(harness.sent.length, 1);
    assert.deepEqual(harness.sent[0]!.options, { deliverAs: "followUp" });
  } finally {
    __subagentsTest.removeCallbackMarker(job.id);
    __subagentsTest.setCallbackHarness(undefined, undefined);
  }
});

test("finish callback is suppressed when no interactive UI context is available", () => {
  const job = makeFinishedJob();
  const harness = makeHarness(true, false);
  try {
    __subagentsTest.setCallbackHarness(harness.api, harness.ctx);

    __subagentsTest.notifyMainAgentOfFinishedJob(job);

    assert.equal(harness.sent.length, 0);
    assert.equal(fs.existsSync(__subagentsTest.callbackMarkerPath(job.id)), false);
  } finally {
    __subagentsTest.removeCallbackMarker(job.id);
    __subagentsTest.setCallbackHarness(undefined, undefined);
  }
});

test("finish callback removes marker when delivery fails so a later attempt can retry", () => {
  const job = makeFinishedJob();
  const failingHarness = makeHarness(true, true, new Error("busy race"));
  const retryHarness = makeHarness(true);
  try {
    __subagentsTest.setCallbackHarness(failingHarness.api, failingHarness.ctx);
    __subagentsTest.notifyMainAgentOfFinishedJob(job);

    assert.equal(failingHarness.sent.length, 0);
    assert.equal(fs.existsSync(__subagentsTest.callbackMarkerPath(job.id)), false);
    assert.equal(failingHarness.notifications.at(-1)?.type, "error");

    __subagentsTest.setCallbackHarness(retryHarness.api, retryHarness.ctx);
    __subagentsTest.notifyMainAgentOfFinishedJob(job);
    assert.equal(retryHarness.sent.length, 1);
  } finally {
    __subagentsTest.removeCallbackMarker(job.id);
    __subagentsTest.setCallbackHarness(undefined, undefined);
  }
});

test("removing persisted job files also removes the callback marker", () => {
  const job = makeFinishedJob();
  const harness = makeHarness(true);
  try {
    __subagentsTest.setCallbackHarness(harness.api, harness.ctx);
    __subagentsTest.notifyMainAgentOfFinishedJob(job);

    assert.equal(Boolean(__subagentsTest.callbackMarkerPath(job.id)), true);
    __subagentsTest.removePersistedJobFiles(job.id);

    assert.equal(harness.sent.length, 1);
    // A second notification would only be deduped if the marker still existed.
    __subagentsTest.notifyMainAgentOfFinishedJob(job);
    assert.equal(harness.sent.length, 2);
  } finally {
    __subagentsTest.removeCallbackMarker(job.id);
    __subagentsTest.setCallbackHarness(undefined, undefined);
  }
});

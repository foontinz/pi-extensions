import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import type { UsageStats } from "../../subagents/core/types.js";
import { isNotifiableWorkflowStatus, retryPendingNotifications, workflowUsageStats } from "../index.js";
import { renderWorkflowNotification, type WorkflowNotificationDetails } from "../ui/notification.js";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_role: string, text: string) => text,
};

const usage: UsageStats = { input: 3487, output: 376, cacheRead: 0, cacheWrite: 0, cost: 0.21, contextTokens: 0, turns: 5 };
const content = "<workflow-notification>\nWorkflow 97e85be8 completed.\nagents: 5, failures: 0\n</workflow-notification>";

function lines(c: Component): string {
  return c.render(120).join("\n");
}

test("collapsed notification is a single summary line without the raw body", () => {
  const details: WorkflowNotificationDetails = { runId: "97e85be8", status: "completed", agents: 5, failures: 0, usage };
  const text = lines(renderWorkflowNotification(details, content, false, theme));
  assert.equal(text.split("\n").length, 1);
  assert.match(text, /✓ Workflow 97e85be8 completed/);
  assert.match(text, /5 agents/);
  assert.match(text, /↑3.5k ↓376/);
  assert.doesNotMatch(text, /workflow-notification/);
});

test("expanded notification includes the body", () => {
  const details: WorkflowNotificationDetails = { runId: "97e85be8", status: "completed", agents: 5, failures: 0, usage };
  const text = lines(renderWorkflowNotification(details, content, true, theme));
  assert.match(text, /Workflow 97e85be8 completed\./);
  assert.match(text, /agents: 5, failures: 0/);
  assert.doesNotMatch(text, /<workflow-notification>/);
});

test("paused runs are notification-eligible and unknown cost is not fabricated as zero", () => {
  assert.equal(isNotifiableWorkflowStatus("paused"), true);
  assert.equal(isNotifiableWorkflowStatus("running"), false);
  const base = {
    input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costState: "unavailable",
    contextTokens: 3, turns: 1, structuredSubmissions: 0, leafAttempts: 0, cacheHits: 0,
  };
  const unknown = workflowUsageStats({ usage: { ...base, cost: null } } as any);
  assert.equal(Object.hasOwn(unknown, "cost"), false);
  const unknownText = lines(renderWorkflowNotification({ runId: "unknown", status: "completed", usage: unknown }, "", false, theme));
  assert.doesNotMatch(unknownText, /\$/);

  const free = workflowUsageStats({ usage: { ...base, cost: 0, costState: "reported" } } as any);
  assert.equal(free.cost, 0);
  const freeText = lines(renderWorkflowNotification({ runId: "free", status: "completed", usage: free }, "", false, theme));
  assert.match(freeText, /\$0\.000/);
});

test("failed paused notifications retry for the matching owner without treating running runs as terminal", async () => {
  const base = {
    owner: { sessionId: "session" },
    leaves: [],
    failures: [],
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, costState: "unavailable",
      contextTokens: 0, turns: 0, structuredSubmissions: 0, leafAttempts: 0, cacheHits: 0,
    },
    notification: { state: "failed", attempts: 1, updatedAt: 1 },
  };
  const paused = { ...base, runId: "paused", status: "paused" };
  const running = { ...base, runId: "running", status: "running" };
  const other = { ...base, runId: "other", status: "paused", owner: { sessionId: "other" } };
  const delivered: any[] = [];
  const ctx = { isIdle: () => true } as any;
  const engine = {
    owners: {
      owner: () => ({ sessionId: "session" }),
      matchingContext: () => ctx,
    },
    store: { scan: async () => [paused, running, other].map((record) => ({ state: "ok", record })) },
    applyEvent: async (runId: string, event: unknown) => { delivered.push({ runId, event }); },
  } as any;
  const pi = { sendMessage: () => {} } as any;

  await retryPendingNotifications(pi, engine, ctx);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].runId, "paused");
  assert.equal(delivered[0].event.notification.state, "delivered");
  assert.equal(delivered[0].event.notification.attempts, 2);
});

test("failed notification shows the error and a red glyph", () => {
  const details: WorkflowNotificationDetails = { runId: "deadbeef", status: "failed", error: "boom" };
  const collapsed = lines(renderWorkflowNotification(details, "<workflow-notification>\nWorkflow deadbeef failed: boom\n</workflow-notification>", false, theme));
  assert.match(collapsed, /✗ Workflow deadbeef failed/);
  const expanded = lines(renderWorkflowNotification(details, "<workflow-notification>\nWorkflow deadbeef failed: boom\n</workflow-notification>", true, theme));
  assert.match(expanded, /boom/);
});

test("cancelled notification renders a distinct glyph and reason inline", () => {
  const details: WorkflowNotificationDetails = { runId: "beefcafe", status: "cancelled", error: "stopped by request" };
  const collapsed = lines(renderWorkflowNotification(details, "<workflow-notification>\nWorkflow beefcafe cancelled: stopped by request\n</workflow-notification>", false, theme));
  assert.equal(collapsed.split("\n").length, 1);
  assert.match(collapsed, /⊘ Workflow beefcafe cancelled/);
  assert.match(collapsed, /stopped by request/);
});

test("collapsed failure surfaces the error inline (visible in minimized mode)", () => {
  const details: WorkflowNotificationDetails = {
    runId: "deadbeef",
    status: "failed",
    error: "agent #0: worktree:true needs a git repository, but \"/tmp/x\" is not inside one.\nsecond line",
  };
  const collapsed = lines(renderWorkflowNotification(details, "<workflow-notification>\n...\n</workflow-notification>", false, theme));
  assert.equal(collapsed.split("\n").length, 1, "stays a single line");
  assert.match(collapsed, /worktree:true needs a git repository/);
  assert.doesNotMatch(collapsed, /second line/, "only the first line is shown");
});

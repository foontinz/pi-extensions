import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import type { UsageStats } from "../../subagents/core/types.js";
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

test("failed notification shows the error and a red glyph", () => {
  const details: WorkflowNotificationDetails = { runId: "deadbeef", status: "failed", error: "boom" };
  const collapsed = lines(renderWorkflowNotification(details, "<workflow-notification>\nWorkflow deadbeef failed: boom\n</workflow-notification>", false, theme));
  assert.match(collapsed, /✗ Workflow deadbeef failed/);
  const expanded = lines(renderWorkflowNotification(details, "<workflow-notification>\nWorkflow deadbeef failed: boom\n</workflow-notification>", true, theme));
  assert.match(expanded, /boom/);
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

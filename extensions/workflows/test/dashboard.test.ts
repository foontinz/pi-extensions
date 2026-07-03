import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { UsageStats } from "../../subagents/core/types.js";
import { WorkflowDashboard } from "../ui/dashboard.js";
import type { WorkflowSnapshot } from "../index.js";

const plainTheme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const usage: UsageStats = { input: 12300, output: 4100, cacheRead: 0, cacheWrite: 0, cost: 0.083, contextTokens: 0, turns: 9 };

function snap(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  const now = Date.now();
  return {
    runId: "a1b2c3d4",
    origin: "inline",
    startedAt: now - 42_000,
    status: "running",
    phase: "synthesize",
    phases: ["research", "synthesize"],
    active: 8,
    queued: 3,
    launched: 4,
    usage,
    failures: 1,
    rateLimited: false,
    agents: [
      { index: 0, label: "crawl-docs", phase: "research", status: "completed", attempt: 0, maxRetries: 2, startedAt: now - 30_000, finishedAt: now - 18_000 },
      { index: 1, label: "fetch-legacy", phase: "research", status: "failed", attempt: 2, maxRetries: 2, startedAt: now - 30_000, finishedAt: now - 5_000, reason: "timeout" },
      { index: 2, label: "summarize", phase: "synthesize", status: "running", attempt: 0, maxRetries: 2, startedAt: now - 3_000 },
      { index: 3, label: "verify", phase: "synthesize", status: "retrying", attempt: 1, maxRetries: 2, startedAt: now - 5_000 },
    ],
    ...overrides,
  };
}

test("every rendered line fits within the requested width", () => {
  for (const width of [40, 56, 76, 96, 120]) {
    const lines = new WorkflowDashboard(snap(), plainTheme, 3).render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
  }
});

test("running dashboard shows phase, counts, tokens and agent glyphs", () => {
  const text = new WorkflowDashboard(snap(), plainTheme, 0).render(76).join("\n");
  assert.match(text, /Workflow a1b2c3d4/);
  assert.match(text, /synthesize/);
  assert.match(text, /8 active/);
  assert.match(text, /3 queued/);
  assert.match(text, /↑12k ↓4.1k/);
  assert.match(text, /1 failed/);
  assert.match(text, /✓ crawl-docs/);
  assert.match(text, /✗ fetch-legacy/);
  assert.match(text, /↻ verify/);
  assert.match(text, /retry 1\/2/);
  assert.match(text, /timeout/);
});

test("completed dashboard replaces the phase with a status label", () => {
  const text = new WorkflowDashboard(snap({ status: "completed", phase: undefined }), plainTheme, 0).render(76).join("\n");
  assert.match(text, /✓ completed/);
  assert.doesNotMatch(text, /running/);
});

test("cancelled dashboard shows the cancelled glyph and label", () => {
  const text = new WorkflowDashboard(snap({ status: "cancelled", phase: undefined }), plainTheme, 0).render(76).join("\n");
  assert.match(text, /⊘ cancelled/);
});

test("collapses to a bounded number of agent rows", () => {
  const now = Date.now();
  const many = Array.from({ length: 20 }, (_, i) => ({
    index: i,
    label: `agent-${i}`,
    phase: "work",
    status: "running" as const,
    attempt: 0,
    maxRetries: 2,
    startedAt: now,
  }));
  const lines = new WorkflowDashboard(snap({ agents: many, launched: 20 }), plainTheme, 0).render(76);
  assert.ok(lines.some((l) => /… \d+ more/.test(l)), "should show an overflow indicator");
});

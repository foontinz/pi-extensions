import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import type { UsageStats } from "../../subagents/core/types.js";
import { createWorkflowView, type WorkflowSnapshot } from "../index.js";
import { WorkflowDashboard } from "../ui/dashboard.js";

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

test("renders a borderless header plus one row per agent", () => {
  const lines = new WorkflowDashboard(snap(), plainTheme, 0).render(110);
  assert.equal(lines.length, 1 + 4); // header + 4 agents, no box chrome
  assert.doesNotMatch(lines[0], /[╭╰│├]─/);
  assert.match(lines[0], /◆ {2}⠋ RUNNING {2}│ {2}WORKFLOW {2}PHASE 2\/2 {2}synthesize/);
  assert.match(lines[1], /^ {3}├─ /);
  assert.match(lines[4], /^ {3}└─ /);
});

test("a long runId never overflows when shown after finish", () => {
  const long = new WorkflowDashboard(
    snap({ runId: "a".repeat(80), status: "completed", phase: undefined, phases: [] }),
    plainTheme,
    0,
  ).render(60);
  for (const line of long) assert.ok(visibleWidth(line) <= 60, `overflow: ${JSON.stringify(line)}`);
});

test("phase remains visible at common narrow widths", () => {
  const header = new WorkflowDashboard(snap(), plainTheme, 0).render(76)[0];
  assert.match(header, /WORKFLOW {2}PHASE 2\/2/);
  assert.match(header, /RUN 1\/4/);
});

test("running dashboard shows phase, counts, tokens and agent glyphs", () => {
  const text = new WorkflowDashboard(snap(), plainTheme, 0).render(120).join("\n");
  assert.match(text, /WORKFLOW {2}PHASE 2\/2 {2}synthesize/);
  assert.match(text, /RUN 1\/4/);
  assert.match(text, /↑12k ↓4.1k/);
  assert.match(text, /1 FAILED/);
  assert.match(text, /✓ crawl-docs/);
  assert.match(text, /✗ fetch-legacy/);
  assert.match(text, /↻ verify/);
  assert.match(text, /retry 1\/2/);
  assert.match(text, /timeout/);
});

test("phase is shown only in the header, not repeated on agent rows", () => {
  const text = new WorkflowDashboard(snap(), plainTheme, 0).render(120).join("\n");
  assert.equal(text.match(/synthesize/g)?.length, 1);
  assert.doesNotMatch(text, /research/);
});

test("running rows show each agent's latest activity", () => {
  const current = snap();
  current.agents[2].activity = "→ read extensions/workflows/index.ts";
  const text = new WorkflowDashboard(current, plainTheme, 0).render(120).join("\n");
  assert.match(text, /summarize.*→ read extensions\/workflows\/index\.ts/);
});

test("agent activity strips terminal escape and control sequences", () => {
  const current = snap();
  current.agents[2].activity = "safe \x1b]2;spoofed title\x07\x1b[2J text\x00";
  const text = new WorkflowDashboard(current, plainTheme, 0).render(120).join("\n");
  assert.match(text, /safe\s+text/);
  assert.doesNotMatch(text, /spoofed|\x1b|\x00/);
});

test("live view updates one registered widget without changing its order", () => {
  let setWidgetCalls = 0;
  let renderRequests = 0;
  let widget: Component | undefined;
  const tui = { requestRender: () => { renderRequests += 1; } };
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (_key: string, content: unknown) => {
        setWidgetCalls += 1;
        if (typeof content === "function") {
          widget = (content as (_tui: typeof tui, theme: typeof plainTheme) => Component)(tui, plainTheme);
        }
      },
    },
  } as unknown as ExtensionContext;

  const view = createWorkflowView(ctx, "a1b2c3d4", "inline");
  view.onState(snap({ phase: "research", phases: ["research"] }));
  assert.equal(setWidgetCalls, 1);
  assert.match(widget?.render(110).join("\n") ?? "", /research/);

  view.onState(snap({ phase: "synthesize", phases: ["research", "synthesize"] }));
  assert.equal(setWidgetCalls, 1, "state updates must not remove and re-add the widget");
  assert.equal(renderRequests, 1);
  assert.match(widget?.render(110).join("\n") ?? "", /synthesize/);
});

test("finishing a cancelled view terminalizes in-flight agent rows", () => {
  let widget: Component | undefined;
  const tui = { requestRender: () => {} };
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (_key: string, content: unknown) => {
        if (typeof content === "function") {
          widget = (content as (_tui: typeof tui, theme: typeof plainTheme) => Component)(tui, plainTheme);
        }
      },
    },
  } as unknown as ExtensionContext;
  const view = createWorkflowView(ctx, "cancelled1", "inline");
  view.onState(snap());
  view.finish("cancelled");
  const text = widget?.render(120).join("\n") ?? "";
  assert.match(text, /◆ {2}CANCELLED/);
  assert.match(text, /⊘ summarize.*workflow cancelled/);
  assert.doesNotMatch(text, /⠋ summarize/);
});

test("completed dashboard replaces the phase with a status label", () => {
  const text = new WorkflowDashboard(snap({ status: "completed", phase: undefined }), plainTheme, 0).render(76).join("\n");
  assert.match(text, /◆ {2}COMPLETED/);
  assert.doesNotMatch(text, /RUNNING/);
});

test("cancelled dashboard shows the cancelled label", () => {
  const text = new WorkflowDashboard(snap({ status: "cancelled", phase: undefined }), plainTheme, 0).render(76).join("\n");
  assert.match(text, /◆ {2}CANCELLED/);
});

test("failed agents are prioritized ahead of queued rows when collapsed", () => {
  const now = Date.now();
  const agents: WorkflowSnapshot["agents"] = [
    ...Array.from({ length: 5 }, (_, i) => ({ index: i, label: `running-${i}`, status: "running" as const, attempt: 0, maxRetries: 2, startedAt: now })),
    { index: 5, label: "queued-a", status: "queued", attempt: 0, maxRetries: 2 },
    { index: 6, label: "queued-b", status: "queued", attempt: 0, maxRetries: 2 },
    { index: 7, label: "important-failure", status: "failed", attempt: 0, maxRetries: 2, reason: "boom" },
  ];
  const text = new WorkflowDashboard(snap({ agents, launched: agents.length }), plainTheme, 0).render(100).join("\n");
  assert.match(text, /important-failure/);
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

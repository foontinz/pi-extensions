import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { renderWorkflowCall, renderWorkflowResult } from "../ui/tool-render.js";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_role: string, text: string) => text,
};

function lines(c: Component): string {
  return c.render(120).join("\n");
}

test("call renders a compact source label", () => {
  const collapsed = lines(renderWorkflowCall({ script: "return 1;" }, theme, {}, false));
  assert.equal(collapsed.split("\n").length, 1);
  assert.match(collapsed, /Workflow inline/);
  const named = lines(renderWorkflowCall({ name: "release" }, theme, {}, false));
  assert.match(named, /Workflow name release/);
});

test("background start result collapses to one line", () => {
  const result = { content: [{ type: "text", text: "Workflow 26df68c3 started in the background (inline). A notification will arrive on completion. Script: /tmp/x.js" }], details: { runId: "26df68c3", status: "running", scriptPath: "/tmp/x.js" } };
  const collapsed = lines(renderWorkflowResult(result, theme, {}, false));
  assert.equal(collapsed.split("\n").length, 1);
  assert.match(collapsed, /▸ Workflow 26df68c3 started · background/);
  assert.doesNotMatch(collapsed, /\/tmp\/x\.js/);
});

test("foreground completion collapses to a summary line", () => {
  const result = { content: [{ type: "text", text: "agents: 3, failures: 0\n\n{ ... }" }], details: { runId: "abcd1234", agents: 3, failures: [], usage: { input: 1987, output: 20 } } };
  const collapsed = lines(renderWorkflowResult(result, theme, {}, false));
  assert.match(collapsed, /✓ Workflow abcd1234 done/);
  assert.match(collapsed, /3 agents/);
  assert.match(collapsed, /↑2.0k ↓20/);
});

test("verbose/expanded result shows the full body", () => {
  const result = { content: [{ type: "text", text: "agents: 3, failures: 0\n\nFULL BODY" }], details: { runId: "abcd1234", agents: 3, failures: [] } };
  const full = lines(renderWorkflowResult(result, theme, {}, true));
  assert.match(full, /FULL BODY/);
});

test("errors are always shown", () => {
  const result = { content: [{ type: "text", text: "boom exploded" }] };
  const errored = lines(renderWorkflowResult(result, theme, { isError: true }, false));
  assert.match(errored, /boom exploded/);
});

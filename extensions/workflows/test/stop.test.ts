import assert from "node:assert/strict";
import test from "node:test";
import workflowsExtension from "../index.js";

interface CapturedTool { name: string; execute: (...args: any[]) => Promise<any> }
function loadExtension() {
  const tools = new Map<string, CapturedTool>();
  const commands: string[] = [];
  const fakePi: any = {
    on: () => {}, registerMessageRenderer: () => {}, registerTool: (tool: CapturedTool) => tools.set(tool.name, tool),
    registerCommand: (name: string) => commands.push(name), sendMessage: () => {},
    getThinkingLevel: () => "high", getAllTools: () => [],
  };
  workflowsExtension(fakePi);
  return { tools, commands };
}
const ctx = { hasUI: false, cwd: "/tmp", model: { provider: "p", id: "m" }, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } } as any;
const textOf = (result: any) => result.content.map((part: any) => part.text).join("\n");

test("registers canonical durable workflow surfaces and no legacy stop tool", () => {
  const { tools, commands } = loadExtension();
  for (const name of ["Workflow", "workflow_status", "workflow_output", "workflow_control", "workflow_apply", "workflow_release_workspace"]) assert.ok(tools.has(name), name);
  assert.equal(tools.has("stop_workflow"), false);
  assert.deepEqual(commands.sort(), ["workflow", "workflows"]);
});

test("workflow_control reports unknown owner-scoped active runs", async () => {
  const { tools } = loadExtension();
  const result = await tools.get("workflow_control")!.execute("id", { action: "stop", runId: "11111111-1111-4111-8111-111111111111" }, undefined, undefined, ctx);
  assert.match(textOf(result), /No active owner-scoped workflow/);
  assert.equal(result.details.stopped, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import workflowsExtension from "../index.js";

interface CapturedTool {
  name: string;
  execute: (id: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
}

function loadExtension() {
  const tools = new Map<string, CapturedTool>();
  const commands: string[] = [];
  const fakePi: any = {
    on: () => {},
    registerMessageRenderer: () => {},
    registerTool: (t: CapturedTool) => tools.set(t.name, t),
    registerCommand: (name: string) => commands.push(name),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  workflowsExtension(fakePi);
  return { tools, commands };
}

const ctx = { hasUI: false, cwd: "/tmp" } as any;
const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");

test("registers the stop_workflow tool and no slash command", () => {
  const { tools, commands } = loadExtension();
  assert.ok(tools.has("stop_workflow"), "stop_workflow tool registered");
  assert.deepEqual(commands, [], "workflows register no slash commands");
});

test("stop_workflow reports when there is nothing to stop", async () => {
  const { tools } = loadExtension();
  const stop = tools.get("stop_workflow")!;

  const all = await stop.execute("c", {}, undefined, undefined, ctx);
  assert.match(textOf(all), /No running workflows\./);
  assert.equal(all.details.stopped, 0);

  const one = await stop.execute("c", { runId: "deadbeef" }, undefined, undefined, ctx);
  assert.match(textOf(one), /No running workflow deadbeef\./);
  assert.equal(one.details.stopped, 0);
});


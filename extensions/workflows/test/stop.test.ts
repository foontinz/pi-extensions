import assert from "node:assert/strict";
import test from "node:test";
import workflowsExtension from "../index.js";

interface CapturedTool {
  name: string;
  execute: (id: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
}
interface CapturedCommand {
  name: string;
  getArgumentCompletions?: (prefix: string) => any;
  handler: (args: string, ctx: any) => Promise<void>;
}

function loadExtension() {
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, CapturedCommand>();
  const fakePi: any = {
    on: () => {},
    registerMessageRenderer: () => {},
    registerTool: (t: CapturedTool) => tools.set(t.name, t),
    registerCommand: (name: string, def: Omit<CapturedCommand, "name">) => commands.set(name, { name, ...def }),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  workflowsExtension(fakePi);
  return { tools, commands };
}

const ctx = { hasUI: false, cwd: "/tmp" } as any;
const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");

test("registers the stop_workflow tool and /workflow-stop command", () => {
  const { tools, commands } = loadExtension();
  assert.ok(tools.has("stop_workflow"), "stop_workflow tool registered");
  assert.ok(commands.has("workflow-stop"), "/workflow-stop command registered");
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

test("/workflow-stop notifies when idle and completes argument candidates", async () => {
  const { commands } = loadExtension();
  const cmd = commands.get("workflow-stop")!;

  const notes: Array<{ msg: string; level: string }> = [];
  const cmdCtx = { ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) } } as any;
  await cmd.handler("", cmdCtx);
  assert.equal(notes.length, 1);
  assert.match(notes[0].msg, /No running workflows\./);

  // "all" is always offered as a completion candidate.
  const completions = cmd.getArgumentCompletions?.("a") ?? [];
  assert.ok(completions.some((c: any) => c.value === "all"));
});

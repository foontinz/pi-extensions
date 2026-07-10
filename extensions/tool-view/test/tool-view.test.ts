import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolView, { getToolViewToolSettings, selectManagedTools } from "../index";

test("selects only active built-ins using canonical sourceInfo", () => {
  const names = selectManagedTools(
    ["read", "bash", "write"],
    [
      { name: "read", sourceInfo: { source: "builtin" } },
      { name: "bash", sourceInfo: { source: "extension" } },
      { name: "write", sourceInfo: { source: "builtin" } },
    ],
    ["write"],
  );

  assert.deepEqual(names, ["read"]);
});

test("exposes Pi bash and image settings for managed definitions", () => {
  const settings = getToolViewToolSettings({
    getShellPath: () => "/custom/shell",
    getShellCommandPrefix: () => "source ~/.profile &&",
    getImageAutoResize: () => false,
  } as any);

  assert.deepEqual(settings, {
    shellPath: "/custom/shell",
    commandPrefix: "source ~/.profile &&",
    autoResizeImages: false,
  });
});

test("delegates managed tool execution using the invocation cwd", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools: any[] = [];
  const mockPi = {
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin" } }],
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: () => {},
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;

  toolView(mockPi);
  await handlers.get("session_start")?.({}, { cwd: "/", ui: { setStatus: () => {} } });
  assert.equal(tools.length, 1);

  const cwd = await mkdtemp(join(tmpdir(), "pi-tool-view-cwd-"));
  try {
    await writeFile(join(cwd, "from-invocation-cwd.txt"), "correct directory\n");
    const result = await tools[0].execute(
      "call-id",
      { path: "from-invocation-cwd.txt" },
      undefined,
      undefined,
      { cwd, model: undefined },
    );
    assert.equal(result.content[0]?.type, "text");
    assert.match((result.content[0] as { text: string }).text, /correct directory/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadMcpServers } from "../../mcp/config.js";
import { SharedMcpGateway } from "../../mcp/gateway.js";
import { createMcpProxyTool } from "../../mcp/proxy-tool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const echoServer = path.resolve(here, "..", "fixtures", "mcp-echo-server.mjs");

function writeConfig(dir: string): void {
  const config = { mcpServers: { echo: { command: process.execPath, args: [echoServer] } } };
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify(config), "utf8");
}

test("loadMcpServers merges global + project with project winning", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cfg-"));
  try {
    fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "x" }, b: { url: "http://h", auth: "bearer", bearerToken: "t" } } }));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "override" } } }));
    const servers = loadMcpServers(dir, dir);
    assert.equal(servers.size, 2);
    assert.equal((servers.get("a") as { command: string }).command, "override");
    const b = servers.get("b") as { transport: string; headers?: Record<string, string> };
    assert.equal(b.transport, "http");
    assert.equal(b.headers?.Authorization, "Bearer t");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadMcpServers resolves bearerTokenEnv and bearer placeholders without persisting secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-env-"));
  const previous = process.env.TEST_MCP_BEARER_TOKEN;
  process.env.TEST_MCP_BEARER_TOKEN = "secret-value";
  try {
    fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({
      mcpServers: {
        byName: { url: "https://example.test", auth: "bearer", bearerTokenEnv: "TEST_MCP_BEARER_TOKEN" },
        byPlaceholder: { url: "https://example.test", auth: "bearer", bearerToken: "$env:TEST_MCP_BEARER_TOKEN" },
      },
    }));
    const servers = loadMcpServers(dir, dir);
    assert.equal((servers.get("byName") as { headers?: Record<string, string> }).headers?.Authorization, "Bearer secret-value");
    assert.equal((servers.get("byPlaceholder") as { headers?: Record<string, string> }).headers?.Authorization, "Bearer secret-value");
  } finally {
    if (previous === undefined) delete process.env.TEST_MCP_BEARER_TOKEN;
    else process.env.TEST_MCP_BEARER_TOKEN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gateway connects to a stdio MCP server once and calls a tool", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gw-"));
  writeConfig(dir);
  const gateway = new SharedMcpGateway(dir, dir);
  try {
    assert.deepEqual(gateway.serverNames(), ["echo"]);
    const tools = await gateway.listAllTools();
    assert.ok(tools.some((t) => t.name === "echo" && t.server === "echo"));

    const result = await gateway.callTool("echo", { message: "hi" });
    assert.equal(result.isError, false);
    assert.match(result.text, /echo: hi/);

    // Second call reuses the same connection (no throw, still works).
    const again = await gateway.callTool("echo", { message: "again" }, "echo");
    assert.match(again.text, /echo: again/);
  } finally {
    await gateway.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("proxy tool exposes status/search/describe/call over the gateway", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-proxy-"));
  writeConfig(dir);
  const gateway = new SharedMcpGateway(dir, dir);
  const tool = createMcpProxyTool(gateway);
  const run = async (params: Record<string, unknown>): Promise<string> => {
    const result = await tool.execute("call", params as never, undefined, undefined, {} as never);
    const block = result.content[0] as { text?: string };
    return block.text ?? "";
  };
  try {
    assert.match(await run({}), /Configured MCP servers: echo/);
    assert.match(await run({ search: "echo" }), /echo \[echo\]/);
    assert.match(await run({ describe: "echo" }), /Parameters:/);
    assert.match(await run({ tool: "echo", args: JSON.stringify({ message: "yo" }) }), /echo: yo/);
    assert.match(await run({ tool: "echo", args: "not json" }), /could not parse/);
  } finally {
    await gateway.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

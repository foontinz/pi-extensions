// Minimal modular MCP SDK v2 server used by the shared-gateway integration test.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

function createServer() {
  const server = new McpServer({ name: "echo-server", version: "2.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo back the provided message.",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
  );
  return server;
}

serveStdio(createServer, { onerror: (error) => console.error(error) });

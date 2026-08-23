/**
 * A thin `mcp` gateway tool injected into in-process subagent sessions. It forwards
 * calls to the process-wide `SharedMcpGateway` (which connects to each MCP server
 * once and reuses the connection), so child sessions get MCP access without loading
 * or reconnecting an MCP adapter of their own.
 *
 * Modes (mirrors the interactive gateway's essentials):
 *   {}                                  -> status: list configured servers
 *   { server }                          -> list tools for a server
 *   { search }                          -> search tools by name/description
 *   { describe }                        -> show a tool's parameter schema
 *   { tool, args }                      -> call a tool (args is an object or JSON string; server optional)
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpToolInfo, SharedMcpGateway } from "./gateway.js";

const McpProxyParams = Type.Object({
  server: Type.Optional(Type.String({ description: "Target/filter server name." })),
  search: Type.Optional(Type.String({ description: "Search tools by name/description substring." })),
  describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)." })),
  tool: Type.Optional(Type.String({ description: "Tool name to call." })),
  args: Type.Optional(Type.Union([
    Type.String({ description: 'Arguments as a JSON string (e.g. \'{"key":"value"}\').' }),
    Type.Object({}, { additionalProperties: true, description: "Arguments as a JSON object." }),
  ])),
});

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }], details: {} };
}

function summarizeTools(tools: McpToolInfo[]): string {
  if (tools.length === 0) return "(no tools)";
  return tools
    .map((tool) => `- ${tool.name}${tool.server ? ` [${tool.server}]` : ""}${tool.description ? `: ${truncate(tool.description, 120)}` : ""}`)
    .join("\n");
}

function truncate(input: string, max: number): string {
  const oneLine = input.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function createMcpProxyTool(gateway: SharedMcpGateway): ToolDefinition<typeof McpProxyParams> {
  return {
    name: "mcp",
    label: "MCP",
    description: [
      "Access MCP (Model Context Protocol) server tools shared from the parent session.",
      "No args -> list servers. { server } -> list its tools. { search } -> find tools.",
      "{ describe } -> show a tool's parameters. { tool, args } -> call a tool (args is an object or JSON string).",
    ].join("\n"),
    promptSnippet: "Call shared MCP server tools (list/search/describe/call).",
    parameters: McpProxyParams,
    async execute(_id, params, signal) {
      if (params.tool) {
        let parsedArgs: Record<string, unknown> = {};
        if (typeof params.args === "string" && params.args.trim()) {
          const parsed = JSON.parse(params.args) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error('MCP "args" must encode a JSON object.');
          }
          parsedArgs = parsed as Record<string, unknown>;
        } else if (params.args !== undefined) {
          if (!params.args || typeof params.args !== "object" || Array.isArray(params.args)) {
            throw new Error('MCP "args" must be a JSON object.');
          }
          parsedArgs = params.args as Record<string, unknown>;
        }
        const result = await gateway.callTool(params.tool, parsedArgs, params.server, signal);
        if (result.isError) throw new Error(`MCP tool error: ${result.text}`);
        return text(result.text);
      }

      if (params.describe) {
        const info = await gateway.findTool(params.describe, params.server, signal);
        if (!info) return text(`No MCP tool named "${params.describe}"${params.server ? ` on server ${params.server}` : ""}.`);
        return text(
          [
            `${info.name}${info.server ? ` [${info.server}]` : ""}`,
            info.description ?? "(no description)",
            "",
            "Parameters:",
            JSON.stringify(info.inputSchema ?? {}, null, 2),
          ].join("\n"),
        );
      }

      if (params.search) {
        const needle = params.search.toLowerCase();
        const all = await gateway.listAllTools(signal);
        const matches = all.filter(
          (tool) => tool.name.toLowerCase().includes(needle) || (tool.description ?? "").toLowerCase().includes(needle),
        );
        return text(`Matching tools:\n${summarizeTools(matches)}`);
      }

      if (params.server) {
        const tools = await gateway.listServerTools(params.server, signal);
        return text(`Tools on ${params.server}:\n${summarizeTools(tools)}`);
      }

      const names = gateway.serverNames();
      if (names.length === 0) return text("No MCP servers are configured.");
      return text(`Configured MCP servers: ${names.join(", ")}.\nUse { server } to list a server's tools, { search } to find tools, or { tool, args } to call one.`);
    },
  };
}

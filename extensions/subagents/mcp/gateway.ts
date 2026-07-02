/**
 * Process-wide shared MCP gateway for in-process subagents.
 *
 * Nested `createAgentSession` sessions load no extensions (bare ResourceLoader), so
 * they do not inherit the parent's `mcp` gateway tool. Rather than reconnect an MCP
 * adapter per child (the per-child cost P3.3 warns about), this gateway connects to
 * each configured MCP server **once per process** and reuses those client sessions
 * across every subagent / workflow agent. A thin proxy tool (see `proxy-tool.ts`)
 * forwards child MCP calls here.
 *
 * Connections are lazy (established on first use), deduped across concurrent callers,
 * and torn down on `disposeAll()` (session shutdown).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadMcpServers, type McpServerDef } from "./config.js";

export interface McpToolInfo {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallResult {
  isError: boolean;
  text: string;
  raw: unknown;
}

interface Connection {
  client: Client;
  tools: McpToolInfo[];
}

const CONNECT_TIMEOUT_MS = 30_000;

export class SharedMcpGateway {
  private readonly servers: Map<string, McpServerDef>;
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Connection>>();
  private disposed = false;

  constructor(
    private readonly cwd: string,
    private readonly agentDir: string,
    overridePath?: string,
  ) {
    this.servers = loadMcpServers(cwd, agentDir, overridePath);
  }

  /** Names of all configured servers (whether or not connected yet). */
  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  hasServers(): boolean {
    return this.servers.size > 0;
  }

  private async connect(name: string): Promise<Connection> {
    if (this.disposed) throw new Error("MCP gateway disposed");
    const existing = this.connections.get(name);
    if (existing) return existing;
    const inFlight = this.connecting.get(name);
    if (inFlight) return inFlight;

    const def = this.servers.get(name);
    if (!def) throw new Error(`Unknown MCP server: ${name}`);

    const promise = this.createConnection(def)
      .then((connection) => {
        this.connections.set(name, connection);
        return connection;
      })
      .finally(() => this.connecting.delete(name));
    this.connecting.set(name, promise);
    return promise;
  }

  private async createConnection(def: McpServerDef): Promise<Connection> {
    const client = new Client({ name: "pi-subagents-mcp", version: "1.0.0" }, { capabilities: {} });
    const transport = def.transport === "stdio"
      ? new StdioClientTransport({ command: def.command, args: def.args, env: buildEnv(def.env), cwd: def.cwd, stderr: "ignore" })
      : await this.createHttpTransport(def);

    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect to MCP server ${def.name}`);
    const listed = await client.listTools();
    const tools: McpToolInfo[] = (listed.tools ?? []).map((tool) => ({
      server: def.name,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    return { client, tools };
  }

  private async createHttpTransport(def: Extract<McpServerDef, { transport: "http" }>) {
    const url = new URL(def.url);
    const requestInit = def.headers ? { headers: def.headers } : undefined;
    try {
      const http = new StreamableHTTPClientTransport(url, { requestInit });
      return http;
    } catch {
      return new SSEClientTransport(url, { requestInit });
    }
  }

  /** Ensure every configured server is connected; returns discovered tools. Errors per server are swallowed. */
  async listAllTools(): Promise<McpToolInfo[]> {
    const results = await Promise.allSettled([...this.servers.keys()].map((name) => this.connect(name)));
    const tools: McpToolInfo[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") tools.push(...result.value.tools);
    }
    return tools;
  }

  async listServerTools(server: string): Promise<McpToolInfo[]> {
    const connection = await this.connect(server);
    return connection.tools;
  }

  /** Find a tool by (optional) server + name across connected/known servers. */
  async findTool(name: string, server?: string): Promise<McpToolInfo | undefined> {
    if (server) {
      const tools = await this.listServerTools(server);
      return tools.find((tool) => tool.name === name);
    }
    const all = await this.listAllTools();
    return all.find((tool) => tool.name === name);
  }

  async callTool(name: string, args: Record<string, unknown>, server?: string): Promise<McpCallResult> {
    const target = server ?? (await this.findTool(name))?.server;
    if (!target) throw new Error(`No MCP server exposes a tool named "${name}"`);
    const connection = await this.connect(target);
    const result = (await connection.client.callTool({ name, arguments: args })) as {
      content?: Array<Record<string, unknown>>;
      isError?: boolean;
    };
    return { isError: Boolean(result.isError), text: renderContent(result.content ?? []), raw: result };
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    const closing = [...this.connections.values()].map((connection) =>
      connection.client.close().catch(() => {}),
    );
    this.connections.clear();
    await Promise.allSettled(closing);
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let shared: SharedMcpGateway | undefined;

export function getSharedMcpGateway(cwd: string, agentDir: string, overridePath?: string): SharedMcpGateway {
  if (!shared) shared = new SharedMcpGateway(cwd, agentDir, overridePath);
  return shared;
}

export async function disposeSharedMcpGateway(): Promise<void> {
  const gateway = shared;
  shared = undefined;
  if (gateway) await gateway.disposeAll();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEnv(env?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") base[key] = value;
  }
  return { ...base, ...(env ?? {}) };
}

function renderContent(content: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource" && block.resource && typeof block.resource === "object") {
      const resource = block.resource as { text?: unknown; uri?: unknown };
      if (typeof resource.text === "string") parts.push(resource.text);
      else if (typeof resource.uri === "string") parts.push(`[resource ${resource.uri}]`);
    } else {
      try {
        parts.push(JSON.stringify(block));
      } catch {
        parts.push(String(block));
      }
    }
  }
  return parts.join("\n");
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out (${ms}ms) trying to ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

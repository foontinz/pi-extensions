/**
 * Process-wide shared MCP gateway for in-process subagents.
 *
 * Nested `createAgentSession` sessions load no extensions (bare ResourceLoader), so
 * they do not inherit the parent's `mcp` gateway tool. Rather than reconnect an MCP
 * adapter per child, this gateway connects to each configured MCP server once per
 * process and reuses those client sessions across subagents and workflow agents.
 */

import {
  Client,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type RequestOptions,
  type Tool,
  type Transport,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadMcpServers, type McpProtocolVersion, type McpServerDef } from "./config.js";

export interface McpToolInfo {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpCallResult {
  isError: boolean;
  text: string;
  raw: CallToolResult;
}

interface Connection {
  client: Client;
  tools: McpToolInfo[];
  definition: McpServerDef;
}

const CONNECT_TIMEOUT_MS = 30_000;

export class SharedMcpGateway {
  private readonly servers: Map<string, McpServerDef>;
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Connection>>();
  private readonly lifecycle = new AbortController();
  private disposed = false;

  constructor(
    private readonly cwd: string,
    private readonly agentDir: string,
    overridePath?: string,
  ) {
    this.servers = loadMcpServers(cwd, agentDir, overridePath);
  }

  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  hasServers(): boolean {
    return this.servers.size > 0;
  }

  private async connect(name: string, signal?: AbortSignal): Promise<Connection> {
    if (this.disposed) throw new Error("MCP gateway disposed");
    const existing = this.connections.get(name);
    if (existing) return existing;

    let promise = this.connecting.get(name);
    if (!promise) {
      const definition = this.servers.get(name);
      if (!definition) throw new Error(`Unknown MCP server: ${name}`);
      promise = this.createConnection(definition)
        .then(async (connection) => {
          if (this.disposed) {
            await connection.client.close().catch(() => {});
            throw new Error("MCP gateway disposed");
          }
          this.connections.set(name, connection);
          return connection;
        })
        .finally(() => this.connecting.delete(name));
      this.connecting.set(name, promise);
    }
    return waitForSignal(promise, signal);
  }

  private createClient(definition: McpServerDef): Client {
    const versionNegotiation = resolveVersionNegotiation(definition.protocolVersion);
    return new Client(
      { name: "pi-subagents-mcp", version: "1.0.0" },
      versionNegotiation ? { versionNegotiation } : undefined,
    );
  }

  private requestOptions(definition: McpServerDef, signal?: AbortSignal): RequestOptions {
    const requestSignal = signal
      ? AbortSignal.any([this.lifecycle.signal, signal])
      : this.lifecycle.signal;
    return {
      timeout: definition.requestTimeoutMs ?? CONNECT_TIMEOUT_MS,
      signal: requestSignal,
    };
  }

  private async createConnection(definition: McpServerDef): Promise<Connection> {
    if (definition.transport === "http") return this.createHttpConnection(definition);

    const transport = new StdioClientTransport({
      command: definition.command,
      args: definition.args,
      env: buildEnv(definition.env),
      cwd: definition.cwd ?? this.cwd,
      stderr: "ignore",
    });
    return this.connectAndDiscover(definition, transport);
  }

  private async createHttpConnection(
    definition: Extract<McpServerDef, { transport: "http" }>,
  ): Promise<Connection> {
    const kinds: Array<"streamable-http" | "sse"> = definition.httpTransport
      ? [definition.httpTransport]
      : ["streamable-http", "sse"];

    let firstError: unknown;
    for (const kind of kinds) {
      const url = new URL(definition.url);
      const requestInit = definition.headers ? { headers: definition.headers } : undefined;
      const transport = kind === "streamable-http"
        ? new StreamableHTTPClientTransport(url, { requestInit })
        : new SSEClientTransport(url, { requestInit });
      try {
        return await this.connectAndDiscover(definition, transport);
      } catch (error) {
        firstError ??= error;
        const mayFallback = kind === "streamable-http"
          && definition.httpTransport === undefined
          && definition.protocolVersion !== "2026-07-28"
          && error instanceof SdkHttpError
          && [404, 405, 406, 415].includes(error.status);
        if (!mayFallback) throw error;
      }
    }
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

  private async connectAndDiscover(definition: McpServerDef, transport: Transport): Promise<Connection> {
    const client = this.createClient(definition);
    try {
      await client.connect(transport, this.requestOptions(definition));
      const listed = await client.listTools(undefined, this.requestOptions(definition));
      const tools = filterTools(definition, listed.tools ?? []).map((tool) => ({
        server: definition.name,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      return { client, tools, definition };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  /** Ensure every configured server is connected; errors remain isolated per server. */
  async listAllTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const results = await Promise.allSettled([...this.servers.keys()].map((name) => this.connect(name, signal)));
    const tools: McpToolInfo[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") tools.push(...result.value.tools);
    }
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
    return tools;
  }

  async listServerTools(server: string, signal?: AbortSignal): Promise<McpToolInfo[]> {
    const connection = await this.connect(server, signal);
    return connection.tools;
  }

  /** Find a tool by server/name and reject ambiguous unqualified names. */
  async findTool(name: string, server?: string, signal?: AbortSignal): Promise<McpToolInfo | undefined> {
    if (server) {
      const tools = await this.listServerTools(server, signal);
      return tools.find((tool) => tool.name === name);
    }
    const matches = (await this.listAllTools(signal)).filter((tool) => tool.name === name);
    if (matches.length > 1) {
      throw new Error(`MCP tool "${name}" is exposed by multiple servers (${matches.map((tool) => tool.server).join(", ")}); specify server`);
    }
    return matches[0];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    server?: string,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const target = server ?? (await this.findTool(name, undefined, signal))?.server;
    if (!target) throw new Error(`No MCP server exposes a tool named "${name}"`);
    const connection = await this.connect(target, signal);
    if (requiresApproval(connection.definition, name)) {
      throw new Error(`MCP tool "${name}" on ${target} requires interactive approval and is blocked in a subagent`);
    }
    const result = await connection.client.callTool(
      { name, arguments: args },
      this.requestOptions(connection.definition, signal),
    );
    return {
      isError: Boolean(result.isError),
      text: renderCallResult(result),
      raw: result,
    };
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    this.lifecycle.abort(new Error("MCP gateway disposed"));
    await Promise.allSettled(this.connecting.values());
    const closing = [...this.connections.values()].map((connection) => connection.client.close().catch(() => {}));
    this.connections.clear();
    await Promise.allSettled(closing);
  }
}

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

function resolveVersionNegotiation(
  version: McpProtocolVersion | undefined,
): VersionNegotiationOptions | undefined {
  if (!version || version === "legacy") return undefined;
  return version === "auto" ? { mode: "auto" } : { mode: { pin: version } };
}

function buildEnv(env?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") base[key] = value;
  }
  return { ...base, ...(env ?? {}) };
}

function filterTools(definition: McpServerDef, tools: Tool[]): Tool[] {
  return tools.filter((tool) => {
    const included = !definition.includeTools || definition.includeTools.some((pattern) => matchesGlob(tool.name, pattern));
    const excluded = definition.excludeTools?.some((pattern) => matchesGlob(tool.name, pattern)) ?? false;
    return included && !excluded;
  });
}

function requiresApproval(definition: McpServerDef, toolName: string): boolean {
  if (definition.approveTools === true) return true;
  if (!Array.isArray(definition.approveTools)) return false;
  return definition.approveTools.some((pattern) => matchesGlob(toolName, pattern));
}

function matchesGlob(value: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(value);
}

function renderCallResult(result: CallToolResult): string {
  const rendered = renderContent(Array.isArray(result.content) ? result.content : []);
  if (rendered) return rendered;
  if (result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent, null, 2);
    } catch {
      return String(result.structuredContent);
    }
  }
  return "";
}

function renderContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const value of content) {
    if (!value || typeof value !== "object") {
      parts.push(String(value));
      continue;
    }
    const block = value as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource" && block.resource && typeof block.resource === "object") {
      const resource = block.resource as { text?: unknown; blob?: unknown; uri?: unknown };
      if (typeof resource.text === "string") parts.push(resource.text);
      else if (typeof resource.blob === "string") parts.push(`[blob resource ${String(resource.uri ?? "")}]`);
      else if (typeof resource.uri === "string") parts.push(`[resource ${resource.uri}]`);
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      parts.push(`[resource ${block.uri}]`);
    } else if ((block.type === "image" || block.type === "audio") && typeof block.mimeType === "string") {
      parts.push(`[${block.type} ${block.mimeType}]`);
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

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

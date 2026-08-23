/**
 * Minimal MCP config loader for the shared subagent gateway.
 *
 * Reads `mcp.json` (agent-dir global) and project-local `.pi/mcp.json` / `.mcp.json`,
 * merging server definitions by name (project overrides global). This is a focused
 * reader — it intentionally does not implement the interactive adapter's import
 * sources, OAuth, or write paths; it only needs enough to (re)connect the same
 * servers the parent adapter already talks to.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import stripJsonComments from "strip-json-comments";

export type McpProtocolVersion = "legacy" | "auto" | "2026-07-28";

interface McpServerOptions {
  protocolVersion?: McpProtocolVersion;
  httpTransport?: "streamable-http" | "sse";
  requestTimeoutMs?: number;
  includeTools?: string[];
  excludeTools?: string[];
  approveTools?: boolean | string[];
}

export interface McpStdioServerDef extends McpServerOptions {
  transport: "stdio";
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerDef extends McpServerOptions {
  transport: "http";
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export type McpServerDef = McpStdioServerDef | McpHttpServerDef;

interface RawServerEntry {
  command?: string;
  args?: unknown;
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  auth?: string;
  bearerToken?: string;
  bearerTokenEnv?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  protocolVersion?: McpProtocolVersion;
  httpTransport?: "streamable-http" | "sse";
  requestTimeoutMs?: number;
  includeTools?: unknown;
  excludeTools?: unknown;
  approveTools?: unknown;
}

interface RawConfig {
  mcpServers?: Record<string, RawServerEntry>;
  "mcp-servers"?: Record<string, RawServerEntry>;
  servers?: Record<string, RawServerEntry>;
  settings?: { approveTools?: unknown };
}

/** Config paths in adapter precedence order (later entries override earlier ones). */
function candidatePaths(cwd: string, agentDir: string, overridePath?: string): string[] {
  return [
    path.join(homedir(), ".config", "mcp", "mcp.json"),
    path.join(homedir(), ".agents", "mcp.json"),
    path.join(homedir(), ".agents", "mcp", "mcp.json"),
    overridePath ? path.resolve(overridePath) : path.join(agentDir, "mcp.json"),
    path.resolve(cwd, ".mcp.json"),
    path.resolve(cwd, ".pi", "mcp.json"),
  ];
}

function readConfig(filePath: string): RawConfig | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw, { trailingCommas: true })) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as RawConfig;
  } catch {
    return undefined;
  }
}

function interpolateEnv(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_match, envName: string) => process.env[envName] ?? "")
    .replace(/\$env:(\w+)/g, (_match, envName: string) => process.env[envName] ?? "");
}

function resolveBearerToken(entry: RawServerEntry): string | undefined {
  if (entry.bearerToken !== undefined) return interpolateEnv(entry.bearerToken);
  return entry.bearerTokenEnv ? process.env[entry.bearerTokenEnv] : undefined;
}

function normalizePatterns(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const patterns = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return patterns.length > 0 ? patterns : undefined;
}

function normalizeApproval(value: unknown): boolean | string[] | undefined {
  if (typeof value === "boolean") return value;
  return normalizePatterns(value);
}

function normalizeOptions(entry: RawServerEntry): McpServerOptions {
  const protocolVersion = entry.protocolVersion;
  const httpTransport = entry.httpTransport;
  const includeTools = normalizePatterns(entry.includeTools);
  const excludeTools = normalizePatterns(entry.excludeTools);
  const approveTools = normalizeApproval(entry.approveTools);
  return {
    ...(protocolVersion === "legacy" || protocolVersion === "auto" || protocolVersion === "2026-07-28"
      ? { protocolVersion }
      : {}),
    ...(httpTransport === "streamable-http" || httpTransport === "sse" ? { httpTransport } : {}),
    ...(typeof entry.requestTimeoutMs === "number" && entry.requestTimeoutMs > 0
      ? { requestTimeoutMs: entry.requestTimeoutMs }
      : {}),
    ...(includeTools ? { includeTools } : {}),
    ...(excludeTools ? { excludeTools } : {}),
    ...(approveTools !== undefined ? { approveTools } : {}),
  };
}

function normalizeEntry(name: string, entry: RawServerEntry): McpServerDef | undefined {
  if (!entry || typeof entry !== "object" || entry.disabled === true) return undefined;
  const hasCommand = typeof entry.command === "string" && entry.command.trim().length > 0;
  const hasUrl = typeof entry.url === "string" && entry.url.trim().length > 0;
  if (hasCommand === hasUrl) return undefined;
  const options = normalizeOptions(entry);
  if (hasCommand) {
    return {
      transport: "stdio",
      name,
      command: entry.command!,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: entry.env,
      cwd: entry.cwd,
      ...options,
    };
  }

  const headers = Object.fromEntries(
    Object.entries(entry.headers ?? {}).map(([key, value]) => [key, interpolateEnv(value)]),
  );
  const bearerToken = resolveBearerToken(entry);
  if (entry.auth === "bearer" && bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  return {
    transport: "http",
    name,
    url: interpolateEnv(entry.url!),
    headers: Object.keys(headers).length ? headers : undefined,
    ...options,
  };
}

function mergeEntry(base: RawServerEntry | undefined, next: RawServerEntry): RawServerEntry {
  if (!base) return { ...next };
  let inherited = { ...base };
  if (typeof next.command === "string") {
    for (const key of ["url", "headers", "auth", "bearerToken", "bearerTokenEnv"] as const) delete inherited[key];
  } else if (typeof next.url === "string") {
    delete inherited.command;
    delete inherited.args;
    delete inherited.env;
    delete inherited.cwd;
    if (base.url !== next.url) {
      for (const key of ["headers", "auth", "bearerToken", "bearerTokenEnv"] as const) delete inherited[key];
    }
  }
  return { ...inherited, ...next };
}

/** Load and merge MCP server definitions using the adapter's standard source precedence. */
export function loadMcpServers(cwd: string, agentDir: string, overridePath?: string): Map<string, McpServerDef> {
  const rawMerged = new Map<string, RawServerEntry>();
  let globalApproveTools: boolean | string[] | undefined;
  for (const filePath of candidatePaths(cwd, agentDir, overridePath)) {
    const config = readConfig(filePath);
    const configuredApproval = normalizeApproval(config?.settings?.approveTools);
    if (configuredApproval !== undefined) globalApproveTools = configuredApproval;
    const servers = config?.mcpServers ?? config?.["mcp-servers"] ?? config?.servers;
    if (!servers) continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== "object") continue;
      rawMerged.set(name, mergeEntry(rawMerged.get(name), entry));
    }
  }

  const normalized = new Map<string, McpServerDef>();
  for (const [name, entry] of rawMerged) {
    const effectiveEntry = entry.approveTools === undefined && globalApproveTools !== undefined
      ? { ...entry, approveTools: globalApproveTools }
      : entry;
    const definition = normalizeEntry(name, effectiveEntry);
    if (definition) normalized.set(name, definition);
  }
  return normalized;
}

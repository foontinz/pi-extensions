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
import * as path from "node:path";

export interface McpStdioServerDef {
  transport: "stdio";
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerDef {
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
}

interface RawConfig {
  mcpServers?: Record<string, RawServerEntry>;
  servers?: Record<string, RawServerEntry>;
}

/** Config paths in ascending priority order (later entries override earlier ones). */
function candidatePaths(cwd: string, agentDir: string, overridePath?: string): string[] {
  if (overridePath) return [path.resolve(overridePath)];
  return [
    path.join(agentDir, "mcp.json"),
    path.resolve(cwd, ".mcp.json"),
    path.resolve(cwd, ".pi", "mcp.json"),
  ];
}

function readConfig(filePath: string): RawConfig | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
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

function normalizeEntry(name: string, entry: RawServerEntry): McpServerDef | undefined {
  if (!entry || typeof entry !== "object" || entry.disabled) return undefined;
  if (typeof entry.command === "string" && entry.command.trim()) {
    return {
      transport: "stdio",
      name,
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: entry.env,
      cwd: entry.cwd,
    };
  }
  if (typeof entry.url === "string" && entry.url.trim()) {
    const headers = Object.fromEntries(
      Object.entries(entry.headers ?? {}).map(([key, value]) => [key, interpolateEnv(value)]),
    );
    const bearerToken = resolveBearerToken(entry);
    if (entry.auth === "bearer" && bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
    return { transport: "http", name, url: entry.url, headers: Object.keys(headers).length ? headers : undefined };
  }
  return undefined;
}

/** Load and merge MCP server definitions. Project-local entries override global ones. */
export function loadMcpServers(cwd: string, agentDir: string, overridePath?: string): Map<string, McpServerDef> {
  const merged = new Map<string, McpServerDef>();
  // Ascending priority: later files override earlier ones on name collisions.
  for (const filePath of candidatePaths(cwd, agentDir, overridePath)) {
    const config = readConfig(filePath);
    const servers = config?.mcpServers ?? config?.servers;
    if (!servers) continue;
    for (const [name, entry] of Object.entries(servers)) {
      const def = normalizeEntry(name, entry);
      if (def) merged.set(name, def);
    }
  }
  return merged;
}

import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  getLastAssistantUsage,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { getSharedMcpGateway } from "../mcp/gateway.js";
import { createMcpProxyTool } from "../mcp/proxy-tool.js";
import { emptyUsageStats, type SubagentResult, type TerminalReason, type UsageStats } from "./types.js";

// Shared, process-wide handles so fanned-out agents don't each rebuild auth/model
// state (decision E). Lazily created and reused across concurrent sessions.
let sharedAuthStorage: ReturnType<typeof AuthStorage.create> | undefined;
let sharedModelRegistry: ReturnType<typeof ModelRegistry.create> | undefined;

export function getSharedHandles(): { authStorage: ReturnType<typeof AuthStorage.create>; modelRegistry: ReturnType<typeof ModelRegistry.create> } {
  if (!sharedAuthStorage) sharedAuthStorage = AuthStorage.create();
  if (!sharedModelRegistry) sharedModelRegistry = ModelRegistry.create(sharedAuthStorage);
  return { authStorage: sharedAuthStorage, modelRegistry: sharedModelRegistry };
}

/**
 * Best-effort resolution of a CLI-style model pattern (`provider/id`, `id`, or a
 * substring) to a concrete Model. Returns undefined when no pattern is given or no
 * match is found, so the session falls back to default discovery.
 */
export function resolveModelPattern(pattern: string | undefined): unknown | undefined {
  if (!pattern || !pattern.trim()) return undefined;
  const { modelRegistry } = getSharedHandles();
  const all = modelRegistry.getAll() as Array<{ provider: string; id: string }>;
  const raw = pattern.trim();
  const [maybeProvider, maybeId] = raw.includes("/") ? raw.split("/", 2) : [undefined, raw];
  const id = (maybeId ?? raw).split(":")[0]?.toLowerCase();
  const provider = maybeProvider?.toLowerCase();
  const matches = all.filter((model) => {
    const providerOk = !provider || model.provider.toLowerCase() === provider;
    const idOk = model.id.toLowerCase() === id || model.id.toLowerCase().includes(id ?? "");
    return providerOk && idOk;
  });
  const prefer = matches.find((model) => modelRegistry.hasConfiguredAuth(model as never)) ?? matches[0];
  return prefer;
}

export interface InProcessSubagentOptions {
  task: string;
  cwd: string;
  tools?: readonly string[];
  systemPrompt?: string;
  appendSystemPrompt?: readonly string[];
  timeoutMs?: number;
  /**
   * Give the agent a shared `mcp` gateway tool that forwards to the process-wide
   * MCP connection pool (servers connected once, reused across agents).
   */
  mcp?: boolean;
  /** External abort (e.g. the workflow signal). Triggers session.abort(). */
  signal?: AbortSignal;
}

export function createBareResourceLoader(systemPrompt?: string, appendSystemPrompt: readonly string[] = []): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [...appendSystemPrompt],
    extendResources: () => {},
    reload: async () => {},
  };
}

export async function runSubagentInProcess(options: InProcessSubagentOptions): Promise<SubagentResult> {
  if (options.signal?.aborted) {
    return { output: "", usage: emptyUsageStats(), error: { reason: "stop", message: "aborted before start" } };
  }

  const { authStorage, modelRegistry } = getSharedHandles();
  const sessionManager = SessionManager.inMemory(options.cwd);

  const customTools: ToolDefinition[] = [];
  let toolAllowlist = options.tools ? [...options.tools] : undefined;
  if (options.mcp) {
    const gateway = getSharedMcpGateway(options.cwd, getAgentDir());
    customTools.push(createMcpProxyTool(gateway) as ToolDefinition);
    // The allowlist (when present) gates custom tools too, so make sure `mcp` is in it.
    if (toolAllowlist && !toolAllowlist.includes("mcp")) toolAllowlist = [...toolAllowlist, "mcp"];
  }

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    authStorage,
    modelRegistry,
    resourceLoader: createBareResourceLoader(options.systemPrompt, options.appendSystemPrompt),
    tools: toolAllowlist,
    noTools: toolAllowlist && toolAllowlist.length === 0 ? "all" : undefined,
    customTools: customTools.length > 0 ? customTools : undefined,
    sessionManager,
    settingsManager: SettingsManager.create(options.cwd, getAgentDir()),
  });

  let timedOut = false;
  let externallyAborted = false;
  const timeout = options.timeoutMs && options.timeoutMs > 0
    ? setTimeout(() => { timedOut = true; void session.abort(); }, options.timeoutMs)
    : undefined;
  const onAbort = () => { externallyAborted = true; void session.abort(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await session.prompt(options.task);
    const entries = sessionManager.getEntries();
    const usage = normalizeUsage(getLastAssistantUsage(entries as never) as unknown);
    const messages = ((session as { messages?: unknown[] }).messages ?? []) as unknown[];
    const output = extractLastAssistantText(messages);
    const turns = countAssistantTurns(messages);
    if (timedOut || externallyAborted) {
      return {
        output,
        usage: { ...usage, turns },
        error: { reason: timedOut ? "timeout" : "stop", message: timedOut ? `subagent timed out after ${options.timeoutMs}ms` : "aborted" },
      };
    }
    // Surface a model-side terminal error (stopReason "error"/"aborted") that would
    // otherwise be reported as a silent empty-string success.
    const failure = detectAssistantFailure(messages);
    if (failure) {
      return { output, usage: { ...usage, turns }, error: failure };
    }
    return { output, structuredOutput: parseJsonOutput(output), usage: { ...usage, turns } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason: TerminalReason = timedOut ? "timeout" : externallyAborted ? "stop" : "error";
    return { output: "", usage: emptyUsageStats(), error: { reason, message } };
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    session.dispose();
  }
}

function normalizeUsage(value: unknown): UsageStats {
  const usage = emptyUsageStats();
  if (!value || typeof value !== "object") return usage;
  const record = value as Record<string, unknown>;
  const number = (key: string): number => (typeof record[key] === "number" ? (record[key] as number) : 0);
  usage.input = number("input");
  usage.output = number("output");
  usage.cacheRead = number("cacheRead");
  usage.cacheWrite = number("cacheWrite");
  usage.cost = number("cost");
  usage.contextTokens = number("totalTokens") || number("contextTokens");
  usage.turns = 1;
  return usage;
}

/**
 * The subagent's textual output. Scans backwards for the most recent assistant
 * message that actually carries text.
 *
 * A run can end with the terminal assistant message being tool-calls-only (no
 * text block) — e.g. the loop stopped right after a tool call, or the model
 * emitted only a `thinking` block. Returning that message's (empty) text made
 * `agent()` resolve to "" even though earlier assistant turns had content. We
 * therefore skip text-less assistant messages and fall back to the last one
 * that has a non-empty text block.
 */
export function extractLastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    const text = assistantMessageText(message.content);
    if (text.trim().length > 0) return text;
  }
  return "";
}

function assistantMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text: string } =>
        Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Inspect the terminal assistant message for a model-side failure that the
 * one-shot runner would otherwise swallow (returning an empty success). Maps
 * `stopReason` "error" -> error and "aborted" -> stop so `WorkflowRunner` records
 * it in `failures()` instead of counting an inert run as a success.
 */
export function detectAssistantFailure(messages: readonly unknown[]): { reason: TerminalReason; message: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
    if (message.role !== "assistant") continue;
    const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
    if (message.stopReason === "error") return { reason: "error", message: errorMessage ?? "assistant returned an error" };
    if (message.stopReason === "aborted") return { reason: "stop", message: errorMessage ?? "assistant was aborted" };
    return undefined; // Most recent assistant message finished normally.
  }
  return undefined;
}

function countAssistantTurns(messages: readonly unknown[]): number {
  let turns = 0;
  for (const message of messages) {
    if ((message as { role?: unknown }).role === "assistant") turns += 1;
  }
  return Math.max(turns, 1);
}

function parseJsonOutput(output: string): unknown | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

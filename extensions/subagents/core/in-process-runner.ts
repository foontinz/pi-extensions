import * as fs from "node:fs";
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

type ModelPatternRegistry = Pick<ReturnType<typeof ModelRegistry.create>, "getAll" | "hasConfiguredAuth">;
type PatternModel = { provider: string; id: string };

const CLI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function modelPatternQueries(pattern: string): string[] {
  const queries = [pattern.toLowerCase()];
  const colon = pattern.lastIndexOf(":");
  if (colon > 0 && CLI_THINKING_LEVELS.has(pattern.slice(colon + 1).toLowerCase())) {
    queries.push(pattern.slice(0, colon).toLowerCase());
  }
  return queries;
}

function chooseModelMatch(
  candidates: PatternModel[],
  queries: string[],
  registry: ModelPatternRegistry,
): PatternModel | undefined {
  // Exact IDs always beat fuzzy matches, even when the fuzzy match is the only
  // authenticated one. Within the same tier, configured auth remains the tie-breaker.
  for (const exact of [true, false]) {
    for (const query of queries) {
      const matches = candidates.filter((model) => exact
        ? model.id.toLowerCase() === query
        : model.id.toLowerCase().includes(query));
      if (matches.length > 0) {
        return matches.find((model) => registry.hasConfiguredAuth(model as never)) ?? matches[0];
      }
    }
  }
  return undefined;
}

/**
 * Best-effort resolution of a CLI-style model pattern (`provider/id`, `id`, or a
 * substring) to a concrete Model. Returns undefined when no pattern is given or no
 * match is found, so the session falls back to default discovery.
 */
export function resolveModelPattern(
  pattern: string | undefined,
  registry?: ModelPatternRegistry,
): unknown | undefined {
  if (!pattern || !pattern.trim()) return undefined;
  const modelRegistry = registry ?? getSharedHandles().modelRegistry;
  const all = modelRegistry.getAll() as PatternModel[];
  const raw = pattern.trim();
  const separator = raw.indexOf("/");
  const firstSegment = separator >= 0 ? raw.slice(0, separator).toLowerCase() : undefined;
  const providers = new Set(all.map((model) => model.provider.toLowerCase()));

  if (firstSegment && providers.has(firstSegment)) {
    const providerCandidates = all.filter((model) => model.provider.toLowerCase() === firstSegment);
    const canonical = chooseModelMatch(providerCandidates, modelPatternQueries(raw.slice(separator + 1)), modelRegistry);
    if (canonical) return canonical;

    // A known provider-looking prefix can also be part of a literal model ID
    // (for example, an OpenRouter ID). Only fall back after canonical matching fails.
    return chooseModelMatch(all, modelPatternQueries(raw), modelRegistry);
  }

  return chooseModelMatch(all, modelPatternQueries(raw), modelRegistry);
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
  /**
   * Persist the agent's full session transcript (JSONL) into this directory
   * instead of running in-memory. Enables after-the-fact read/grep of what the
   * agent actually did (tool calls, thinking, outputs).
   */
  sessionDir?: string;
  /** Explicit session id (controls the transcript filename suffix). */
  sessionId?: string;
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

export async function runSubagentInProcess(
  options: InProcessSubagentOptions,
  createSession: typeof createAgentSession = createAgentSession,
): Promise<SubagentResult> {
  if (options.signal?.aborted) {
    return { output: "", usage: emptyUsageStats(), error: { reason: "stop", message: "aborted before start" } };
  }

  const { authStorage, modelRegistry } = getSharedHandles();
  const sessionManager = options.sessionDir
    ? SessionManager.create(options.cwd, options.sessionDir, options.sessionId ? { id: options.sessionId } : undefined)
    : SessionManager.inMemory(options.cwd);
  // The transcript file is created lazily on the first assistant message
  // (SessionManager._persist). Only report it once it actually exists on disk,
  // so callers never advertise a read/grep path for a run that produced nothing.
  const persistedTranscript = (): string | undefined => {
    try {
      const file = sessionManager.getSessionFile();
      return file && fs.existsSync(file) ? file : undefined;
    } catch {
      return undefined;
    }
  };

  const customTools: ToolDefinition[] = [];
  let toolAllowlist = options.tools ? [...options.tools] : undefined;
  if (options.mcp) {
    const gateway = getSharedMcpGateway(options.cwd, getAgentDir());
    customTools.push(createMcpProxyTool(gateway) as ToolDefinition);
    // The allowlist (when present) gates custom tools too, so make sure `mcp` is in it.
    if (toolAllowlist && !toolAllowlist.includes("mcp")) toolAllowlist = [...toolAllowlist, "mcp"];
  }

  type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
  type Cancellation = { reason: "stop" | "timeout"; message: string };
  type CreationOutcome =
    | { kind: "created"; session: Session }
    | { kind: "create-error"; error: unknown };

  let session: Session | undefined;
  let cancellation: Cancellation | undefined;
  let resolveCancellation!: (value: Cancellation) => void;
  const cancellationPromise = new Promise<Cancellation>((resolve) => { resolveCancellation = resolve; });
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined;
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  const timeoutCancellation = (): Cancellation => ({
    reason: "timeout",
    message: `subagent timed out after ${timeoutMs}ms`,
  });

  const handleRejection = (value: unknown): void => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return;
    try {
      if (typeof (value as { then?: unknown }).then === "function") {
        void Promise.resolve(value).catch(() => {});
      }
    } catch {
      // Accessing a hostile thenable can itself throw. Cancellation must still settle.
    }
  };
  const abortSession = (target: Session | undefined): void => {
    if (!target) return;
    try {
      handleRejection(target.abort());
    } catch {
      // Cooperative abort is best effort; disposal below is the hard boundary.
    }
  };
  const disposeSession = (target: Session | undefined): void => {
    if (!target) return;
    try {
      handleRejection(target.dispose());
    } catch {
      // Disposal errors must never replace the run's terminal result.
    }
  };
  const cancel = (next: Cancellation): void => {
    if (cancellation) return;
    cancellation = next;
    // Resolve first so a synchronous abort-induced prompt settlement cannot win
    // the race over the cancellation which caused it.
    resolveCancellation(next);
    abortSession(session);
  };
  const onAbort = () => cancel({ reason: "stop", message: "aborted" });
  const checkDeadline = (): void => {
    // Timers cannot fire while synchronous session creation/prompt work blocks
    // the event loop, so also enforce the recorded wall-clock deadline directly.
    if (!cancellation && deadline !== undefined && performance.now() >= deadline) cancel(timeoutCancellation());
  };
  const partialResult = (target: Session): Pick<SubagentResult, "output" | "usage"> => {
    let entries: unknown[] = [];
    try {
      entries = sessionManager.getEntries();
    } catch {
      // Session stats may still provide complete usage without transcript entries.
    }

    let messages: unknown[] | undefined;
    try {
      const value = (target as { messages?: unknown }).messages;
      if (Array.isArray(value)) messages = value;
    } catch {
      // Usage must survive a failed message snapshot.
    }

    let output = "";
    if (messages) {
      try { output = extractLastAssistantText(messages); } catch {}
    }

    let usage = emptyUsageStats();
    try { usage = usageFromSession(target, entries); } catch {}
    if (messages) {
      try { usage.turns = countAssistantTurns(messages); } catch {}
    }
    return { output, usage };
  };

  // Both cancellation sources start before createSession, so startup is part of
  // the run's deadline. A cancelled startup is detached and cleaned up if it
  // eventually creates a session.
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = timeoutMs === undefined
    ? undefined
    : setTimeout(() => cancel(timeoutCancellation()), timeoutMs);

  try {
    // addEventListener does not replay an abort that happened before registration.
    if (options.signal?.aborted) onAbort();

    const creationPromise: Promise<CreationOutcome> = Promise.resolve()
      .then(() => createSession({
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
      }))
      .then(
        (created): CreationOutcome => ({ kind: "created", session: created.session }),
        (error): CreationOutcome => ({ kind: "create-error", error }),
      );

    const startup = await Promise.race([
      creationPromise,
      cancellationPromise.then((value) => ({ kind: "cancelled" as const, value })),
    ]);

    if (startup.kind === "cancelled") {
      // creationPromise never rejects (failures are values), so this continuation
      // handles both outcomes and safely disposes a session created after return.
      void creationPromise.then((late) => {
        if (late.kind === "created") disposeSession(late.session);
      });
      return { output: "", usage: emptyUsageStats(), sessionFile: persistedTranscript(), error: startup.value };
    }
    if (startup.kind === "create-error") {
      const message = startup.error instanceof Error ? startup.error.message : String(startup.error);
      return { output: "", usage: emptyUsageStats(), sessionFile: persistedTranscript(), error: { reason: "error", message } };
    }

    session = startup.session;
    checkDeadline();
    if (cancellation) {
      const partial = partialResult(session);
      return { ...partial, sessionFile: persistedTranscript(), error: cancellation };
    }

    const promptPromise = Promise.resolve()
      .then(() => session!.prompt(options.task))
      .then(
        () => ({ kind: "prompt-complete" as const }),
        (error) => ({ kind: "prompt-error" as const, error }),
      );
    const promptOutcome = await Promise.race([
      promptPromise,
      cancellationPromise.then((value) => ({ kind: "cancelled" as const, value })),
    ]);

    checkDeadline();
    if (cancellation) {
      const partial = partialResult(session);
      return { ...partial, sessionFile: persistedTranscript(), error: cancellation };
    }
    if (promptOutcome.kind === "cancelled") {
      const partial = partialResult(session);
      return { ...partial, sessionFile: persistedTranscript(), error: promptOutcome.value };
    }
    if (promptOutcome.kind === "prompt-error") {
      const message = promptOutcome.error instanceof Error ? promptOutcome.error.message : String(promptOutcome.error);
      const partial = partialResult(session);
      return { ...partial, sessionFile: persistedTranscript(), error: { reason: "error", message } };
    }

    try {
      const entries = sessionManager.getEntries();
      const usage = usageFromSession(session, entries);
      const messages = ((session as { messages?: unknown[] }).messages ?? []) as unknown[];
      const output = extractLastAssistantText(messages);
      const turns = countAssistantTurns(messages);
      // Surface a model-side terminal error (stopReason "error"/"aborted") that would
      // otherwise be reported as a silent empty-string success.
      const failure = detectAssistantFailure(messages);
      if (failure) {
        return { output, usage: { ...usage, turns }, sessionFile: persistedTranscript(), error: failure };
      }
      return { output, structuredOutput: parseJsonOutput(output), usage: { ...usage, turns }, sessionFile: persistedTranscript() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: "", usage: emptyUsageStats(), sessionFile: persistedTranscript(), error: { reason: "error", message } };
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    disposeSession(session);
  }
}

/**
 * Prefer the session's cumulative stats: they sum input/output/cost across ALL
 * assistant turns and expose `cost` as a single number. The per-message usage
 * from `getLastAssistantUsage` only covers the final turn and stores `cost` as
 * an object (`{ total, ... }`), which the legacy numeric parse below read as 0 —
 * that's why workflow/subagent spend always showed $0. Falls back to the
 * per-message path if stats are unavailable.
 */
function usageFromSession(session: unknown, entries: unknown[]): UsageStats {
  try {
    const stats = (session as {
      getSessionStats?: () => {
        tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
        cost?: number;
        contextUsage?: { tokens?: number };
      };
    }).getSessionStats?.();
    if (stats?.tokens) {
      const usage = emptyUsageStats();
      usage.input = stats.tokens.input ?? 0;
      usage.output = stats.tokens.output ?? 0;
      usage.cacheRead = stats.tokens.cacheRead ?? 0;
      usage.cacheWrite = stats.tokens.cacheWrite ?? 0;
      usage.cost = typeof stats.cost === "number" ? stats.cost : 0;
      usage.contextTokens = stats.contextUsage?.tokens ?? stats.tokens.total ?? 0;
      return usage;
    }
  } catch {
    // fall through to the per-message estimate below
  }
  return normalizeUsage(getLastAssistantUsage(entries as never) as unknown);
}

export function normalizeUsage(value: unknown): UsageStats {
  const usage = emptyUsageStats();
  if (!value || typeof value !== "object") return usage;
  const record = value as Record<string, unknown>;
  const number = (key: string): number => (typeof record[key] === "number" ? (record[key] as number) : 0);
  const nested = (key: string): number => {
    const v = record[key];
    if (typeof v === "number") return v;
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).total === "number") {
      return (v as { total: number }).total;
    }
    return 0;
  };
  usage.input = number("input");
  usage.output = number("output");
  usage.cacheRead = number("cacheRead");
  usage.cacheWrite = number("cacheWrite");
  usage.cost = nested("cost");
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
    // `||` (not `??`): an empty-string errorMessage should still fall back to the default.
    if (message.stopReason === "error") return { reason: "error", message: errorMessage || "assistant returned an error" };
    if (message.stopReason === "aborted") return { reason: "stop", message: errorMessage || "assistant was aborted" };
    if (message.stopReason === "length") return { reason: "error", message: errorMessage || "assistant response was truncated (token limit)" };
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

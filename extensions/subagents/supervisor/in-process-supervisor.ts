/**
 * In-process subagent supervisor.
 *
 * Drives a nested `AgentSession` in the parent process (no `pi` subprocess / tmux)
 * and forwards its live `AgentSessionEvent` stream to a callback. The event shapes
 * are identical to the `--mode json` stdout stream the subprocess path parsed, so
 * the caller can feed them straight into the existing `processEvent` machinery.
 */

import {
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type AgentSessionEvent,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getSharedMcpGateway } from "../mcp/gateway.js";
import { createMcpProxyTool } from "../mcp/proxy-tool.js";
import { createBareResourceLoader, getSharedModelRuntime, resolveModelPattern } from "../core/in-process-runner.js";

export interface InProcessStartOptions {
  cwd: string;
  task: string;
  tools: string[];
  /** Abort startup when the invoking tool call is cancelled. */
  signal?: AbortSignal;
  /** Inject the shared `mcp` gateway tool (forwards to the process-wide MCP pool). */
  mcp?: boolean;
  model?: string;
  thinking?: string;
  /**
   * Combined append prompt (agent + user + JSON addendum). Appended to pi's default
   * coding system prompt, matching the subprocess `--append-system-prompt` behavior.
   */
  appendSystemPrompt?: string;
  /**
   * Persist the agent's full session transcript (JSONL) into this directory
   * instead of running in-memory, so it can be read/grepped after the fact.
   */
  sessionDir?: string;
  /** Explicit session id (controls the transcript filename suffix). */
  sessionId?: string;
  onEvent: (event: AgentSessionEvent) => void;
  onDone: (outcome: InProcessOutcome) => void;
}

export interface InProcessOutcome {
  aborted: boolean;
  error?: string;
}

export interface InProcessHandle {
  /** Ask the session to abort cooperatively. */
  abort: () => void;
  /** Immediately dispose the session and settle the supervisor as aborted. */
  forceAbort?: () => void;
  /** Idempotent alias for forceAbort, for shutdown/cleanup callers. */
  dispose?: () => void;
  /** Stop treating the invoking tool call's signal as job cancellation. */
  detachStartupSignal?: () => void;
  modelResolved: boolean;
}

let createSession: typeof createAgentSession = createAgentSession;
let createModelRuntime: typeof getSharedModelRuntime = getSharedModelRuntime;

export function startInProcessAgent(options: InProcessStartOptions): InProcessHandle {
  let aborted = false;
  let forceAborted = false;
  let completionDelivered = false;
  let completionRetryQueued = false;
  let automaticCompletionRetryUsed = false;
  let pendingOutcome: InProcessOutcome | undefined;
  let session: AgentSession | undefined;
  let disposedSession: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let startupSignalAttached = false;

  const detachStartupSignal = () => {
    if (!startupSignalAttached) return;
    options.signal?.removeEventListener("abort", onSignalAbort);
    startupSignalAttached = false;
  };
  const disposeSession = () => {
    try { unsubscribe?.(); } catch {}
    unsubscribe = undefined;
    if (!session || disposedSession === session) return;
    disposedSession = session;
    try { session.dispose(); } catch {}
  };
  const deliverCompletion = (allowAutomaticRetry: boolean) => {
    if (completionDelivered || !pendingOutcome) return;
    try {
      options.onDone(pendingOutcome);
      completionDelivered = true;
      detachStartupSignal();
    } catch (error) {
      // Do not mark completion delivered until the owner accepts it. Retry once
      // after supervisor cleanup; forceAbort/dispose can retry again later.
      if (allowAutomaticRetry && !automaticCompletionRetryUsed && !completionRetryQueued) {
        completionRetryQueued = true;
        queueMicrotask(() => {
          completionRetryQueued = false;
          automaticCompletionRetryUsed = true;
          deliverCompletion(false);
        });
      } else {
        console.error("in-process supervisor completion callback failed", error);
      }
    }
  };
  const finish = (outcome: InProcessOutcome) => {
    pendingOutcome ??= outcome;
    detachStartupSignal();
    deliverCompletion(true);
  };
  const abortCooperatively = () => {
    aborted = true;
    try {
      const pending = session?.abort();
      void pending?.catch(() => {});
    } catch {
      // The caller's grace timer owns escalation to forceAbort().
    }
  };
  const forceAbort = () => {
    if (forceAborted) {
      // Disposal remains idempotent, but a previously rejected completion
      // callback gets another chance to accept the stored terminal outcome.
      deliverCompletion(false);
      return;
    }
    forceAborted = true;
    if (!aborted) abortCooperatively();
    disposeSession();
    finish({ aborted: true });
  };
  const onSignalAbort = () => forceAbort();

  const handle: InProcessHandle = {
    abort: abortCooperatively,
    forceAbort,
    dispose: forceAbort,
    detachStartupSignal,
    modelResolved: !options.model,
  };

  if (options.signal?.aborted) forceAbort();
  else if (options.signal) {
    startupSignalAttached = true;
    options.signal.addEventListener("abort", onSignalAbort, { once: true });
  }

  void (async () => {
    try {
      if (forceAborted) return;
      const modelRuntime = await createModelRuntime();
      if (forceAborted) return;
      const model = resolveModelPattern(options.model, modelRuntime);
      handle.modelResolved = !options.model || model !== undefined;
      const customTools: ToolDefinition[] = [];
      let toolAllowlist = options.tools.length > 0 ? [...options.tools] : undefined;
      if (options.mcp) {
        customTools.push(createMcpProxyTool(getSharedMcpGateway(options.cwd, getAgentDir())) as ToolDefinition);
        if (toolAllowlist && !toolAllowlist.includes("mcp")) toolAllowlist = [...toolAllowlist, "mcp"];
      }
      const created = await createSession({
        cwd: options.cwd,
        agentDir: getAgentDir(),
        modelRuntime,
        model: model as never,
        thinkingLevel: options.thinking as never,
        resourceLoader: createBareResourceLoader(undefined, options.appendSystemPrompt ? [options.appendSystemPrompt] : []),
        tools: toolAllowlist,
        noTools: toolAllowlist && toolAllowlist.length === 0 ? "all" : undefined,
        customTools: customTools.length > 0 ? customTools : undefined,
        sessionManager: options.sessionDir
          ? SessionManager.create(options.cwd, options.sessionDir, options.sessionId ? { id: options.sessionId } : undefined)
          : SessionManager.inMemory(options.cwd),
        settingsManager: SettingsManager.create(options.cwd, getAgentDir()),
      });
      session = created.session;

      if (aborted) {
        disposeSession();
        finish({ aborted: true });
        return;
      }
      if (!session.model) {
        disposeSession();
        finish({ aborted: false, error: "no model available for in-process subagent (configure a default model or pass model)" });
        return;
      }

      unsubscribe = session.subscribe((event) => {
        try {
          options.onEvent(event);
        } catch {
          // Event forwarding must never destabilize the session.
        }
      });

      try {
        await session.prompt(options.task);
        finish({ aborted });
      } finally {
        disposeSession();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish({ aborted, error: message });
      disposeSession();
    }
  })();

  return handle;
}

export const __inProcessSupervisorTest = {
  setCreateAgentSession(factory: typeof createAgentSession | undefined): void {
    createSession = factory ?? createAgentSession;
  },
  setModelRuntime(factory: typeof getSharedModelRuntime | undefined): void {
    createModelRuntime = factory ?? getSharedModelRuntime;
  },
};

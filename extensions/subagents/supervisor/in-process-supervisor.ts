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
} from "@earendil-works/pi-coding-agent";
import { createBareResourceLoader, getSharedHandles, resolveModelPattern } from "../core/in-process-runner.js";

export interface InProcessStartOptions {
  cwd: string;
  task: string;
  tools: string[];
  model?: string;
  thinking?: string;
  /**
   * Combined append prompt (agent + user + JSON addendum). Appended to pi's default
   * coding system prompt, matching the subprocess `--append-system-prompt` behavior.
   */
  appendSystemPrompt?: string;
  onEvent: (event: AgentSessionEvent) => void;
  onDone: (outcome: InProcessOutcome) => void;
}

export interface InProcessOutcome {
  aborted: boolean;
  error?: string;
}

export interface InProcessHandle {
  abort: () => void;
  modelResolved: boolean;
}

export function startInProcessAgent(options: InProcessStartOptions): InProcessHandle {
  const { authStorage, modelRegistry } = getSharedHandles();
  const model = resolveModelPattern(options.model);
  let aborted = false;
  let session: AgentSession | undefined;

  const handle: InProcessHandle = {
    abort: () => {
      aborted = true;
      void session?.abort();
    },
    modelResolved: !options.model || model !== undefined,
  };

  void (async () => {
    try {
      const created = await createAgentSession({
        cwd: options.cwd,
        agentDir: getAgentDir(),
        authStorage,
        modelRegistry,
        model: model as never,
        thinkingLevel: options.thinking as never,
        resourceLoader: createBareResourceLoader(undefined, options.appendSystemPrompt ? [options.appendSystemPrompt] : []),
        tools: options.tools.length > 0 ? [...options.tools] : undefined,
        noTools: options.tools.length === 0 ? "all" : undefined,
        sessionManager: SessionManager.inMemory(options.cwd),
        settingsManager: SettingsManager.create(options.cwd, getAgentDir()),
      });
      session = created.session;

      if (aborted) {
        session.dispose();
        options.onDone({ aborted: true });
        return;
      }
      if (!session.model) {
        session.dispose();
        options.onDone({ aborted: false, error: "no model available for in-process subagent (configure a default model or pass model)" });
        return;
      }

      const unsubscribe = session.subscribe((event) => {
        try {
          options.onEvent(event);
        } catch {
          // Event forwarding must never destabilize the session.
        }
      });

      try {
        await session.prompt(options.task);
        options.onDone({ aborted });
      } finally {
        unsubscribe();
        session.dispose();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onDone({ aborted, error: message });
    }
  })();

  return handle;
}

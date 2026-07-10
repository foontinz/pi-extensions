import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

// goal: a persistent objective loop, inspired by Codex/Claude Code `/goal`.
//
// `/goal <objective>` sets a completion condition and keeps the agent working
// autonomously across turns until it declares the goal achieved (or blocked and
// needing you). A live overlay shows iterations / turns / elapsed / context.
//
//   /goal <text>            set an objective and start working toward it
//   /goal max=20 <text>     same, but cap auto-iterations at 20
//   /goal status            show the current objective and stats
//   /goal stop|clear|done   stop the loop and clear the objective
//
// The agent signals progress with sentinels on their own line:
//   [[GOAL_ACHIEVED]]              -> loop stops, success
//   [[GOAL_BLOCKED: <question>]]   -> loop pauses, asks you; resume with /goal

const DEFAULT_MAX_ITERATIONS = 30;
const MAX_ITERATIONS = 500;
const MAX_GOAL_LENGTH = 10_000;
const MAX_BLOCKED_REASON_LENGTH = 4_000;
const MAX_PERSISTED_TURNS = 1_000_000;
const STATE_ENTRY = "goal-state";

interface GoalState {
  goal: string;
  startedAt: number;
  iterations: number; // completed agent runs while active
  turns: number; // LLM turns while active
  maxIterations: number;
  active: boolean;
  blockedReason?: string;
}

interface AssistantLike {
  role: string;
  content: Array<{ type: string; text?: string }>;
  stopReason?: unknown;
}

interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
  message?: unknown;
}

type GoalSignal = { type: "achieved" } | { type: "blocked"; reason: string } | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedNonNegativeInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function readGoalState(data: unknown): GoalState | undefined {
  if (!isRecord(data)) return undefined;

  const goal = typeof data.goal === "string" ? data.goal.trim() : "";
  if (!goal || goal.length > MAX_GOAL_LENGTH) return undefined;
  if (!isBoundedNonNegativeInteger(data.startedAt, Number.MAX_SAFE_INTEGER) || data.startedAt === 0) return undefined;
  if (!isBoundedNonNegativeInteger(data.maxIterations, MAX_ITERATIONS) || data.maxIterations === 0) return undefined;
  if (!isBoundedNonNegativeInteger(data.iterations, data.maxIterations)) return undefined;
  if (!isBoundedNonNegativeInteger(data.turns, MAX_PERSISTED_TURNS)) return undefined;
  if (typeof data.active !== "boolean") return undefined;

  let blockedReason: string | undefined;
  if (data.blockedReason !== undefined) {
    if (typeof data.blockedReason !== "string") return undefined;
    blockedReason = data.blockedReason.trim();
    if (!blockedReason || blockedReason.length > MAX_BLOCKED_REASON_LENGTH) return undefined;
  }

  // Contradictory or exhausted state must never restart an automatic loop.
  const active = data.active && !blockedReason && data.iterations < data.maxIterations;
  return {
    goal,
    startedAt: data.startedAt,
    iterations: data.iterations,
    turns: data.turns,
    maxIterations: data.maxIterations,
    active,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

function assistantText(msg: AssistantLike): string {
  return msg.content
    .map((p) => (p.type === "text" ? p.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

function finalAssistantFromBranch(entries: unknown[]): AssistantLike | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as SessionEntryLike | undefined;
    if (entry?.type !== "message") continue;

    const message = entry.message as AssistantLike | undefined;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    return message;
  }
  return undefined;
}

function finalGoalSignal(text: string): GoalSignal {
  // A trailing line ending is conventional output formatting, but no blank line,
  // text, or whitespace may follow the sentinel.
  const withoutFinalNewline = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  const finalLine = withoutFinalNewline.slice(withoutFinalNewline.lastIndexOf("\n") + 1);

  if (finalLine === "[[GOAL_ACHIEVED]]") return { type: "achieved" };

  const blocked = /^\[\[GOAL_BLOCKED: (\S(?:[^\]\r\n]*\S)?)\]\]$/.exec(finalLine);
  return blocked ? { type: "blocked", reason: blocked[1] } : undefined;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export default function (pi: ExtensionAPI) {
  let state: GoalState | undefined;

  const persist = () => {
    try {
      pi.appendEntry(STATE_ENTRY, state ? { ...state } : { active: false });
    } catch {
      // never let persistence crash the host
    }
  };

  const contextTokens = (ctx: ExtensionContext): string => {
    try {
      const u = ctx.getContextUsage?.();
      if (u && typeof u.tokens === "number") {
        return u.tokens >= 1000 ? `${Math.round(u.tokens / 1000)}k` : String(u.tokens);
      }
    } catch {}
    return "?";
  };

  const renderWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!state) {
      ctx.ui.setWidget("goal", []);
      ctx.ui.setStatus("goal", "");
      return;
    }
    const elapsed = fmtDuration(Date.now() - state.startedAt);
    const status = state.active ? "active" : state.blockedReason ? "blocked" : "paused";
    const header =
      `🎯 goal (${status}) · ${state.iterations}/${state.maxIterations} iters · ` +
      `${state.turns} turns · ${elapsed} · ctx ${contextTokens(ctx)}`;
    const lines = [header, `   ${truncate(state.goal, 100)}`];
    if (state.blockedReason) lines.push(`   ⚠ needs you: ${truncate(state.blockedReason, 100)}`);
    ctx.ui.setWidget("goal", lines);
    ctx.ui.setStatus("goal", `🎯 ${status}`);
  };

  const clearGoal = (ctx: ExtensionContext, note?: string) => {
    state = undefined;
    persist();
    renderWidget(ctx);
    if (note && ctx.hasUI) ctx.ui.notify(note, "info");
  };

  const restoreGoalState = (ctx: ExtensionContext) => {
    state = undefined;
    try {
      const branch = ctx.sessionManager.getBranch() as unknown[];
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i] as SessionEntryLike | undefined;
        if (entry?.type === "custom" && entry.customType === STATE_ENTRY) {
          // The newest state entry is authoritative. Do not fall back to an
          // older branch state when it is malformed or explicitly cleared.
          state = readGoalState(entry.data);
          break;
        }
      }
    } catch {
      state = undefined;
    }
  };

  // Inject the persistent objective + completion protocol into the system prompt
  // for every turn while the goal is active.
  pi.on("before_agent_start", (event: { systemPrompt: string }, _ctx: ExtensionContext) => {
    if (!state?.active) return undefined;
    const block = [
      "<active_goal>",
      "You are working toward a persistent GOAL that spans multiple turns. Keep working",
      "autonomously — plan, take actions, verify — without waiting for further user input.",
      "Do not stop after a single step; continue until the goal is genuinely complete.",
      "",
      `GOAL: ${state.goal}`,
      "",
      "Completion protocol (put the sentinel on its own line at the very end of a message):",
      "- When the goal is fully satisfied and verified, output exactly: [[GOAL_ACHIEVED]]",
      "- If you are genuinely blocked and need a user decision, output exactly:",
      "  [[GOAL_BLOCKED: <the specific question or decision you need>]]",
      "Do not emit either sentinel until it truly applies. Never fabricate completion.",
      "</active_goal>",
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
    if (!state?.active) return;
    state.turns++;
    renderWidget(ctx);
  });

  // Decide only after Pi has exhausted its own retries, compaction recovery,
  // and queued messages. agent_end is too early: its final assistant state can
  // still be replaced by a retry or follow-up.
  pi.on("agent_settled", (_event: unknown, ctx: ExtensionContext) => {
    if (!state?.active) return;

    const finalAssistant = finalAssistantFromBranch(ctx.sessionManager.getBranch() as unknown[]);
    if (!finalAssistant || finalAssistant.stopReason !== "stop") {
      // Pause after failed, aborted, truncated, or tool-use-only terminal state.
      // Leaving the state active would inject an abandoned goal into the next
      // unrelated user prompt and could restart the autonomous loop.
      state.active = false;
      persist();
      renderWidget(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify('🎯 goal paused after an incomplete agent run. Run "/goal" to resume.', "warning");
      }
      return;
    }

    state.iterations++;
    const signal = finalGoalSignal(assistantText(finalAssistant));

    if (signal?.type === "achieved") {
      const summary =
        `🎯 goal achieved in ${state.iterations} iters / ${state.turns} turns / ` +
        `${fmtDuration(Date.now() - state.startedAt)}.`;
      clearGoal(ctx, summary);
      return;
    }

    if (signal?.type === "blocked") {
      state.active = false;
      state.blockedReason = signal.reason;
      persist();
      renderWidget(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(`🎯 goal paused — needs you: ${truncate(state.blockedReason, 120)}`, "warning");
      }
      return;
    }

    if (state.iterations >= state.maxIterations) {
      state.active = false;
      persist();
      renderWidget(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `🎯 goal loop hit ${state.maxIterations} iterations without completion. ` +
            `Run "/goal" to resume or "/goal stop" to clear.`,
          "warning",
        );
      }
      return;
    }

    persist();
    renderWidget(ctx);
    // A different extension may have started a run from its own settled hook.
    // Do not corrupt that run by injecting a goal continuation into it.
    if (!ctx.isIdle()) return;

    // sendUserMessage is fire-and-forget (void): Pi exposes no dispatch or
    // queue acknowledgement, so this is deliberately one enqueue request per
    // agent_settled event rather than a delivery-guaranteed retry.
    pi.sendUserMessage(
      "Continue working toward the active goal. If it is already fully satisfied and verified, " +
        "reply with [[GOAL_ACHIEVED]]; if you are blocked and need a decision, reply with " +
        "[[GOAL_BLOCKED: <question>]].",
      { deliverAs: "followUp" },
    );
  });

  // Reconstruct state after /reload or resume from the selected branch only.
  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    restoreGoalState(ctx);
    renderWidget(ctx);
  });

  // /tree changes the active branch without recreating the extension runtime.
  pi.on("session_tree", (_event: unknown, ctx: ExtensionContext) => {
    restoreGoalState(ctx);
    renderWidget(ctx);
  });

  pi.on("session_shutdown", () => {
    // in-memory only; persisted via appendEntry already
  });

  const showStatus = (ctx: ExtensionCommandContext) => {
    if (!state) {
      ctx.ui.notify("🎯 no active goal. Set one with: /goal <objective>", "info");
      return;
    }
    const elapsed = fmtDuration(Date.now() - state.startedAt);
    const status = state.active ? "active" : state.blockedReason ? "blocked" : "paused";
    ctx.ui.notify(
      `🎯 goal (${status}): ${truncate(state.goal, 140)}\n` +
        `${state.iterations}/${state.maxIterations} iters · ${state.turns} turns · ${elapsed}` +
        (state.blockedReason ? `\nneeds you: ${state.blockedReason}` : ""),
      "info",
    );
  };

  pi.registerCommand("goal", {
    description: "Set a persistent objective the agent keeps working toward until done. /goal <objective> | status | stop",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["status", "stop", "clear", "done"].map((v) => ({ value: v, label: v }));
      const f = opts.filter((o) => o.value.startsWith(prefix));
      return f.length > 0 ? f : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const raw = (args ?? "").trim();
      const lower = raw.toLowerCase();

      if (lower === "status" || (raw === "" && !state)) {
        showStatus(ctx);
        return;
      }

      // Commands run immediately even while an agent is streaming. Refuse
      // mutations then so a command cannot replace or resume a goal halfway
      // through another run.
      if (!ctx.isIdle()) {
        ctx.ui.notify("🎯 wait for the current agent run to finish before changing the goal.", "warning");
        return;
      }

      if (lower === "stop" || lower === "clear" || lower === "cancel" || lower === "done") {
        if (!state) {
          ctx.ui.notify("🎯 no active goal to clear.", "info");
          return;
        }
        clearGoal(ctx, "🎯 goal cleared.");
        return;
      }

      // No args but a goal exists -> resume the loop (e.g. after block/max).
      if (raw === "" && state) {
        state.active = true;
        state.iterations = 0;
        state.blockedReason = undefined;
        persist();
        renderWidget(ctx);
        ctx.ui.notify("🎯 resuming goal loop.", "info");
        pi.sendUserMessage("Resume working toward the active goal now.", { deliverAs: "followUp" });
        return;
      }

      // Optional "max=NN" prefix to cap iterations.
      let maxIterations = DEFAULT_MAX_ITERATIONS;
      let goalText = raw;
      const maxMatch = /^max\s*=\s*(\d+)\s+(.*)$/is.exec(raw);
      if (maxMatch) {
        maxIterations = Math.max(1, Math.min(MAX_ITERATIONS, parseInt(maxMatch[1], 10)));
        goalText = maxMatch[2].trim();
      }
      if (!goalText) {
        ctx.ui.notify("🎯 usage: /goal <objective>  (optional: /goal max=20 <objective>)", "warning");
        return;
      }
      if (goalText.length > MAX_GOAL_LENGTH) {
        ctx.ui.notify(`🎯 goal is too long (maximum ${MAX_GOAL_LENGTH} characters).`, "warning");
        return;
      }

      state = {
        goal: goalText,
        startedAt: Date.now(),
        iterations: 0,
        turns: 0,
        maxIterations,
        active: true,
      };
      persist();
      renderWidget(ctx);
      ctx.ui.notify(`🎯 goal set (max ${maxIterations} iters). Working toward it now…`, "info");
      pi.sendUserMessage("Start working toward the active goal now.", { deliverAs: "followUp" });
    },
  });
}

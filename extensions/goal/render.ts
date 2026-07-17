import type { GoalCheckpointV2, GoalPhase } from "./state.ts";

export interface GoalContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent?: number | null;
}

export interface GoalRenderOptions {
  /** Current context usage. Null/unknown token counts render as `ctx ?`. */
  contextUsage?: GoalContextUsage | null;
  /** Explicit Pi-style percentage; takes precedence over contextUsage. */
  contextPercent?: number | null;
  /** Used only by callers that include elapsed duration in surrounding UI. */
  now?: number;
  /** Maximum code-point width for each returned line. */
  maxWidth?: number;
  /** Maximum code-point width for model-authored attention detail. */
  nextActionWidth?: number;
  /** A caller displaying the last valid checkpoint may flag a corrupt newer authority. */
  corruptState?: boolean;
}

export type GoalAttentionOwner = "user" | "task" | "machine" | "terminal";

export interface GoalAttention {
  owner: GoalAttentionOwner;
  badge: string;
  detail: string;
  tone: "accent" | "warning" | "error" | "success" | "muted";
}

export interface GoalPhaseDisplay {
  phase?: GoalPhase;
  ordinal: number;
  total: number;
  title: string;
}

/** Flatten whitespace and truncate without splitting a Unicode code point. */
export function truncateOneLine(value: string, maxLength: number): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) throw new RangeError("maxLength must be a non-negative integer");
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(flat);
  if (characters.length <= maxLength) return flat;
  if (maxLength === 0) return "";
  if (maxLength === 1) return "…";
  return `${characters.slice(0, maxLength - 1).join("")}…`;
}

function inferredActivePhaseIndex(checkpoint: GoalCheckpointV2): number {
  if (checkpoint.activePhaseId) {
    const index = checkpoint.phases.findIndex((phase) => phase.id === checkpoint.activePhaseId);
    if (index >= 0) return index;
  }
  return checkpoint.phases.findIndex((phase) =>
    phase.status === "running"
    || phase.status === "candidate_complete"
    || phase.status === "verifying"
    || phase.status === "blocked");
}

export function getGoalPhaseDisplay(checkpoint: GoalCheckpointV2): GoalPhaseDisplay {
  const index = inferredActivePhaseIndex(checkpoint);
  if (index < 0) {
    return {
      ordinal: checkpoint.phases.length === 0 ? 0 : 1,
      total: checkpoint.phases.length,
      title: checkpoint.phases.length === 0 ? "planning" : checkpoint.phases[0].title,
      ...(checkpoint.phases[0] ? { phase: checkpoint.phases[0] } : {}),
    };
  }
  return {
    phase: checkpoint.phases[index],
    ordinal: index + 1,
    total: checkpoint.phases.length,
    title: checkpoint.phases[index].title,
  };
}

export function isInterruptedGoal(checkpoint: GoalCheckpointV2): boolean {
  return checkpoint.pauseReason === "interrupted"
    || checkpoint.scheduler.state === "recovery_required";
}


function validPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function goalContextPercent(options: GoalRenderOptions = {}): number | undefined {
  if (options.contextPercent === null) return undefined;
  if (validPercent(options.contextPercent)) return options.contextPercent;
  const usage = options.contextUsage;
  if (!usage || usage.tokens === null) return undefined;
  if (usage.percent === null) return undefined;
  if (validPercent(usage.percent)) return usage.percent;
  if (validPercent(usage.tokens) && validPercent(usage.contextWindow) && usage.contextWindow > 0) {
    return (usage.tokens / usage.contextWindow) * 100;
  }
  return undefined;
}

export function formatContextPercent(value: number | null | undefined): string {
  return validPercent(value) ? `${Math.round(value)}%` : "?";
}


export function getGoalNextAction(checkpoint: GoalCheckpointV2): string {
  const phase = getGoalPhaseDisplay(checkpoint).phase;
  return checkpoint.ledger.nextAction
    ?? phase?.nextAction
    ?? (isInterruptedGoal(checkpoint)
      ? "Reconcile current files, git state, and evidence before repeating work."
      : "Record the next concrete action.");
}

function attentionDetail(value: string, options: GoalRenderOptions): string {
  return truncateOneLine(value, options.nextActionWidth ?? 72);
}

/** Derive who owns the next action without adding any persisted state. */
export function getGoalAttention(
  checkpoint: GoalCheckpointV2,
  options: GoalRenderOptions = {},
): GoalAttention {
  const nextAction = (): string => attentionDetail(getGoalNextAction(checkpoint), options);

  if (options.corruptState || checkpoint.pauseReason === "corrupt_state") {
    return {
      owner: "user",
      badge: "PAUSED — CORRUPT STATE",
      detail: "run /goal resume to recover or /goal stop to discard",
      tone: "error",
    };
  }
  if (checkpoint.lifecycle === "failed") {
    return { owner: "terminal", badge: "FAILED", detail: nextAction(), tone: "error" };
  }
  if (checkpoint.lifecycle === "cancelled") {
    return { owner: "terminal", badge: "CANCELLED", detail: nextAction(), tone: "error" };
  }
  if (checkpoint.lifecycle === "succeeded") {
    return { owner: "terminal", badge: "SUCCEEDED", detail: "", tone: "success" };
  }
  if (checkpoint.scheduler.state === "dispatch_pending" || checkpoint.scheduler.state === "run_in_flight") {
    return { owner: "machine", badge: "WORKING", detail: nextAction(), tone: "accent" };
  }
  if (checkpoint.scheduler.state === "compaction_pending" || checkpoint.compaction.state === "pending") {
    return {
      owner: "machine",
      badge: "RECOVERING — COMPACTING",
      detail: "nothing needed from you",
      tone: "muted",
    };
  }
  if (checkpoint.lifecycle === "blocked") {
    const question = [...checkpoint.ledger.openQuestions]
      .reverse()
      .find((value) => value.trim().length > 0);
    return {
      owner: "user",
      badge: "WAITING FOR YOU",
      detail: attentionDetail(question ?? getGoalNextAction(checkpoint), options),
      tone: "warning",
    };
  }
  if (checkpoint.lifecycle === "waiting_external" && checkpoint.waitFor) {
    const kind = checkpoint.waitFor.kind;
    const id = truncateOneLine(checkpoint.waitFor.id, 48);
    return {
      owner: "task",
      badge: `WAITING FOR TASK ${kind} ${id}`,
      detail: "auto-resumes on completion or failure",
      tone: "accent",
    };
  }
  if (checkpoint.lifecycle === "waiting_external") {
    return {
      owner: "user",
      badge: "WAITING FOR YOU",
      detail: attentionDetail(`tell me when done: ${getGoalNextAction(checkpoint)}`, options),
      tone: "warning",
    };
  }
  if (checkpoint.lifecycle === "verifying_goal" && checkpoint.scheduler.state === "idle") {
    return {
      owner: "user",
      badge: "NEEDS YOUR REVIEW",
      detail: "accept with /goal done or re-check with /goal verify",
      tone: "warning",
    };
  }
  if (checkpoint.lifecycle === "paused" || checkpoint.scheduler.state === "recovery_required") {
    const reason = checkpoint.pauseReason?.replaceAll("_", " ") ?? "recovery required";
    return {
      owner: "user",
      badge: `PAUSED (${reason})`,
      detail: "run /goal resume",
      tone: "warning",
    };
  }
  if (checkpoint.lifecycle === "recovering" && checkpoint.scheduler.state === "idle") {
    return {
      owner: "machine",
      badge: "RECOVERING",
      detail: "auto-continues; nothing needed from you",
      tone: "muted",
    };
  }
  return { owner: "machine", badge: "WORKING", detail: nextAction(), tone: "accent" };
}

/** Retained for callers that previously consumed the compact lifecycle label. */
export function formatGoalLifecycle(checkpoint: GoalCheckpointV2): string {
  return getGoalAttention(checkpoint).badge.toLowerCase();
}

function phaseLabel(checkpoint: GoalCheckpointV2, titleLimit: number): string | undefined {
  const phase = getGoalPhaseDisplay(checkpoint);
  if (phase.total === 0) return checkpoint.lifecycle === "planning" ? undefined : "plan pending";
  return `phase ${phase.ordinal}/${phase.total}: ${truncateOneLine(phase.title, titleLimit)}`;
}

function bounded(line: string, maxWidth: number | undefined): string {
  if (maxWidth === undefined || Array.from(line).length <= maxWidth) return line;
  if (maxWidth === 1) return "…";
  return `${Array.from(line).slice(0, maxWidth - 1).join("")}…`;
}

function checkedWidth(value: number | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("render width must be a positive integer");
  return value;
}

/** A single compact line suitable for `ui.setStatus` or a status notification. */
export function formatGoalStatusLine(
  checkpoint: GoalCheckpointV2,
  options: GoalRenderOptions = {},
): string {
  const width = checkedWidth(options.maxWidth);
  const attention = getGoalAttention(checkpoint, options);
  const line = [
    `🎯 ${attention.badge}`,
    phaseLabel(checkpoint, 48),
    `run ${checkpoint.budgets.epochRuns}/${checkpoint.budgets.maxEpochRuns}`,
  ].filter((part): part is string => part !== undefined).join(" · ");
  return bounded(line, width);
}

/** One restrained, information-dense row above the editor. */
export function formatGoalWidgetLines(
  checkpoint: GoalCheckpointV2,
  options: GoalRenderOptions = {},
): string[] {
  const width = checkedWidth(options.maxWidth, 140)!;
  const attention = getGoalAttention(checkpoint, options);
  const header = formatGoalStatusLine(checkpoint, { ...options, maxWidth: undefined });
  const detail = attention.detail ? `  ›  ${attention.detail}` : "";
  return [bounded(`${header}${detail}`, width)];
}

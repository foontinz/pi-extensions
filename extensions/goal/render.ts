import type { GoalCheckpointV2, GoalLifecycle, GoalPhase } from "./state.ts";

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
  nextActionWidth?: number;
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


function lifecycleLabel(lifecycle: GoalLifecycle): string {
  return lifecycle.replaceAll("_", " ");
}

export function formatGoalLifecycle(checkpoint: GoalCheckpointV2): string {
  return isInterruptedGoal(checkpoint) ? "interrupted" : lifecycleLabel(checkpoint.lifecycle);
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
  const context = formatContextPercent(goalContextPercent(options));
  const line = [
    `🎯 ${formatGoalLifecycle(checkpoint)}`,
    phaseLabel(checkpoint, 48),
    `run ${checkpoint.budgets.epochRuns}/${checkpoint.budgets.maxEpochRuns}`,
    `ctx ${context}`,
  ].filter((part): part is string => part !== undefined).join(" · ");
  return bounded(line, width);
}

/** One restrained, information-dense row above the editor. */
export function formatGoalWidgetLines(
  checkpoint: GoalCheckpointV2,
  options: GoalRenderOptions = {},
): string[] {
  const width = checkedWidth(options.maxWidth, 140)!;
  const header = formatGoalStatusLine(checkpoint, options);
  const actionLabel = isInterruptedGoal(checkpoint) ? "reconcile" : "next";
  const action = truncateOneLine(getGoalNextAction(checkpoint), options.nextActionWidth ?? 72);
  return [bounded(`${header}  ›  ${actionLabel}: ${action}`, width)];
}

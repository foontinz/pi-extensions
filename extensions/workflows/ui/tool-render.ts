import { Box, type Component, Text } from "@earendil-works/pi-tui";

/** Minimal theme surface we depend on (matches the pi `Theme` class). */
export interface ToolRenderTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
  bg(role: string, text: string): string;
}

interface RenderCtx {
  isPartial?: boolean;
  isError?: boolean;
}

interface WorkflowArgs {
  script?: string;
  scriptPath?: string;
  name?: string;
  background?: boolean;
}

interface UsageLike {
  input: number;
  output: number;
}

interface ResultDetails {
  runId?: string;
  status?: string;
  scriptPath?: string;
  agents?: number;
  failures?: unknown[];
  usage?: UsageLike;
}

interface ToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
}

function tint(context: RenderCtx, theme: ToolRenderTheme): (t: string) => string {
  const bgKey = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
  return (t) => theme.bg(bgKey, t);
}

function sourceLabel(args: WorkflowArgs | undefined): string {
  if (args?.scriptPath) return "scriptPath";
  if (args?.name) return `name ${args.name}`;
  return "inline";
}

/** Compact/full render of a `Workflow` tool call (mirrors `tool-view`). */
export function renderWorkflowCall(args: WorkflowArgs | undefined, theme: ToolRenderTheme, context: RenderCtx, full: boolean): Component {
  const box = new Box(1, 0, tint(context, theme));
  let line = `${theme.fg("toolTitle", theme.bold("Workflow"))} ${theme.fg("accent", sourceLabel(args))}`;
  if (full && args?.background === false) line += theme.fg("dim", " · foreground");
  box.addChild(new Text(line, 0, 0));
  return box;
}

/** Compact/full render of a `Workflow` tool result (mirrors `tool-view`). */
export function renderWorkflowResult(result: ToolResultLike | undefined, theme: ToolRenderTheme, context: RenderCtx, full: boolean): Component {
  const box = new Box(1, 0, tint(context, theme));
  const text = resultText(result);

  if (context.isError) {
    box.addChild(new Text(theme.fg("error", text || "Error"), 0, 0));
    return box;
  }
  if (full) {
    box.addChild(new Text(text, 0, 0));
    return box;
  }

  box.addChild(new Text(compactLine(result?.details as ResultDetails | undefined, text, theme), 0, 0));
  return box;
}

function compactLine(details: ResultDetails | undefined, text: string, theme: ToolRenderTheme): string {
  const title = theme.bold("Workflow");
  const id = details?.runId ? ` ${theme.fg("muted", details.runId)}` : "";

  if (details?.status === "running") {
    return `${theme.fg("accent", "▸")} ${title}${id} ${theme.fg("dim", "started · background")}`;
  }
  if (details?.status === "cancelled") {
    return `${theme.fg("warning", "⊘")} ${title}${id} ${theme.fg("warning", "cancelled")}`;
  }
  if (details?.status === "failed") {
    return `${theme.fg("error", "✗")} ${title}${id} ${theme.fg("error", "failed")}`;
  }
  if (details?.runId) {
    const failed = Array.isArray(details.failures) ? details.failures.length : 0;
    const bits: string[] = [];
    if (details.agents != null) bits.push(`${details.agents} agent${details.agents === 1 ? "" : "s"}`);
    if (details.usage) bits.push(`↑${compact(details.usage.input)} ↓${compact(details.usage.output)}`);
    let line = `${theme.fg(failed ? "warning" : "success", "✓")} ${title}${id} ${theme.fg("success", "done")}`;
    if (bits.length > 0) line += theme.fg("dim", ` · ${bits.join(" · ")}`);
    if (failed) line += theme.fg("error", ` · ${failed} failed`);
    return line;
  }
  return theme.fg("dim", firstLine(text));
}

function resultText(result: ToolResultLike | undefined): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
}

function compact(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

import { Box, type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { UsageStats } from "../../subagents/core/types.js";
import { compact, firstLine } from "./format.js";

/** Structured payload attached to the `workflow-notification` custom message. */
export interface WorkflowNotificationDetails {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  agents?: number;
  failures?: number;
  usage?: UsageStats;
  error?: string;
}

/** Minimal theme surface we depend on (matches the pi `Theme` class). */
export interface NotificationTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
  bg(role: string, text: string): string;
}

/**
 * Render a completed/failed workflow notification.
 *
 * Collapsed (default, mirrors `tool-view` minimized): a single tinted line.
 * Full (message expanded, or `tool-view` verbose): adds the error / summary body.
 * The LLM always receives the untouched message `content`; this only affects
 * how the entry looks in the transcript.
 */
export function renderWorkflowNotification(
  details: WorkflowNotificationDetails | undefined,
  content: string,
  full: boolean,
  theme: NotificationTheme,
): Component {
  const status = details?.status ?? "completed";
  const glyph = status === "failed"
    ? { icon: "✗", role: "error" }
    : status === "cancelled"
      ? { icon: "⊘", role: "warning" }
      : { icon: "✓", role: "success" };
  const head =
    `${theme.fg(glyph.role, glyph.icon)} ${theme.bold("Workflow")}` +
    ` ${theme.fg("muted", details?.runId ?? "")}` +
    ` ${theme.fg(glyph.role, status)}`;

  const bits: string[] = [];
  if (details?.agents != null) bits.push(theme.fg("muted", `${details.agents} agent${details.agents === 1 ? "" : "s"}`));
  if (details?.failures) bits.push(theme.fg("error", `${details.failures} failed`));
  if (details?.usage) bits.push(theme.fg("muted", `↑${compact(details.usage.input)} ↓${compact(details.usage.output)}`));
  if (details?.usage?.cost) bits.push(theme.fg("muted", `$${details.usage.cost.toFixed(details.usage.cost < 1 ? 3 : 2)}`));
  // On failure/cancellation, surface the reason inline so it stays visible even
  // when the notice is collapsed (minimized/medium tool-view mode).
  if (status !== "completed" && details?.error) {
    bits.push(theme.fg(glyph.role, truncateToWidth(firstLine(details.error), 100, "…")));
  }
  const summary = bits.length > 0 ? theme.fg("dim", " · ") + bits.join(theme.fg("dim", " · ")) : "";

  const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
  if (!full) {
    box.addChild(new Text(head + summary, 0, 0));
    return box;
  }

  const lines = [head + summary];
  const body = stripTags(content);
  if (body) lines.push(theme.fg("dim", body));
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

function stripTags(content: string): string {
  return content
    .replace(/<\/?workflow-notification>\n?/g, "")
    .trim();
}

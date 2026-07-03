import { Box, type Component, Text } from "@earendil-works/pi-tui";
import type { UsageStats } from "../../subagents/core/types.js";

/** Structured payload attached to the `workflow-notification` custom message. */
export interface WorkflowNotificationDetails {
  runId: string;
  status: "completed" | "failed";
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
  const ok = details?.status !== "failed";
  const statusRole = ok ? "success" : "error";
  const head =
    `${theme.fg(statusRole, ok ? "✓" : "✗")} ${theme.bold("Workflow")}` +
    ` ${theme.fg("muted", details?.runId ?? "")}` +
    ` ${theme.fg(statusRole, ok ? "completed" : "failed")}`;

  const bits: string[] = [];
  if (details?.agents != null) bits.push(theme.fg("muted", `${details.agents} agent${details.agents === 1 ? "" : "s"}`));
  if (details?.failures) bits.push(theme.fg("error", `${details.failures} failed`));
  if (details?.usage) bits.push(theme.fg("muted", `↑${compact(details.usage.input)} ↓${compact(details.usage.output)}`));
  if (details?.usage?.cost) bits.push(theme.fg("muted", `$${details.usage.cost.toFixed(details.usage.cost < 1 ? 3 : 2)}`));
  const summary = bits.length > 0 ? theme.fg("dim", " · ") + bits.join(theme.fg("dim", " · ")) : "";

  const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
  if (!full) {
    box.addChild(new Text(head + summary, 0, 0));
    return box;
  }

  const lines = [head + summary];
  if (details?.error) lines.push(theme.fg("error", details.error));
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

function compact(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

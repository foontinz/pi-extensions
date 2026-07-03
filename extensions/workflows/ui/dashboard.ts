import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowSnapshot } from "../index.js";

/** Minimal theme surface we depend on (matches the pi `Theme` class). */
export interface DashboardTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_SLOTS = 8;
const MAX_AGENT_ROWS = 6;
const MAX_WIDTH = 96;
const LABEL_MIN = 6;
const LABEL_MAX = 24;
const PHASE_MIN = 4;
const PHASE_MAX = 12;

/**
 * A responsive, boxed live view of a running (or just-finished) workflow.
 * Rendered as a `belowEditor` widget; recreated by the extension on every
 * animation tick so `frame` and elapsed time advance.
 */
export class WorkflowDashboard implements Component {
  constructor(
    private readonly snap: WorkflowSnapshot,
    private readonly theme: DashboardTheme,
    private readonly frame: number,
  ) {}

  invalidate(): void {
    // Stateless: a fresh instance is created per render, nothing to clear.
  }

  render(width: number): string[] {
    const w = Math.min(width, MAX_WIDTH);
    const inner = Math.max(1, w - 4); // "│ " + content + " │"
    const t = this.theme;
    const s = this.snap;

    const lines: string[] = [];
    lines.push(this.topBorder(w));
    lines.push(this.row(this.headline(inner), inner));
    lines.push(this.row(this.metrics(inner), inner));
    lines.push(this.divider(w));

    const rows = this.pickAgents();
    if (rows.length === 0) {
      lines.push(this.row(t.fg("dim", "waiting for agents…"), inner));
    } else {
      const labelW = clamp(Math.max(0, ...rows.map((r) => visibleWidth(r.label))), LABEL_MIN, Math.min(LABEL_MAX, inner));
      const phaseW = clamp(Math.max(0, ...rows.map((r) => (r.phase ? visibleWidth(r.phase) : 0))), PHASE_MIN, PHASE_MAX);
      for (const view of rows) lines.push(this.row(this.agentRow(view, inner, labelW, phaseW), inner));
      const hidden = s.agents.length - rows.length;
      if (hidden > 0) lines.push(this.row(t.fg("dim", `… ${hidden} more`), inner));
    }
    lines.push(this.bottomBorder(w));
    return lines;
  }

  // --- sections ---------------------------------------------------------

  private headline(inner: number): string {
    const t = this.theme;
    const s = this.snap;
    const { icon, role } = statusGlyph(s.status, this.frame);
    const label =
      s.status === "completed"
        ? t.fg("success", "completed")
        : s.status === "failed"
          ? t.fg("error", "failed")
          : s.status === "cancelled"
            ? t.fg("warning", "cancelled")
            : this.phaseLabel();
    const done = s.agents.filter((a) => a.status === "completed").length;
    const bar = progressBar(done, Math.max(s.launched, 1), t);
    const count = t.fg("muted", `${done}/${s.launched || 0}`);
    const left = `${t.fg(role, icon)} ${label}`;
    const right = `${bar} ${count}`;
    return joinEnds(left, right, inner);
  }

  /** Phase breadcrumb (current highlighted) while running, else the plain phase. */
  private phaseLabel(): string {
    const t = this.theme;
    const s = this.snap;
    if (s.phases.length > 1) {
      return s.phases
        .map((p) => (p === s.phase ? t.bold(t.fg("accent", p)) : t.fg("dim", p)))
        .join(t.fg("dim", " › "));
    }
    return s.phase ? t.fg("accent", s.phase) : t.fg("dim", "running");
  }

  private metrics(inner: number): string {
    const t = this.theme;
    const s = this.snap;
    const parts: string[] = [];
    const running = s.status === "running";
    if (running) {
      parts.push(t.fg("accent", `${s.active} active`));
      if (s.queued > 0) parts.push(t.fg("muted", `${s.queued} queued`));
    } else {
      parts.push(t.fg("muted", `${s.launched} agent${s.launched === 1 ? "" : "s"}`));
    }
    parts.push(t.fg("muted", `↑${compact(s.usage.input)} ↓${compact(s.usage.output)}`));
    if (s.usage.cost > 0) parts.push(t.fg("muted", `$${s.usage.cost.toFixed(s.usage.cost < 1 ? 3 : 2)}`));
    if (s.failures > 0) parts.push(t.fg("error", `${s.failures} failed`));
    if (s.rateLimited) parts.push(t.fg("warning", "rate-limited"));
    const left = parts.join(t.fg("dim", " · "));
    const right = t.fg("muted", elapsed(s.startedAt, s.finishedAt));
    return joinEnds(left, right, inner);
  }

  private agentRow(view: WorkflowSnapshot["agents"][number], inner: number, labelW: number, phaseW: number): string {
    const t = this.theme;
    const { icon, role } = agentGlyph(view.status, this.frame);
    const label = truncateToWidth(view.label, labelW, "…");
    const phase = view.phase ? truncateToWidth(view.phase, phaseW, "…") : "";
    const detail = agentDetail(view);
    const left = `${t.fg(role, icon)} ${t.fg("text", padEnd(label, labelW))}  ${t.fg("muted", padEnd(phase, phaseW))}`;
    const right = t.fg(view.status === "failed" ? "error" : "muted", detail);
    return joinEnds(left, right, inner);
  }

  private pickAgents(): WorkflowSnapshot["agents"] {
    const s = this.snap;
    if (s.agents.length <= MAX_AGENT_ROWS) return s.agents;
    const rank = (a: WorkflowSnapshot["agents"][number]): number =>
      a.status === "running" || a.status === "retrying" ? 0 : a.status === "queued" ? 1 : a.status === "failed" ? 2 : 3;
    return [...s.agents]
      .sort((a, b) => rank(a) - rank(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.index - b.index)
      .slice(0, MAX_AGENT_ROWS)
      .sort((a, b) => a.index - b.index);
  }

  // --- box helpers ------------------------------------------------------

  private topBorder(w: number): string {
    const t = this.theme;
    const title = ` ${t.bold(t.fg("accent", "Workflow"))} ${t.fg("muted", this.snap.runId || "")} `;
    const titleW = visibleWidth(title);
    const fill = Math.max(0, w - 3 - titleW - 1);
    return t.fg("border", "╭─") + title + t.fg("border", "─".repeat(fill) + "╮");
  }

  private bottomBorder(w: number): string {
    return this.theme.fg("border", `╰${"─".repeat(w - 2)}╯`);
  }

  private divider(w: number): string {
    return this.theme.fg("border", `├${"─".repeat(w - 2)}┤`);
  }

  private row(content: string, inner: number): string {
    const b = this.theme.fg("border", "│");
    return `${b} ${padEnd(content, inner)} ${b}`;
  }
}

// --- pure formatting ----------------------------------------------------

function statusGlyph(status: WorkflowSnapshot["status"], frame: number): { icon: string; role: string } {
  if (status === "completed") return { icon: "✓", role: "success" };
  if (status === "failed") return { icon: "✗", role: "error" };
  if (status === "cancelled") return { icon: "⊘", role: "warning" };
  return { icon: SPINNER[frame % SPINNER.length], role: "accent" };
}

function agentGlyph(status: WorkflowSnapshot["agents"][number]["status"], frame: number): { icon: string; role: string } {
  switch (status) {
    case "completed":
      return { icon: "✓", role: "success" };
    case "failed":
      return { icon: "✗", role: "error" };
    case "retrying":
      return { icon: "↻", role: "warning" };
    case "queued":
      return { icon: "·", role: "muted" };
    default:
      return { icon: SPINNER[frame % SPINNER.length], role: "accent" };
  }
}

function agentDetail(view: WorkflowSnapshot["agents"][number]): string {
  if (view.status === "queued") return "queued";
  if (view.status === "failed") return truncateToWidth(view.reason ?? "failed", 28, "…");
  if (view.status === "retrying") return `retry ${view.attempt}/${view.maxRetries}`;
  if (view.startedAt) return elapsed(view.startedAt, view.finishedAt);
  return "";
}

function progressBar(done: number, total: number, theme: DashboardTheme): string {
  const filled = Math.max(0, Math.min(BAR_SLOTS, Math.round((done / total) * BAR_SLOTS)));
  return theme.fg("success", "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(BAR_SLOTS - filled));
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function elapsed(startedAt: number, finishedAt?: number): string {
  const total = Math.max(0, Math.floor(((finishedAt ?? Date.now()) - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  if (m < 60) return `${m}:${sec.toString().padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}:${(m % 60).toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

function compact(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/** Right-pad accounting for ANSI escapes; truncate if too wide. */
function padEnd(s: string, w: number): string {
  const vis = visibleWidth(s);
  if (vis === w) return s;
  if (vis > w) return truncateToWidth(s, w, "…", true);
  return s + " ".repeat(w - vis);
}

/** Place `left` and `right` on one line of width `w`, right-aligning `right`. */
function joinEnds(left: string, right: string, w: number): string {
  const rw = visibleWidth(right);
  if (rw >= w) return truncateToWidth(right, w, "…", true);
  const lw = w - rw - 1;
  return `${padEnd(left, lw)} ${right}`;
}

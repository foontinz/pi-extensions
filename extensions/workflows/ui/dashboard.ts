import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowSnapshot } from "../index.js";
import { clamp, compact, elapsed, joinEnds, padEnd, sanitizeTerminalText } from "./format.js";

/** Minimal theme surface we depend on (matches the pi `Theme` class). */
export interface DashboardTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_AGENT_ROWS = 6;
const LABEL_MIN = 6;
const LABEL_MAX = 24;

/**
 * A live view of a running (or just-finished) workflow, rendered as a
 * `belowEditor` widget in the same visual language as the goal widget:
 * a borderless header line (state ◆ + phase, metrics right-aligned) with
 * tree-connector agent rows beneath it. The extension keeps the component
 * registered and updates it in place so multiple workflow widgets retain
 * their insertion order while the spinner advances.
 */
export class WorkflowDashboard implements Component {
  constructor(
    private snap: WorkflowSnapshot,
    private readonly theme: DashboardTheme,
    private frame: number,
  ) {}

  update(snap: WorkflowSnapshot, frame: number): void {
    this.snap = snap;
    this.frame = frame;
  }

  invalidate(): void {
    // Rendering is stateless; there is no cache to clear.
  }

  render(width: number): string[] {
    const t = this.theme;
    const s = this.snap;

    const lines: string[] = [this.header(width)];

    const rows = this.pickAgents();
    const hidden = s.agents.length - rows.length;
    if (rows.length === 0) {
      lines.push(truncateToWidth(`   ${t.fg("dim", "└─ waiting for agents…")}`, width));
      return lines;
    }
    const labelW = clamp(Math.max(0, ...rows.map((r) => visibleWidth(r.label))), LABEL_MIN, Math.min(LABEL_MAX, width));
    for (const [i, view] of rows.entries()) {
      const last = hidden === 0 && i === rows.length - 1;
      lines.push(this.agentRow(view, width, labelW, last));
    }
    if (hidden > 0) lines.push(truncateToWidth(`   ${t.fg("dim", `└─ … ${hidden} more`)}`, width));
    return lines;
  }

  // --- sections ---------------------------------------------------------

  /** `◆  RUNNING  │  PHASE 2/2  synthesize` with dim metrics right-aligned. */
  private header(width: number): string {
    const t = this.theme;
    const s = this.snap;
    const paint = (text: string): string => t.fg(statusRole(s.status), text);
    const left = paint("◆") + "  " + paint(t.bold(statusLabel(s.status, this.frame))) + t.fg("dim", "  │  ") + this.phaseLabel();

    const done = s.agents.filter((a) => a.status === "completed").length;
    // Keep workflow state/phase visible first. Add right-side metrics in
    // priority order only while they fit the remaining width.
    const alerts: string[] = [];
    if (s.failures > 0) alerts.push(t.fg("error", t.bold(`${s.failures} FAILED`)));
    if (s.rateLimited) alerts.push(t.fg("warning", t.bold("RATE-LIMITED")));
    const candidates = [
      ...alerts,
      t.fg("dim", `RUN ${done}/${s.launched || 0}`),
      t.fg("dim", elapsed(s.startedAt, s.finishedAt)),
      t.fg("dim", `↑${compact(s.usage.input)} ↓${compact(s.usage.output)}`),
      t.fg("dim", `$${s.usage.cost.toFixed(s.usage.cost < 1 ? 3 : 2)}`),
    ];
    const reservedLeft = Math.min(visibleWidth(left), Math.max(20, Math.floor(width * 0.55)));
    const availableRight = Math.max(0, width - reservedLeft - 2);
    const selected: string[] = [];
    let selectedWidth = 0;
    for (const candidate of candidates) {
      const extra = visibleWidth(candidate) + (selected.length > 0 ? 3 : 0);
      if (selectedWidth + extra > availableRight) continue;
      selected.push(candidate);
      selectedWidth += extra;
    }
    const right = selected.join(t.fg("dim", " · "));
    if (!right) return truncateToWidth(left, width, "…");
    const leftFit = truncateToWidth(left, Math.max(1, width - visibleWidth(right) - 2), "…");
    const gap = " ".repeat(Math.max(2, width - visibleWidth(leftFit) - visibleWidth(right)));
    return truncateToWidth(leftFit + gap + right, width);
  }

  /** `WORKFLOW  PHASE 2/2  synthesize` while running, else the origin/run id. */
  private phaseLabel(): string {
    const t = this.theme;
    const s = this.snap;
    // The muted WORKFLOW tag keeps this header distinguishable from the goal
    // widget, which shares the `◆  STATE  │  PHASE x/y` shape.
    const tag = t.fg("muted", "WORKFLOW") + "  ";
    if (s.phase && s.phases.length > 0) {
      const ordinal = Math.max(1, s.phases.indexOf(s.phase) + 1);
      return tag + t.fg("muted", `PHASE ${ordinal}/${s.phases.length}`) + "  " + t.fg("text", s.phase);
    }
    if (s.status === "running") return tag + t.fg("muted", "STARTING");
    return tag + t.fg("muted", s.runId || s.origin);
  }

  private agentRow(
    view: WorkflowSnapshot["agents"][number],
    width: number,
    labelW: number,
    last: boolean,
  ): string {
    const t = this.theme;
    const { icon, role } = agentGlyph(view.status, this.frame);
    const label = truncateToWidth(view.label, labelW, "…");
    const activity = agentActivity(view);
    const activityRole = view.status === "failed" ? "error" : view.status === "retrying" ? "warning" : "muted";
    const left = `   ${t.fg("dim", last ? "└─" : "├─")} ${t.fg(role, icon)} ${t.fg("text", padEnd(label, labelW))}  ${t.fg(activityRole, activity)}`;
    const runtime = view.startedAt ? elapsed(view.startedAt, view.finishedAt) : "";
    return joinEnds(left, t.fg("dim", runtime), width);
  }

  private pickAgents(): WorkflowSnapshot["agents"] {
    const s = this.snap;
    if (s.agents.length <= MAX_AGENT_ROWS) return s.agents;
    const rank = (a: WorkflowSnapshot["agents"][number]): number =>
      a.status === "running" || a.status === "retrying" ? 0 : a.status === "failed" ? 1 : a.status === "queued" ? 2 : 3;
    return [...s.agents]
      .sort((a, b) => rank(a) - rank(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.index - b.index)
      .slice(0, MAX_AGENT_ROWS)
      .sort((a, b) => a.index - b.index);
  }
}

// --- pure formatting ----------------------------------------------------

function statusRole(status: WorkflowSnapshot["status"]): string {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "cancelled") return "warning";
  return "accent";
}

function statusLabel(status: WorkflowSnapshot["status"], frame: number): string {
  if (status === "running") return `${SPINNER[frame % SPINNER.length]} RUNNING`;
  return status.toUpperCase();
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
    case "cancelled":
      return { icon: "⊘", role: "warning" };
    default:
      return { icon: SPINNER[frame % SPINNER.length], role: "accent" };
  }
}

function agentActivity(view: WorkflowSnapshot["agents"][number]): string {
  const activity = view.activity ? sanitizeTerminalText(view.activity).replace(/\s+/g, " ").trim() : undefined;
  if (view.status === "queued") return `queued · ${activity || "waiting for a slot"}`;
  if (view.status === "cancelled") return truncateToWidth(view.reason ?? activity ?? "cancelled", 64, "…");
  if (view.status === "failed") return truncateToWidth(view.reason ?? activity ?? "failed", 64, "…");
  if (view.status === "retrying") return `retry ${view.attempt}/${view.maxRetries} · ${activity || "correcting output"}`;
  if (view.status === "completed") return "done";
  return activity || "working…";
}


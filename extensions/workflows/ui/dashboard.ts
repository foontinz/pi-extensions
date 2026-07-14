import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowSnapshot } from "../index.js";
import { clamp, compact, elapsed, joinEnds, padEnd } from "./format.js";

/** Minimal theme surface we depend on (matches the pi `Theme` class). */
export interface DashboardTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_AGENT_ROWS = 6;
const LABEL_MIN = 6;
const LABEL_MAX = 24;
const PHASE_MIN = 4;
const PHASE_MAX = 12;

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
    const phaseW = clamp(Math.max(0, ...rows.map((r) => (r.phase ? visibleWidth(r.phase) : 0))), PHASE_MIN, PHASE_MAX);
    for (const [i, view] of rows.entries()) {
      const last = hidden === 0 && i === rows.length - 1;
      lines.push(this.agentRow(view, width, labelW, phaseW, last));
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
    // Active/queued counts are visible in the agent rows; the header keeps
    // only run progress, token/cost totals, and elapsed time.
    const dimParts: string[] = [`RUN ${done}/${s.launched || 0}`];
    dimParts.push(`↑${compact(s.usage.input)} ↓${compact(s.usage.output)}`);
    // The workflow's own cost — always shown so a run's spend is visible at a glance.
    dimParts.push(`$${s.usage.cost.toFixed(s.usage.cost < 1 ? 3 : 2)}`);
    dimParts.push(elapsed(s.startedAt, s.finishedAt));
    let right = "";
    if (s.failures > 0) right += t.fg("error", t.bold(`${s.failures} FAILED`)) + t.fg("dim", " · ");
    if (s.rateLimited) right += t.fg("warning", t.bold("RATE-LIMITED")) + t.fg("dim", " · ");
    right += t.fg("dim", dimParts.join(" · "));

    const rightWidth = visibleWidth(right);
    if (rightWidth + 12 >= width) return truncateToWidth(`${left}  ${right}`, width);
    const leftFit = truncateToWidth(left, Math.max(1, width - rightWidth - 3), "…");
    const gap = " ".repeat(Math.max(2, width - visibleWidth(leftFit) - rightWidth));
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
    phaseW: number,
    last: boolean,
  ): string {
    const t = this.theme;
    const { icon, role } = agentGlyph(view.status, this.frame);
    const label = truncateToWidth(view.label, labelW, "…");
    const phase = view.phase ? truncateToWidth(view.phase, phaseW, "…") : "";
    const detail = agentDetail(view);
    const left = `   ${t.fg("dim", last ? "└─" : "├─")} ${t.fg(role, icon)} ${t.fg("text", padEnd(label, labelW))}  ${t.fg("muted", padEnd(phase, phaseW))}`;
    const right = t.fg(view.status === "failed" ? "error" : "muted", detail);
    return joinEnds(left, right, width);
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


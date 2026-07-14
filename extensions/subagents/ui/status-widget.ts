import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { shortJobId } from "../core/ids.js";
import { truncateOneLine } from "../platform/text.js";

export interface StatusJobView {
  id: string;
  label: string;
  agent?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  cleanupPhase?: "none" | "pending" | "running" | "complete" | "retained" | "failed";
  cleanupPending?: boolean;
  cleanupError?: string;
  latestAssistantText?: string;
  finalOutput?: string;
  errorMessage?: string;
  stopReason?: string;
  usage?: { input: number; output: number; cost: number };
}

export interface StatusTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

export type LatestLogPreview<T extends StatusJobView = StatusJobView> = (job: T) => string | undefined;

const MAX_ROWS = 6;
const LABEL_MIN = 6;
const LABEL_MAX = 24;

/**
 * The subagents `belowEditor` widget, in the same visual language as the goal
 * and workflow widgets: a borderless header line (state ◆ + muted AGENTS tag,
 * dim metrics right-aligned) with tree-connector job rows beneath it.
 */
export function formatStatusTable<T extends StatusJobView>(
  jobs: T[],
  theme: StatusTheme,
  latestLogPreview: LatestLogPreview<T>,
  width = 140,
): string[] {
  const lines: string[] = [header(jobs, theme, width)];
  const rows = pickJobs(jobs);
  const hidden = jobs.length - rows.length;
  const labelW = clamp(Math.max(0, ...rows.map((job) => visibleWidth(rowLabel(job)))), LABEL_MIN, Math.min(LABEL_MAX, width));
  for (const [i, job] of rows.entries()) {
    const last = hidden === 0 && i === rows.length - 1;
    lines.push(jobRow(job, theme, latestLogPreview, width, labelW, last));
  }
  if (hidden > 0) lines.push(truncateToWidth(`   ${theme.fg("dim", `└─ … ${hidden} more`)}`, width));
  return lines;
}

/** `◆  RUNNING  │  AGENTS  2 active` with dim totals right-aligned. */
function header(jobs: StatusJobView[], theme: StatusTheme, width: number): string {
  const t = theme;
  const running = jobs.filter((job) => job.status === "running").length;
  const done = jobs.filter((job) => job.status === "completed").length;
  const failed = jobs.filter((job) => job.status === "failed").length;

  const { label, role } = headerState(running, failed, done);
  const paint = (text: string): string => t.fg(role, text);
  const count = running > 0 ? `${running} active` : `${jobs.length} recent`;
  const left = paint("◆") + "  " + paint(t.bold(label)) + t.fg("dim", "  │  ")
    + t.fg("muted", "AGENTS") + "  " + t.fg("text", count);

  const dimParts: string[] = [`RUN ${done}/${jobs.length}`];
  const usage = sumUsage(jobs);
  if (usage.input > 0 || usage.output > 0) dimParts.push(`↑${compact(usage.input)} ↓${compact(usage.output)}`);
  if (usage.cost > 0) dimParts.push(`$${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}`);
  let right = "";
  if (failed > 0) right += t.fg("error", t.bold(`${failed} FAILED`)) + t.fg("dim", " · ");
  right += t.fg("dim", dimParts.join(" · "));

  const rightWidth = visibleWidth(right);
  if (rightWidth + 12 >= width) return truncateToWidth(`${left}  ${right}`, width);
  const leftFit = truncateToWidth(left, Math.max(1, width - rightWidth - 3), "…");
  const gap = " ".repeat(Math.max(2, width - visibleWidth(leftFit) - rightWidth));
  return truncateToWidth(leftFit + gap + right, width);
}

function headerState(running: number, failed: number, done: number): { label: string; role: string } {
  if (running > 0) return { label: "RUNNING", role: "accent" };
  if (failed > 0) return { label: "FAILED", role: "error" };
  if (done === 0) return { label: "STOPPED", role: "warning" };
  return { label: "DONE", role: "success" };
}

function jobRow<T extends StatusJobView>(
  job: T,
  theme: StatusTheme,
  latestLogPreview: LatestLogPreview<T>,
  width: number,
  labelW: number,
  last: boolean,
): string {
  const t = theme;
  const { icon, role } = jobGlyph(job.status);
  const label = truncateToWidth(rowLabel(job), labelW, "…");
  const detail = truncateOneLine(jobDetail(job, latestLogPreview), 64);
  const left = `   ${t.fg("dim", last ? "└─" : "├─")} ${t.fg(role, icon)} ${t.fg("text", padEnd(label, labelW))}  `
    + t.fg(job.status === "failed" ? "error" : "muted", detail);
  const right = t.fg("dim", `${shortJobId(job.id)} · ${formatJobRuntime(job)}`);
  return joinEnds(left, right, width);
}

function jobGlyph(status: StatusJobView["status"]): { icon: string; role: string } {
  switch (status) {
    case "completed":
      return { icon: "✓", role: "success" };
    case "failed":
      return { icon: "✗", role: "error" };
    case "cancelled":
      return { icon: "·", role: "muted" };
    default:
      return { icon: "●", role: "accent" };
  }
}

/** Latest activity/outcome for a row; status itself is carried by the glyph. */
function jobDetail<T extends StatusJobView>(job: T, latestLogPreview: LatestLogPreview<T>): string {
  const cleanup = cleanupState(job);
  if (cleanup) return cleanup;
  const source = jobPreviewSource(job, latestLogPreview);
  return cleanPreview(source) || previewFallback(job);
}

function pickJobs<T extends StatusJobView>(jobs: T[]): T[] {
  if (jobs.length <= MAX_ROWS) return jobs;
  const rank = (job: T): number => job.status === "running" ? 0 : job.status === "failed" ? 1 : 2;
  const chosen = new Set(
    [...jobs].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt).slice(0, MAX_ROWS),
  );
  return jobs.filter((job) => chosen.has(job));
}

export function compactJobState<T extends StatusJobView>(job: T, latestLogPreview: LatestLogPreview<T>): string {
  const cleanup = cleanupState(job);
  if (cleanup) return cleanup;
  const statusWord = job.status === "completed" ? "done" : job.status === "cancelled" ? "stopped" : job.status;
  // Show the actual latest line (truncated), not fabricated keywords, so the
  // widget always reflects real activity rather than word-salad from paths/noise.
  const preview = cleanPreview(jobPreviewSource(job, latestLogPreview));
  return `${statusWord} ${preview || previewFallback(job)}`;
}

function cleanupState(job: StatusJobView): string | undefined {
  if (job.cleanupPhase === "failed" || job.cleanupError) return `cleanup-failed ${truncateOneLine(job.cleanupError ?? "check logs", 60)}`;
  if (job.cleanupPending || job.cleanupPhase === "pending" || job.cleanupPhase === "running") return `cleanup-${job.cleanupPhase ?? "pending"}`;
  return undefined;
}

function jobPreviewSource<T extends StatusJobView>(job: T, latestLogPreview: LatestLogPreview<T>): string | undefined {
  if (job.status === "running") return job.latestAssistantText || latestLogPreview(job);
  if (job.status === "completed") return job.finalOutput;
  return job.errorMessage || job.stopReason || latestLogPreview(job);
}

function previewFallback(job: StatusJobView): string {
  if (job.status === "running") return "working…";
  if (job.status === "completed") return "output ready";
  if (job.status === "cancelled") return "stopped by request";
  return "check logs";
}

/** Strip ANSI + "assistant:" prefixes and collapse to a single short line. */
function cleanPreview(text: string | undefined): string {
  if (!text) return "";
  const cleaned = text.replace(/\x1b\[[0-9;]*m/g, " ").replace(/^assistant:\s*/i, "");
  return truncateOneLine(cleaned, 48);
}

function rowLabel(job: StatusJobView): string {
  return (job.label || job.agent || job.id).replace(/\s+/g, "-");
}

function sumUsage(jobs: StatusJobView[]): { input: number; output: number; cost: number } {
  return jobs.reduce(
    (total, job) => ({
      input: total.input + (job.usage?.input ?? 0),
      output: total.output + (job.usage?.output ?? 0),
      cost: total.cost + (job.usage?.cost ?? 0),
    }),
    { input: 0, output: 0, cost: 0 },
  );
}

export function formatJobRuntime(job: Pick<StatusJobView, "startedAt" | "finishedAt">): string {
  const elapsedMs = (job.finishedAt ?? Date.now()) - job.startedAt;
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}:${remainingMinutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/** Abbreviate a count: `1234` -> `"1.2k"`, `1_500_000` -> `"1.5m"`. */
function compact(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
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

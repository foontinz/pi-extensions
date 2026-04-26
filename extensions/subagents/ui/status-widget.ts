import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
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
}

export type LatestLogPreview<T extends StatusJobView = StatusJobView> = (job: T) => string | undefined;

export function formatStatusTable<T extends StatusJobView>(jobs: T[], ctx: ExtensionContext, latestLogPreview: LatestLogPreview<T>): string[] {
  const visibleRows = jobs.slice(0, 8);
  const idWidth = Math.max("id".length, ...visibleRows.map((job) => shortJobId(job.id).length));
  const labelWidth = Math.min(20, Math.max("agent".length, ...visibleRows.map((job) => compactStatusLabel(job).length)));
  const statusWidth = Math.max("status".length, ...visibleRows.map((job) => job.status.length));
  const timeWidth = "start".length;
  const durationWidth = "runtime".length;
  const header = `${padCell("id", idWidth)}  ${padCell("agent", labelWidth)}  ${padCell("start", timeWidth)}  ${padCell("runtime", durationWidth)}  ${padCell("status", statusWidth)}  state`;
  const separator = `${"─".repeat(idWidth)}  ${"─".repeat(labelWidth)}  ${"─".repeat(timeWidth)}  ${"─".repeat(durationWidth)}  ${"─".repeat(statusWidth)}  ${"─".repeat(32)}`;
  const rows = visibleRows.map((job) => formatStatusRow(job, ctx, latestLogPreview, idWidth, labelWidth, timeWidth, durationWidth, statusWidth));
  if (jobs.length > visibleRows.length) rows.push(ctx.ui.theme.fg("dim", `… ${jobs.length - visibleRows.length} more`));
  return [ctx.ui.theme.fg("muted", "subagents"), ctx.ui.theme.fg("dim", header), ctx.ui.theme.fg("dim", separator), ...rows];
}

export function compactJobState<T extends StatusJobView>(job: T, latestLogPreview: LatestLogPreview<T>): string {
  if (job.cleanupPhase === "failed" || job.cleanupError) return `cleanup-failed ${truncateOneLine(job.cleanupError ?? "check logs", 60)}`;
  if (job.cleanupPending || job.cleanupPhase === "pending" || job.cleanupPhase === "running") return `cleanup-${job.cleanupPhase ?? "pending"}`;
  const statusWord = job.status === "completed" ? "done" : job.status === "cancelled" ? "stopped" : job.status;
  const fallback = job.status === "running"
    ? ["background", "task", "active"]
    : job.status === "completed"
      ? ["final", "output", "ready"]
      : job.status === "cancelled"
        ? ["by", "request", "stopped"]
        : ["check", "logs", "failed"];
  const source = job.status === "running"
    ? job.latestAssistantText || latestLogPreview(job)
    : job.status === "completed"
      ? job.finalOutput
      : job.errorMessage || job.stopReason || latestLogPreview(job);
  const words = extractStatusWords(source).filter((word) => word !== statusWord).slice(0, 3);
  while (words.length < 3) words.push(fallback[words.length] ?? "task");
  return [statusWord, ...words].slice(0, 4).join(" ");
}

function formatStatusRow<T extends StatusJobView>(job: T, ctx: ExtensionContext, latestLogPreview: LatestLogPreview<T>, idWidth: number, labelWidth: number, timeWidth: number, durationWidth: number, statusWidth: number): string {
  const color = job.status === "completed" ? "success" : job.status === "running" ? "accent" : job.status === "cancelled" ? "muted" : "warning";
  const id = ctx.ui.theme.fg("muted", padCell(shortJobId(job.id), idWidth));
  const label = ctx.ui.theme.fg("muted", padCell(compactStatusLabel(job), labelWidth));
  const started = ctx.ui.theme.fg("muted", padCell(formatStatusTime(job.startedAt), timeWidth));
  const duration = ctx.ui.theme.fg("muted", padCell(formatJobRuntime(job), durationWidth));
  const status = ctx.ui.theme.fg(color, padCell(job.status, statusWidth));
  const state = ctx.ui.theme.fg(color, compactJobState(job, latestLogPreview));
  return `${id}  ${label}  ${started}  ${duration}  ${status}  ${state}`;
}

function compactStatusLabel(job: StatusJobView): string {
  const raw = (job.label || job.agent || job.id).replace(/\s+/g, "-");
  return raw.length <= 20 ? raw : `${raw.slice(0, 19)}…`;
}

function formatStatusTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
}

export function formatJobRuntime(job: StatusJobView): string {
  const elapsedMs = (job.finishedAt ?? Date.now()) - job.startedAt;
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}:${remainingMinutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function padCell(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function extractStatusWords(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .replace(/\x1b\[[0-9;]*m/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STATUS_STOP_WORDS.has(word));
}

const STATUS_STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was", "were", "has", "have", "had",
  "assistant", "message", "complete", "tool", "bash", "read", "write", "edit", "turn", "started", "ended", "output", "chars",
]);

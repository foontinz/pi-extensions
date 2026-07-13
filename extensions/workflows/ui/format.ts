import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Shared pure formatting helpers for the workflows UI widgets.

/** Abbreviate a count: `1234` -> `"1.2k"`, `1_500_000` -> `"1.5m"`. */
export function compact(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/** The first line of `text`, otherwise unmodified. */
export function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

/** The first line of `text`, truncated to 80 chars with an ellipsis. */
export function firstLineClamped(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export function elapsed(startedAt: number, finishedAt?: number): string {
  const total = Math.max(0, Math.floor(((finishedAt ?? Date.now()) - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  if (m < 60) return `${m}:${sec.toString().padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}:${(m % 60).toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

/** Right-pad accounting for ANSI escapes; truncate if too wide. */
export function padEnd(s: string, w: number): string {
  const vis = visibleWidth(s);
  if (vis === w) return s;
  if (vis > w) return truncateToWidth(s, w, "…", true);
  return s + " ".repeat(w - vis);
}

/** Place `left` and `right` on one line of width `w`, right-aligning `right`. */
export function joinEnds(left: string, right: string, w: number): string {
  const rw = visibleWidth(right);
  if (rw >= w) return truncateToWidth(right, w, "…", true);
  const lw = w - rw - 1;
  return `${padEnd(left, lw)} ${right}`;
}

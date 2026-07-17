/**
 * /usage panel — interactive cross-session usage explorer.
 *
 * Four views over the same deduplicated entry set:
 *   Overview — GitHub-style cost heatmap with a movable day cursor and a
 *              per-model breakdown of the selected day
 *   Models   — per-model turns/tokens/cost table with share bars
 *   Projects — the same table grouped by session cwd
 *   Days     — recent per-day table with cost bars
 *
 * Keyboard:
 *   tab / shift+tab / 1-4   switch view
 *   ← ↓ ↑ → / h j k l       move the day cursor (Overview) or scroll (tables)
 *   t                       cycle time range for the table views
 *   esc / q                 close
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  aggregateEntries,
  emptyStats,
  todayKey,
  type GroupStats,
  type UsageData,
  type UsageEntry,
} from "./core.js";

// ─── GitHub-style green palette (truecolor ANSI) ─────────────────────────────

const HEAT_FG = [
  "\x1b[38;2;48;54;61m",   // 0 – empty   (muted slate)
  "\x1b[38;2;14;68;41m",   // 1 – darkest green
  "\x1b[38;2;0;109;50m",   // 2 – dark green
  "\x1b[38;2;38;166;65m",  // 3 – medium green
  "\x1b[38;2;57;211;83m",  // 4 – bright green
] as const;

const RST     = "\x1b[0m";
const INVERSE = "\x1b[7m";
const DAYS    = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTHS  = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// Grid geometry – single source of truth
const LABEL_W = 4;  // "Mon " = 3 chars + 1 separator space
const CELL_W  = 2;  // "▪ "  = 1 block char + 1 separator space

// ─── tabs & ranges ────────────────────────────────────────────────────────────

const TABS = ["Overview", "Models", "Projects", "Days"] as const;
type Tab = 0 | 1 | 2 | 3;

const RANGES = [
  { label: "7d",  days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "all", days: Infinity },
] as const;

// ─── date helpers ─────────────────────────────────────────────────────────────

function toKey(d: Date): string { return d.toISOString().slice(0, 10); }

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

/** Monday of the ISO week containing d */
function weekStart(d: Date): Date {
  const dow = d.getUTCDay();                    // 0 = Sun
  return addDays(d, dow === 0 ? -6 : 1 - dow);
}

function utcToday(): Date {
  const t = new Date();
  t.setUTCHours(0, 0, 0, 0);
  return t;
}

/** First day key included by a range ending today, or undefined for "all". */
function rangeStartKey(rangeIdx: number): string | undefined {
  const range = RANGES[rangeIdx]!;
  if (!Number.isFinite(range.days)) return undefined;
  return toKey(addDays(utcToday(), -(range.days - 1)));
}

const WEEKDAYS_SUN0 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function prettyDay(key: string): string {
  const d = new Date(key + "T00:00:00.000Z");
  return `${WEEKDAYS_SUN0[d.getUTCDay()]} ${key}`;
}

// ─── formatting helpers ───────────────────────────────────────────────────────

const pr = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
const pl = (s: string, w: number) => " ".repeat(Math.max(0, w - s.length)) + s;

function fmtUSD(v: number): string {
  if (v >= 1000) return "$" + Math.round(v).toLocaleString("en-US");
  if (v >= 1) return "$" + v.toFixed(2);
  if (v > 0) return "$" + v.toFixed(4);
  return "$0";
}

function fmtCount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 10e3) return (n / 1e3).toFixed(0) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

const BAR_PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/** Left-aligned bar of `width` cells filled to `frac` with ⅛-block precision. */
function bar(frac: number, width: number): string {
  const cells = Math.max(0, Math.min(1, frac)) * width;
  let full = Math.floor(cells);
  let eighths = Math.round((cells - full) * 8);
  if (eighths === 8) { full += 1; eighths = 0; }
  const partial = BAR_PARTIAL[eighths]!;
  const used = full + (partial ? 1 : 0);
  return "█".repeat(full) + partial + " ".repeat(Math.max(0, width - used));
}

function shortenProject(project: string, home: string | undefined): string {
  if (home && project.startsWith(home)) return "~" + project.slice(home.length);
  return project;
}

// ─── heatmap helpers ──────────────────────────────────────────────────────────

function costLevel(cost: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (cost <= 0 || max <= 0) return 0;
  const r = cost / max;
  if (r <= 0.10) return 1;
  if (r <= 0.30) return 2;
  if (r <= 0.60) return 3;
  return 4;
}

function heatCell(level: 0 | 1 | 2 | 3 | 4, selected: boolean): string {
  const ch = level === 0 ? "·" : "▪";
  return (selected ? INVERSE : "") + HEAT_FG[level] + ch + RST;
}

// ─── UsagePanel TUI component ─────────────────────────────────────────────────

export class UsagePanel {
  private tab: Tab = 0;
  private rangeIdx = 1;              // 30d default for the table views
  private cursor: Date;              // selected heatmap day (UTC midnight)
  private weekOffset = 0;            // weeks the visible window is shifted back
  private scroll = 0;                // table scroll offset (Models/Projects/Days)
  private cache: { width: number; lines: string[] } | null = null;
  private rangeCache = new Map<number, ReturnType<typeof aggregateEntries>>();

  constructor(
    private readonly data: UsageData,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly home = process.env.HOME,
  ) {
    this.cursor = utcToday();
  }

  // ── input ───────────────────────────────────────────────────────────────────

  handleInput(raw: string): void {
    if (matchesKey(raw, Key.escape) || raw === "q") {
      this.done();
      return;
    }

    if (matchesKey(raw, Key.tab)) return this.switchTab((this.tab + 1) % TABS.length as Tab);
    if (matchesKey(raw, "shift+tab")) return this.switchTab((this.tab + TABS.length - 1) % TABS.length as Tab);
    if (raw === "1" || raw === "2" || raw === "3" || raw === "4") {
      return this.switchTab((Number(raw) - 1) as Tab);
    }

    if (raw === "t" && this.tab !== 0) {
      this.rangeIdx = (this.rangeIdx + 1) % RANGES.length;
      this.scroll = 0;
      this.invalidate();
      return;
    }

    const left  = matchesKey(raw, Key.left)  || raw === "h";
    const right = matchesKey(raw, Key.right) || raw === "l";
    const up    = matchesKey(raw, Key.up)    || raw === "k";
    const down  = matchesKey(raw, Key.down)  || raw === "j";

    if (this.tab === 0) {
      // Heatmap columns are weeks: left/right move a week, up/down move a day.
      if (left)  return this.moveCursor(-7);
      if (right) return this.moveCursor(7);
      if (up)    return this.moveCursor(-1);
      if (down)  return this.moveCursor(1);
    } else {
      if (up)   { this.scroll = Math.max(0, this.scroll - 1); this.invalidate(); return; }
      if (down) { this.scroll++; this.invalidate(); return; }
      if (matchesKey(raw, Key.pageUp))   { this.scroll = Math.max(0, this.scroll - 10); this.invalidate(); return; }
      if (matchesKey(raw, Key.pageDown)) { this.scroll += 10; this.invalidate(); return; }
    }
  }

  private switchTab(tab: Tab): void {
    this.tab = tab;
    this.scroll = 0;
    this.invalidate();
  }

  private moveCursor(deltaDays: number): void {
    const next = addDays(this.cursor, deltaDays);
    if (next > utcToday()) return;
    this.cursor = next;
    this.invalidate();
  }

  invalidate(): void { this.cache = null; }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const lines = this.build(width);
    this.cache = { width, lines };
    return lines;
  }

  // ── shared pieces ───────────────────────────────────────────────────────────

  private rangeStats(): ReturnType<typeof aggregateEntries> {
    const cached = this.rangeCache.get(this.rangeIdx);
    if (cached) return cached;

    // Trailing ranges end today: exclude future-dated entries (clock skew,
    // imported sessions) that the heatmap would not show either.
    const startKey = rangeStartKey(this.rangeIdx);
    const endKey = todayKey();
    const stats = startKey === undefined
      ? this.data
      : aggregateEntries(this.data.entries.filter((e) => e.day >= startKey && e.day <= endKey));
    this.rangeCache.set(this.rangeIdx, stats);
    return stats;
  }

  /** Cost and turn totals for the trailing `days` window including today. */
  private trailingStats(days: number): { cost: number; turns: number } {
    const startKey = toKey(addDays(utcToday(), -(days - 1)));
    const endKey = todayKey();
    let cost = 0;
    let turns = 0;
    for (const [day, stats] of this.data.days) {
      if (day >= startKey && day <= endKey) {
        cost += stats.cost.total;
        turns += stats.turns;
      }
    }
    return { cost, turns };
  }

  private header(width: number): string[] {
    const { theme } = this;
    const tabsParts: string[] = [];
    for (let i = 0; i < TABS.length; i++) {
      const label = `${i + 1} ${TABS[i]}`;
      tabsParts.push(i === this.tab
        ? theme.fg("accent", theme.bold(label))
        : theme.fg("dim", label));
    }
    const left = theme.fg("accent", theme.bold(" USAGE")) + "  " + tabsParts.join(theme.fg("dim", "  ·  "));

    const rangeLabel = this.tab === 0 ? "" : `range ${RANGES[this.rangeIdx]!.label}`;
    const right = theme.fg("muted", rangeLabel) + (rangeLabel ? " " : "");
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return [
      truncateToWidth(left + " ".repeat(gap) + right, width),
      theme.fg("accent", "─".repeat(width)),
    ];
  }

  private footer(width: number): string[] {
    const { theme } = this;
    const hints = this.tab === 0
      ? "←→ week  ↑↓ day  ·  tab/1-4 views  ·  esc close"
      : "t range  ·  ↑↓ scroll  ·  tab/1-4 views  ·  esc close";
    return ["", truncateToWidth(theme.fg("dim", " " + hints), width)];
  }

  // ── main builder ────────────────────────────────────────────────────────────

  private build(width: number): string[] {
    const lines = this.header(width);
    switch (this.tab) {
      case 0: lines.push(...this.buildOverview(width)); break;
      case 1: lines.push(...this.buildGroupTable(width, "Model")); break;
      case 2: lines.push(...this.buildGroupTable(width, "Project")); break;
      case 3: lines.push(...this.buildDays(width)); break;
    }
    lines.push(...this.footer(width));
    return lines.map((l) => truncateToWidth(l, width));
  }

  // ── Overview ────────────────────────────────────────────────────────────────

  private buildOverview(width: number): string[] {
    const { theme, data } = this;
    const lines: string[] = [""];

    // Stat tiles: today / trailing windows / all time.
    const today = data.days.get(todayKey()) ?? emptyStats();
    const week = this.trailingStats(7);
    const month = this.trailingStats(30);
    const tiles: Array<[string, number, number]> = [
      ["Today",    today.cost.total,      today.turns],
      ["7 days",   week.cost,             week.turns],
      ["30 days",  month.cost,            month.turns],
      ["All time", data.grand.cost.total, data.grand.turns],
    ];
    const TILE_W = 14;
    let labelRow = " ";
    let valueRow = " ";
    let subRow   = " ";
    for (const [label, cost, turns] of tiles) {
      labelRow += theme.fg("dim", pr(label, TILE_W));
      valueRow += theme.fg("accent", theme.bold(pr(fmtUSD(cost), TILE_W)));
      subRow   += theme.fg("muted", pr(turns > 0 ? `${fmtCount(turns)} turns` : "", TILE_W));
    }
    lines.push(labelRow, valueRow, subRow, "");

    // Heatmap window: keep the cursor's week visible.
    const numWeeks = Math.max(8, Math.floor((width - LABEL_W) / CELL_W));
    const todayDate = utcToday();
    const currentWeek = weekStart(todayDate);
    const cursorWeek = weekStart(this.cursor);
    const cursorWeeksBack = Math.round((currentWeek.getTime() - cursorWeek.getTime()) / (7 * 86_400_000));
    if (cursorWeeksBack < this.weekOffset) this.weekOffset = cursorWeeksBack;
    if (cursorWeeksBack > this.weekOffset + numWeeks - 1) this.weekOffset = cursorWeeksBack - numWeeks + 1;

    const anchor = addDays(currentWeek, -this.weekOffset * 7);
    const startW = addDays(anchor, -(numWeeks - 1) * 7);
    const weeks  = Array.from({ length: numWeeks }, (_, i) => addDays(startW, i * 7));

    // max daily cost in the visible window (normalises colours)
    let maxCost = 0;
    for (const w of weeks) {
      for (let d = 0; d < 7; d++) {
        const c = data.days.get(toKey(addDays(w, d)))?.cost.total ?? 0;
        if (c > maxCost) maxCost = c;
      }
    }

    // Month header row: place full "Jan"/"Feb"/… at the first visible column of
    // each month; characters overflow into the neighbouring space naturally,
    // matching how GitHub's contribution graph renders month labels.
    const gridVisWidth = numWeeks * CELL_W;
    const rawMonth = new Array<string>(gridVisWidth).fill(" ");
    let lastMonth = -1;
    for (let wi = 0; wi < weeks.length; wi++) {
      const mo = weeks[wi]!.getUTCMonth();
      if (mo !== lastMonth) {
        const name = MONTHS[mo]!;                    // "Jan" – exactly 3 chars
        const pos  = wi * CELL_W;
        for (let ci = 0; ci < name.length && pos + ci < gridVisWidth; ci++) {
          rawMonth[pos + ci] = name[ci]!;
        }
        lastMonth = mo;
      }
    }
    lines.push(" ".repeat(LABEL_W) + theme.fg("muted", rawMonth.join("")));

    // 7 day rows (Monday … Sunday)
    const cursorKey = toKey(this.cursor);
    for (let dow = 0; dow < 7; dow++) {
      let row = theme.fg("dim", DAYS[dow]) + " ";
      for (const w of weeks) {
        const day = addDays(w, dow);
        if (day > todayDate) {
          row += " ".repeat(CELL_W);
          continue;
        }
        const key = toKey(day);
        const cost = data.days.get(key)?.cost.total ?? 0;
        row += heatCell(costLevel(cost, maxCost), key === cursorKey) + " ".repeat(CELL_W - 1);
      }
      lines.push(row);
    }

    // Legend
    lines.push("");
    let legend = " ".repeat(LABEL_W) + theme.fg("dim", "no usage ");
    for (let l = 1; l <= 4; l++) legend += heatCell(l as 1 | 2 | 3 | 4, false) + " ";
    legend += theme.fg("dim", " more");
    if (this.weekOffset > 0) legend += theme.fg("dim", `   (${this.weekOffset}w back)`);
    lines.push(legend, "");

    // Selected-day breakdown
    lines.push(...this.buildDayDetail(width, cursorKey));
    return lines;
  }

  private buildDayDetail(width: number, dayKey: string): string[] {
    const { theme } = this;
    const lines: string[] = [];
    const day = this.data.days.get(dayKey);

    const title = theme.bold(prettyDay(dayKey));
    if (!day) {
      lines.push(" " + title + theme.fg("dim", "  —  no usage"));
      return lines;
    }

    const t = day.tokens;
    lines.push(
      " " + title +
      "   " + theme.fg("accent", theme.bold(fmtUSD(day.cost.total))) +
      theme.fg("muted", `  ·  ${day.turns} turns  ·  in ${fmtCount(t.input)}  out ${fmtCount(t.output)}` +
        `  cache r/w ${fmtCount(t.cacheRead)}/${fmtCount(t.cacheWrite)}`),
    );

    const dayModels = aggregateEntries(this.data.entries.filter((e) => e.day === dayKey)).models;
    const sorted = [...dayModels.entries()].sort((a, b) => b[1].cost.total - a[1].cost.total);
    const top = sorted.slice(0, 5);
    const maxCost = top[0]?.[1].cost.total ?? 0;

    const NAME_W = Math.min(34, Math.max(16, width - 36));
    for (const [model, s] of top) {
      const name = model.length > NAME_W ? model.slice(0, NAME_W - 1) + "…" : model;
      lines.push(
        "   " + pr(name, NAME_W) +
        theme.fg("muted", pl(`${s.turns}`, 6) + " turns  ") +
        pl(fmtUSD(s.cost.total), 8) + "  " +
        theme.fg("success", bar(maxCost > 0 ? s.cost.total / maxCost : 0, 12)),
      );
    }
    if (sorted.length > top.length) {
      lines.push("   " + theme.fg("dim", `… ${sorted.length - top.length} more models`));
    }
    return lines;
  }

  // ── Models / Projects tables ────────────────────────────────────────────────

  private buildGroupTable(width: number, kind: "Model" | "Project"): string[] {
    const { theme } = this;
    const stats = this.rangeStats();
    const groups = kind === "Model" ? stats.models : stats.projects;
    const lines: string[] = [""];

    const rows = [...groups.entries()].sort((a, b) => b[1].cost.total - a[1].cost.total);
    const grandTotal = stats.grand.cost.total;

    // name | turns | input | output | cache | cost | share
    const FIXED = 7 + 9 + 9 + 11 + 10 + 16;
    const NAME_W = Math.max(18, width - FIXED - 2);

    lines.push(
      " " +
      theme.fg("dim", pr(kind, NAME_W)) +
      theme.fg("dim", pl("Turns", 7)) +
      theme.fg("dim", pl("Input", 9)) +
      theme.fg("dim", pl("Output", 9)) +
      theme.fg("dim", pl("Cache r/w", 11)) +
      theme.fg("dim", pl("Cost", 10)) +
      theme.fg("dim", "  Share"),
    );
    lines.push(" " + theme.fg("dim", "─".repeat(Math.max(0, width - 2))));

    const MAX_ROWS = 18;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - MAX_ROWS)));
    const visible = rows.slice(this.scroll, this.scroll + MAX_ROWS);

    if (rows.length === 0) {
      lines.push(" " + theme.fg("dim", "no usage in this range"));
    }

    for (const [rawName, s] of visible) {
      const display = kind === "Project" ? shortenProject(rawName, this.home) : rawName;
      const name = display.length > NAME_W ? "…" + display.slice(-(NAME_W - 1)) : display;
      const share = grandTotal > 0 ? s.cost.total / grandTotal : 0;
      lines.push(
        " " +
        pr(name, NAME_W) +
        theme.fg("muted", pl(fmtCount(s.turns), 7)) +
        theme.fg("muted", pl(fmtCount(s.tokens.input), 9)) +
        theme.fg("muted", pl(fmtCount(s.tokens.output), 9)) +
        theme.fg("muted", pl(`${fmtCount(s.tokens.cacheRead)}/${fmtCount(s.tokens.cacheWrite)}`, 11)) +
        theme.fg("accent", pl(fmtUSD(s.cost.total), 10)) +
        "  " + theme.fg("success", bar(share, 8)) +
        theme.fg("dim", ` ${Math.round(share * 100)}%`),
      );
    }

    if (this.scroll > 0 || rows.length > this.scroll + MAX_ROWS) {
      const below = Math.max(0, rows.length - this.scroll - MAX_ROWS);
      lines.push(" " + theme.fg("dim", `… ${this.scroll} above · ${below} below`));
    }

    lines.push(" " + theme.fg("dim", "─".repeat(Math.max(0, width - 2))));
    const g = stats.grand;
    lines.push(
      " " +
      theme.bold(pr("TOTAL", NAME_W)) +
      theme.bold(pl(fmtCount(g.turns), 7)) +
      theme.bold(pl(fmtCount(g.tokens.input), 9)) +
      theme.bold(pl(fmtCount(g.tokens.output), 9)) +
      theme.bold(pl(`${fmtCount(g.tokens.cacheRead)}/${fmtCount(g.tokens.cacheWrite)}`, 11)) +
      theme.fg("accent", theme.bold(pl(fmtUSD(g.cost.total), 10))),
    );
    return lines;
  }

  // ── Days table ──────────────────────────────────────────────────────────────

  private buildDays(width: number): string[] {
    const { theme } = this;
    const stats = this.rangeStats();
    const lines: string[] = [""];

    const rows = [...stats.days.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    const maxCost = rows.reduce((m, [, s]) => Math.max(m, s.cost.total), 0);

    const FIXED = 7 + 9 + 9 + 10 + 4;
    const DATE_W = 17;  // "Fri 2026-07-17 •" plus separator
    const BAR_W = Math.max(8, Math.min(30, width - DATE_W - FIXED - 2));

    lines.push(
      " " +
      theme.fg("dim", pr("Day", DATE_W)) +
      theme.fg("dim", pl("Turns", 7)) +
      theme.fg("dim", pl("Input", 9)) +
      theme.fg("dim", pl("Output", 9)) +
      theme.fg("dim", pl("Cost", 10)) +
      theme.fg("dim", "    "),
    );
    lines.push(" " + theme.fg("dim", "─".repeat(Math.max(0, width - 2))));

    const MAX_ROWS = 18;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - MAX_ROWS)));
    const visible = rows.slice(this.scroll, this.scroll + MAX_ROWS);

    if (rows.length === 0) {
      lines.push(" " + theme.fg("dim", "no usage in this range"));
    }

    const today = todayKey();
    for (const [day, s] of visible) {
      const label = prettyDay(day) + (day === today ? " •" : "");
      lines.push(
        " " +
        (day === today ? theme.bold(pr(label, DATE_W)) : pr(label, DATE_W)) +
        theme.fg("muted", pl(fmtCount(s.turns), 7)) +
        theme.fg("muted", pl(fmtCount(s.tokens.input), 9)) +
        theme.fg("muted", pl(fmtCount(s.tokens.output), 9)) +
        theme.fg("accent", pl(fmtUSD(s.cost.total), 10)) +
        "    " + theme.fg("success", bar(maxCost > 0 ? s.cost.total / maxCost : 0, BAR_W)),
      );
    }

    if (this.scroll > 0 || rows.length > this.scroll + MAX_ROWS) {
      const below = Math.max(0, rows.length - this.scroll - MAX_ROWS);
      lines.push(" " + theme.fg("dim", `… ${this.scroll} above · ${below} below`));
    }

    lines.push(" " + theme.fg("dim", "─".repeat(Math.max(0, width - 2))));
    const g = stats.grand;
    lines.push(
      " " +
      theme.bold(pr("TOTAL", DATE_W)) +
      theme.bold(pl(fmtCount(g.turns), 7)) +
      theme.bold(pl(fmtCount(g.tokens.input), 9)) +
      theme.bold(pl(fmtCount(g.tokens.output), 9)) +
      theme.fg("accent", theme.bold(pl(fmtUSD(g.cost.total), 10))),
    );
    return lines;
  }
}

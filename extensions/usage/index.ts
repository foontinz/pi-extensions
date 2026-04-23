/**
 * /usage — cross-session cost heatmap
 *
 * Shows a GitHub-style contribution calendar coloured by $ spent, plus a
 * per-model breakdown table with grand totals.
 *
 * Keyboard:
 *   ←  /  h   scroll heatmap one week back (older)
 *   →  /  l   scroll heatmap one week forward (newer)
 *   Esc / q   close
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ─── types ───────────────────────────────────────────────────────────────────

interface DayCost {
  total: number;
  input: number;
  output: number;
  turns: number;
}

interface ModelStats {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface UsageData {
  days: Map<string, DayCost>;
  models: Map<string, ModelStats>;
  grand: { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

// ─── GitHub-style green palette (truecolor ANSI) ─────────────────────────────

const HEAT_FG = [
  "\x1b[38;2;48;54;61m",   // 0 – empty   (muted slate)
  "\x1b[38;2;14;68;41m",   // 1 – darkest green
  "\x1b[38;2;0;109;50m",   // 2 – dark green
  "\x1b[38;2;38;166;65m",  // 3 – medium green
  "\x1b[38;2;57;211;83m",  // 4 – bright green
] as const;

const RST    = "\x1b[0m";
const DAYS   = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// Grid geometry – single source of truth
const LABEL_W = 4;  // "Mon " = 3 chars + 1 separator space
const CELL_W  = 2;  // "▪ "  = 1 block char + 1 separator space

// ─── data loading ─────────────────────────────────────────────────────────────

async function loadData(): Promise<UsageData> {
  const root   = join(homedir(), ".pi", "agent", "sessions");
  const days   = new Map<string, DayCost>();
  const models = new Map<string, ModelStats>();
  const grand  = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  const scanDir = async (dir: string) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory())               await scanDir(p);
      else if (e.name.endsWith(".jsonl")) await scanFile(p);
    }
  };

  const scanFile = async (path: string) => {
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
        const cost = entry.message?.usage?.cost;
        if (!cost?.total) continue;

        const day   = (entry.timestamp as string).slice(0, 10);  // "YYYY-MM-DD"
        const model = (entry.message?.model as string) || "unknown";

        const d = days.get(day) ?? { total: 0, input: 0, output: 0, turns: 0 };
        d.total  += cost.total;
        d.input  += cost.input      ?? 0;
        d.output += cost.output     ?? 0;
        d.turns  += 1;
        days.set(day, d);

        const m = models.get(model) ?? { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        m.turns      += 1;
        m.input      += cost.input      ?? 0;
        m.output     += cost.output     ?? 0;
        m.cacheRead  += cost.cacheRead  ?? 0;
        m.cacheWrite += cost.cacheWrite ?? 0;
        m.total      += cost.total;
        models.set(model, m);

        grand.turns      += 1;
        grand.input      += cost.input      ?? 0;
        grand.output     += cost.output     ?? 0;
        grand.cacheRead  += cost.cacheRead  ?? 0;
        grand.cacheWrite += cost.cacheWrite ?? 0;
        grand.total      += cost.total;
      } catch { /* skip malformed lines */ }
    }
  };

  await scanDir(root);
  return { days, models, grand };
}

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

// ─── heatmap helpers ──────────────────────────────────────────────────────────

function heatCell(level: 0 | 1 | 2 | 3 | 4): string {
  return HEAT_FG[level] + (level === 0 ? "·" : "▪") + RST;
}

function costLevel(cost: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (cost <= 0 || max <= 0) return 0;
  const r = cost / max;
  if (r <= 0.10) return 1;
  if (r <= 0.30) return 2;
  if (r <= 0.60) return 3;
  return 4;
}

// ─── padding helpers (raw strings only – no ANSI inside) ─────────────────────

const pr = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
const pl = (s: string, w: number) => " ".repeat(Math.max(0, w - s.length)) + s;

// ─── UsagePanel TUI component ─────────────────────────────────────────────────

class UsagePanel {
  private weekOffset = 0;  // 0 = anchor at current week; positive = scroll back
  private cache: { width: number; lines: string[] } | null = null;

  constructor(
    private readonly data: UsageData,
    private readonly theme: any,
    private readonly done: () => void,
  ) {}

  handleInput(raw: string): void {
    if (matchesKey(raw, Key.escape) || raw === "q") {
      this.done();
    } else if (matchesKey(raw, Key.left) || raw === "h") {
      this.weekOffset++;
      this.invalidate();
    } else if (matchesKey(raw, Key.right) || raw === "l") {
      this.weekOffset = Math.max(0, this.weekOffset - 1);
      this.invalidate();
    }
  }

  invalidate(): void { this.cache = null; }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const lines = this.build(width);
    this.cache = { width, lines };
    return lines;
  }

  // ── main builder ────────────────────────────────────────────────────────────

  private build(width: number): string[] {
    const { theme, data, weekOffset } = this;
    const lines: string[] = [];
    const hr = theme.fg("accent", "─".repeat(width));

    // ── header bar ────────────────────────────────────────────────────────────
    const leftStr  = theme.fg("accent", theme.bold(" USAGE"));
    // Build right string from raw parts so visibleWidth is exact
    const rightRaw = "Total: $" + data.grand.total.toFixed(4) + "  Turns: " + data.grand.turns;
    const rightStr = "Total: " + theme.fg("accent", "$" + data.grand.total.toFixed(4)) +
                     "  Turns: " + data.grand.turns;
    const gap = " ".repeat(Math.max(1, width - visibleWidth(leftStr) - rightRaw.length));
    lines.push(leftStr + gap + rightStr);
    lines.push(hr);
    lines.push("");

    // ── heatmap ───────────────────────────────────────────────────────────────
    const numWeeks = Math.max(8, Math.floor((width - LABEL_W) / CELL_W));

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // anchor = Monday of the last visible week
    // weekOffset=0 → current week is last; positive → scroll back
    const anchor = addDays(weekStart(today), -weekOffset * 7);
    const startW = addDays(anchor, -(numWeeks - 1) * 7);
    const weeks  = Array.from({ length: numWeeks }, (_, i) => addDays(startW, i * 7));

    // max daily cost in the visible window (normalises colours)
    let maxCost = 0;
    for (const w of weeks) {
      for (let d = 0; d < 7; d++) {
        const c = data.days.get(toKey(addDays(w, d)))?.total ?? 0;
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
      const mo = weeks[wi].getUTCMonth();
      if (mo !== lastMonth) {
        const name = MONTHS[mo];                     // "Jan" – exactly 3 chars
        const pos  = wi * CELL_W;
        for (let ci = 0; ci < name.length && pos + ci < gridVisWidth; ci++) {
          rawMonth[pos + ci] = name[ci]!;
        }
        lastMonth = mo;
      }
    }
    lines.push(" ".repeat(LABEL_W) + theme.fg("muted", rawMonth.join("")));

    // 7 day rows (Monday … Sunday)
    for (let dow = 0; dow < 7; dow++) {
      let row = theme.fg("dim", DAYS[dow]) + " ";
      for (const w of weeks) {
        const day = addDays(w, dow);
        if (day > today) {
          row += " ".repeat(CELL_W);
          continue;
        }
        const cost = data.days.get(toKey(day))?.total ?? 0;
        row += heatCell(costLevel(cost, maxCost)) + " ".repeat(CELL_W - 1);
      }
      lines.push(row);
    }

    // Legend + scroll hint
    lines.push("");
    let legend = " ".repeat(LABEL_W) + theme.fg("dim", "no usage ");
    for (let l = 1; l <= 4; l++) legend += heatCell(l as 1 | 2 | 3 | 4) + " ";
    legend += theme.fg("dim", " more");
    if (weekOffset > 0) legend += theme.fg("dim", `   (${weekOffset}w back)`);
    lines.push(legend);
    lines.push(" ".repeat(LABEL_W) + theme.fg("dim", "← older  → newer  esc close"));

    lines.push("");
    lines.push(hr);
    lines.push("");

    // ── model breakdown table ─────────────────────────────────────────────────
    // Column widths: name | turns | input | output | cache | total
    const CW = [26, 7, 10, 10, 10, 11] as const;
    const divW = CW[0] + CW[1] + CW[2] + CW[3] + CW[4] + CW[5];

    lines.push(
      theme.fg("dim", pr("Model",  CW[0])) +
      theme.fg("dim", pl("Turns",  CW[1])) +
      theme.fg("dim", pl("Input",  CW[2])) +
      theme.fg("dim", pl("Output", CW[3])) +
      theme.fg("dim", pl("Cache",  CW[4])) +
      theme.fg("dim", pl("Total",  CW[5])),
    );
    lines.push(theme.fg("dim", "─".repeat(Math.min(divW, width))));

    const sorted = [...data.models.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [model, s] of sorted) {
      const name  = model.length >= CW[0] ? model.slice(0, CW[0] - 2) + "…" : model;
      const cache = s.cacheRead + s.cacheWrite;
      lines.push(truncateToWidth(
        pr(name, CW[0]) +
        pl(String(s.turns),            CW[1]) +
        pl("$" + s.input .toFixed(3),  CW[2]) +
        pl("$" + s.output.toFixed(3),  CW[3]) +
        pl("$" + cache   .toFixed(3),  CW[4]) +
        theme.fg("accent", pl("$" + s.total.toFixed(4), CW[5])),
        width,
      ));
    }

    lines.push(theme.fg("dim", "─".repeat(Math.min(divW, width))));

    const g      = data.grand;
    const gCache = g.cacheRead + g.cacheWrite;
    lines.push(truncateToWidth(
      theme.bold(pr("TOTAL",                        CW[0])) +
      theme.bold(pl(String(g.turns),                CW[1])) +
      theme.bold(pl("$" + g.input .toFixed(3),      CW[2])) +
      theme.bold(pl("$" + g.output.toFixed(3),      CW[3])) +
      theme.bold(pl("$" + gCache  .toFixed(3),      CW[4])) +
      theme.fg("accent", theme.bold(pl("$" + g.total.toFixed(4), CW[5]))),
      width,
    ));

    lines.push("");

    return lines.map(l => truncateToWidth(l, width));
  }
}

// ─── extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show token/cost usage heatmap across all sessions",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Loading session data…", "info");
      const data = await loadData();

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const panel = new UsagePanel(data, theme, done);
        return {
          render:      (w)   => panel.render(w),
          invalidate:  ()    => panel.invalidate(),
          handleInput: (raw) => { panel.handleInput(raw); tui.requestRender(); },
        };
      });
    },
  });
}

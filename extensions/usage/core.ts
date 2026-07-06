/**
 * Shared usage data loading.
 *
 * Scans `~/.pi/agent/sessions/**.jsonl` for assistant-turn cost entries.
 * Exposes both a full scan (`loadUsageData`, used by the `/usage` panel) and a
 * cheap, cached `getTodayCost()` that other extensions (e.g. workflows) can call
 * on a render tick without hammering the filesystem.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── types ───────────────────────────────────────────────────────────────────

export interface DayCost {
  total: number;
  input: number;
  output: number;
  turns: number;
}

export interface ModelStats {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

// Grand totals share the per-model shape; today's slice shares the per-day shape.
export type Grand = ModelStats;
export type TodayCost = DayCost;

export interface UsageData {
  days: Map<string, DayCost>;
  models: Map<string, ModelStats>;
  grand: Grand;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function sessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/**
 * UTC day key ("YYYY-MM-DD") — matches the `entry.timestamp` slice used below.
 * Note: "today" is UTC, so spend rolls over at an odd local hour for non-UTC
 * users. Kept UTC so the panel and the workflows dashboard always agree.
 */
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function walkJsonl(dir: string, onFile: (path: string) => Promise<void>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkJsonl(p, onFile);
    else if (e.name.endsWith(".jsonl")) await onFile(p);
  }
}

/** Iterate assistant-turn cost entries in a single .jsonl file. */
async function forEachCostEntry(
  path: string,
  fn: (day: string, model: string, cost: Record<string, number>) => void,
): Promise<void> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const cost = entry.message?.usage?.cost;
      if (!cost?.total) continue;
      if (typeof entry.timestamp !== "string") continue;
      const day = entry.timestamp.slice(0, 10);
      const model = (entry.message?.model as string) || "unknown";
      fn(day, model, cost);
    } catch {
      /* skip malformed lines */
    }
  }
}

// ─── full scan (for the /usage panel) ─────────────────────────────────────────

export async function loadUsageData(): Promise<UsageData> {
  const days = new Map<string, DayCost>();
  const models = new Map<string, ModelStats>();
  const grand: Grand = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  await walkJsonl(sessionsRoot(), (path) =>
    forEachCostEntry(path, (day, model, cost) => {
      const d = days.get(day) ?? { total: 0, input: 0, output: 0, turns: 0 };
      d.total += cost.total;
      d.input += cost.input ?? 0;
      d.output += cost.output ?? 0;
      d.turns += 1;
      days.set(day, d);

      const m = models.get(model) ?? { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      m.turns += 1;
      m.input += cost.input ?? 0;
      m.output += cost.output ?? 0;
      m.cacheRead += cost.cacheRead ?? 0;
      m.cacheWrite += cost.cacheWrite ?? 0;
      m.total += cost.total;
      models.set(model, m);

      grand.turns += 1;
      grand.input += cost.input ?? 0;
      grand.output += cost.output ?? 0;
      grand.cacheRead += cost.cacheRead ?? 0;
      grand.cacheWrite += cost.cacheWrite ?? 0;
      grand.total += cost.total;
    }),
  );

  return { days, models, grand };
}

/** Today's cost pulled straight from a full scan (used by the panel). */
export function todayCostFrom(data: UsageData): TodayCost {
  return data.days.get(todayKey()) ?? { total: 0, input: 0, output: 0, turns: 0 };
}

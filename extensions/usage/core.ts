/**
 * Shared usage data loading.
 *
 * Scans `~/.pi/agent/sessions/**.jsonl` for assistant-turn cost entries and
 * aggregates them per day and per model (used by the `/usage` panel).
 *
 * Performance: session logs are append-only JSONL and one file (the live
 * session) can be tens of MB. A persistent per-file cache keyed by mtime+size
 * lets repeat loads skip unchanged files entirely and read only the appended
 * tail of a growing file, so a warm `/usage` is near-instant.
 */

import { open, readdir, stat } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
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

// ─── paths & date helpers ─────────────────────────────────────────────────────

function sessionsRoot(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

function cachePath(): string {
  return join(homedir(), ".pi", "agent", "usage-cache.json");
}

/**
 * UTC day key ("YYYY-MM-DD") — matches the `entry.timestamp` slice used below.
 * Note: "today" is UTC, so spend rolls over at an odd local hour for non-UTC
 * users. Kept UTC so the panel and the workflows dashboard always agree.
 */
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── per-file aggregates ──────────────────────────────────────────────────────

interface FileAggregate {
  days: Record<string, DayCost>;
  models: Record<string, ModelStats>;
}

const NEWLINE = 0x0a;

function addDay(days: Record<string, DayCost>, key: string, cost: Record<string, number>): void {
  const d = days[key] ?? { total: 0, input: 0, output: 0, turns: 0 };
  d.total += cost.total;
  d.input += cost.input ?? 0;
  d.output += cost.output ?? 0;
  d.turns += 1;
  days[key] = d;
}

function addModel(models: Record<string, ModelStats>, key: string, cost: Record<string, number>): void {
  const m = models[key] ?? { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  m.turns += 1;
  m.input += cost.input ?? 0;
  m.output += cost.output ?? 0;
  m.cacheRead += cost.cacheRead ?? 0;
  m.cacheWrite += cost.cacheWrite ?? 0;
  m.total += cost.total;
  models[key] = m;
}

/**
 * Parse only the complete lines in `buf` (up to the last newline) and fold cost
 * entries into `agg`. Returns the number of bytes consumed (offset of the last
 * newline + 1) so the caller can resume exactly there on the next append.
 *
 * A cheap `"cost"` substring check skips the many large non-assistant lines
 * (tool results, user turns) without a full JSON.parse.
 */
function foldBuffer(buf: Buffer, agg: FileAggregate): number {
  const lastNl = buf.lastIndexOf(NEWLINE);
  if (lastNl < 0) return 0;
  const text = buf.subarray(0, lastNl + 1).toString("utf8");
  for (const line of text.split("\n")) {
    if (!line || !line.includes('"cost"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const cost = entry.message?.usage?.cost;
      if (!cost?.total) continue;
      if (typeof entry.timestamp !== "string") continue;
      const day = entry.timestamp.slice(0, 10);
      const model = (entry.message?.model as string) || "unknown";
      addDay(agg.days, day, cost);
      addModel(agg.models, model, cost);
    } catch {
      /* skip malformed lines */
    }
  }
  return lastNl + 1;
}

/** Read `[start, size)` of a file into a Buffer (empty when nothing to read). */
async function readRange(path: string, start: number, size: number): Promise<Buffer> {
  if (size <= start) return Buffer.alloc(0);
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(size - start);
    const { bytesRead } = await fh.read(buf, 0, size - start, start);
    return bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// ─── on-disk cache ────────────────────────────────────────────────────────────

const CACHE_VERSION = 1;

interface FileCacheEntry extends FileAggregate {
  mtimeMs: number;
  size: number;
  /** Byte offset of the last complete line already folded (resume point). */
  consumed: number;
}

interface CacheFile {
  version: number;
  files: Record<string, FileCacheEntry>;
}

function readCache(): CacheFile {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as CacheFile;
    if (raw?.version === CACHE_VERSION && raw.files && typeof raw.files === "object") return raw;
  } catch {
    /* missing/corrupt/stale cache — rebuild from scratch */
  }
  return { version: CACHE_VERSION, files: {} };
}

function writeCache(cache: CacheFile): void {
  try {
    writeFileSync(cachePath(), JSON.stringify(cache));
  } catch {
    /* best-effort: a missing cache just means a cold load next time */
  }
}

// ─── directory walk ───────────────────────────────────────────────────────────

async function collectJsonl(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await collectJsonl(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// ─── main load (cached + incremental) ─────────────────────────────────────────

/** Resolve one file to its aggregate, reusing/extending the cache where possible. */
async function resolveFile(path: string, prev: FileCacheEntry | undefined): Promise<FileCacheEntry | undefined> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return undefined;
  }

  // Unchanged: reuse the cached aggregate untouched.
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev;

  // Appended (grew, not rewound): fold only the new tail into a copy.
  if (prev && st.size > prev.size && st.mtimeMs >= prev.mtimeMs) {
    const agg: FileAggregate = { days: structuredClone(prev.days), models: structuredClone(prev.models) };
    const buf = await readRange(path, prev.consumed, st.size);
    const bytes = foldBuffer(buf, agg);
    return { ...agg, mtimeMs: st.mtimeMs, size: st.size, consumed: prev.consumed + bytes };
  }

  // New or rewritten/truncated: full scan.
  const agg: FileAggregate = { days: {}, models: {} };
  const buf = await readRange(path, 0, st.size);
  const consumed = foldBuffer(buf, agg);
  return { ...agg, mtimeMs: st.mtimeMs, size: st.size, consumed };
}

export async function loadUsageData(): Promise<UsageData> {
  const cache = readCache();
  const paths = await collectJsonl(sessionsRoot());

  const nextFiles: Record<string, FileCacheEntry> = {};
  // Bounded concurrency keeps a cold load from opening every large file at once.
  const CONCURRENCY = 8;
  for (let i = 0; i < paths.length; i += CONCURRENCY) {
    const batch = paths.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(batch.map((p) => resolveFile(p, cache.files[p])));
    for (let j = 0; j < batch.length; j++) {
      const entry = resolved[j];
      if (entry) nextFiles[batch[j]!] = entry;
    }
  }

  // Aggregate per-file results into the global view.
  const days = new Map<string, DayCost>();
  const models = new Map<string, ModelStats>();
  const grand: Grand = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  for (const entry of Object.values(nextFiles)) {
    for (const [key, d] of Object.entries(entry.days)) {
      const g = days.get(key) ?? { total: 0, input: 0, output: 0, turns: 0 };
      g.total += d.total;
      g.input += d.input;
      g.output += d.output;
      g.turns += d.turns;
      days.set(key, g);
    }
    for (const [key, m] of Object.entries(entry.models)) {
      const g = models.get(key) ?? { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      g.turns += m.turns;
      g.input += m.input;
      g.output += m.output;
      g.cacheRead += m.cacheRead;
      g.cacheWrite += m.cacheWrite;
      g.total += m.total;
      models.set(key, g);
      grand.turns += m.turns;
      grand.input += m.input;
      grand.output += m.output;
      grand.cacheRead += m.cacheRead;
      grand.cacheWrite += m.cacheWrite;
      grand.total += m.total;
    }
  }

  writeCache({ version: CACHE_VERSION, files: nextFiles });
  return { days, models, grand };
}

/** Today's cost pulled straight from a full scan (used by the /usage panel). */
export function todayCostFrom(data: UsageData): TodayCost {
  return data.days.get(todayKey()) ?? { total: 0, input: 0, output: 0, turns: 0 };
}

/**
 * Shared usage data loading.
 *
 * Scans the active session directory for assistant-turn cost entries and
 * aggregates them per day and per model (used by the `/usage` panel).
 *
 * The cache stores complete per-file assistant entries. Files are only reused
 * when their complete filesystem stamp matches; changed files are read again
 * from a stable snapshot. Keeping entries (rather than only totals) also lets
 * the final aggregation deduplicate history copied by `/fork` and `/clone`.
 */

import type { Stats } from "node:fs";
import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

function defaultSessionsRoot(): string {
  return join(getAgentDir(), "sessions");
}

function cachePath(): string {
  return join(getAgentDir(), "usage-cache.json");
}

/**
 * UTC day key ("YYYY-MM-DD") — matches the `entry.timestamp` slice used below.
 * Note: "today" is UTC, so spend rolls over at an odd local hour for non-UTC
 * users. Kept UTC so the panel and the workflows dashboard always agree.
 */
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── per-file entries ─────────────────────────────────────────────────────────

interface Cost {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface AssistantUsageEntry {
  /** Present on current Pi session entries; absent on legacy/malformed entries. */
  entryId?: string;
  day: string;
  model: string;
  cost: Cost;
}

interface FileAggregate {
  entries: AssistantUsageEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function costValue(value: unknown): number {
  return finiteNumber(value) ? value : 0;
}

/** Parse all complete JSON values in a stable file snapshot. */
function parseSessionFile(text: string): FileAggregate {
  const entries: AssistantUsageEntry[] = [];

  // split() deliberately includes a final line without a trailing newline.
  // A concurrently written partial final line simply fails JSON.parse and is
  // picked up after the writer changes the file stamp on a later load.
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || !line.includes('"cost"')) continue;

    try {
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
      if (entry.message.role !== "assistant") continue;

      const usage = isRecord(entry.message.usage) ? entry.message.usage : undefined;
      const cost = usage && isRecord(usage.cost) ? usage.cost : undefined;
      // Keep the existing behaviour of ignoring zero-cost assistant turns.
      if (!cost || !finiteNumber(cost.total) || !cost.total) continue;
      if (typeof entry.timestamp !== "string") continue;

      const modelId = typeof entry.message.model === "string" && entry.message.model
        ? entry.message.model
        : "unknown";
      const provider = typeof entry.message.provider === "string" && entry.message.provider
        ? entry.message.provider
        : undefined;
      const model = provider ? `${provider}/${modelId}` : modelId;
      const entryId = typeof entry.id === "string" && entry.id ? entry.id : undefined;
      entries.push({
        ...(entryId ? { entryId } : {}),
        day: entry.timestamp.slice(0, 10),
        model,
        cost: {
          total: cost.total,
          input: costValue(cost.input),
          output: costValue(cost.output),
          cacheRead: costValue(cost.cacheRead),
          cacheWrite: costValue(cost.cacheWrite),
        },
      });
    } catch {
      // One malformed JSONL line must not make the rest of this file unusable.
    }
  }

  return { entries };
}

// ─── stable snapshots ─────────────────────────────────────────────────────────

interface FileStamp {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function fileStamp(st: Stats): FileStamp {
  return {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
  };
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs;
}

/**
 * Read a whole file only when it remains unchanged from before to after the
 * read. A writer racing this scan is retried once; an unstable file is skipped
 * for this load and reconsidered next time instead of caching a partial read.
 */
async function readStableSnapshot(path: string): Promise<{ stamp: FileStamp; text: string } | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "r");
      const beforeStats = await handle.stat();
      if (!beforeStats.isFile()) return undefined;

      const content = await handle.readFile({ encoding: "utf8" });
      const afterStats = await handle.stat();
      if (!afterStats.isFile()) return undefined;

      const before = fileStamp(beforeStats);
      const after = fileStamp(afterStats);
      if (sameStamp(before, after)) {
        return { stamp: after, text: content };
      }
    } catch {
      // A disappearing/unreadable file is isolated from all other sessions.
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return undefined;
}

// ─── on-disk cache ────────────────────────────────────────────────────────────

const CACHE_VERSION = 3;

interface FileCacheEntry extends FileAggregate {
  stamp: FileStamp;
}

interface CacheFile {
  version: number;
  // An array of pairs avoids user-controlled object keys such as "__proto__".
  files: Array<[string, FileCacheEntry]>;
}

function parseCachedUsageEntry(value: unknown): AssistantUsageEntry | undefined {
  if (!isRecord(value) || typeof value.day !== "string" || typeof value.model !== "string" || !isRecord(value.cost)) {
    return undefined;
  }
  const { cost } = value;
  if (!finiteNumber(cost.total) || !finiteNumber(cost.input) || !finiteNumber(cost.output) ||
      !finiteNumber(cost.cacheRead) || !finiteNumber(cost.cacheWrite)) {
    return undefined;
  }
  if (value.entryId !== undefined && typeof value.entryId !== "string") return undefined;

  return {
    ...(typeof value.entryId === "string" && value.entryId ? { entryId: value.entryId } : {}),
    day: value.day,
    model: value.model,
    cost: {
      total: cost.total,
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cacheRead,
      cacheWrite: cost.cacheWrite,
    },
  };
}

function parseFileCacheEntry(value: unknown): FileCacheEntry | undefined {
  if (!isRecord(value) || !isRecord(value.stamp) || !Array.isArray(value.entries)) return undefined;
  const { stamp } = value;
  if (!finiteNumber(stamp.dev) || !finiteNumber(stamp.ino) || !finiteNumber(stamp.size) ||
      !finiteNumber(stamp.mtimeMs) || !finiteNumber(stamp.ctimeMs)) {
    return undefined;
  }

  const entries: AssistantUsageEntry[] = [];
  for (const rawEntry of value.entries) {
    const entry = parseCachedUsageEntry(rawEntry);
    if (!entry) return undefined;
    entries.push(entry);
  }

  return {
    stamp: {
      dev: stamp.dev,
      ino: stamp.ino,
      size: stamp.size,
      mtimeMs: stamp.mtimeMs,
      ctimeMs: stamp.ctimeMs,
    },
    entries,
  };
}

async function readCache(): Promise<Map<string, FileCacheEntry>> {
  try {
    const raw: unknown = JSON.parse(await readFile(cachePath(), "utf8"));
    if (!isRecord(raw) || raw.version !== CACHE_VERSION || !Array.isArray(raw.files)) return new Map();

    const files = new Map<string, FileCacheEntry>();
    for (const pair of raw.files) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") continue;
      const entry = parseFileCacheEntry(pair[1]);
      if (entry) files.set(pair[0], entry);
    }
    return files;
  } catch {
    // Missing/corrupt/stale cache — rebuild from session files.
    return new Map();
  }
}

async function writeCache(files: Map<string, FileCacheEntry>): Promise<void> {
  const cache: CacheFile = { version: CACHE_VERSION, files: [...files.entries()] };
  try {
    await writeFile(cachePath(), JSON.stringify(cache), "utf8");
  } catch {
    // Best-effort: a missing cache only makes the next load cold.
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

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonl(path, out);
    } else if (entry.name.endsWith(".jsonl")) {
      // Let resolveFile handle symlinks, deletion races, and unreadable files.
      out.push(path);
    }
  }
  return out;
}

// ─── main load (cached + rescan changed files) ─────────────────────────────────

/** Resolve one file, fully rescanning it whenever its stamp changed. */
async function resolveFile(path: string, previous: FileCacheEntry | undefined): Promise<FileCacheEntry | undefined> {
  try {
    const currentStats = await stat(path);
    if (!currentStats.isFile()) return undefined;
    const current = fileStamp(currentStats);
    if (previous && sameStamp(previous.stamp, current)) return previous;

    const snapshot = await readStableSnapshot(path);
    if (!snapshot) return undefined;
    return { stamp: snapshot.stamp, ...parseSessionFile(snapshot.text) };
  } catch {
    // One bad session file must not prevent the usage panel from opening.
    return undefined;
  }
}

function addDay(days: Map<string, DayCost>, key: string, cost: Cost): void {
  const day = days.get(key) ?? { total: 0, input: 0, output: 0, turns: 0 };
  day.total += cost.total;
  day.input += cost.input;
  day.output += cost.output;
  day.turns += 1;
  days.set(key, day);
}

function addModel(models: Map<string, ModelStats>, key: string, cost: Cost): void {
  const model = models.get(key) ?? { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  model.turns += 1;
  model.input += cost.input;
  model.output += cost.output;
  model.cacheRead += cost.cacheRead;
  model.cacheWrite += cost.cacheWrite;
  model.total += cost.total;
  models.set(key, model);
}

/**
 * Load usage from Pi's effective session directory. Callers should pass
 * `ctx.sessionManager.getSessionDir()` so --session-dir, environment, and
 * settings overrides are honored. The default keeps direct callers compatible.
 */
export async function loadUsageData(sessionDir = defaultSessionsRoot()): Promise<UsageData> {
  const cache = await readCache();
  const paths = await collectJsonl(sessionDir);
  const nextFiles = new Map<string, FileCacheEntry>();

  // Bounded concurrency keeps a cold load from opening every large file at once.
  const CONCURRENCY = 8;
  for (let index = 0; index < paths.length; index += CONCURRENCY) {
    const batch = paths.slice(index, index + CONCURRENCY);
    const resolved = await Promise.all(batch.map((path) => resolveFile(path, cache.get(path))));
    for (let i = 0; i < batch.length; i++) {
      const entry = resolved[i];
      if (entry) nextFiles.set(batch[i]!, entry);
    }
  }

  const days = new Map<string, DayCost>();
  const models = new Map<string, ModelStats>();
  const grand: Grand = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const seenAssistantEntryIds = new Set<string>();

  for (const file of nextFiles.values()) {
    for (const entry of file.entries) {
      // Forked/cloned sessions copy the original entry IDs. Count a copied
      // assistant turn once while leaving legacy entries without IDs intact.
      if (entry.entryId) {
        if (seenAssistantEntryIds.has(entry.entryId)) continue;
        seenAssistantEntryIds.add(entry.entryId);
      }

      addDay(days, entry.day, entry.cost);
      addModel(models, entry.model, entry.cost);
      grand.turns += 1;
      grand.input += entry.cost.input;
      grand.output += entry.cost.output;
      grand.cacheRead += entry.cost.cacheRead;
      grand.cacheWrite += entry.cost.cacheWrite;
      grand.total += entry.cost.total;
    }
  }

  await writeCache(nextFiles);
  return { days, models, grand };
}

/** Today's cost pulled straight from loaded data (used by the /usage panel). */
export function todayCostFrom(data: UsageData): TodayCost {
  return data.days.get(todayKey()) ?? { total: 0, input: 0, output: 0, turns: 0 };
}

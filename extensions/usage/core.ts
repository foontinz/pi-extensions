/**
 * Shared usage data loading.
 *
 * Scans the active session directory for assistant-turn cost entries and
 * returns a deduplicated flat entry list plus aggregates per day, per model,
 * and per project (used by the `/usage` panel).
 *
 * The cache stores complete per-file assistant entries. Files are only reused
 * when their complete filesystem stamp matches; changed files are read again
 * from a stable snapshot. Keeping entries (rather than only totals) also lets
 * the final aggregation deduplicate history copied by `/fork` and `/clone`.
 */

import type { Stats } from "node:fs";
import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ─── types ───────────────────────────────────────────────────────────────────

export interface Cost {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/** One deduplicated assistant turn with everything the panel drills into. */
export interface UsageEntry {
  day: string;
  model: string;
  project: string;
  cost: Cost;
  tokens: Tokens;
}

/** Aggregate over any group of entries (a day, a model, a project, everything). */
export interface GroupStats {
  turns: number;
  cost: Cost;
  tokens: Tokens;
}

export interface UsageData {
  entries: UsageEntry[];
  days: Map<string, GroupStats>;
  models: Map<string, GroupStats>;
  projects: Map<string, GroupStats>;
  grand: GroupStats;
}

export function emptyStats(): GroupStats {
  return {
    turns: 0,
    cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  };
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

interface AssistantUsageEntry {
  /** Present on current Pi session entries; absent on legacy/malformed entries. */
  entryId?: string;
  day: string;
  model: string;
  cost: Cost;
  tokens: Tokens;
}

interface FileAggregate {
  /** Session cwd from the header line; absent on legacy/truncated files. */
  project?: string;
  /** Session start (header timestamp); orders originals before their forks. */
  startedAt?: string;
  entries: AssistantUsageEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrZero(value: unknown): number {
  return finiteNumber(value) ? value : 0;
}

/** Parse all complete JSON values in a stable file snapshot. */
function parseSessionFile(text: string): FileAggregate {
  const entries: AssistantUsageEntry[] = [];
  let project: string | undefined;
  let startedAt: string | undefined;
  let headerSeen = false;

  // split() deliberately includes a final line without a trailing newline.
  // A concurrently written partial final line simply fails JSON.parse and is
  // picked up after the writer changes the file stamp on a later load.
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;

    // The session header (usually the first line) carries the project cwd
    // and the session start time.
    if (!headerSeen && line.includes('"type":"session"')) {
      headerSeen = true;
      try {
        const header: unknown = JSON.parse(line);
        if (isRecord(header) && header.type === "session") {
          if (typeof header.cwd === "string" && header.cwd) project = header.cwd;
          if (typeof header.timestamp === "string" && header.timestamp) startedAt = header.timestamp;
        }
      } catch {
        // Malformed header — fall back to the directory-derived project name.
      }
      continue;
    }

    if (!line.includes('"cost"')) continue;

    try {
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
      if (entry.message.role !== "assistant") continue;

      const usage = isRecord(entry.message.usage) ? entry.message.usage : undefined;
      const cost = usage && isRecord(usage.cost) ? usage.cost : undefined;
      if (!usage || !cost || !finiteNumber(cost.total)) continue;
      if (typeof entry.timestamp !== "string") continue;

      const tokens: Tokens = {
        input: numberOrZero(usage.input),
        output: numberOrZero(usage.output),
        cacheRead: numberOrZero(usage.cacheRead),
        cacheWrite: numberOrZero(usage.cacheWrite),
        reasoning: numberOrZero(usage.reasoning),
      };
      // Skip turns with neither cost nor tokens (aborted/empty turns), but
      // keep zero-cost turns from free or local models so token and turn
      // totals stay complete.
      const tokenSum = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
      if (!cost.total && !tokenSum) continue;

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
          input: numberOrZero(cost.input),
          output: numberOrZero(cost.output),
          cacheRead: numberOrZero(cost.cacheRead),
          cacheWrite: numberOrZero(cost.cacheWrite),
        },
        tokens,
      });
    } catch {
      // One malformed JSONL line must not make the rest of this file unusable.
    }
  }

  return { ...(project ? { project } : {}), ...(startedAt ? { startedAt } : {}), entries };
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

const CACHE_VERSION = 5;

interface FileCacheEntry extends FileAggregate {
  stamp: FileStamp;
}

interface CacheFile {
  version: number;
  // An array of pairs avoids user-controlled object keys such as "__proto__".
  files: Array<[string, FileCacheEntry]>;
}

function parseCachedUsageEntry(value: unknown): AssistantUsageEntry | undefined {
  if (!isRecord(value) || typeof value.day !== "string" || typeof value.model !== "string" ||
      !isRecord(value.cost) || !isRecord(value.tokens)) {
    return undefined;
  }
  const { cost, tokens } = value;
  if (!finiteNumber(cost.total) || !finiteNumber(cost.input) || !finiteNumber(cost.output) ||
      !finiteNumber(cost.cacheRead) || !finiteNumber(cost.cacheWrite)) {
    return undefined;
  }
  if (!finiteNumber(tokens.input) || !finiteNumber(tokens.output) || !finiteNumber(tokens.cacheRead) ||
      !finiteNumber(tokens.cacheWrite) || !finiteNumber(tokens.reasoning)) {
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
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      reasoning: tokens.reasoning,
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
  if (value.project !== undefined && typeof value.project !== "string") return undefined;
  if (value.startedAt !== undefined && typeof value.startedAt !== "string") return undefined;

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
    ...(typeof value.project === "string" && value.project ? { project: value.project } : {}),
    ...(typeof value.startedAt === "string" && value.startedAt ? { startedAt: value.startedAt } : {}),
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

function addToStats(stats: GroupStats, entry: UsageEntry): void {
  stats.turns += 1;
  stats.cost.total += entry.cost.total;
  stats.cost.input += entry.cost.input;
  stats.cost.output += entry.cost.output;
  stats.cost.cacheRead += entry.cost.cacheRead;
  stats.cost.cacheWrite += entry.cost.cacheWrite;
  stats.tokens.input += entry.tokens.input;
  stats.tokens.output += entry.tokens.output;
  stats.tokens.cacheRead += entry.tokens.cacheRead;
  stats.tokens.cacheWrite += entry.tokens.cacheWrite;
  stats.tokens.reasoning += entry.tokens.reasoning;
}

function addToGroup(groups: Map<string, GroupStats>, key: string, entry: UsageEntry): void {
  let stats = groups.get(key);
  if (!stats) {
    stats = emptyStats();
    groups.set(key, stats);
  }
  addToStats(stats, entry);
}

/** Aggregate any entry subset (the panel re-runs this over range filters). */
export function aggregateEntries(entries: Iterable<UsageEntry>): Omit<UsageData, "entries"> {
  const days = new Map<string, GroupStats>();
  const models = new Map<string, GroupStats>();
  const projects = new Map<string, GroupStats>();
  const grand = emptyStats();

  for (const entry of entries) {
    addToGroup(days, entry.day, entry);
    addToGroup(models, entry.model, entry);
    addToGroup(projects, entry.project, entry);
    addToStats(grand, entry);
  }

  return { days, models, projects, grand };
}

/**
 * Best-effort project label for a session file without a readable header:
 * the session directory name is Pi's escaped cwd (`--Users-alice-dev-app--`),
 * which is ambiguous to unescape, so it is shown as-is.
 */
function fallbackProject(path: string, sessionDir: string): string {
  const dir = dirname(path);
  if (dir === sessionDir) return "(unknown project)";
  return basename(dir);
}

/**
 * Sortable session start key. Prefers the header timestamp; falls back to the
 * timestamp Pi encodes in the file name ("2026-07-16T22-56-46-455Z_…"),
 * normalized to ISO so both forms compare correctly. Files with no known
 * start sort last so sessions with a known (earlier) start win deduplication.
 */
function sessionStartKey(path: string, file: { startedAt?: string }): string {
  if (file.startedAt) return file.startedAt;
  const m = basename(path).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (m) return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  return "9999-12-31T23:59:59.999Z";
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

  const entries: UsageEntry[] = [];
  const seenAssistantEntryIds = new Set<string>();

  // Deduplicate in session-start order: a fork/clone always starts after the
  // session it copied, so the original session wins and copied history stays
  // attributed to its original project regardless of file-walk order.
  const ordered = [...nextFiles.entries()].sort((a, b) => {
    const ka = sessionStartKey(a[0], a[1]);
    const kb = sessionStartKey(b[0], b[1]);
    return ka < kb ? -1 : ka > kb ? 1 : a[0].localeCompare(b[0]);
  });

  for (const [path, file] of ordered) {
    const project = file.project ?? fallbackProject(path, sessionDir);
    for (const entry of file.entries) {
      // Forked/cloned sessions copy the original entry IDs. Count a copied
      // assistant turn once while leaving legacy entries without IDs intact.
      if (entry.entryId) {
        if (seenAssistantEntryIds.has(entry.entryId)) continue;
        seenAssistantEntryIds.add(entry.entryId);
      }
      entries.push({ day: entry.day, model: entry.model, project, cost: entry.cost, tokens: entry.tokens });
    }
  }

  await writeCache(nextFiles);
  return { entries, ...aggregateEntries(entries) };
}

/** Today's stats pulled straight from loaded data (used by the /usage panel). */
export function todayCostFrom(data: UsageData): GroupStats {
  return data.days.get(todayKey()) ?? emptyStats();
}

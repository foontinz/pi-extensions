import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type AppPaths,
  type PrPaths,
  appPaths,
  decodePrKeyDirName,
  ensureAppDirs,
  ensurePrDirs,
  parsePrKey,
  prPaths,
} from "./paths.ts";

export type PrStatus = "initializing" | "watching" | "running" | "error";
export type EventType = "comment" | "review_comment" | "review" | "ci_failed" | "ci_passed" | "conflict";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface TmuxPaneRef {
  socketName: string | null;
  sessionId: string;
  windowId: string;
  paneId: string;
  ownerToken: string;
  paneToken: string;
}

export interface EventRecord {
  id: string;
  type: EventType;
  observedAt: string;
  actor: string | null;
  summary: string;
  raw: JsonValue;
  runAttempts: number;
}

export interface Escalation {
  id: string;
  runId: string | null;
  reason: string;
  details: string;
  createdAt: string;
  acknowledged: boolean;
}

export interface LastRun {
  runId: string;
  eventIds: string[];
  startedAt: string;
  finishedAt: string | null;
  outcome: "success" | "dry_run" | "escalated" | "timeout" | "error" | null;
}

export interface PrState {
  schemaVersion: 1;
  key: string;
  url: string;
  repoRoot: string | null;
  worktreePath: string | null;
  headRefName: string | null;
  baseRefName: string | null;
  status: PrStatus;
  createdAt: string;
  updatedAt: string;
  cursors: {
    initializedAt: string | null;
    issueCommentsSince: string | null;
    issueCommentIdsAtSince: number[];
    reviewCommentsSince: string | null;
    reviewCommentIdsAtSince: number[];
    lastReviewId: number | null;
    checksHash: string | null;
    mergeable: "UNKNOWN" | "MERGEABLE" | "CONFLICTING" | null;
    headOid: string | null;
    prState: "OPEN" | "CLOSED" | "MERGED" | null;
  };
  pendingEvents: EventRecord[];
  lastRun: LastRun | null;
  consecutiveErrors: number;
  escalations: Escalation[];
  tmux: TmuxPaneRef | null;
  lastError: string | null;
}

export interface InitialPrState {
  key: string;
  url?: string;
  repoRoot?: string | null;
  worktreePath?: string | null;
  headRefName?: string | null;
  baseRefName?: string | null;
}

const STATUSES = new Set<PrStatus>(["initializing", "watching", "running", "error"]);
const EVENT_TYPES = new Set<EventType>([
  "comment",
  "review_comment",
  "review",
  "ci_failed",
  "ci_passed",
  "conflict",
]);
const MERGEABLE = new Set(["UNKNOWN", "MERGEABLE", "CONFLICTING"]);
const PR_STATES = new Set(["OPEN", "CLOSED", "MERGED"]);
const OUTCOMES = new Set(["success", "dry_run", "escalated", "timeout", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return string(value, field);
}

function timestamp(value: unknown, field: string): string {
  const result = string(value, field);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${field} must be an RFC3339 timestamp`);
  return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function integerArray(value: unknown, field: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => nonNegativeInteger(entry, `${field}[${index}]`));
}

function jsonValue(value: unknown, field: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${field}[${index}]`));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, `${field}.${key}`)]));
  }
  throw new Error(`${field} is not valid JSON`);
}

function parseTmuxRef(value: unknown): TmuxPaneRef | null {
  if (value === null) return null;
  const item = assertRecord(value, "state.tmux");
  const socketName = nullableString(item.socketName, "state.tmux.socketName");
  const sessionId = string(item.sessionId, "state.tmux.sessionId");
  const windowId = string(item.windowId, "state.tmux.windowId");
  const paneId = string(item.paneId, "state.tmux.paneId");
  const ownerToken = string(item.ownerToken, "state.tmux.ownerToken");
  const paneToken = string(item.paneToken, "state.tmux.paneToken");
  if (!/^\$\d+$/.test(sessionId) || !/^@\d+$/.test(windowId) || !/^%\d+$/.test(paneId)) {
    throw new Error("state.tmux contains invalid tmux IDs");
  }
  if (!/^[a-f\d-]{36}$/i.test(ownerToken) || !/^[a-f\d-]{36}$/i.test(paneToken)) {
    throw new Error("state.tmux contains invalid ownership tokens");
  }
  return { socketName, sessionId, windowId, paneId, ownerToken, paneToken };
}

function parseEvent(value: unknown, index: number): EventRecord {
  const item = assertRecord(value, `state.pendingEvents[${index}]`);
  const type = string(item.type, `state.pendingEvents[${index}].type`) as EventType;
  if (!EVENT_TYPES.has(type)) throw new Error(`Unknown event type: ${type}`);
  return {
    id: string(item.id, `state.pendingEvents[${index}].id`),
    type,
    observedAt: timestamp(item.observedAt, `state.pendingEvents[${index}].observedAt`),
    actor: nullableString(item.actor, `state.pendingEvents[${index}].actor`),
    summary: string(item.summary, `state.pendingEvents[${index}].summary`),
    raw: jsonValue(item.raw, `state.pendingEvents[${index}].raw`),
    runAttempts: nonNegativeInteger(item.runAttempts, `state.pendingEvents[${index}].runAttempts`),
  };
}

function parseEscalation(value: unknown, index: number): Escalation {
  const item = assertRecord(value, `state.escalations[${index}]`);
  if (typeof item.acknowledged !== "boolean") {
    throw new Error(`state.escalations[${index}].acknowledged must be boolean`);
  }
  return {
    id: string(item.id, `state.escalations[${index}].id`),
    runId: nullableString(item.runId, `state.escalations[${index}].runId`),
    reason: string(item.reason, `state.escalations[${index}].reason`),
    details: string(item.details, `state.escalations[${index}].details`),
    createdAt: timestamp(item.createdAt, `state.escalations[${index}].createdAt`),
    acknowledged: item.acknowledged,
  };
}

function parseLastRun(value: unknown): LastRun | null {
  if (value === null) return null;
  const item = assertRecord(value, "state.lastRun");
  if (!Array.isArray(item.eventIds)) throw new Error("state.lastRun.eventIds must be an array");
  const outcome = item.outcome;
  if (outcome !== null && (typeof outcome !== "string" || !OUTCOMES.has(outcome))) {
    throw new Error("state.lastRun.outcome is invalid");
  }
  return {
    runId: string(item.runId, "state.lastRun.runId"),
    eventIds: item.eventIds.map((entry, index) => string(entry, `state.lastRun.eventIds[${index}]`)),
    startedAt: timestamp(item.startedAt, "state.lastRun.startedAt"),
    finishedAt: item.finishedAt === null ? null : timestamp(item.finishedAt, "state.lastRun.finishedAt"),
    outcome: outcome as LastRun["outcome"],
  };
}

export function createPrState(input: InitialPrState, now = new Date()): PrState {
  const parsed = parsePrKey(input.key);
  const at = now.toISOString();
  return {
    schemaVersion: 1,
    key: parsed.key,
    url: input.url ?? `https://${parsed.host}/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`,
    repoRoot: input.repoRoot ?? null,
    worktreePath: input.worktreePath ?? null,
    headRefName: input.headRefName ?? null,
    baseRefName: input.baseRefName ?? null,
    status: "initializing",
    createdAt: at,
    updatedAt: at,
    cursors: {
      initializedAt: null,
      issueCommentsSince: null,
      issueCommentIdsAtSince: [],
      reviewCommentsSince: null,
      reviewCommentIdsAtSince: [],
      lastReviewId: null,
      checksHash: null,
      mergeable: null,
      headOid: null,
      prState: null,
    },
    pendingEvents: [],
    lastRun: null,
    consecutiveErrors: 0,
    escalations: [],
    tmux: null,
    lastError: null,
  };
}

export function parsePrState(value: unknown, expectedKey?: string): PrState {
  const state = assertRecord(value, "state");
  if (state.schemaVersion !== 1) throw new Error(`Unsupported state schema: ${String(state.schemaVersion)}`);

  const key = parsePrKey(string(state.key, "state.key")).key;
  if (expectedKey !== undefined && key !== parsePrKey(expectedKey).key) {
    throw new Error(`State key ${key} does not match expected key ${parsePrKey(expectedKey).key}`);
  }

  const status = string(state.status, "state.status") as PrStatus;
  if (!STATUSES.has(status)) throw new Error(`Unknown state status: ${status}`);
  const cursors = assertRecord(state.cursors, "state.cursors");
  const mergeable = cursors.mergeable;
  if (mergeable !== null && (typeof mergeable !== "string" || !MERGEABLE.has(mergeable))) {
    throw new Error("state.cursors.mergeable is invalid");
  }
  const prState = cursors.prState ?? null;
  if (prState !== null && (typeof prState !== "string" || !PR_STATES.has(prState))) {
    throw new Error("state.cursors.prState is invalid");
  }
  if (!Array.isArray(state.pendingEvents)) throw new Error("state.pendingEvents must be an array");
  if (!Array.isArray(state.escalations)) throw new Error("state.escalations must be an array");

  return {
    schemaVersion: 1,
    key,
    url: string(state.url, "state.url"),
    repoRoot: nullableString(state.repoRoot, "state.repoRoot"),
    worktreePath: nullableString(state.worktreePath, "state.worktreePath"),
    headRefName: nullableString(state.headRefName, "state.headRefName"),
    baseRefName: state.baseRefName === undefined ? null : nullableString(state.baseRefName, "state.baseRefName"),
    status,
    createdAt: timestamp(state.createdAt, "state.createdAt"),
    updatedAt: timestamp(state.updatedAt, "state.updatedAt"),
    cursors: {
      initializedAt:
        cursors.initializedAt === undefined || cursors.initializedAt === null
          ? null
          : timestamp(cursors.initializedAt, "state.cursors.initializedAt"),
      issueCommentsSince: nullableString(cursors.issueCommentsSince, "state.cursors.issueCommentsSince"),
      issueCommentIdsAtSince: integerArray(cursors.issueCommentIdsAtSince, "state.cursors.issueCommentIdsAtSince"),
      reviewCommentsSince: nullableString(cursors.reviewCommentsSince, "state.cursors.reviewCommentsSince"),
      reviewCommentIdsAtSince: integerArray(cursors.reviewCommentIdsAtSince, "state.cursors.reviewCommentIdsAtSince"),
      lastReviewId:
        cursors.lastReviewId === null ? null : nonNegativeInteger(cursors.lastReviewId, "state.cursors.lastReviewId"),
      checksHash: nullableString(cursors.checksHash, "state.cursors.checksHash"),
      mergeable: mergeable as PrState["cursors"]["mergeable"],
      headOid: nullableString(cursors.headOid, "state.cursors.headOid"),
      prState: prState as PrState["cursors"]["prState"],
    },
    pendingEvents: state.pendingEvents.map(parseEvent),
    lastRun: parseLastRun(state.lastRun),
    consecutiveErrors: nonNegativeInteger(state.consecutiveErrors, "state.consecutiveErrors"),
    escalations: state.escalations.map(parseEscalation),
    tmux: parseTmuxRef(state.tmux),
    lastError: nullableString(state.lastError, "state.lastError"),
  };
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new Error("Value is not JSON serializable");
  const text = `${serialized}\n`;
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await ensureDirectory(dirname(path));

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Refusing unsafe state directory: ${path}`);
  }
}

async function requireSafePrDirectory(paths: PrPaths): Promise<boolean> {
  try {
    const info = await lstat(paths.prDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Refusing unsafe PR state directory: ${paths.prDir}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function loadPrState(input: string, app: AppPaths = appPaths()): Promise<PrState | undefined> {
  const key = parsePrKey(input).key;
  const paths = prPaths(key, app);
  if (!(await requireSafePrDirectory(paths))) return undefined;
  let text: string;
  try {
    text = await readFile(paths.stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return parsePrState(JSON.parse(text) as unknown, key);
  } catch (error) {
    throw new Error(`Invalid state ${paths.stateFile}: ${(error as Error).message}`);
  }
}

async function withPrStateLock<T>(paths: PrPaths, task: () => Promise<T>): Promise<T> {
  const lockPath = join(paths.prDir, "state-operation.lock");
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        return await task();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await lstat(lockPath)).mtimeMs > 60_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error(`Timed out waiting for state operation lock: ${lockPath}`);
}

async function readStateFile(paths: PrPaths, expectedKey: string): Promise<PrState | undefined> {
  try {
    return parsePrState(JSON.parse(await readFile(paths.stateFile, "utf8")) as unknown, expectedKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function mergeMonotonicEscalations(next: PrState, current: PrState | undefined): void {
  if (!current) return;
  const nextById = new Map(next.escalations.map((item) => [item.id, item]));
  for (const saved of current.escalations) {
    const candidate = nextById.get(saved.id);
    if (!candidate) {
      next.escalations.push(saved);
      continue;
    }
    if (saved.acknowledged) candidate.acknowledged = true;
  }
}

export async function savePrState(state: PrState, app: AppPaths = appPaths()): Promise<void> {
  const parsed = parsePrState(state, state.key);
  const paths = prPaths(parsed.key, app);
  await ensureAppDirs(app);
  await ensurePrDirs(paths);
  await withPrStateLock(paths, async () => {
    mergeMonotonicEscalations(parsed, await readStateFile(paths, parsed.key));
    parsed.updatedAt = new Date().toISOString();
    await writeJsonAtomic(paths.stateFile, parsed);
  });
  state.updatedAt = parsed.updatedAt;
  state.escalations = parsed.escalations;
}

export async function mutatePrState<T>(
  input: string,
  mutate: (state: PrState) => T | Promise<T>,
  app: AppPaths = appPaths(),
): Promise<{ state: PrState; result: T }> {
  const key = parsePrKey(input).key;
  const paths = prPaths(key, app);
  await ensureAppDirs(app);
  await ensurePrDirs(paths);
  return withPrStateLock(paths, async () => {
    const state = await readStateFile(paths, key);
    if (!state) throw new Error(`${key} is not watched`);
    const result = await mutate(state);
    const parsed = parsePrState(state, key);
    parsed.updatedAt = new Date().toISOString();
    await writeJsonAtomic(paths.stateFile, parsed);
    return { state: parsed, result };
  });
}

export async function appendEventRecords(
  input: string,
  events: readonly EventRecord[],
  app: AppPaths = appPaths(),
): Promise<void> {
  if (events.length === 0) return;
  const key = parsePrKey(input).key;
  const paths = prPaths(key, app);
  await ensureAppDirs(app);
  await ensurePrDirs(paths);
  const recordedIds = new Set<string>();
  try {
    const existing = await readFile(paths.eventsFile, "utf8");
    for (const [index, line] of existing.split("\n").entries()) {
      if (line === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`Invalid events JSONL ${paths.eventsFile}:${index + 1}: ${(error as Error).message}`);
      }
      if (typeof value !== "object" || value === null || typeof (value as { id?: unknown }).id !== "string") {
        throw new Error(`Invalid event record ${paths.eventsFile}:${index + 1}`);
      }
      recordedIds.add((value as { id: string }).id);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const unrecorded = events.filter((event) => !recordedIds.has(event.id));
  if (unrecorded.length === 0) return;
  const lines = unrecorded.map((event) => JSON.stringify(event)).join("\n") + "\n";
  const handle = await open(paths.eventsFile, "a", 0o600);
  try {
    await handle.writeFile(lines, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function archivePrState(input: string, app: AppPaths = appPaths()): Promise<string | undefined> {
  const key = parsePrKey(input).key;
  const paths = prPaths(key, app);
  if (!(await requireSafePrDirectory(paths))) return undefined;
  const suffix = new Date().toISOString().replaceAll(":", "-");
  const archive = join(paths.prDir, `state.unwatched.${suffix}.json`);
  try {
    await rename(paths.stateFile, archive);
    return archive;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface ListedState {
  state?: PrState;
  path: string;
  error?: Error;
}

export async function listPrStates(app: AppPaths = appPaths()): Promise<ListedState[]> {
  let names: string[];
  try {
    names = await readdir(app.prsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const results = await Promise.all(
    names.sort().map(async (name): Promise<ListedState | undefined> => {
      const directory = join(app.prsDir, name);
      const path = join(directory, "state.json");
      let expectedKey: string;
      try {
        expectedKey = decodePrKeyDirName(name);
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error("PR state entry is not a real directory");
        }
        const text = await readFile(path, "utf8");
        return { state: parsePrState(JSON.parse(text) as unknown, expectedKey), path };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        return { path, error: error as Error };
      }
    }),
  );
  return results.filter((entry): entry is ListedState => entry !== undefined);
}

export function statePaths(state: Pick<PrState, "key">, app: AppPaths = appPaths()): PrPaths {
  return prPaths(state.key, app);
}

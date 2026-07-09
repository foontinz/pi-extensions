import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JobOwnerInfo } from "./types.js";

export interface JobStorePaths {
  root: string;
  jobsDir: string;
  logsDir: string;
  /** Full per-job session transcripts (JSONL), one dir per job. */
  sessionsDir: string;
}

/** A short-lived, durable claim made before a job record exists. */
export interface CapacityReservation {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  instanceId: string;
  parentPid: number;
  repoKey: string;
  createdAt: number;
}

export const JOB_STORE_ROOT = process.env.PI_SUBAGENTS_STORE_DIR
  ? path.resolve(process.env.PI_SUBAGENTS_STORE_DIR)
  : path.join(os.homedir(), ".pi", "agent", "subagents");
export const JOB_OWNERS_DIR = path.join(JOB_STORE_ROOT, "owners");

const JOB_LOCK_STALE_MS = 5 * 60_000;
const JOB_LOCK_WAIT_MS = 2_000;

export function storePathsForOwner(owner: JobOwnerInfo): JobStorePaths {
  const root = path.join(JOB_OWNERS_DIR, owner.id);
  return { root, jobsDir: path.join(root, "jobs"), logsDir: path.join(root, "logs"), sessionsDir: path.join(root, "sessions") };
}

export function ensureJobStoreDirsFor(store: JobStorePaths): void {
  for (const dir of [JOB_STORE_ROOT, JOB_OWNERS_DIR, store.root, store.jobsDir, store.logsDir, store.sessionsDir, capacityReservationsDirForStore(store)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best effort; persistence still works if chmod is unavailable.
    }
  }
}

export function jobStatePathForStore(store: JobStorePaths, id: string): string {
  return path.join(store.jobsDir, `${id}.json`);
}

export function jobLogPathForStore(store: JobStorePaths, id: string, stream: "stdout" | "stderr"): string {
  return path.join(store.logsDir, stream === "stdout" ? `${id}.stdout.jsonl` : `${id}.stderr.log`);
}

export function jobExitCodePathForStore(store: JobStorePaths, id: string): string {
  return path.join(store.logsDir, `${id}.exit`);
}

/** Isolated directory holding one job's full session transcript(s) (JSONL). */
export function jobSessionDirForStore(store: JobStorePaths, id: string): string {
  return path.join(store.sessionsDir, id);
}

export function callbackMarkerPathForStore(store: JobStorePaths, id: string): string {
  return path.join(store.jobsDir, `${id}.callback.json`);
}

/** Directory for durable pre-launch capacity claims for one stable owner. */
export function capacityReservationsDirForStore(store: JobStorePaths): string {
  return path.join(store.root, "reservations");
}

export function capacityReservationPathForStore(store: JobStorePaths, reservationId: string): string {
  return path.join(capacityReservationsDirForStore(store), `${reservationId}.json`);
}

/**
 * A single owner-wide lock used only to count records/reservations and create
 * or remove a reservation. Never hold it while preparing a worktree or
 * starting a model session.
 */
export function capacityLockPathForStore(store: JobStorePaths): string {
  return path.join(store.root, ".capacity.lock");
}

export function withOwnerCapacityLock<T>(store: JobStorePaths, action: () => T): T {
  ensureJobStoreDirsFor(store);
  return withFileLock(capacityLockPathForStore(store), action);
}

export function readCapacityReservationsForStore(store: JobStorePaths): CapacityReservation[] {
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(capacityReservationsDirForStore(store));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const reservations: CapacityReservation[] = [];
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) continue;
    try {
      const reservation = JSON.parse(fs.readFileSync(path.join(capacityReservationsDirForStore(store), fileName), "utf-8")) as unknown;
      if (isCapacityReservation(reservation) && fileName === `${reservation.id}.json`) reservations.push(reservation);
    } catch {
      // A concurrent atomic rename or a corrupt stale reservation is not a
      // usable claim. The next successful reservation writes a fresh record.
    }
  }
  return reservations;
}

/** Remove reservation records whose owning process no longer exists. */
export function pruneDeadCapacityReservationsForStore(store: JobStorePaths): CapacityReservation[] {
  const live: CapacityReservation[] = [];
  for (const reservation of readCapacityReservationsForStore(store)) {
    if (isProcessAlive(reservation.parentPid)) {
      live.push(reservation);
      continue;
    }
    try {
      fs.rmSync(capacityReservationPathForStore(store, reservation.id), { force: true });
    } catch {
      // Keep the claim in this scan if it could not be removed. This is
      // conservative: a failed cleanup must not permit over-capacity starts.
      live.push(reservation);
    }
  }
  return live;
}

export function withJobFileLock<T>(store: JobStorePaths, jobId: string, action: () => T): T {
  return withFileLock(`${jobStatePathForStore(store, jobId)}.lock`, action);
}

function withFileLock<T>(lockPath: string, action: () => T): T {
  const started = Date.now();
  while (true) {
    let fd: number | undefined;
    let acquired = false;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      acquired = true;
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, "utf-8");
      return action();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (acquired || code !== "EEXIST") throw error;
      maybeRemoveStaleLock(lockPath);
      if (Date.now() - started > JOB_LOCK_WAIT_MS) throw error;
      sleepSync(25);
      continue;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      if (acquired) {
        try { fs.rmSync(lockPath, { force: true }); } catch {}
      }
    }
  }
}

function isCapacityReservation(value: unknown): value is CapacityReservation {
  if (!value || typeof value !== "object") return false;
  const reservation = value as Partial<CapacityReservation>;
  return reservation.schemaVersion === 1
    && typeof reservation.id === "string"
    && typeof reservation.ownerId === "string"
    && typeof reservation.instanceId === "string"
    && typeof reservation.parentPid === "number"
    && Number.isInteger(reservation.parentPid)
    && reservation.parentPid > 0
    && typeof reservation.repoKey === "string"
    && typeof reservation.createdAt === "number";
}

export function writeTextAtomicForStore(store: JobStorePaths, filePath: string, text: string): void {
  ensureJobStoreDirsFor(store);
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

export function writeJsonAtomicForStore(store: JobStorePaths, filePath: string, value: unknown): void {
  writeTextAtomicForStore(store, filePath, JSON.stringify(value) + "\n");
}

function maybeRemoveStaleLock(lockPath: string): void {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8").trim().split(/\r?\n/);
    const pid = Number.parseInt(raw[0] ?? "", 10);
    const timestamp = Number.parseInt(raw[1] ?? "", 10);
    if (!Number.isFinite(pid) || !Number.isFinite(timestamp)) return;
    if (Date.now() - timestamp < JOB_LOCK_STALE_MS) return;
    if (isProcessAlive(pid)) return;
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Ignore: another process may have removed/recreated the lock.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

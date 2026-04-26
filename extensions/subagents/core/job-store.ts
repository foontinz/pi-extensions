import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JobOwnerInfo } from "./types.js";

export interface JobStorePaths {
  root: string;
  jobsDir: string;
  logsDir: string;
}

export const JOB_STORE_ROOT = process.env.PI_SUBAGENTS_STORE_DIR
  ? path.resolve(process.env.PI_SUBAGENTS_STORE_DIR)
  : path.join(os.homedir(), ".pi", "agent", "subagents");
export const JOB_OWNERS_DIR = path.join(JOB_STORE_ROOT, "owners");

const JOB_LOCK_STALE_MS = 5 * 60_000;
const JOB_LOCK_WAIT_MS = 2_000;

export function storePathsForOwner(owner: JobOwnerInfo): JobStorePaths {
  const root = path.join(JOB_OWNERS_DIR, owner.id);
  return { root, jobsDir: path.join(root, "jobs"), logsDir: path.join(root, "logs") };
}

export function ensureJobStoreDirsFor(store: JobStorePaths): void {
  for (const dir of [JOB_STORE_ROOT, JOB_OWNERS_DIR, store.root, store.jobsDir, store.logsDir]) {
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

export function callbackMarkerPathForStore(store: JobStorePaths, id: string): string {
  return path.join(store.jobsDir, `${id}.callback.json`);
}

export function withJobFileLock<T>(store: JobStorePaths, jobId: string, action: () => T): T {
  const lockPath = `${jobStatePathForStore(store, jobId)}.lock`;
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

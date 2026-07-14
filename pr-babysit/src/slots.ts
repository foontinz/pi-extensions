import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type AppPaths, appPaths, ensureAppDirs } from "./paths.ts";

export interface RunSlot {
  index: number;
  path: string;
  token: string;
  release(): Promise<void>;
}

interface SlotOwner {
  token: string;
  pid: number;
  startedAt: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(path: string): Promise<SlotOwner | null> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing unsafe run slot: ${path}`);
    const value = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Partial<SlotOwner>;
    if (
      typeof value.token !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.startedAt !== "string" ||
      Number.isNaN(Date.parse(value.startedAt))
    ) return null;
    return { token: value.token, pid: value.pid, startedAt: value.startedAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function activeLeases(app: AppPaths, staleAfterMs: number): Promise<Array<{ path: string; owner: SlotOwner }>> {
  const names = await readdir(app.slotsDir);
  const active: Array<{ path: string; owner: SlotOwner }> = [];
  for (const name of names) {
    if (!/^lease-[a-f\d-]{36}$/i.test(name)) continue;
    const path = join(app.slotsDir, name);
    const owner = await readOwner(path);
    const stale = owner === null || Date.now() - Date.parse(owner.startedAt) > staleAfterMs || !processAlive(owner.pid);
    if (stale) {
      // Lease paths contain UUIDs and are never reused, so removing this exact
      // stale path cannot delete a replacement lease created by another process.
      await rm(path, { recursive: true, force: true });
    } else {
      active.push({ path, owner });
    }
  }
  return active.sort((left, right) =>
    left.owner.startedAt.localeCompare(right.owner.startedAt) || left.owner.token.localeCompare(right.owner.token)
  );
}

export async function acquireRunSlot(
  maximum: number,
  options: {
    app?: AppPaths;
    signal?: AbortSignal;
    staleAfterMs?: number;
    retryMs?: number;
  } = {},
): Promise<RunSlot> {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 32) throw new Error("maximum run slots must be 1 to 32");
  const app = options.app ?? appPaths();
  const staleAfterMs = options.staleAfterMs ?? 2 * 60 * 60_000;
  const retryMs = options.retryMs ?? 1_000;
  await ensureAppDirs(app);
  const token = randomUUID();
  const path = join(app.slotsDir, `lease-${token}`);
  const temporary = join(app.slotsDir, `.lease-${token}.tmp`);
  const owner: SlotOwner = { token, pid: process.pid, startedAt: new Date().toISOString() };
  await mkdir(temporary, { mode: 0o700 });
  try {
    await writeFile(join(temporary, "owner.json"), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  try {
    while (!options.signal?.aborted) {
      const leases = await activeLeases(app, staleAfterMs);
      const index = leases.findIndex((lease) => lease.owner.token === token);
      if (index < 0) throw new Error("Run slot lease disappeared while waiting");
      if (index < maximum) {
        return {
          index,
          path,
          token,
          async release(): Promise<void> {
            const saved = await readOwner(path);
            if (saved === null) return;
            if (saved.token !== token) throw new Error("Run slot ownership changed");
            await rm(path, { recursive: true });
          },
        };
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(finish, retryMs);
        const signal = options.signal;
        function finish(): void {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          resolveWait();
        }
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    throw new Error("Run slot acquisition aborted");
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

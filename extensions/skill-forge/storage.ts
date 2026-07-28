import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Diagnostic, ForgeState } from "./types.ts";
import { STATE_VERSION, type ForgeConfig } from "./types.ts";

export const DEFAULT_CONFIG: ForgeConfig = {
  backgroundEnabled: true,
  paused: false,
  inventoryIntervalMs: 60_000,
  maxRetries: 4,
  maxRequestChars: 36_000,
  maxEntriesPerChunk: 120,
};

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function canonicalProject(cwd: string): Promise<string> {
  return realpath(cwd).catch(() => resolve(cwd));
}

export async function projectStateDir(agentDir: string, cwd: string): Promise<{ cwd: string; key: string; dir: string }> {
  const canonical = await canonicalProject(cwd);
  const key = sha256(canonical);
  return { cwd: canonical, key, dir: join(agentDir, "skill-forge", "projects", key) };
}

function initialState(cwd: string, projectKey: string): ForgeState {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    project: { cwd, projectKey, createdAt: now, updatedAt: now },
    config: { ...DEFAULT_CONFIG },
    watermarks: {},
    jobs: [],
    proposals: [],
    diagnostics: [],
  };
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function string(value: unknown, maximum = 100_000): value is string { return typeof value === "string" && value.length <= maximum; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number { return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum; }
function timestamp(value: unknown): value is string { return string(value, 40) && Number.isFinite(Date.parse(value)); }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function scope(value: unknown): value is "user" | "project" { return value === "user" || value === "project"; }
function fail(path: string): never { throw new Error(`Malformed or incompatible Skill Forge state at ${path}`); }
function stampShape(value: unknown): boolean {
  return record(value) && finite(value.dev) && finite(value.ino) && finite(value.size) && finite(value.mtimeMs) && finite(value.ctimeMs);
}
function evidenceShape(value: unknown): boolean {
  return record(value) && string(value.ref, 64) && string(value.sessionId, 300) && string(value.sessionPath, 4_096) && string(value.entryId, 300)
    && (value.parentId === null || string(value.parentId, 300)) && ["root", "reply", "orphan"].includes(value.branchRelation as string)
    && string(value.timestamp, 100) && string(value.kind, 100) && string(value.excerpt, 1_000) && digest(value.evidenceDigest);
}
function proposedScopeShape(value: unknown): boolean {
  return record(value) && scope(value.scope) && string(value.rationale, 2_000) && finite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    && Array.isArray(value.signals) && value.signals.length <= 20 && value.signals.every((item) => string(item, 300));
}
function validateState(raw: unknown, cwd: string, key: string): ForgeState {
  if (!record(raw)) fail("root");
  if (raw.version !== STATE_VERSION) fail("version");
  if (!record(raw.project) || raw.project.cwd !== cwd || raw.project.projectKey !== key || !timestamp(raw.project.createdAt) || !timestamp(raw.project.updatedAt)) fail("project");
  const config = raw.config;
  if (!record(config) || typeof config.backgroundEnabled !== "boolean" || typeof config.paused !== "boolean"
    || !integer(config.inventoryIntervalMs, 10_000, 86_400_000) || !integer(config.maxRetries, 1, 20)
    || !integer(config.maxRequestChars, 4_096, 200_000) || !integer(config.maxEntriesPerChunk, 1, 2_000)) fail("config");
  if (!record(raw.watermarks)) fail("watermarks");
  for (const [path, value] of Object.entries(raw.watermarks)) {
    if (!record(value) || value.path !== path || !string(value.sessionId, 300) || !integer(value.nextEntryIndex) || !digest(value.processedPrefixDigest)
      || !stampShape(value.lastStamp) || !integer(value.lastEntryCount) || !timestamp(value.updatedAt)) fail(`watermarks.${path}`);
  }
  if (!Array.isArray(raw.jobs) || raw.jobs.length > 100_000) fail("jobs");
  const jobIds = new Set<string>();
  for (const [index, value] of raw.jobs.entries()) {
    if (!record(value) || !string(value.id, 100) || jobIds.has(value.id) || !string(value.sessionId, 300) || !string(value.sessionPath, 4_096)
      || !integer(value.startEntryIndex) || !integer(value.endEntryIndex, value.startEntryIndex + 1) || !digest(value.rangeDigest)
      || !["queued", "leased", "retry", "dead"].includes(value.status as string) || !integer(value.attempts, 0, 1_000)
      || !finite(value.nextRunAt) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
      || (value.lastError !== undefined && !string(value.lastError, 2_000))) fail(`jobs.${index}`);
    jobIds.add(value.id);
    if (value.status === "leased") {
      if (!record(value.lease) || !string(value.lease.owner, 200) || !string(value.lease.token, 200) || !finite(value.lease.expiresAt)) fail(`jobs.${index}.lease`);
    } else if (value.lease !== undefined) fail(`jobs.${index}.lease`);
  }
  if (!Array.isArray(raw.proposals) || raw.proposals.length > 20_000) fail("proposals");
  const proposalIds = new Set<string>();
  for (const [index, value] of raw.proposals.entries()) {
    if (!record(value) || !string(value.id, 100) || proposalIds.has(value.id) || !integer(value.revision, 1) || !string(value.capabilityKey, 160)
      || !digest(value.fingerprint) || !string(value.title, 200) || !string(value.rationale, 2_000) || !finite(value.confidence) || value.confidence < 0 || value.confidence > 1
      || !string(value.skillName, 64) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.skillName) || !string(value.description, 1_024) || !string(value.skillMd, 50_000)
      || !proposedScopeShape(value.proposedScope) || (value.selectedScope !== undefined && !scope(value.selectedScope)) || !["create", "update"].includes(value.operation as string)
      || !["ready", "deferred", "rejected", "invalidated", "applying", "accepted", "apply_failed"].includes(value.status as string)
      || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || (value.reviewerEditedAt !== undefined && !timestamp(value.reviewerEditedAt))
      || (value.rejectionReason !== undefined && !string(value.rejectionReason, 2_000)) || (value.lastApplyError !== undefined && !string(value.lastApplyError, 2_000))
      || !Array.isArray(value.provenance) || value.provenance.length > 500) fail(`proposals.${index}`);
    proposalIds.add(value.id);
    for (const provenance of value.provenance) {
      if (!record(provenance) || !string(provenance.sessionId, 300) || !string(provenance.sessionPath, 4_096) || !string(provenance.jobId, 100)
        || !timestamp(provenance.analyzedAt) || !string(provenance.analyzerModel, 300) || !string(provenance.analyzerPromptVersion, 100)
        || !digest(provenance.candidateFingerprint) || !Array.isArray(provenance.evidence) || provenance.evidence.length > 200 || !provenance.evidence.every(evidenceShape)) fail(`proposals.${index}.provenance`);
    }
    if (value.status === "applying") {
      const applying = value.applying;
      if (!record(applying) || !scope(applying.scope) || !string(applying.path, 4_096) || !digest(applying.contentDigest) || !timestamp(applying.startedAt)
        || !string(applying.owner, 200) || !string(applying.token, 200) || !finite(applying.expiresAt)) fail(`proposals.${index}.applying`);
    } else if (value.applying !== undefined) fail(`proposals.${index}.applying`);
    if (value.installed !== undefined && (!record(value.installed) || !scope(value.installed.scope) || !string(value.installed.path, 4_096) || !digest(value.installed.contentDigest) || !timestamp(value.installed.installedAt))) fail(`proposals.${index}.installed`);
  }
  if (!Array.isArray(raw.diagnostics) || raw.diagnostics.length > 200) fail("diagnostics");
  for (const [index, value] of raw.diagnostics.entries()) {
    if (!record(value) || !string(value.id, 100) || !timestamp(value.at) || !["info", "warning", "error"].includes(value.severity as string)
      || !string(value.code, 100) || !string(value.message, 2_000) || (value.sessionPath !== undefined && !string(value.sessionPath, 4_096)) || (value.jobId !== undefined && !string(value.jobId, 100))) fail(`diagnostics.${index}`);
  }
  return raw as unknown as ForgeState;
}

function hydrateState(raw: unknown, cwd: string, key: string): ForgeState { return validateState(raw, cwd, key); }

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
  try {
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    // Some filesystems do not permit directory fsync. The file rename remains atomic.
  }
}

interface LockOwner { pid: number; token: string; createdAt: number }
type LockState = "active" | "stale" | "missing";

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function inspectLock(lockPath: string): Promise<LockState> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
    return typeof owner.pid !== "number" || (!processAlive(owner.pid) && Date.now() - (owner.createdAt ?? 0) > 2_000) ? "stale" : "active";
  } catch {
    try {
      return Date.now() - (await stat(lockPath)).mtimeMs > 30_000 ? "stale" : "active";
    } catch (error) {
      // The owner can release the lock after owner.json is read but before the
      // fallback stat. That is normal contention, not a background failure.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }
}

export class ProjectStore {
  readonly statePath: string;
  readonly lockPath: string;

  constructor(readonly dir: string, readonly cwd: string, readonly projectKey: string) {
    this.statePath = join(dir, "state.json");
    this.lockPath = join(dir, ".state.lock");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => undefined);
    await this.withLock(async (state) => state);
  }

  async read(): Promise<ForgeState> {
    try {
      return hydrateState(JSON.parse(await readFile(this.statePath, "utf8")), this.cwd, this.projectKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState(this.cwd, this.projectKey);
      // Preserve a corrupt file for doctor rather than replacing it outside the lock.
      throw new Error(`Skill Forge state is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async withLock<T>(operation: (state: ForgeState) => Promise<T> | T): Promise<T> {
    const release = await this.acquireLock();
    try {
      let state: ForgeState;
      try { state = await this.read(); }
      catch (error) {
        const corrupt = `${this.statePath}.quarantine-${Date.now()}-${randomBytes(4).toString("hex")}`;
        // Fail closed unless the incompatible bytes were successfully preserved.
        await rename(this.statePath, corrupt);
        state = initialState(this.cwd, this.projectKey);
        addDiagnostic(state, "error", "state_quarantined", `${error instanceof Error ? error.message : String(error)}; preserved at ${corrupt}`);
      }
      const result = await operation(state);
      state.project.updatedAt = new Date().toISOString();
      validateState(state, this.cwd, this.projectKey);
      await writeAtomicJson(this.statePath, state);
      return result;
    } finally {
      await release();
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const token = `${process.pid}-${randomBytes(10).toString("hex")}`;
    for (let attempt = 0; attempt < 160; attempt++) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        await writeAtomicJson(join(this.lockPath, "owner.json"), { pid: process.pid, token, createdAt: Date.now() } satisfies LockOwner);
        return async () => {
          try {
            const owner = JSON.parse(await readFile(join(this.lockPath, "owner.json"), "utf8")) as LockOwner;
            if (owner.token === token) await rm(this.lockPath, { recursive: true, force: true });
          } catch { /* already released or replaced */ }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockState = await inspectLock(this.lockPath);
        if (lockState === "missing") continue;
        if (lockState === "stale" && await this.reapStaleLock()) continue;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(20 + attempt * 5, 200)));
      }
    }
    throw new Error(`Timed out acquiring Skill Forge state lock: ${this.lockPath}`);
  }

  private async reapStaleLock(): Promise<boolean> {
    const reaperPath = `${this.lockPath}.reaper`;
    try {
      await mkdir(reaperPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A process may die while owning the reaper mutex. Reclaim that mutex
      // after a conservative timeout so one crash cannot wedge this project.
      try {
        if (Date.now() - (await stat(reaperPath)).mtimeMs > 30_000) {
          await rm(reaperPath, { recursive: true, force: true });
        }
      } catch { /* another process already removed it */ }
      return false;
    }
    try {
      // Re-evaluate only after winning the reaper mutex. A live contender may
      // have acquired a replacement lock while this process was waiting.
      let stale = false;
      try {
        const owner = JSON.parse(await readFile(join(this.lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
        stale = typeof owner.pid !== "number" || (!processAlive(owner.pid) && Date.now() - (owner.createdAt ?? 0) > 2_000);
      } catch {
        try { stale = Date.now() - (await stat(this.lockPath)).mtimeMs > 30_000; }
        catch { return true; }
      }
      if (!stale) return false;
      await rm(this.lockPath, { recursive: true, force: true });
      return true;
    } finally {
      await rm(reaperPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function addDiagnostic(
  state: ForgeState,
  severity: Diagnostic["severity"],
  code: string,
  message: string,
  extra: Pick<Diagnostic, "sessionPath" | "jobId"> = {},
): void {
  const at = new Date().toISOString();
  const id = sha256(`${at}\0${code}\0${message}\0${extra.sessionPath ?? ""}`).slice(0, 16);
  const previous = state.diagnostics.at(-1);
  if (previous?.code === code && previous.message === message && previous.sessionPath === extra.sessionPath) return;
  state.diagnostics.push({ id, at, severity, code, message: message.slice(0, 2_000), ...extra });
  if (state.diagnostics.length > 200) state.diagnostics.splice(0, state.diagnostics.length - 200);
}

export async function assertRegularNotSymlink(path: string, allowMissing = false): Promise<void> {
  try {
    const value = await lstat(path);
    if (value.isSymbolicLink()) throw new Error(`Refusing symlink path: ${path}`);
    if (!value.isFile() && !value.isDirectory()) throw new Error(`Refusing non-regular path: ${path}`);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export const __testing = { initialState, hydrateState, validateState, writeAtomicJson, processAlive, inspectLock };

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { beginApplying, failApplying, finishAccepted, validateInstallableSkill } from "./proposals.ts";
import type { ProjectStore } from "./storage.ts";
import { sha256 } from "./storage.ts";
import type { ApplyingLease, Proposal, Scope } from "./types.ts";

export interface InstallOptions { projectCwd: string; agentDir: string; configDirName: string; projectTrusted: boolean }
interface Identity { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
export interface InstallPlan {
  proposalId: string;
  scope: Scope;
  base: string;
  root: string;
  skillDir: string;
  path: string;
  content: string;
  contentDigest: string;
  collision: "none" | "identical" | "different";
  existing?: string;
  destinationIdentity?: Identity;
  diff?: string;
}

const APPLY_LEASE_MS = 2 * 60_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function identity(value: Awaited<ReturnType<typeof lstat>>): Identity { return { dev: Number(value.dev), ino: Number(value.ino), size: Number(value.size), mtimeMs: Number(value.mtimeMs), ctimeMs: Number(value.ctimeMs) }; }
function sameIdentity(a: Identity | undefined, b: Identity | undefined): boolean {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs);
}
function sameNode(a: Identity | undefined, b: Identity | undefined): boolean { return Boolean(a && b && a.dev === b.dev && a.ino === b.ino); }
async function lstatMaybe(path: string) {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function readRegularNoFollow(path: string): Promise<{ content: string; identity: Identity }> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Install destination is not a regular file: ${path}`);
    const content = await handle.readFile("utf8");
    const after = await handle.stat();
    const a = identity(before); const b = identity(after);
    if (!sameIdentity(a, b)) throw new Error(`Install destination changed while being read: ${path}`);
    return { content, identity: b };
  } finally { await handle.close(); }
}

async function ensureSafeDirectories(base: string, target: string): Promise<void> {
  const baseResolved = resolve(base);
  if (!inside(target, baseResolved)) throw new Error(`Install path escapes scope base: ${target}`);
  const baseStat = await lstat(baseResolved);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw new Error(`Unsafe scope base: ${baseResolved}`);
  let current = baseResolved;
  for (const part of relative(baseResolved, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    const value = await lstatMaybe(current);
    if (!value) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error(`Unsafe newly created path component: ${current}`);
    } else if (value.isSymbolicLink() || !value.isDirectory()) throw new Error(`Unsafe path component: ${current}`);
  }
}

export function boundedDiff(before: string, after: string, maximum = 8_000): string {
  const oldLines = before.split("\n"); const newLines = after.split("\n"); const lines: string[] = [];
  for (let index = 0; index < Math.max(oldLines.length, newLines.length); index++) {
    if (oldLines[index] === newLines[index]) continue;
    if (oldLines[index] !== undefined) lines.push(`-${index + 1}: ${oldLines[index]}`);
    if (newLines[index] !== undefined) lines.push(`+${index + 1}: ${newLines[index]}`);
    if (lines.join("\n").length > maximum) { lines.push("…diff truncated…"); break; }
  }
  return lines.join("\n");
}

export async function prepareInstall(proposal: Proposal, scope: Scope, options: InstallOptions): Promise<InstallPlan> {
  if (scope === "project" && !options.projectTrusted) throw new Error("Project skill installation requires project trust");
  validateInstallableSkill(proposal.skillMd, proposal.skillName);
  const base = resolve(scope === "project" ? options.projectCwd : options.agentDir);
  const root = resolve(scope === "project" ? join(base, options.configDirName, "skills") : join(base, "skills"));
  const skillDir = resolve(root, proposal.skillName); const path = resolve(skillDir, "SKILL.md");
  if (!inside(root, base) || !inside(skillDir, root) || !inside(path, root)) throw new Error("Skill install path is not confined to its scope root");
  let chain = base;
  for (const component of ["", ...relative(base, path).split(sep).filter(Boolean)]) {
    if (component) chain = join(chain, component);
    const value = await lstatMaybe(chain);
    if (value?.isSymbolicLink()) throw new Error(`Refusing symlinked install path: ${chain}`);
  }
  let existing: string | undefined; let destinationIdentity: Identity | undefined;
  const destination = await lstatMaybe(path);
  if (destination) {
    if (destination.isSymbolicLink() || !destination.isFile()) throw new Error(`Install destination is not a regular file: ${path}`);
    const current = await readRegularNoFollow(path); existing = current.content; destinationIdentity = current.identity;
  }
  return {
    proposalId: proposal.id, scope, base, root, skillDir, path, content: proposal.skillMd, contentDigest: sha256(proposal.skillMd),
    collision: existing === undefined ? "none" : existing === proposal.skillMd ? "identical" : "different",
    ...(existing !== undefined ? { existing, destinationIdentity, diff: boundedDiff(existing, proposal.skillMd) } : {}),
  };
}

function assertReviewedCollision(reviewed: InstallPlan, current: InstallPlan, confirmed: boolean): void {
  if (reviewed.path !== current.path || reviewed.root !== current.root || reviewed.contentDigest !== current.contentDigest || reviewed.scope !== current.scope) throw new Error("Install target or proposal changed after review");
  if (reviewed.collision === "different" && !confirmed) throw new Error("Existing skill differs; explicit collision confirmation is required");
  if (reviewed.collision !== current.collision) throw new Error(`Destination changed after review (${reviewed.collision} -> ${current.collision})`);
  if (reviewed.collision !== "none" && (reviewed.existing !== current.existing || !sameIdentity(reviewed.destinationIdentity, current.destinationIdentity))) throw new Error("Destination changed after collision review");
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); }
  catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { await handle.close(); }
}

async function verifyInstalled(plan: InstallPlan): Promise<void> {
  const value = await lstat(plan.path);
  if (value.isSymbolicLink() || !value.isFile()) throw new Error("Installed destination is not a regular non-symlink file");
  const actual = await readRegularNoFollow(plan.path);
  if (sha256(actual.content) !== plan.contentDigest || actual.content !== plan.content) throw new Error("Installed bytes failed digest verification");
  const canonicalRoot = await realpath(plan.root); const canonicalPath = await realpath(plan.path);
  if (!inside(canonicalPath, canonicalRoot)) throw new Error("Installed file resolved outside the skill root");
}

export async function applyInstall(store: ProjectStore, reviewed: InstallPlan, collisionConfirmed: boolean, options: InstallOptions): Promise<void> {
  const owner = `${process.pid}-${randomBytes(8).toString("hex")}`; const token = randomBytes(16).toString("hex");
  let applying!: ApplyingLease; let plan!: InstallPlan;
  await store.withLock(async (state) => {
    const proposal = state.proposals.find((item) => item.id === reviewed.proposalId);
    if (!proposal) throw new Error(`Unknown proposal: ${reviewed.proposalId}`);
    if (proposal.status === "accepted") {
      if (!proposal.installed || proposal.installed.contentDigest !== reviewed.contentDigest || proposal.installed.scope !== reviewed.scope) {
        throw new Error("Accepted proposal scope or digest differs; reopen it as a new revision before installing elsewhere");
      }
      const currentAccepted = await prepareInstall(proposal, reviewed.scope, options);
      if (currentAccepted.path !== proposal.installed.path || currentAccepted.collision !== "identical" || currentAccepted.contentDigest !== proposal.installed.contentDigest) {
        throw new Error("Accepted skill installation is missing or has drifted; reopen the proposal before repairing it");
      }
      return;
    }
    if (proposal.status !== "ready") throw new Error(`Proposal ${proposal.id} cannot be accepted from status ${proposal.status}`);
    // Re-derive the target from locked proposal content and caller-owned roots,
    // then revalidate every collision, including an identical destination.
    plan = await prepareInstall(proposal, reviewed.scope, options);
    assertReviewedCollision(reviewed, plan, collisionConfirmed);
    applying = { scope: plan.scope, path: plan.path, contentDigest: plan.contentDigest, startedAt: new Date().toISOString(), owner, token, expiresAt: Date.now() + APPLY_LEASE_MS };
    beginApplying(proposal, applying);
  });
  if (!applying) return; // Idempotent already-accepted finalization.

  try {
    await ensureSafeDirectories(plan.base, plan.skillDir);
    const parentBefore = identity(await lstat(plan.skillDir));
    if (plan.collision === "identical") {
      const current = await readRegularNoFollow(plan.path);
      if (!sameIdentity(plan.destinationIdentity, current.identity) || sha256(current.content) !== plan.contentDigest) throw new Error("Identical destination became stale before acceptance");
    } else {
      if (plan.collision === "none" && await lstatMaybe(plan.path)) throw new Error("Destination appeared after review; refusing silent overwrite");
      if (plan.collision === "different") {
        const current = await readRegularNoFollow(plan.path);
        if (!sameIdentity(plan.destinationIdentity, current.identity) || current.content !== plan.existing) throw new Error("Destination changed before write");
      }
      const temporary = join(plan.skillDir, `.SKILL.md.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      try { await handle.writeFile(plan.content, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      try {
        const parentNow = identity(await lstat(plan.skillDir));
        if (!sameNode(parentBefore, parentNow)) throw new Error("Skill directory changed during installation");
        if (plan.collision === "none") {
          // link(2) is an atomic no-replace publication; a concurrent new
          // destination produces EEXIST rather than being overwritten.
          await link(temporary, plan.path);
          await rm(temporary, { force: true });
        } else {
          const current = await readRegularNoFollow(plan.path);
          if (!sameIdentity(plan.destinationIdentity, current.identity) || current.content !== plan.existing) throw new Error("Destination changed immediately before rename");
          await rename(temporary, plan.path);
        }
        await chmod(plan.path, 0o600);
        await fsyncDirectory(plan.skillDir);
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    }
    await verifyInstalled(plan);
    await store.withLock((state) => {
      const proposal = state.proposals.find((item) => item.id === plan.proposalId);
      if (!proposal) throw new Error("Proposal disappeared during apply");
      finishAccepted(proposal, applying);
    });
  } catch (error) {
    await store.withLock((state) => {
      const proposal = state.proposals.find((item) => item.id === plan.proposalId);
      if (proposal) failApplying(proposal, applying, error instanceof Error ? error.message : String(error));
    });
    throw error;
  }
}

export const __testing = { inside, ensureSafeDirectories, lstatMaybe, readRegularNoFollow, sameIdentity, sameNode, assertReviewedCollision, APPLY_LEASE_MS };

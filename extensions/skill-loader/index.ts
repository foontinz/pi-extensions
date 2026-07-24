import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt, getAgentDir, getSettingsListTheme, loadSkillsFromDir, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  Container,
  type SettingItem,
  SettingsList,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = join(getAgentDir(), "skill-loader");
const SOURCES_DIR = join(ROOT, "sources");
const REGISTRY_PATH = join(ROOT, "registry.json");
const REGISTRY_LOCK_PATH = join(ROOT, "registry.lock");
const LEASES_DIR = join(ROOT, "leases");
const USER_SKILLS_DIR = join(getAgentDir(), "skills");
const SKILLS_UI_COMMAND_NAME = "skills-ui";
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const SKILL_COMMAND_PREFIX = "skill:";
const MAX_TAG_SUGGESTIONS = 20;

export type InlineSkill = {
  name: string;
  description?: string;
  filePath: string;
  baseDir: string;
};

export type Registry = {
  version: 1;
  skills: Record<string, InstalledSkill>;
  userSkills: Record<string, UserSkillPreference>;
};

export type UserSkillPreference = {
  enabled: boolean;
  discoveredAt: string;
  updatedAt: string;
};

export type InstalledSkill = {
  name: string;
  description: string;
  path: string;
  sourceUrl: string;
  sourceId: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
};

export type GitHubSpec = {
  cloneUrl: string;
  sourceId: string;
  /** Segments following /tree/ in a GitHub URL. Resolved against remote refs after cloning. */
  treePath?: string[];
};

type DiscoveredSkill = Pick<InstalledSkill, "name" | "description" | "path">;

function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function emptyRegistry(): Registry {
  return {
    version: 1,
    skills: Object.create(null) as Record<string, InstalledSkill>,
    userSkills: Object.create(null) as Record<string, UserSkillPreference>,
  };
}

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRegistry(content: string): Registry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid skill-loader registry JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.skills)) {
    throw new Error("Invalid skill-loader registry: expected version 1 with a skills object");
  }
  const skills = Object.create(null) as Record<string, InstalledSkill>;
  for (const [key, value] of Object.entries(parsed.skills)) {
    if (
      !isRecord(value) ||
      typeof value.name !== "string" || value.name !== key ||
      typeof value.description !== "string" ||
      typeof value.path !== "string" ||
      typeof value.sourceUrl !== "string" ||
      typeof value.sourceId !== "string" ||
      typeof value.enabled !== "boolean" ||
      typeof value.installedAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      throw new Error(`Invalid skill-loader registry skill record: ${key}`);
    }
    skills[key] = value as unknown as InstalledSkill;
  }

  const rawUserSkills = parsed.userSkills ?? {};
  if (!isRecord(rawUserSkills)) throw new Error("Invalid skill-loader registry: userSkills must be an object");
  const userSkills = Object.create(null) as Record<string, UserSkillPreference>;
  for (const [key, value] of Object.entries(rawUserSkills)) {
    if (
      !isRecord(value) ||
      typeof value.enabled !== "boolean" ||
      typeof value.discoveredAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      throw new Error(`Invalid skill-loader user-skill preference: ${key}`);
    }
    userSkills[key] = value as unknown as UserSkillPreference;
  }
  return { version: 1, skills, userSkills };
}

async function loadRegistry(): Promise<Registry> {
  try {
    return parseRegistry(await readFile(REGISTRY_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw error;
  }
}

async function saveRegistry(registry: Registry): Promise<void> {
  const directory = dirname(REGISTRY_PATH);
  await mkdir(directory, { recursive: true });
  const tmp = `${REGISTRY_PATH}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tmp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(registry, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, REGISTRY_PATH);
    // The registry is committed once rename succeeds. Directory fsync improves
    // crash durability where supported, but must not turn a committed write
    // into an apparent failure whose caller deletes referenced artifacts.
    try {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Some platforms/filesystems do not support opening or syncing dirs.
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

type LockOwner = { token: string; pid: number; createdAt: number };

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isLockCollision(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    if (typeof owner?.token === "string" && typeof owner?.pid === "number" && typeof owner?.createdAt === "number") {
      return owner as LockOwner;
    }
  } catch {
    // A contender may observe the directory before its owner file is written.
  }
  return undefined;
}

async function releaseDirectoryLock(lockPath: string, owner: LockOwner): Promise<void> {
  try {
    if ((await readLockOwner(lockPath))?.token === owner.token) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch {
    // Lock cleanup must not hide the registry mutation result.
  }
}

async function reclaimStaleLock(lockPath: string): Promise<boolean> {
  try {
    const owner = await readLockOwner(lockPath);
    if (owner) {
      if (await processIsAlive(owner.pid)) return false;
    } else {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) return false;
    }

    // Rename claims this dead/legacy partial lock before removing it, so a
    // contender can never delete a newly acquired replacement.
    const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    await rename(lockPath, stalePath);
    await rm(stalePath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Serialize registry writes across both concurrent extension calls and pi processes. */
export async function withDirectoryLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const owner: LockOwner = { token: randomUUID(), pid: process.pid, createdAt: Date.now() };
  const candidate = `${lockPath}.candidate-${process.pid}-${owner.token}`;
  await mkdir(candidate);
  try {
    await writeFile(join(candidate, "owner.json"), JSON.stringify(owner), "utf8");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        // Directory rename atomically publishes both the lock and its owner.
        await rename(candidate, lockPath);
      } catch (error) {
        if (!isLockCollision(error)) throw error;
        if (await reclaimStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for skill-loader lock: ${lockPath}`);
        }
        await delay(LOCK_RETRY_DELAY_MS);
        continue;
      }

      try {
        return await task();
      } finally {
        await releaseDirectoryLock(lockPath, owner);
      }
    }
  } finally {
    await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
  }
}

let registryMutationQueue: Promise<void> = Promise.resolve();

function withRegistryLock<T>(task: () => Promise<T>): Promise<T> {
  const run = registryMutationQueue.then(() => withDirectoryLock(REGISTRY_LOCK_PATH, task));
  registryMutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function mutateRegistry<T>(mutation: (registry: Registry) => T | Promise<T>): Promise<T> {
  return withRegistryLock(async () => {
    const registry = await loadRegistry();
    const result = await mutation(registry);
    await saveRegistry(registry);
    return result;
  });
}

function sourceIdFor(url: string): string {
  const clean = url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 10);
  return `${clean.slice(0, 70)}_${hash}`;
}

function decodePathSegment(segment: string, input: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new Error(`Invalid encoded path in GitHub URL: ${input}`);
  }
}

export function parseGitHubUrl(input: string): GitHubSpec {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Missing GitHub URL");

  // Supports:
  //   https://github.com/org/repo
  //   https://github.com/org/repo/tree/ref/path/to/skills
  //   git@github.com:org/repo.git
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    const cloneUrl = `https://github.com/${sshMatch[1]}/${sshMatch[2]}.git`;
    return { cloneUrl, sourceId: sourceIdFor(trimmed) };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Only GitHub URLs are supported for now: ${trimmed}`);
  }
  if (url.hostname !== "github.com") throw new Error(`Only github.com URLs are supported for now: ${trimmed}`);

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Expected a GitHub repo URL: ${trimmed}`);
  const [owner, rawRepo] = parts;
  const repo = rawRepo.replace(/\.git$/, "");
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  const treePath = parts[2] === "tree" && parts.length > 3
    ? parts.slice(3).map((segment) => decodePathSegment(segment, trimmed))
    : undefined;

  return { cloneUrl, treePath, sourceId: sourceIdFor(trimmed) };
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/** Split a /tree/ path at the longest branch or tag name advertised by the remote. */
export function splitTreePath(treePath: string[], remoteRefs: Iterable<string>): { checkout: string; subdir?: string } {
  const refs = new Set(remoteRefs);
  for (let end = treePath.length; end > 0; end--) {
    const candidate = treePath.slice(0, end).join("/");
    if (refs.has(`refs/heads/${candidate}`) || refs.has(`refs/tags/${candidate}`)) {
      const subdir = treePath.slice(end).join("/");
      return { checkout: candidate, subdir: subdir || undefined };
    }
  }

  // A SHA cannot be resolved from ls-remote reliably; a single path segment is
  // still a valid ref to fetch. For an unknown branch, fetch gives the user the
  // useful git error instead of silently scanning the wrong checkout.
  return { checkout: treePath[0]!, subdir: treePath.slice(1).join("/") || undefined };
}

async function resolveTreePath(target: string, treePath: string[] | undefined): Promise<{ checkout?: string; subdir?: string }> {
  if (!treePath || treePath.length === 0) return {};
  const advertised = await git(["ls-remote", "--heads", "--tags", "origin"], target);
  const refs = advertised
    .split(/\r?\n/)
    .map((line) => line.split("\t")[1])
    .filter((ref): ref is string => Boolean(ref));
  return splitTreePath(treePath, refs);
}

export function isPathWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function sourcePathFor(sourcesDir: string, sourceId: string): string {
  // sourceId is generated from the URL, but cloneOrUpdate is public too.
  // Keep both the checkout and its lock as direct children of sourcesDir.
  if (!/^[a-zA-Z0-9._-]+$/.test(sourceId) || sourceId === "." || sourceId === "..") {
    throw new Error(`Invalid skill source ID: ${sourceId}`);
  }
  const target = resolve(sourcesDir, sourceId);
  if (!isPathWithin(sourcesDir, target)) throw new Error(`Invalid skill source ID: ${sourceId}`);
  return target;
}

function sourceLockPathFor(sourcesDir: string, sourceId: string): string {
  const target = sourcePathFor(sourcesDir, sourceId);
  return `${target}.lock`;
}

function immutableGenerationPrefix(sourceId: string): string {
  return `${sourceId}.generation-`;
}

function checkoutRootForInstalledSkill(skill: Pick<InstalledSkill, "path" | "sourceId">): string {
  sourcePathFor(SOURCES_DIR, skill.sourceId); // Validate the logical source ID.
  const relativePath = relative(resolve(SOURCES_DIR), resolve(skill.path));
  const firstSegment = relativePath.split(sep)[0];
  const prefix = immutableGenerationPrefix(skill.sourceId);
  const generationSuffix = firstSegment?.startsWith(prefix) ? firstSegment.slice(prefix.length) : undefined;
  const isPublishedGeneration = generationSuffix !== undefined && /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generationSuffix);
  if (
    !firstSegment ||
    firstSegment === ".." ||
    (firstSegment !== skill.sourceId && !isPublishedGeneration)
  ) {
    throw new Error(`Skill path is outside its source checkout: ${skill.path}`);
  }
  return resolve(SOURCES_DIR, firstSegment);
}

type GenerationLease = { pid: number; createdAt: number; checkoutRoots: string[] };

function generationRootForInstalledSkill(skill: InstalledSkill): string | undefined {
  const root = checkoutRootForInstalledSkill(skill);
  return basename(root).startsWith(immutableGenerationPrefix(skill.sourceId)) ? root : undefined;
}

async function writeGenerationLease(path: string, checkoutRoots: string[]): Promise<void> {
  await mkdir(LEASES_DIR, { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const lease: GenerationLease = {
    pid: process.pid,
    createdAt: Date.now(),
    checkoutRoots: [...new Set(checkoutRoots.map((root) => resolve(root)))],
  };
  try {
    await writeFile(tmp, JSON.stringify(lease), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function liveGenerationLeaseRoots(): Promise<Set<string>> {
  const roots = new Set<string>();
  let entries: string[];
  try {
    entries = await readdir(LEASES_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return roots;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(LEASES_DIR, entry);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<GenerationLease>;
      if (!Number.isInteger(parsed.pid) || !Array.isArray(parsed.checkoutRoots)) throw new Error("invalid lease");
      if (!(await processIsAlive(parsed.pid!))) {
        await rm(path, { force: true });
        continue;
      }
      for (const root of parsed.checkoutRoots) {
        if (typeof root === "string" && isPathWithin(SOURCES_DIR, root)) roots.add(resolve(root));
      }
    } catch {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  return roots;
}

async function removeSourceStaging(sourceId: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(SOURCES_DIR);
  } catch {
    return;
  }
  const prefix = `${sourceId}.staging-`;
  await Promise.allSettled(
    entries.filter((entry) => entry.startsWith(prefix)).map((entry) =>
      rm(resolve(SOURCES_DIR, entry), { recursive: true, force: true }),
    ),
  );
}

async function collectSourceGarbage(sourceId: string, registry: Registry): Promise<void> {
  const keep = await liveGenerationLeaseRoots();
  for (const skill of Object.values(registry.skills)) {
    const root = generationRootForInstalledSkill(skill);
    if (root) keep.add(resolve(root));
  }
  let entries: string[];
  try {
    entries = await readdir(SOURCES_DIR);
  } catch {
    return;
  }
  const generationPrefix = immutableGenerationPrefix(sourceId);
  await Promise.allSettled(entries.flatMap((entry) => {
    const path = resolve(SOURCES_DIR, entry);
    return entry.startsWith(generationPrefix) && !keep.has(path)
      ? [rm(path, { recursive: true, force: true })]
      : [];
  }));
  await removeSourceStaging(sourceId);
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const pathStat = await lstat(path);
  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink: ${path}`);
  }
}

async function assertSafeSkillTree(root: string, confinementRoot = root): Promise<string> {
  await assertRealDirectory(root, "Skill directory");
  if (resolve(confinementRoot) !== resolve(root)) {
    await assertRealDirectory(confinementRoot, "Skill checkout root");
  }

  const realConfinementRoot = await realpath(confinementRoot);
  const realRoot = await realpath(root);
  if (!isPathWithin(realConfinementRoot, realRoot)) {
    throw new Error(`Skill directory escapes its source checkout: ${root}`);
  }

  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      // Git internals are not skill content and can be very large. Validate the
      // checkout root itself, but do not recursively scan its private database.
      if (entry === ".git" && resolve(dir) === resolve(realConfinementRoot)) continue;
      const path = join(dir, entry);
      const entryStat = await lstat(path);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in skill sources: ${path}`);
      }
      const realEntry = await realpath(path);
      if (!isPathWithin(realConfinementRoot, realEntry)) {
        throw new Error(`Skill source path escapes its checkout: ${path}`);
      }
      if (entryStat.isDirectory()) await visit(path);
    }
  };
  await visit(root);
  return realRoot;
}

async function cloneOrUpdateUnlocked(spec: GitHubSpec, sourcesDir: string): Promise<string> {
  await mkdir(sourcesDir, { recursive: true });
  await assertRealDirectory(sourcesDir, "Skill sources directory");
  const target = sourcePathFor(sourcesDir, spec.sourceId);
  const existingTarget = await lstatIfExists(target);
  if (existingTarget?.isSymbolicLink()) {
    throw new Error(`Skill source checkout must not be a symlink: ${target}`);
  }

  if (await exists(join(target, ".git"))) {
    // Validate an existing checkout before asking git to read its metadata.
    await assertSafeSkillTree(target, sourcesDir);
    await git(["fetch", "--prune", "--tags", "origin"], target);
  } else {
    await rm(target, { recursive: true, force: true });
    await git(["clone", "--depth", "1", spec.cloneUrl, target]);
  }

  const { checkout, subdir } = await resolveTreePath(target, spec.treePath);
  // Fetching into FETCH_HEAD and then detaching from it is deliberate: it
  // ensures refreshes use the fetched branch/tag/SHA rather than a stale local
  // branch or a same-named tag.
  await git(["fetch", "--depth", "1", "origin", checkout ?? "HEAD"], target);
  await git(["checkout", "--detach", "FETCH_HEAD"], target);

  const root = subdir ? resolve(target, subdir) : target;
  if (!isPathWithin(target, root) || isPathWithin(join(target, ".git"), root)) {
    throw new Error(`Invalid subdirectory in GitHub URL: ${subdir ?? ""}`);
  }
  if (!(await exists(root))) {
    throw new Error(`Skill subdirectory does not exist in the fetched ref: ${subdir}`);
  }
  await assertSafeSkillTree(root, target);
  return root;
}

/** Clone/update one source while serializing the checkout with other Pi processes. */
export async function cloneOrUpdate(spec: GitHubSpec, sourcesDir = SOURCES_DIR): Promise<string> {
  return withDirectoryLock(sourceLockPathFor(sourcesDir, spec.sourceId), () => cloneOrUpdateUnlocked(spec, sourcesDir));
}

type ImmutableCheckout = { root: string; checkoutRoot: string };

async function cloneImmutableGenerationUnlocked(spec: GitHubSpec, sourcesDir: string): Promise<ImmutableCheckout> {
  const stagingId = `${spec.sourceId}.staging-${process.pid}-${randomUUID()}`;
  const stagingRoot = sourcePathFor(sourcesDir, stagingId);
  let publishedRoot: string | undefined;
  let ownsPublishedRoot = false;
  try {
    const skillRoot = await cloneOrUpdateUnlocked({ ...spec, sourceId: stagingId }, sourcesDir);
    const skillRelativePath = relative(stagingRoot, skillRoot);
    // Published generations are content snapshots, not mutable Git worktrees.
    await rm(join(stagingRoot, ".git"), { recursive: true, force: true });
    const generationId = `${immutableGenerationPrefix(spec.sourceId)}${Date.now()}-${randomUUID()}`;
    publishedRoot = sourcePathFor(sourcesDir, generationId);
    await rename(stagingRoot, publishedRoot);
    ownsPublishedRoot = true;
    const publishedSkillRoot = resolve(publishedRoot, skillRelativePath);
    await assertSafeSkillTree(publishedSkillRoot, publishedRoot);
    return { root: publishedSkillRoot, checkoutRoot: publishedRoot };
  } catch (error) {
    await Promise.allSettled([
      rm(stagingRoot, { recursive: true, force: true }),
      ...(publishedRoot && ownsPublishedRoot ? [rm(publishedRoot, { recursive: true, force: true })] : []),
    ]);
    throw error;
  }
}

/**
 * Publish a refresh as a new immutable generation. Existing Pi sessions keep
 * reading their previous generation while the registry atomically switches new
 * sessions to the fully validated checkout.
 */
export async function cloneImmutableGeneration(spec: GitHubSpec, sourcesDir = SOURCES_DIR): Promise<string> {
  return withDirectoryLock(sourceLockPathFor(sourcesDir, spec.sourceId), async () =>
    (await cloneImmutableGenerationUnlocked(spec, sourcesDir)).root,
  );
}

/** Use Pi's own skill loader so YAML, validation, ignores, and discovery match normal skill loading. */
export async function discoverSkills(root: string): Promise<DiscoveredSkill[]> {
  const safeRoot = await assertSafeSkillTree(root);
  const { skills } = loadSkillsFromDir({ dir: safeRoot, source: "skill-loader" });
  const discovered = skills.filter((skill) => basename(skill.filePath) === "SKILL.md");
  const seen = new Set<string>();
  for (const skill of discovered) {
    if (!isValidSkillName(skill.name)) {
      throw new Error(`Invalid downloaded skill name: ${skill.name}`);
    }
    if (seen.has(skill.name)) {
      throw new Error(`Duplicate downloaded skill name: ${skill.name}`);
    }
    seen.add(skill.name);
  }
  return discovered
    .map((skill) => ({ name: skill.name, description: skill.description, path: skill.baseDir }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Discover Pi's normal user skills without modifying their SKILL.md files. */
export function discoverUserSkills(root = USER_SKILLS_DIR): Skill[] {
  return loadSkillsFromDir({ dir: root, source: "user" }).skills
    .sort((a, b) => a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath));
}

/** New user-directory skills are deliberately user-only until explicitly enabled. */
export function reconcileUserSkillPreferences(
  registry: Registry,
  discovered: Skill[],
  now: string,
): void {
  const currentPaths = new Set(discovered.map((skill) => resolve(skill.filePath)));
  for (const path of Object.keys(registry.userSkills)) {
    if (!currentPaths.has(path)) delete registry.userSkills[path];
  }
  for (const path of currentPaths) {
    registry.userSkills[path] ??= { enabled: false, discoveredAt: now, updatedAt: now };
  }
}

function userSkillPreference(registry: Registry, skill: Skill, userSkillsRoot = USER_SKILLS_DIR): UserSkillPreference | undefined {
  if (!isPathWithin(userSkillsRoot, skill.filePath)) return undefined;
  return registry.userSkills[resolve(skill.filePath)] ?? { enabled: false, discoveredAt: "", updatedAt: "" };
}

/** Apply Skill Loader visibility while preserving non-user/project/package skill policy. */
export function selectSkillsForPrompt(skills: Skill[], registry: Registry, userSkillsRoot = USER_SKILLS_DIR): Skill[] {
  const installedByPath = new Map(
    Object.values(registry.skills).map((skill) => [resolve(skill.path), skill.enabled] as const),
  );
  return skills.flatMap((skill) => {
    const userPreference = userSkillPreference(registry, skill, userSkillsRoot);
    const installedEnabled = installedByPath.get(resolve(skill.baseDir));
    const enabled = userPreference?.enabled ?? installedEnabled;
    if (enabled === undefined) return [skill];
    return enabled ? [{ ...skill, disableModelInvocation: false }] : [];
  });
}

const STANDARD_SKILLS_SECTION = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;

/** Replace Pi's generated skills section without rewriting user-owned skill files. */
export function rewriteSkillsInPrompt(systemPrompt: string, allSkills: Skill[], selectedSkills: Skill[]): string {
  const originalSection = formatSkillsForPrompt(allSkills);
  const selectedSection = formatSkillsForPrompt(selectedSkills);
  if (originalSection && systemPrompt.includes(originalSection)) {
    return systemPrompt.replace(originalSection, selectedSection);
  }
  if (STANDARD_SKILLS_SECTION.test(systemPrompt)) {
    return systemPrompt.replace(STANDARD_SKILLS_SECTION, selectedSection);
  }
  if (!selectedSection) return systemPrompt;
  const cwdMarker = "\nCurrent working directory:";
  const markerIndex = systemPrompt.lastIndexOf(cwdMarker);
  return markerIndex >= 0
    ? `${systemPrompt.slice(0, markerIndex)}${selectedSection}${systemPrompt.slice(markerIndex)}`
    : `${systemPrompt}${selectedSection}`;
}

function skillCommands(pi: Pick<ExtensionAPI, "getCommands">): InlineSkill[] {
  return pi.getCommands().flatMap((command) => {
    if (command.source !== "skill" || !command.name.startsWith(SKILL_COMMAND_PREFIX)) return [];
    const name = command.name.slice(SKILL_COMMAND_PREFIX.length);
    if (!isValidSkillName(name)) return [];
    return [{
      name,
      description: command.description,
      filePath: command.sourceInfo.path,
      // Pi's native skill expansion resolves references from the SKILL.md
      // directory, including for package-provided and root .md skills.
      baseDir: dirname(command.sourceInfo.path),
    }];
  });
}

type TextRange = { start: number; end: number };

type ParsedInlineTags = {
  skills: InlineSkill[];
  text: string;
};

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Ranges are sorted and non-overlapping, so membership stays O(log n). */
function rangeContains(ranges: TextRange[], index: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle]!;
    if (index < range.start) high = middle - 1;
    else if (index >= range.end) low = middle + 1;
    else return true;
  }
  return false;
}

function markdownContainerInfo(line: string): { content: string; blockquoteDepth: number } {
  const content = line.endsWith("\r") ? line.slice(0, -1) : line;
  // Consume mixed nested blockquote/list prefixes in one linear match. Fence
  // closure additionally requires the opener's blockquote depth, preventing a
  // literal `> ``` ` inside a top-level fence from ending it.
  const containers = content.match(/^(?:(?: {0,3}>[ \t]?)|(?: {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+))+/)?.[0] ?? "";
  return {
    content: content.slice(containers.length),
    blockquoteDepth: containers.match(/>/g)?.length ?? 0,
  };
}

type BacktickRun = { start: number; length: number };

function isEscapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

function collectBacktickRuns(text: string, blockRanges: TextRange[]): BacktickRun[] {
  const runs: BacktickRun[] = [];
  for (let index = 0; index < text.length;) {
    if (text[index] !== "`" || isEscapedAt(text, index) || rangeContains(blockRanges, index)) {
      index++;
      continue;
    }
    let end = index + 1;
    while (text[end] === "`") end++;
    runs.push({ start: index, length: end - index });
    index = end;
  }
  return runs;
}

/** Markdown code and URLs are literal text, not invocation syntax. */
function protectedTagRanges(text: string): TextRange[] {
  const blocks: TextRange[] = [];
  let fence: { marker: "`" | "~"; length: number; start: number; blockquoteDepth: number } | undefined;
  let lineStart = 0;

  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline + 1;
    const rawLine = text.slice(lineStart, newline === -1 ? text.length : newline);
    const container = markdownContainerInfo(rawLine);
    const line = container.content;
    if (!fence) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (opening) {
        const run = opening[1]!;
        fence = {
          marker: run[0] as "`" | "~",
          length: run.length,
          start: lineStart,
          blockquoteDepth: container.blockquoteDepth,
        };
      } else if (/^(?: {4}|\t)/.test(line)) {
        blocks.push({ start: lineStart, end: lineEnd });
      }
    } else {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      const run = closing?.[1];
      if (
        run &&
        container.blockquoteDepth === fence.blockquoteDepth &&
        run[0] === fence.marker &&
        run.length >= fence.length
      ) {
        blocks.push({ start: fence.start, end: lineEnd });
        fence = undefined;
      }
    }
    lineStart = lineEnd;
  }
  if (fence) blocks.push({ start: fence.start, end: text.length });
  const blockRanges = mergeRanges(blocks);
  const ranges = [...blockRanges];

  const runs = collectBacktickRuns(text, blockRanges);
  const nextSameLength = new Array<number | undefined>(runs.length);
  const nextByLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!;
    nextSameLength[index] = nextByLength.get(run.length);
    nextByLength.set(run.length, index);
  }
  for (let index = 0; index < runs.length;) {
    const closeIndex = nextSameLength[index];
    if (closeIndex === undefined) {
      index++;
      continue;
    }
    const opening = runs[index]!;
    const closing = runs[closeIndex]!;
    ranges.push({ start: opening.start, end: closing.start + closing.length });
    index = closeIndex + 1;
  }

  for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+/gi)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  // Relative Markdown link destinations can look exactly like @skill tags.
  // Protect balanced inline destinations and reference-definition lines.
  for (let index = 0; index < text.length;) {
    if (text[index] !== "]" || text[index + 1] !== "(" || isEscapedAt(text, index)) {
      index++;
      continue;
    }
    let depth = 1;
    let cursor = index + 2;
    while (cursor < text.length && depth > 0 && text[cursor] !== "\n") {
      if (!isEscapedAt(text, cursor)) {
        if (text[cursor] === "(") depth++;
        else if (text[cursor] === ")") depth--;
      }
      cursor++;
    }
    if (depth === 0) ranges.push({ start: index + 2, end: cursor - 1 });
    // Whether closed or malformed, the scan has consumed the rest of this
    // destination/line; do not rescan overlapping suffixes quadratically.
    index = Math.max(index + 2, cursor);
  }
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return mergeRanges(ranges);
}

function codePointBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const previous = text.charCodeAt(index - 1);
  const start = previous >= 0xdc00 && previous <= 0xdfff ? index - 2 : index - 1;
  return text.slice(Math.max(0, start), index);
}

function codePointAt(text: string, index: number): string | undefined {
  if (index >= text.length) return undefined;
  const point = text.codePointAt(index);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

function isWordCodePoint(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}\p{M}\p{Pc}]/u.test(value);
}

function isTagBoundary(text: string, atIndex: number, slashCount = 0): boolean {
  const precedingIndex = atIndex - slashCount;
  const preceding = codePointBefore(text, precedingIndex);
  if (preceding === undefined) return true;
  // Reject email addresses, paths (POSIX and Windows), URLs, identifiers, and
  // chained @ syntax while allowing normal sentence punctuation.
  return !isWordCodePoint(preceding) && !/[@./\\:=?&%#+-]/.test(preceding);
}

function hasInvalidTagSuffix(text: string, end: number): boolean {
  const next = codePointAt(text, end);
  if (isWordCodePoint(next) || next === "@" || next === "/" || next === "\\") return true;
  return next === "." && isWordCodePoint(codePointAt(text, end + 1));
}

function parseInlineSkillTags(text: string, available: InlineSkill[]): ParsedInlineTags {
  const byName = new Map(available.map((skill) => [skill.name, skill]));
  const protectedRanges = protectedTagRanges(text);
  const found: InlineSkill[] = [];
  const seen = new Set<string>();
  const escapesToRemove = new Set<number>();

  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "@" || rangeContains(protectedRanges, index)) continue;

    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) slashCount++;
    if (!isTagBoundary(text, index, slashCount)) continue;

    let end = index + 1;
    while (end < text.length && /[a-z0-9-]/.test(text[end]!)) end++;
    if (end === index + 1) continue;
    if (hasInvalidTagSuffix(text, end)) continue;

    const skill = byName.get(text.slice(index + 1, end));
    // Escaping is syntax only for a real skill. Unknown text remains byte-for-
    // byte unchanged rather than unexpectedly losing a backslash.
    if (slashCount > 1) continue; // Windows root/UNC-like path, not invocation syntax.
    if (slashCount === 1) {
      if (skill) escapesToRemove.add(index - 1);
      continue;
    }

    if (skill && !seen.has(skill.name)) {
      seen.add(skill.name);
      found.push(skill);
    }
    index = end - 1;
  }

  let normalized = text;
  if (escapesToRemove.size > 0) {
    normalized = "";
    // String indexes elsewhere in this parser are UTF-16 offsets. Build by
    // those same offsets so an emoji before an escape cannot shift removal.
    for (let index = 0; index < text.length; index++) {
      if (!escapesToRemove.has(index)) normalized += text[index];
    }
  }
  return { skills: found, text: normalized };
}

function nativeSkillBlock(skill: InlineSkill, content: string): string {
  const body = stripFrontmatter(content).trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

/**
 * Convert inline @skill tags into Pi's native skill-command pipeline.
 *
 * The first unique skill is emitted as /skill:name so Pi remains responsible
 * for its file loading, argument placement, relative paths, and invocation UI.
 * Additional unique skills use the exact same block format because Pi expands
 * only one leading skill command per prompt.
 */
export async function expandInlineSkillTags(
  text: string,
  available: InlineSkill[],
  readSkill: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<{ text: string; failed: InlineSkill[] } | undefined> {
  const parsed = parseInlineSkillTags(text, available);
  if (parsed.skills.length === 0) {
    return parsed.text === text ? undefined : { text: parsed.text, failed: [] };
  }

  const reads = await Promise.allSettled(parsed.skills.map((skill) => readSkill(skill.filePath)));
  const failed = parsed.skills.filter((_skill, index) => reads[index]?.status === "rejected");
  if (failed.length > 0) {
    // Explicit invocation is all-or-nothing: never proceed after silently
    // dropping a requested policy/review skill.
    return { text: parsed.text, failed };
  }

  const [first, ...additional] = parsed.skills;
  const blocks = additional.map((skill, index) => {
    const result = reads[index + 1] as PromiseFulfilledResult<string>;
    return nativeSkillBlock(skill, result.value);
  });
  const argumentsText = [...blocks, parsed.text].filter(Boolean).join("\n\n");
  return { text: `/skill:${first!.name}${argumentsText ? ` ${argumentsText}` : ""}`, failed: [] };
}

function completionQuery(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): { query: string; prefix: string } | undefined {
  const text = lines.join("\n");
  const cursorOffset = lines.slice(0, cursorLine).reduce((length, line) => length + line.length + 1, 0) + cursorCol;
  const beforeCursor = text.slice(0, cursorOffset);
  const match = beforeCursor.match(/@([a-z0-9-]*)$/);
  if (!match) return undefined;
  const atIndex = cursorOffset - match[0].length;
  let slashCount = 0;
  for (let cursor = atIndex - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) slashCount++;
  if (
    slashCount > 0 ||
    !isTagBoundary(text, atIndex) ||
    hasInvalidTagSuffix(text, cursorOffset) ||
    rangeContains(protectedTagRanges(text), atIndex)
  ) {
    return undefined;
  }
  return { query: match[1]!, prefix: match[0] };
}

function skillCompletionItems(skills: InlineSkill[], query: string): AutocompleteItem[] {
  const normalized = query.toLowerCase();
  return skills
    .map((skill) => {
      const name = skill.name.toLowerCase();
      const prefix = name.startsWith(normalized) ? 0 : 1;
      const position = name.indexOf(normalized);
      return { skill, score: prefix * 10_000 + (position < 0 ? 100_000 : position) + name.length / 100 };
    })
    .filter(({ score }) => score < 100_000)
    .sort((a, b) => a.score - b.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, MAX_TAG_SUGGESTIONS)
    .map(({ skill }) => ({
      value: `@${skill.name}`,
      label: `@${skill.name}`,
      description: skill.description ? `Skill · ${skill.description}` : "Skill",
    }));
}

export function createSkillAutocompleteProvider(
  current: AutocompleteProvider,
  getSkills: () => InlineSkill[],
): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (options.signal.aborted) return null;
      const completion = completionQuery(lines, cursorLine, cursorCol);
      if (!completion) return current.getSuggestions(lines, cursorLine, cursorCol, options);

      const allSkills = getSkills();
      if (options.signal.aborted) return null;
      const skillItems = skillCompletionItems(allSkills, completion.query);
      if (skillItems.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);

      const native = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (options.signal.aborted) return null;
      // Collision safety must use the complete catalog, not the displayed top
      // 20, or a hidden matching skill could consume a selected @file.
      const skillValues = new Set(allSkills.map((skill) => `@${skill.name}`));
      const nativeItems = (native?.items ?? []).map((item) => {
        if (!skillValues.has(item.value)) return item;
        return {
          ...item,
          value: `\\${item.value}`,
          description: item.description ? `File · ${item.description}` : "File · literal @ reference",
        };
      });

      const exactValue = `@${completion.query}`;
      const exactSkills = skillItems.filter((item) => item.value === exactValue);
      const nonExactSkills = skillItems.filter((item) => item.value !== exactValue);
      const prefixSkills = nonExactSkills.filter((item) => item.value.slice(1).startsWith(completion.query));
      const fuzzySkills = nonExactSkills.filter((item) => !item.value.slice(1).startsWith(completion.query));
      const exactNative = nativeItems.filter((item) => item.value.replace(/^\\/, "") === exactValue);
      const remainingNative = nativeItems.filter((item) => item.value.replace(/^\\/, "") !== exactValue);
      const interleaved: AutocompleteItem[] = [];
      const length = Math.max(prefixSkills.length, remainingNative.length);
      for (let index = 0; index < length; index++) {
        if (prefixSkills[index]) interleaved.push(prefixSkills[index]!);
        if (remainingNative[index]) interleaved.push(remainingNative[index]!);
      }
      return {
        prefix: completion.prefix,
        items: [...exactSkills, ...exactNative, ...interleaved, ...fuzzySkills],
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export function reconcileSourceSkills(
  registry: Registry,
  source: Pick<InstalledSkill, "sourceId" | "sourceUrl">,
  discovered: DiscoveredSkill[],
  options: { enabled: boolean; now: string },
): InstalledSkill[] {
  const discoveredNames = new Set(discovered.map((skill) => skill.name));
  // Preflight collisions before mutating so a rejected refresh is atomic even
  // for direct callers outside mutateRegistry().
  for (const skill of discovered) {
    const previous = ownValue(registry.skills, skill.name);
    if (previous && previous.sourceId !== source.sourceId) {
      throw new Error(
        `Skill name collision: ${skill.name} is already installed from ${previous.sourceUrl}; refusing to replace it from ${source.sourceUrl}`,
      );
    }
  }

  // A refresh replaces the complete set for this source. Leave records that
  // have since been claimed by another source alone.
  for (const [name, skill] of Object.entries(registry.skills)) {
    if (skill.sourceId === source.sourceId && !discoveredNames.has(name)) {
      delete registry.skills[name];
    }
  }

  for (const skill of discovered) {
    const previous = ownValue(registry.skills, skill.name);
    registry.skills[skill.name] = {
      name: skill.name,
      description: skill.description,
      path: skill.path,
      sourceUrl: source.sourceUrl,
      sourceId: source.sourceId,
      enabled: previous?.enabled ?? options.enabled,
      installedAt: previous?.installedAt ?? options.now,
      updatedAt: options.now,
    };
  }
  return discovered.map((skill) => registry.skills[skill.name]!);
}

async function installFromGitHub(url: string, options: { enabled: boolean }): Promise<InstalledSkill[]> {
  const spec = parseGitHubUrl(url);
  // Keep the logical source lock through immutable publication, discovery, and
  // registry reconciliation so concurrent installers cannot publish stale data.
  return withDirectoryLock(sourceLockPathFor(SOURCES_DIR, spec.sourceId), async () => {
    await removeSourceStaging(spec.sourceId);
    const checkout = await cloneImmutableGenerationUnlocked(spec, SOURCES_DIR);
    let published = false;
    try {
      const discovered = await discoverSkills(checkout.root);
      if (discovered.length === 0) throw new Error(`No SKILL.md files with valid frontmatter found in ${url}`);
      const installed = await mutateRegistry((registry) =>
        reconcileSourceSkills(registry, { sourceId: spec.sourceId, sourceUrl: url }, discovered, {
          enabled: options.enabled,
          now: new Date().toISOString(),
        }),
      );
      published = true;
      const currentRegistry = await withRegistryLock(() => loadRegistry());
      await collectSourceGarbage(spec.sourceId, currentRegistry).catch(() => undefined);
      return installed;
    } finally {
      // Preserve the primary validation/collision error if best-effort cleanup
      // itself fails; stale artifacts are scavenged by later maintenance.
      if (!published) await rm(checkout.checkoutRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

type SkillToggleTarget = {
  id: string;
  key: string;
  name: string;
  origin: "user" | "downloaded";
  enabled: boolean;
};

async function skillToggleTargets(): Promise<SkillToggleTarget[]> {
  const userSkills = discoverUserSkills();
  const now = new Date().toISOString();
  await mutateRegistry((registry) => reconcileUserSkillPreferences(registry, userSkills, now));
  const registry = await loadRegistry();
  return [
    ...Object.values(registry.skills).map((skill) => ({
      id: `downloaded:${skill.name}`,
      key: skill.name,
      name: skill.name,
      origin: "downloaded" as const,
      enabled: skill.enabled,
    })),
    ...userSkills.map((skill) => {
      const key = resolve(skill.filePath);
      return {
        id: `user:${key}`,
        key,
        name: skill.name,
        origin: "user" as const,
        enabled: registry.userSkills[key]?.enabled ?? false,
      };
    }),
  ].sort((a, b) => a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin) || a.key.localeCompare(b.key));
}

function toSkillSettingItems(targets: SkillToggleTarget[]): SettingItem[] {
  return targets.map((skill) => ({
    id: skill.id,
    label: `${skill.name} (${skill.origin})`,
    currentValue: skill.enabled ? "enabled" : "user-only",
    values: ["enabled", "user-only"],
  }));
}

async function setSkillEnabled(target: SkillToggleTarget, enabled: boolean): Promise<boolean> {
  return mutateRegistry((registry) => {
    const now = new Date().toISOString();
    if (target.origin === "downloaded") {
      const skill = ownValue(registry.skills, target.key);
      if (!skill) return false;
      if (skill.enabled !== enabled) {
        skill.enabled = enabled;
        skill.updatedAt = now;
      }
      return true;
    }
    const preference = registry.userSkills[target.key];
    if (!preference) return false;
    if (preference.enabled !== enabled) {
      preference.enabled = enabled;
      preference.updatedAt = now;
    }
    return true;
  });
}

async function openSkillsUi(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    const message = "/skills-ui is available only in interactive TUI mode.";
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else process.stderr.write(`${message}\n`);
    return;
  }
  const targets = await skillToggleTargets();
  if (targets.length === 0) {
    ctx.ui.notify(`No skills found in ${USER_SKILLS_DIR} or installed with --install-skill.`, "info");
    return;
  }
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  let dirty = false;
  let updateQueue = Promise.resolve();

  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(
      new (class {
        render(width: number) {
          return [
            truncateToWidth(theme.fg("accent", theme.bold("Skills")), width),
            truncateToWidth(
              theme.fg(
                "dim",
                "Enabled skills are advertised to the model. User-only skills stay out of the prompt and remain available through /skill:name.",
              ),
              width,
            ),
            "",
          ];
        }
        invalidate() {}
      })(),
    );

    const settingsList = new SettingsList(
      toSkillSettingItems(targets),
      Math.min(targets.length + 2, 18),
      getSettingsListTheme(),
      (id, newValue) => {
        updateQueue = updateQueue
          .then(async () => {
            const enabled = newValue === "enabled";
            const target = targetsById.get(id);
            if (!target || target.enabled === enabled) return;
            const ok = await setSkillEnabled(target, enabled);
            if (!ok) return;
            target.enabled = enabled;
            dirty = true;
            settingsList.updateValue(id, enabled ? "enabled" : "user-only");
            tui.requestRender();
          })
          .catch((error) => {
            ctx.ui.notify(`Failed to update skill setting: ${error instanceof Error ? error.message : String(error)}`, "error");
          });
      },
      () => done(undefined),
      { enableSearch: true },
    );

    container.addChild(settingsList);

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  await updateQueue;
  if (!dirty) return;
  const ok = !ctx.hasUI || (await ctx.ui.confirm("Reload skills", "Skill settings updated. Reload resources now so model visibility reflects changes?"));
  if (!ok) {
    ctx.ui.notify("Saved changes. Run /reload later to apply them.", "info");
    return;
  }
  await ctx.reload();
}

export default function skillLoader(pi: ExtensionAPI) {
  // Keep visibility preferences aligned with the exact registry generation used
  // by this runtime's resource discovery. Another Pi process may publish a new
  // generation, but it must not change model visibility until this one reloads.
  let resourceRegistry: Registry | undefined;
  const generationLeasePath = join(LEASES_DIR, `${process.pid}-${randomUUID()}.json`);

  pi.registerFlag("install-skill", {
    description: "Install Agent Skills from a GitHub repo URL. Example: --install-skill https://github.com/daytona/skills",
    type: "string",
  });

  pi.registerFlag("install-skill-enabled", {
    description: "Install --install-skill skills enabled and visible to the model instead of the user-only default",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("install-skill-disabled", {
    description: "Keep --install-skill skills user-only (legacy compatibility; this is now the default)",
    type: "boolean",
    default: false,
  });

  pi.on("resources_discover", async (_event, ctx) => {
    const registry = await withRegistryLock(async () => {
      const loaded = await loadRegistry();
      const generationRoots = Object.values(loaded.skills).flatMap((skill) => {
        try {
          const root = generationRootForInstalledSkill(skill);
          return root ? [root] : [];
        } catch {
          return [];
        }
      });
      await writeGenerationLease(generationLeasePath, generationRoots);
      return loaded;
    });
    resourceRegistry = registry;
    // A stale/corrupt checkout must not hide every unrelated downloaded skill.
    const skills = Object.values(registry.skills);
    if (skills.length > 0) await assertRealDirectory(SOURCES_DIR, "Skill sources directory");
    const results = await Promise.allSettled(
      skills.map(async (skill) => assertSafeSkillTree(skill.path, checkoutRootForInstalledSkill(skill))),
    );
    const skillPaths = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [result.value];
      ctx.ui.notify(`Skipping unavailable skill ${skills[index]!.name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`, "warning");
      return [];
    });
    return { skillPaths };
  });

  pi.on("input", async (event, ctx) => {
    // Installation is a one-shot CLI action. In print mode shutdown() is a
    // no-op, so consume any supplied prompt rather than starting an LLM turn.
    const installUrl = pi.getFlag("install-skill");
    if (typeof installUrl === "string" && installUrl.trim()) return { action: "handled" };
    // pi.sendUserMessage() deliberately disables command expansion. Turning an
    // extension-owned @tag into /skill:name there would send the slash command
    // literally, so only transform direct interactive/RPC user prompts.
    if (event.source === "extension") return { action: "continue" };
    // A leading native command is already exact and should remain untouched.
    if (event.text.startsWith("/skill:")) return { action: "continue" };
    const expanded = await expandInlineSkillTags(event.text, skillCommands(pi));
    if (!expanded) return { action: "continue" };
    if (expanded.failed.length > 0) {
      ctx.ui.notify(
        `Inline skill invocation cancelled; could not load: ${expanded.failed.map((skill) => skill.name).join(", ")}`,
        "error",
      );
      return { action: "handled" };
    }
    return { action: "transform", text: expanded.text, images: event.images };
  });

  pi.on("session_shutdown", async () => {
    await rm(generationLeasePath, { force: true }).catch(() => undefined);
  });

  pi.on("before_agent_start", async (event) => {
    const allSkills = event.systemPromptOptions.skills ?? [];
    const selectedTools = event.systemPromptOptions.selectedTools;
    if (selectedTools && !selectedTools.includes("read")) return;
    const registry = resourceRegistry ?? await loadRegistry();
    const selectedSkills = selectSkillsForPrompt(allSkills, registry);
    event.systemPromptOptions.skills = selectedSkills;
    return { systemPrompt: rewriteSkillsInPrompt(event.systemPrompt, allSkills, selectedSkills) };
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, () => skillCommands(pi)));

    const url = pi.getFlag("install-skill");
    if (typeof url !== "string" || !url.trim()) return;
    try {
      const enabled = pi.getFlag("install-skill-enabled") === true && pi.getFlag("install-skill-disabled") !== true;
      const installed = await installFromGitHub(url, { enabled });
      const message = `Installed ${installed.length} skill(s): ${installed.map((s) => s.name).join(", ")}${enabled ? " (enabled)" : " (user-only)"}`;
      if (ctx.hasUI) ctx.ui.notify(message, "info");
      else process.stderr.write(`${message}\n`);
    } catch (error) {
      const message = `Skill install failed: ${error instanceof Error ? error.message : String(error)}`;
      process.exitCode = 1;
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      else process.stderr.write(`${message}\n`);
    } finally {
      ctx.shutdown();
    }
  });

  pi.registerCommand(SKILLS_UI_COMMAND_NAME, {
    description: "Open an interactive UI to control model visibility for downloaded and user-directory skills",
    handler: async (_args, ctx) => {
      await openSkillsUi(ctx);
    },
  });
}

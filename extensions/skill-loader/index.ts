import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt, getAgentDir, getSettingsListTheme, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = join(getAgentDir(), "skill-loader");
const SOURCES_DIR = join(ROOT, "sources");
const REGISTRY_PATH = join(ROOT, "registry.json");
const REGISTRY_LOCK_PATH = join(ROOT, "registry.lock");
const USER_SKILLS_DIR = join(getAgentDir(), "skills");
const SKILLS_UI_COMMAND_NAME = "skills-ui";
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

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

function emptyRegistry(): Registry {
  return { version: 1, skills: {}, userSkills: {} };
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

async function loadRegistry(): Promise<Registry> {
  try {
    const parsed = JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
    if (parsed?.version === 1 && parsed.skills && typeof parsed.skills === "object") {
      return {
        version: 1,
        skills: parsed.skills,
        // Registry v1 originally tracked only downloaded skills. Missing local
        // preferences migrate safely: user-directory skills default to user-only.
        userSkills: parsed.userSkills && typeof parsed.userSkills === "object" ? parsed.userSkills : {},
      };
    }
  } catch {
    // First run or corrupt file. Start clean rather than crashing pi startup.
  }
  return emptyRegistry();
}

async function saveRegistry(registry: Registry): Promise<void> {
  await mkdir(dirname(REGISTRY_PATH), { recursive: true });
  const tmp = `${REGISTRY_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(registry, null, 2) + "\n", "utf8");
  await rename(tmp, REGISTRY_PATH);
}

type LockOwner = { token: string; pid: number; createdAt: number };

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
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
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) return false;
    const owner = await readLockOwner(lockPath);
    if (owner && (await processIsAlive(owner.pid))) return false;

    // Rename claims this stale lock before removing it, so contenders cannot
    // accidentally remove a newly acquired lock.
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
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await mkdir(lockPath);
    } catch (error) {
      // Only a collision from mkdir means another process owns the lock. Do
      // not treat an EEXIST thrown by owner setup or the task as contention.
      if (!isAlreadyExists(error)) throw error;
      if (await reclaimStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for skill-loader lock: ${lockPath}`);
      }
      await delay(LOCK_RETRY_DELAY_MS);
      continue;
    }

    try {
      await writeFile(join(lockPath, "owner.json"), JSON.stringify(owner), "utf8");
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
    try {
      return await task();
    } finally {
      await releaseDirectoryLock(lockPath, owner);
    }
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

async function assertSafeSkillTree(root: string, confinementRoot = root): Promise<string> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Skill directory must be a real directory, not a symlink: ${root}`);
  }

  const realConfinementRoot = await realpath(confinementRoot);
  const realRoot = await realpath(root);
  if (!isPathWithin(realConfinementRoot, realRoot)) {
    throw new Error(`Skill directory escapes its source checkout: ${root}`);
  }

  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
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

/** Use Pi's own skill loader so YAML, validation, ignores, and discovery match normal skill loading. */
export async function discoverSkills(root: string): Promise<DiscoveredSkill[]> {
  const safeRoot = await assertSafeSkillTree(root);
  const { skills } = loadSkillsFromDir({ dir: safeRoot, source: "skill-loader" });
  return skills
    .filter((skill) => basename(skill.filePath) === "SKILL.md")
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

export function reconcileSourceSkills(
  registry: Registry,
  source: Pick<InstalledSkill, "sourceId" | "sourceUrl">,
  discovered: DiscoveredSkill[],
  options: { enabled: boolean; now: string },
): InstalledSkill[] {
  const discoveredNames = new Set(discovered.map((skill) => skill.name));
  // A refresh replaces the complete set for this source. Leave records that
  // have since been claimed by another source alone.
  for (const [name, skill] of Object.entries(registry.skills)) {
    if (skill.sourceId === source.sourceId && !discoveredNames.has(name)) {
      delete registry.skills[name];
    }
  }

  for (const skill of discovered) {
    const previous = registry.skills[skill.name];
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
  // Keep the source lock through discovery and reconciliation. Otherwise a
  // second process could replace the checkout while this process is scanning it
  // (or overwrite its newer registry result with stale discovery output).
  return withDirectoryLock(sourceLockPathFor(SOURCES_DIR, spec.sourceId), async () => {
    const root = await cloneOrUpdateUnlocked(spec, SOURCES_DIR);
    const discovered = await discoverSkills(root);
    const installed = await mutateRegistry((registry) =>
      reconcileSourceSkills(registry, { sourceId: spec.sourceId, sourceUrl: url }, discovered, {
        enabled: options.enabled,
        now: new Date().toISOString(),
      }),
    );
    if (installed.length === 0) throw new Error(`No SKILL.md files with valid frontmatter found in ${url}`);
    return installed;
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
      const skill = registry.skills[target.key];
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

  pi.on("resources_discover", async () => {
    const registry = await loadRegistry();
    // Discover every downloaded skill so Pi owns /skill:name expansion. Prompt
    // visibility is filtered separately and defaults to user-only.
    const skillPaths = await Promise.all(
      Object.values(registry.skills)
        .map((skill) => assertSafeSkillTree(skill.path, sourcePathFor(SOURCES_DIR, skill.sourceId))),
    );
    return { skillPaths };
  });

  pi.on("before_agent_start", async (event) => {
    const allSkills = event.systemPromptOptions.skills ?? [];
    const selectedTools = event.systemPromptOptions.selectedTools;
    if (selectedTools && !selectedTools.includes("read")) return;
    const registry = await loadRegistry();
    const selectedSkills = selectSkillsForPrompt(allSkills, registry);
    event.systemPromptOptions.skills = selectedSkills;
    return { systemPrompt: rewriteSkillsInPrompt(event.systemPrompt, allSkills, selectedSkills) };
  });

  pi.on("session_start", async (_event, ctx) => {
    const url = pi.getFlag("install-skill");
    if (typeof url !== "string" || !url.trim()) return;
    try {
      const enabled = pi.getFlag("install-skill-enabled") === true && pi.getFlag("install-skill-disabled") !== true;
      const installed = await installFromGitHub(url, { enabled });
      ctx.ui.notify(
        `Installed ${installed.length} skill(s): ${installed.map((s) => s.name).join(", ")}${enabled ? " (enabled)" : " (user-only)"}`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`Skill install failed: ${error instanceof Error ? error.message : String(error)}`, "error");
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

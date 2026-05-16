import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = join(process.env.HOME ?? process.cwd(), ".pi", "agent", "skill-loader");
const SOURCES_DIR = join(ROOT, "sources");
const REGISTRY_PATH = join(ROOT, "registry.json");
const SKILLS_UI_COMMAND_NAME = "skills-ui";

type Registry = {
  version: 1;
  skills: Record<string, InstalledSkill>;
};

type InstalledSkill = {
  name: string;
  description: string;
  path: string;
  sourceUrl: string;
  sourceId: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
};

type GitHubSpec = {
  cloneUrl: string;
  sourceId: string;
  checkout?: string;
  subdir?: string;
};

function emptyRegistry(): Registry {
  return { version: 1, skills: {} };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadRegistry(): Promise<Registry> {
  try {
    const parsed = JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
    if (parsed?.version === 1 && parsed.skills && typeof parsed.skills === "object") return parsed;
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

function sourceIdFor(url: string): string {
  const clean = url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 10);
  return `${clean.slice(0, 70)}_${hash}`;
}

function parseGitHubUrl(input: string): GitHubSpec {
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

  let checkout: string | undefined;
  let subdir: string | undefined;
  const treeIndex = parts.indexOf("tree");
  if (treeIndex >= 0 && parts.length > treeIndex + 1) {
    checkout = parts[treeIndex + 1];
    subdir = parts.slice(treeIndex + 2).join("/") || undefined;
  }

  return { cloneUrl, checkout, subdir, sourceId: sourceIdFor(trimmed) };
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

async function cloneOrUpdate(spec: GitHubSpec): Promise<string> {
  await mkdir(SOURCES_DIR, { recursive: true });
  const target = join(SOURCES_DIR, spec.sourceId);
  if (await exists(join(target, ".git"))) {
    await git(["fetch", "--all", "--tags", "--prune"], target);
  } else {
    await rm(target, { recursive: true, force: true });
    await git(["clone", "--depth", "1", spec.cloneUrl, target]);
  }

  if (spec.checkout) {
    await git(["fetch", "--depth", "1", "origin", spec.checkout], target).catch(async () => {
      await git(["fetch", "--all", "--tags"], target);
    });
    await git(["checkout", spec.checkout], target);
  } else {
    await git(["pull", "--ff-only"], target).catch(() => "");
  }

  const root = spec.subdir ? resolve(target, spec.subdir) : target;
  const rel = relative(target, root);
  if (rel.startsWith("..") || resolve(root) === resolve(target, ".git")) {
    throw new Error(`Invalid subdirectory in GitHub URL: ${spec.subdir}`);
  }
  return root;
}

async function findSkillMarkdowns(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".venv") continue;
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name === "SKILL.md") out.push(full);
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return out;
}

function parseScalarOrBlock(fm: string, key: string): string | undefined {
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const scalar = line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (!scalar) continue;

    const raw = scalar[1].trim();
    if (raw === "|" || raw === ">") {
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (/^[A-Za-z0-9_-]+:\s*/.test(next)) break;
        block.push(next.replace(/^\s{2,}/, ""));
      }
      return raw === ">" ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
    }

    return raw.replace(/^['"]|['"]$/g, "").trim();
  }
  return undefined;
}

function parseSkillFrontmatter(markdown: string, fallbackName: string): { name: string; description: string } | undefined {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return undefined;
  const fm = match[1];
  const name = (parseScalarOrBlock(fm, "name") ?? fallbackName).trim();
  const description = (parseScalarOrBlock(fm, "description") ?? "").trim();
  if (!description) return undefined;
  return { name, description };
}

async function discoverSkills(root: string): Promise<Array<{ name: string; description: string; path: string }>> {
  const files = await findSkillMarkdowns(root);
  const skills = [] as Array<{ name: string; description: string; path: string }>;
  for (const file of files) {
    const meta = parseSkillFrontmatter(await readFile(file, "utf8"), basename(dirname(file)));
    if (!meta) continue;
    skills.push({ ...meta, path: dirname(file) });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function installFromGitHub(url: string, options: { enabled: boolean }): Promise<InstalledSkill[]> {
  const spec = parseGitHubUrl(url);
  const root = await cloneOrUpdate(spec);
  const discovered = await discoverSkills(root);
  if (discovered.length === 0) throw new Error(`No SKILL.md files with valid frontmatter found in ${url}`);

  const registry = await loadRegistry();
  const now = new Date().toISOString();
  for (const skill of discovered) {
    const previous = registry.skills[skill.name];
    registry.skills[skill.name] = {
      name: skill.name,
      description: skill.description,
      path: skill.path,
      sourceUrl: url,
      sourceId: spec.sourceId,
      enabled: previous?.enabled ?? options.enabled,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
    };
  }
  await saveRegistry(registry);
  return discovered.map((skill) => registry.skills[skill.name]);
}

function getSortedSkills(registry: Registry): InstalledSkill[] {
  return Object.values(registry.skills).sort((a, b) => a.name.localeCompare(b.name));
}

function toSkillSettingItems(registry: Registry): SettingItem[] {
  return getSortedSkills(registry).map((skill) => ({
    id: skill.name,
    label: skill.name,
    currentValue: skill.enabled ? "enabled" : "disabled",
    values: ["enabled", "disabled"],
  }));
}

async function setSkillEnabled(name: string, enabled: boolean): Promise<boolean> {
  const registry = await loadRegistry();
  const skill = registry.skills[name];
  if (!skill) return false;
  if (skill.enabled === enabled) return true;
  skill.enabled = enabled;
  skill.updatedAt = new Date().toISOString();
  await saveRegistry(registry);
  return true;
}

async function openSkillsUi(ctx: ExtensionCommandContext): Promise<void> {
  let registry = await loadRegistry();
  if (getSortedSkills(registry).length === 0) {
    ctx.ui.notify("No skills installed with skill-loader yet. Start pi with --install-skill <github-url> first.", "info");
    return;
  }

  let dirty = false;
  let updateQueue = Promise.resolve();

  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(
      new (class {
        render(width: number) {
          return [
            truncateToWidth(theme.fg("accent", theme.bold("Skill Loader")), width),
            truncateToWidth(
              theme.fg(
                "dim",
                "Toggle installed skills. Enabled skills appear in the system prompt after reload; disabled skills stay hidden but can still be invoked with /skill:name.",
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
      toSkillSettingItems(registry),
      Math.min(getSortedSkills(registry).length + 2, 18),
      getSettingsListTheme(),
      (id, newValue) => {
        updateQueue = updateQueue
          .then(async () => {
            const enabled = newValue === "enabled";
            const skill = registry.skills[id];
            if (!skill || skill.enabled === enabled) return;
            const ok = await setSkillEnabled(id, enabled);
            if (!ok) return;
            registry = await loadRegistry();
            dirty = true;
            settingsList.updateValue(id, enabled ? "enabled" : "disabled");
            tui.requestRender();
          })
          .catch((error) => {
            ctx.ui.notify(`Failed to update skill setting: ${error instanceof Error ? error.message : String(error)}`, "error");
          });
      },
      () => done(undefined),
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
  const ok = !ctx.hasUI || (await ctx.ui.confirm("Reload skills", "Skill settings updated. Reload resources now so the system prompt reflects changes?"));
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

  pi.registerFlag("install-skill-disabled", {
    description: "Install --install-skill skills but leave them disabled/hidden from the system prompt",
    type: "boolean",
    default: false,
  });

  pi.on("resources_discover", async () => {
    const registry = await loadRegistry();
    return {
      skillPaths: Object.values(registry.skills)
        .filter((skill) => skill.enabled)
        .map((skill) => skill.path),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const url = pi.getFlag("install-skill");
    if (typeof url !== "string" || !url.trim()) return;
    try {
      const enabled = pi.getFlag("install-skill-disabled") !== true;
      const installed = await installFromGitHub(url, { enabled });
      ctx.ui.notify(
        `Installed ${installed.length} skill(s): ${installed.map((s) => s.name).join(", ")}${enabled ? "" : " (disabled)"}`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`Skill install failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      ctx.shutdown();
    }
  });

  pi.on("input", async (event) => {
    const match = event.text.match(/^\/skill:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\s+([\s\S]*))?$/);
    if (!match) return { action: "continue" };

    const [, name, args = ""] = match;
    const registry = await loadRegistry();
    const skill = registry.skills[name];
    if (!skill || skill.enabled) return { action: "continue" };

    const markdown = await readFile(join(skill.path, "SKILL.md"), "utf8");
    const userArgs = args.trim() ? `\n\nUser: ${args.trim()}` : "";
    return {
      action: "transform",
      text:
        `Load and use this disabled/on-demand skill. Resolve all relative paths against: ${skill.path}\n\n` +
        markdown +
        userArgs,
      images: event.images,
    };
  });

  pi.registerCommand(SKILLS_UI_COMMAND_NAME, {
    description: "Open an interactive UI to enable/disable installed skills",
    handler: async (_args, ctx) => {
      await openSkillsUi(ctx);
    },
  });
}

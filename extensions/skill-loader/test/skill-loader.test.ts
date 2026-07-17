import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  cloneOrUpdate,
  discoverSkills,
  reconcileSourceSkills,
  reconcileUserSkillPreferences,
  rewriteSkillsInPrompt,
  selectSkillsForPrompt,
  splitTreePath,
  withDirectoryLock,
  type Registry,
} from "../index";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("discovers skills with Pi's YAML parser and reconciles removed source skills", async () => {
  const root = await tempDir("pi-skill-loader-yaml-");
  try {
    await mkdir(join(root, "yaml-skill"));
    await writeFile(
      join(root, "yaml-skill", "SKILL.md"),
      "---\nname: yaml-skill\ndescription: >\n  Loads YAML frontmatter\n  exactly as Pi does.\nmetadata:\n  owner: test\n---\n# YAML skill\n",
    );
    await mkdir(join(root, "missing-description"));
    await writeFile(join(root, "missing-description", "SKILL.md"), "---\nname: missing-description\n---\n");

    const discovered = await discoverSkills(root);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.name, "yaml-skill");
    assert.match(discovered[0]?.description ?? "", /Loads YAML frontmatter exactly as Pi does\./);

    const registry: Registry = {
      version: 1,
      userSkills: {},
      skills: {
        stale: {
          name: "stale",
          description: "old",
          path: "/old",
          sourceUrl: "https://github.com/acme/skills",
          sourceId: "acme",
          enabled: true,
          installedAt: "earlier",
          updatedAt: "earlier",
        },
        retained: {
          name: "retained",
          description: "other source",
          path: "/other",
          sourceUrl: "https://github.com/other/skills",
          sourceId: "other",
          enabled: true,
          installedAt: "earlier",
          updatedAt: "earlier",
        },
      },
    };
    const installed = reconcileSourceSkills(
      registry,
      { sourceId: "acme", sourceUrl: "https://github.com/acme/skills" },
      discovered,
      { enabled: false, now: "now" },
    );

    assert.equal(registry.skills.stale, undefined);
    assert.equal(registry.skills.retained?.sourceId, "other");
    assert.equal(installed[0]?.name, "yaml-skill");
    assert.equal(installed[0]?.enabled, false);

    // An empty refresh must remove the last skill from the source too.
    reconcileSourceSkills(
      registry,
      { sourceId: "acme", sourceUrl: "https://github.com/acme/skills" },
      [],
      { enabled: false, now: "later" },
    );
    assert.equal(registry.skills["yaml-skill"], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user-directory skills default to user-only and prompt filtering preserves explicit choices", () => {
  const userRoot = "/agent/skills";
  const skill = (name: string, filePath: string, baseDir: string, disableModelInvocation = false): Skill => ({
    name,
    description: `${name} description`,
    filePath,
    baseDir,
    disableModelInvocation,
    sourceInfo: {} as Skill["sourceInfo"],
  });
  const local = skill("local-skill", `${userRoot}/local-skill/SKILL.md`, `${userRoot}/local-skill`, true);
  const downloaded = skill("downloaded-skill", "/agent/skill-loader/sources/repo/downloaded/SKILL.md", "/agent/skill-loader/sources/repo/downloaded");
  const project = skill("project-skill", "/project/.pi/skills/project-skill/SKILL.md", "/project/.pi/skills/project-skill");
  const registry: Registry = {
    version: 1,
    userSkills: {},
    skills: {
      "downloaded-skill": {
        name: "downloaded-skill",
        description: "downloaded",
        path: downloaded.baseDir,
        sourceUrl: "https://github.com/acme/skills",
        sourceId: "acme",
        enabled: false,
        installedAt: "earlier",
        updatedAt: "earlier",
      },
    },
  };

  assert.deepEqual(selectSkillsForPrompt([local], registry, userRoot), [], "an unseen local skill is user-only immediately");
  const localOnlyPrompt = `Header${formatSkillsForPrompt([{ ...local, disableModelInvocation: false }])}\nCurrent working directory: /project`;
  assert.doesNotMatch(rewriteSkillsInPrompt(localOnlyPrompt, [{ ...local, disableModelInvocation: false }], []), /available_skills|local-skill/);

  reconcileUserSkillPreferences(registry, [local], "now");
  assert.equal(registry.userSkills[local.filePath]?.enabled, false);
  const initiallySelected = selectSkillsForPrompt([local, downloaded, project], registry, userRoot);
  assert.deepEqual(initiallySelected.map((item) => item.name), ["project-skill"]);

  const initialPrompt = `Header${formatSkillsForPrompt([local, downloaded, project])}\nCurrent working directory: /project`;
  const filteredPrompt = rewriteSkillsInPrompt(initialPrompt, [local, downloaded, project], initiallySelected);
  assert.doesNotMatch(filteredPrompt, /local-skill|downloaded-skill/);
  assert.match(filteredPrompt, /project-skill/);

  registry.userSkills[local.filePath]!.enabled = true;
  registry.skills["downloaded-skill"]!.enabled = true;
  const enabled = selectSkillsForPrompt([local, downloaded, project], registry, userRoot);
  assert.deepEqual(enabled.map((item) => item.name), ["local-skill", "downloaded-skill", "project-skill"]);
  assert.equal(enabled[0]?.disableModelInvocation, false, "an explicit UI enable overrides user-only frontmatter");
  const enabledPrompt = rewriteSkillsInPrompt(initialPrompt, [local, downloaded, project], enabled);
  assert.match(enabledPrompt, /local-skill/);
  assert.match(enabledPrompt, /downloaded-skill/);

  reconcileUserSkillPreferences(registry, [], "later");
  assert.equal(registry.userSkills[local.filePath], undefined);
});

test("serializes concurrent registry mutations with a directory lock", async () => {
  const root = await tempDir("pi-skill-loader-lock-");
  try {
    const lockPath = join(root, "registry.lock");
    let running = 0;
    let maximumRunning = 0;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        withDirectoryLock(lockPath, async () => {
          running++;
          maximumRunning = Math.max(maximumRunning, running);
          await new Promise((resolve) => setTimeout(resolve, 15));
          running--;
        }),
      ),
    );

    assert.equal(maximumRunning, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not retry EEXIST thrown by a lock task", async () => {
  const root = await tempDir("pi-skill-loader-lock-task-");
  try {
    let calls = 0;
    await assert.rejects(
      withDirectoryLock(join(root, "registry.lock"), async () => {
        calls++;
        const error = new Error("task failure") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }),
      (error: NodeJS.ErrnoException) => error.code === "EEXIST",
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinks before passing a source to Pi skill discovery", async () => {
  const root = await tempDir("pi-skill-loader-symlink-");
  const outside = await tempDir("pi-skill-loader-outside-");
  try {
    await writeFile(join(outside, "SKILL.md"), "---\nname: escaped\ndescription: escaped\n---\n");
    await symlink(outside, join(root, "linked-skill"));

    await assert.rejects(discoverSkills(root), /Symlinks are not allowed/);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("refresh checks out the fetched slash-containing branch and its skill subdirectory", async () => {
  const root = await tempDir("pi-skill-loader-git-");
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const sources = join(root, "sources");
  try {
    await git(root, "init", "--bare", remote);
    await git(root, "init", work);
    await git(work, "config", "user.email", "test@example.com");
    await git(work, "config", "user.name", "Test");
    await mkdir(join(work, "skills"));
    await writeFile(join(work, "skills", "SKILL.md"), "---\nname: refresh-skill\ndescription: main\n---\n");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "main");
    await git(work, "branch", "-M", "main");
    await git(work, "remote", "add", "origin", remote);
    await git(work, "push", "-u", "origin", "main");
    await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");

    await git(work, "checkout", "-b", "feature/with-slash");
    await writeFile(join(work, "skills", "SKILL.md"), "---\nname: refresh-skill\ndescription: first branch revision\n---\n");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "branch revision one");
    await git(work, "push", "-u", "origin", "feature/with-slash");

    assert.deepEqual(
      splitTreePath(["feature", "with-slash", "skills"], ["refs/heads/feature/with-slash"]),
      { checkout: "feature/with-slash", subdir: "skills" },
    );

    const spec = {
      cloneUrl: pathToFileURL(remote).href,
      sourceId: "local-source",
      treePath: ["feature", "with-slash", "skills"],
    };
    const firstRoot = await cloneOrUpdate(spec, sources);
    assert.match(await readFile(join(firstRoot, "SKILL.md"), "utf8"), /first branch revision/);

    await writeFile(join(work, "skills", "SKILL.md"), "---\nname: refresh-skill\ndescription: second branch revision\n---\n");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "branch revision two");
    await git(work, "push");

    const refreshedRoot = await cloneOrUpdate(spec, sources);
    assert.equal(refreshedRoot, firstRoot);
    assert.match(await readFile(join(refreshedRoot, "SKILL.md"), "utf8"), /second branch revision/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

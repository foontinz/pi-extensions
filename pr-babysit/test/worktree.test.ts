import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PrView } from "../src/gh.ts";
import { appPaths, ensureAppDirs, prPaths, repoRootPath } from "../src/paths.ts";
import { createPrState } from "../src/state.ts";
import {
  buildPrePushHook,
  installPushGuard,
  provisionWorktree,
  removeManagedWorktree,
  runCommand,
  syncWorktreeBeforeRun,
  type CommandRunner,
} from "../src/worktree.ts";

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", ["-C", repo, ...args])).stdout.trim();
}

async function runHook(path: string, cwd: string, line: string, remoteUrl = "authorized-remote"): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(path, ["origin", remoteUrl], { cwd, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(`${line}\n`);
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stderr };
}

async function repository(): Promise<{ path: string; first: string; second: string }> {
  const path = await mkdtemp(join(tmpdir(), "pr-babysit-hook-"));
  await runCommand("git", ["init", path]);
  await git(path, "config", "user.email", "test@example.com");
  await git(path, "config", "user.name", "Test");
  await writeFile(join(path, "file.txt"), "one\n");
  await git(path, "add", "file.txt");
  await git(path, "commit", "-m", "first");
  const first = await git(path, "rev-parse", "HEAD");
  await writeFile(join(path, "file.txt"), "two\n");
  await git(path, "commit", "-am", "second");
  return { path, first, second: await git(path, "rev-parse", "HEAD") };
}

test("pre-push hook permits only fast-forward updates to the PR head", async () => {
  const repo = await repository();
  const hook = join(repo.path, "pre-push");
  await writeFile(hook, buildPrePushHook("feature/fix", "authorized-remote"), { mode: 0o500 });
  await chmod(hook, 0o500);
  const zero = "0".repeat(40);

  assert.equal((await runHook(hook, repo.path, `HEAD ${repo.second} refs/heads/feature/fix ${zero}`)).code, 0);
  assert.equal((await runHook(hook, repo.path, `HEAD ${repo.second} refs/heads/feature/fix ${repo.first}`)).code, 0);
  const wrong = await runHook(hook, repo.path, `HEAD ${repo.second} refs/heads/main ${repo.first}`);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /only refs\/heads\/feature\/fix/);
  const wrongRemote = await runHook(hook, repo.path, `HEAD ${repo.second} refs/heads/feature/fix ${repo.first}`, "attacker-remote");
  assert.notEqual(wrongRemote.code, 0);
  assert.match(wrongRemote.stderr, /not the authorized PR remote/);
  const force = await runHook(hook, repo.path, `HEAD ${repo.first} refs/heads/feature/fix ${repo.second}`);
  assert.notEqual(force.code, 0);
  assert.match(force.stderr, /force push rejected/);
});

test("real git push invokes the guard for other branches and force updates", async () => {
  const repo = await repository();
  const remote = await mkdtemp(join(tmpdir(), "pr-babysit-remote-"));
  await runCommand("git", ["init", "--bare", remote]);
  await git(repo.path, "remote", "add", "origin", remote);
  const prDirectory = await mkdtemp(join(tmpdir(), "pr-babysit-real-push-"));
  await installPushGuard(repo.path, repo.path, prDirectory, "feature/fix", remote);
  await git(repo.path, "push", "origin", "HEAD:refs/heads/feature/fix");
  await assert.rejects(git(repo.path, "push", "origin", "HEAD:refs/heads/main"), /only refs\/heads\/feature\/fix/);
  const attacker = await mkdtemp(join(tmpdir(), "pr-babysit-attacker-remote-"));
  await runCommand("git", ["init", "--bare", attacker]);
  await git(repo.path, "remote", "add", "attacker", attacker);
  await assert.rejects(git(repo.path, "push", "attacker", "HEAD:refs/heads/feature/fix"), /authorized PR remote/);

  await git(repo.path, "reset", "--hard", repo.first);
  await writeFile(join(repo.path, "file.txt"), "diverged\n");
  await git(repo.path, "commit", "-am", "diverged");
  await assert.rejects(
    git(repo.path, "push", "--force", "origin", "HEAD:refs/heads/feature/fix"),
    /force push rejected/,
  );
});

test("push guard is configured per worktree outside PR-authored files", async () => {
  const repo = await repository();
  const prDirectory = await mkdtemp(join(tmpdir(), "pr-babysit-guard-"));
  const hook = await installPushGuard(repo.path, repo.path, prDirectory, "feature/fix", "authorized-remote");
  assert.equal(await git(repo.path, "config", "--worktree", "core.hooksPath"), join(prDirectory, "hooks"));
  assert.match(await readFile(hook, "utf8"), /non-fast-forward/);
  assert.equal(hook.startsWith(repo.path), false);
});

const pr: PrView = {
  host: "github.com",
  owner: "owner",
  repo: "repo",
  number: 7,
  key: "owner/repo#7",
  url: "https://github.com/owner/repo/pull/7",
  title: "PR",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "main",
  headRefName: "feature/fix",
  headRefOid: "abc",
  headRepository: "owner/repo",
  reviewDecision: "",
  statusCheckRollup: [],
};

test("sync automatically merges the base branch into the head branch and pushes it", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-base-merge-"));
  const app = appPaths(home);
  await ensureAppDirs(app);

  // Bare origin plus a seed clone so we can populate main and a diverged feature.
  const origin = await mkdtemp(join(tmpdir(), "pr-babysit-origin-"));
  await runCommand("git", ["init", "--bare", "-b", "main", origin]);
  const seed = await mkdtemp(join(tmpdir(), "pr-babysit-seed-"));
  await runCommand("git", ["clone", origin, seed]);
  await git(seed, "config", "user.email", "seed@example.com");
  await git(seed, "config", "user.name", "Seed");
  await writeFile(join(seed, "base.txt"), "base\n");
  await git(seed, "add", "base.txt");
  await git(seed, "commit", "-m", "base");
  await git(seed, "push", "origin", "main");
  await git(seed, "checkout", "-b", "feature");
  await writeFile(join(seed, "feature.txt"), "feature\n");
  await git(seed, "add", "feature.txt");
  await git(seed, "commit", "-m", "feature work");
  await git(seed, "push", "origin", "feature");
  await git(seed, "checkout", "main");
  await writeFile(join(seed, "main-only.txt"), "main advance\n");
  await git(seed, "add", "main-only.txt");
  await git(seed, "commit", "-m", "advance main");
  await git(seed, "push", "origin", "main");

  const repoRoot = repoRootPath("owner", "repo", app);
  await runCommand("git", ["clone", origin, repoRoot]);
  const worktreePath = prPaths("owner/repo#7", app).worktreePath;
  await git(repoRoot, "worktree", "add", "--track", "-b", "feature", worktreePath, "origin/feature");

  const state = createPrState({ key: "owner/repo#7", repoRoot, worktreePath, baseRefName: "main" });
  const sync = await syncWorktreeBeforeRun(state, app);

  assert.equal(sync.dirty, false);
  assert.equal(sync.base?.branch, "main");
  assert.equal(sync.base?.action, "merged");
  assert.equal(sync.base?.pushed, true);
  // The advance from main is now present locally and pushed to origin/feature.
  assert.ok((await readFile(join(worktreePath, "main-only.txt"), "utf8")).includes("main advance"));
  await git(worktreePath, "fetch", "origin");
  await git(worktreePath, "merge-base", "--is-ancestor", "origin/main", "origin/feature");

  // A second sync is a no-op: base is already contained in the head branch.
  const again = await syncWorktreeBeforeRun(state, app);
  assert.equal(again.base?.action, "up_to_date");
});

test("managed removal refuses dirty worktrees unless explicitly forced", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-dirty-remove-"));
  const app = appPaths(home);
  await ensureAppDirs(app);
  const repoRoot = repoRootPath("owner", "repo", app);
  await runCommand("git", ["init", repoRoot]);
  await git(repoRoot, "config", "user.email", "test@example.com");
  await git(repoRoot, "config", "user.name", "Test");
  await writeFile(join(repoRoot, "file.txt"), "clean\n");
  await git(repoRoot, "add", "file.txt");
  await git(repoRoot, "commit", "-m", "initial");
  const worktreePath = prPaths("owner/repo#1", app).worktreePath;
  await git(repoRoot, "worktree", "add", "-b", "feature/dirty", worktreePath);
  const state = createPrState({ key: "owner/repo#1", repoRoot, worktreePath });
  await writeFile(join(worktreePath, "file.txt"), "dirty\n");
  await assert.rejects(removeManagedWorktree(state, false, app), /uncommitted changes/);
  await removeManagedWorktree(state, true, app);
});

test("provision is idempotent and explicit removal honors managed paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-provision-"));
  const app = appPaths(home);
  await ensureAppDirs(app);
  const calls: Array<{ executable: string; args: readonly string[]; cwd?: string }> = [];
  let pushUrl = "https://github.com/owner/repo.git";
  const fake: CommandRunner = async (executable, args, options = {}) => {
    calls.push({ executable, args: [...args], ...(options.cwd ? { cwd: options.cwd } : {}) });
    if (executable === "gh" && args[0] === "repo") await mkdir(String(args[3]), { recursive: true });
    if (executable === "git" && args.includes("add") && args.includes("--detach")) {
      await mkdir(String(args[args.indexOf("--detach") + 1]), { recursive: true });
    }
    if (executable === "git" && args.includes("rev-parse") && args.includes("@{upstream}")) {
      return { stdout: "refs/remotes/origin/feature/fix\n", stderr: "" };
    }
    if (executable === "git" && args.at(-1) === "remote") return { stdout: "origin\n", stderr: "" };
    if (executable === "git" && args.includes("get-url")) return { stdout: `${pushUrl}\n`, stderr: "" };
    if (executable === "git" && args.includes("status")) return { stdout: "", stderr: "" };
    if (executable === "git" && args.includes("remove")) await rm(String(args.at(-1)), { recursive: true, force: true });
    return { stdout: "", stderr: "" };
  };

  const first = await provisionWorktree(pr, app, fake);
  const second = await provisionWorktree(pr, app, fake);
  assert.deepEqual(second, first);
  assert.equal(calls.filter((call) => call.executable === "gh" && call.args[0] === "pr").length, 1);
  assert.ok(calls.some((call) => call.executable === "gh" && call.args[0] === "repo" && call.args[2] === "github.com/owner/repo"));
  assert.ok(calls.some((call) => call.executable === "gh" && call.args[0] === "pr" && call.args.includes("github.com/owner/repo")));
  assert.equal(first.repoRoot, repoRootPath("owner", "repo", app));
  assert.equal(first.worktreePath, prPaths(pr.key, app).worktreePath);
  pushUrl = "https://github.com/attacker/elsewhere.git";
  await assert.rejects(provisionWorktree(pr, app, fake), /expected github\.com\/owner\/repo/);

  pushUrl = "ssh://git@ghe.example.test/owner/repo.git";
  const enterprisePr: PrView = {
    ...pr,
    host: "ghe.example.test",
    key: "ghe.example.test/owner/repo#7",
    url: "https://ghe.example.test/owner/repo/pull/7",
  };
  const enterprise = await provisionWorktree(enterprisePr, app, fake);
  assert.notEqual(enterprise.repoRoot, first.repoRoot);
  assert.equal(enterprise.repoRoot, repoRootPath("owner", "repo", app, "ghe.example.test"));
  assert.ok(calls.some((call) => call.executable === "gh" && call.args[0] === "repo" && call.args[2] === "ghe.example.test/owner/repo"));
  assert.ok(calls.some((call) => call.executable === "gh" && call.args[0] === "pr" && call.args.includes("ghe.example.test/owner/repo")));

  const state = createPrState({ key: pr.key, repoRoot: first.repoRoot, worktreePath: first.worktreePath });
  await removeManagedWorktree(state, false, app, fake);
  await assert.rejects(
    removeManagedWorktree({ ...state, worktreePath: join(home, "outside") }, true, app, fake),
    /unmanaged/,
  );
});

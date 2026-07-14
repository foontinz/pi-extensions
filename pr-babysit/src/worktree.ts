import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PrView } from "./gh.ts";
import {
  type AppPaths,
  appPaths,
  ensureAppDirs,
  normalizeGithubHost,
  parsePrKey,
  prPaths,
  repoRootPath,
} from "./paths.ts";
import type { PrState } from "./state.ts";

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (executable, args, options = {}) =>
  new Promise<CommandResult>((resolveCommand, reject) => {
    const execOptions: { encoding: "utf8"; maxBuffer: number; cwd?: string; env?: NodeJS.ProcessEnv } = {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    };
    if (options.cwd !== undefined) execOptions.cwd = options.cwd;
    if (options.env !== undefined) execOptions.env = options.env;
    execFile(executable, [...args], execOptions, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message;
        reject(new Error(`${executable} ${args[0] ?? ""} failed: ${detail}`));
      } else {
        resolveCommand({ stdout, stderr });
      }
    });
  });

async function realDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing unsafe directory: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function withDirectoryLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      try {
        return await task();
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(path)).mtimeMs > 10 * 60_000) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`Timed out waiting for worktree lock: ${path}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildPrePushHook(headRefName: string, pushUrl: string): string {
  if (headRefName.trim() === "" || /[\r\n\0]/.test(headRefName)) throw new Error("Invalid PR head branch");
  if (pushUrl.trim() === "" || /[\r\n\0]/.test(pushUrl)) throw new Error("Invalid PR push destination");
  const expected = shellQuote(`refs/heads/${headRefName}`);
  const expectedUrl = shellQuote(pushUrl);
  return `#!/bin/sh
set -eu
expected_ref=${expected}
expected_url=${expectedUrl}
actual_url=\${2-}
if [ "$actual_url" != "$expected_url" ]; then
  echo "pr-babysit: push rejected; destination $actual_url is not the authorized PR remote" >&2
  exit 1
fi
zero=0000000000000000000000000000000000000000
seen=0
while read -r local_ref local_sha remote_ref remote_sha; do
  seen=1
  if [ "$remote_ref" != "$expected_ref" ]; then
    echo "pr-babysit: push rejected; only $expected_ref is allowed" >&2
    exit 1
  fi
  if [ "$local_sha" = "$zero" ]; then
    echo "pr-babysit: deleting the PR head branch is forbidden" >&2
    exit 1
  fi
  if [ "$remote_sha" != "$zero" ] && ! git merge-base --is-ancestor "$remote_sha" "$local_sha"; then
    echo "pr-babysit: non-fast-forward/force push rejected" >&2
    exit 1
  fi
done
exit 0
`;
}

function githubRemoteTarget(pushUrl: string): { host: string; repository: string } | null {
  const scp = /^git@([^:]+):([^/]+\/[^/]+?)(?:\.git)?$/.exec(pushUrl);
  if (scp?.[1] && scp[2]) {
    try {
      return { host: normalizeGithubHost(scp[1]), repository: scp[2].toLowerCase() };
    } catch {
      return null;
    }
  }
  let url: URL;
  try {
    url = new URL(pushUrl);
  } catch {
    return null;
  }
  if (!(url.protocol === "https:" || url.protocol === "ssh:")) return null;
  if (url.search || url.hash || url.password) return null;
  if (url.protocol === "https:" && url.username) return null;
  if (url.protocol === "ssh:" && url.username !== "" && url.username !== "git") return null;
  const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  try {
    return { host: normalizeGithubHost(url.host), repository: `${parts[0]}/${parts[1]}`.toLowerCase() };
  } catch {
    return null;
  }
}

export async function resolvePushDestination(
  worktreePath: string,
  expectedHost: string,
  expectedRepository: string,
  runner: CommandRunner = runCommand,
): Promise<string> {
  const upstream = (await runner("git", ["-C", worktreePath, "rev-parse", "--symbolic-full-name", "@{upstream}"])).stdout.trim();
  const remotes = (await runner("git", ["-C", worktreePath, "remote"])).stdout.split("\n").map((entry) => entry.trim()).filter(Boolean);
  const remote = remotes
    .filter((entry) => upstream.startsWith(`refs/remotes/${entry}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (!remote) throw new Error(`Unable to resolve the PR push remote from upstream ${JSON.stringify(upstream)}`);
  const pushUrl = (await runner("git", ["-C", worktreePath, "remote", "get-url", "--push", remote])).stdout.trim();
  if (pushUrl === "" || /[\r\n\0]/.test(pushUrl)) throw new Error("Resolved PR push destination is invalid");
  const actual = githubRemoteTarget(pushUrl);
  if (actual?.host !== normalizeGithubHost(expectedHost) || actual.repository !== expectedRepository.toLowerCase()) {
    throw new Error(`Refusing PR push remote ${JSON.stringify(pushUrl)}; expected ${expectedHost}/${expectedRepository}`);
  }
  return pushUrl;
}

export async function installPushGuard(
  worktreePath: string,
  repoRoot: string,
  prDirectory: string,
  headRefName: string,
  pushUrl: string,
  runner: CommandRunner = runCommand,
): Promise<string> {
  const hooksDirectory = join(prDirectory, "hooks");
  await mkdir(hooksDirectory, { recursive: true, mode: 0o700 });
  const hookPath = join(hooksDirectory, "pre-push");
  const temporaryHook = join(hooksDirectory, `.pre-push-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryHook, buildPrePushHook(headRefName, pushUrl), { flag: "wx", mode: 0o500 });
    await rename(temporaryHook, hookPath);
    await chmod(hookPath, 0o500);
  } finally {
    await rm(temporaryHook, { force: true }).catch(() => undefined);
  }
  await runner("git", ["-C", repoRoot, "config", "extensions.worktreeConfig", "true"]);
  await runner("git", ["-C", worktreePath, "config", "--worktree", "core.hooksPath", hooksDirectory]);
  return hookPath;
}

export interface ProvisionedWorktree {
  repoRoot: string;
  worktreePath: string;
}

export async function provisionWorktree(
  pr: PrView,
  app: AppPaths = appPaths(),
  runner: CommandRunner = runCommand,
): Promise<ProvisionedWorktree> {
  await ensureAppDirs(app);
  const paths = prPaths(pr.key, app);
  const repoRoot = repoRootPath(pr.owner, pr.repo, app, pr.host);
  const lockPath = `${repoRoot}.lock`;

  return withDirectoryLock(lockPath, async () => {
    if (!(await realDirectory(repoRoot))) {
      const repository = `${pr.host}/${pr.owner}/${pr.repo}`;
      await runner("gh", ["repo", "clone", repository, repoRoot, "--", "--filter=blob:none", "--no-checkout"]);
    }
    await runner("git", ["-C", repoRoot, "rev-parse", "--git-dir"]);

    const existed = await realDirectory(paths.worktreePath);
    if (!existed) {
      await runner("git", ["-C", repoRoot, "fetch", "--prune", "origin"]);
      await runner("git", ["-C", repoRoot, "worktree", "add", "--detach", paths.worktreePath, "HEAD"]);
      try {
        const repository = `${pr.host}/${pr.owner}/${pr.repo}`;
        await runner("gh", ["pr", "checkout", String(pr.number), "--repo", repository, "--force"], {
          cwd: paths.worktreePath,
        });
      } catch (error) {
        await runner("git", ["-C", repoRoot, "worktree", "remove", "--force", paths.worktreePath]).catch(() => undefined);
        throw error;
      }
    } else {
      await runner("git", ["-C", paths.worktreePath, "rev-parse", "--is-inside-work-tree"]);
    }

    const pushUrl = await resolvePushDestination(paths.worktreePath, pr.host, pr.headRepository, runner);
    await installPushGuard(paths.worktreePath, repoRoot, paths.prDir, pr.headRefName, pushUrl, runner);
    return { repoRoot, worktreePath: paths.worktreePath };
  });
}

function validateManagedPaths(state: Pick<PrState, "key" | "repoRoot" | "worktreePath">, app: AppPaths): {
  repoRoot: string;
  worktreePath: string;
} {
  const parsed = parsePrKey(state.key);
  const expectedWorktree = prPaths(parsed.key, app).worktreePath;
  const expectedRepo = repoRootPath(parsed.owner, parsed.repo, app, parsed.host);
  if (state.worktreePath !== expectedWorktree || state.repoRoot !== expectedRepo) {
    throw new Error(`Refusing unmanaged worktree paths recorded for ${state.key}`);
  }
  return { repoRoot: expectedRepo, worktreePath: expectedWorktree };
}

export async function worktreeDirty(
  state: Pick<PrState, "key" | "repoRoot" | "worktreePath">,
  app: AppPaths = appPaths(),
  runner: CommandRunner = runCommand,
): Promise<boolean> {
  const { worktreePath } = validateManagedPaths(state, app);
  const status = await runner("git", ["-C", worktreePath, "status", "--porcelain", "--untracked-files=normal"]);
  return status.stdout.trim() !== "";
}

export async function removeManagedWorktree(
  state: Pick<PrState, "key" | "repoRoot" | "worktreePath">,
  force: boolean,
  app: AppPaths = appPaths(),
  runner: CommandRunner = runCommand,
): Promise<void> {
  const { repoRoot, worktreePath } = validateManagedPaths(state, app);
  if (!(await realDirectory(worktreePath))) return;
  if (!force && (await worktreeDirty(state, app, runner))) {
    throw new Error(`Worktree for ${state.key} has uncommitted changes; retry unwatch with --force to remove it`);
  }
  await runner("git", ["-C", repoRoot, "worktree", "remove", ...(force ? ["--force"] : []), worktreePath]);
  await runner("git", ["-C", repoRoot, "worktree", "prune"]);
}

export interface SyncResult {
  dirty: boolean;
  reset: boolean;
  detail: string;
}

export async function syncWorktreeBeforeRun(
  state: Pick<PrState, "key" | "repoRoot" | "worktreePath">,
  app: AppPaths = appPaths(),
  runner: CommandRunner = runCommand,
): Promise<SyncResult> {
  const { worktreePath } = validateManagedPaths(state, app);
  if (await worktreeDirty(state, app, runner)) return { dirty: true, reset: false, detail: "worktree has local changes" };
  await runner("git", ["-C", worktreePath, "fetch", "--all", "--prune"]);
  let counts: CommandResult;
  try {
    counts = await runner("git", ["-C", worktreePath, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  } catch {
    return { dirty: false, reset: false, detail: "clean worktree has no upstream" };
  }
  const [aheadText, behindText] = counts.stdout.trim().split(/\s+/);
  const ahead = Number(aheadText);
  const behind = Number(behindText);
  if (ahead === 0 && behind > 0) {
    await runner("git", ["-C", worktreePath, "reset", "--hard", "@{upstream}"]);
    return { dirty: false, reset: true, detail: `reset to upstream (${behind} commit${behind === 1 ? "" : "s"} behind)` };
  }
  return { dirty: false, reset: false, detail: `clean worktree (${ahead || 0} ahead, ${behind || 0} behind)` };
}

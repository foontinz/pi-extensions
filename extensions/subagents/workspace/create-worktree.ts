/**
 * Standalone, lifecycle-free git worktree provisioning.
 *
 * Extracted from `index.ts` so both the `run_agent` job lifecycle and the
 * `workflows` engine can create isolated worktrees for in-process subagents.
 *
 * `prepareWorktree` performs creation only (caller owns cleanup via
 * `cleanupWorktreeAsync`/`shouldRetainWorktree`). `createWorktree` wraps it with
 * a `dispose()` closure for callers that want a self-contained lifecycle.
 *
 * Worktree creation across the whole process is bounded by a shared slot
 * semaphore (`PI_SUBAGENTS_MAX_WORKTREE_CREATIONS`, default 4) so a wide
 * fan-out does not stampede git.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { compactPreview } from "../output/preview.js";
import { parseOptionalNonNegativeIntegerEnv } from "../platform/env.js";
import { getShellInvocation } from "../platform/shell.js";
import { buildPostCopyEnv } from "../policy/post-copy-env.js";
import {
  defaultWorktreeEnvConfig,
  normalizeRepoRelativePath,
  normalizeWorktreeEnvConfig,
  WORKTREE_CONFIG_PATH,
} from "./worktree-config.js";
import type {
  GitRootError,
  GitRootNotRepo,
  GitRootOk,
  GitRootResult,
  NormalizedWorktreeCopySpec,
  NormalizedWorktreeEnvConfig,
  NormalizedWorktreePostCopySpec,
  WorktreeEnvConfig,
  WorktreeInfo,
  WorktreeKeepMode,
  WorktreeScriptResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

const GIT_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_WORKTREE_CREATIONS = 4;
const MAX_WORKTREE_CREATIONS = Math.max(
  1,
  parseOptionalNonNegativeIntegerEnv("PI_SUBAGENTS_MAX_WORKTREE_CREATIONS", DEFAULT_MAX_WORKTREE_CREATIONS),
);

/** Status used to decide whether a worktree is retained on disposal. */
export type WorktreeDisposeStatus = "running" | "completed" | "failed" | "cancelled";

export interface PrepareWorktreeOptions {
  /** `true` forces isolation (errors if not a repo); `false` disables it; omit for best-effort auto. */
  worktreeOverride?: boolean;
  keepWorktree?: WorktreeKeepMode;
}

export interface PreparedWorktree {
  cwd: string;
  worktree?: WorktreeInfo;
  warning?: string;
}

export interface CreatedWorktree extends PreparedWorktree {
  /** Tear down the worktree (no-op when none was created or it is retained). */
  dispose: (status?: WorktreeDisposeStatus) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared creation-slot semaphore (process-wide)
// ---------------------------------------------------------------------------

let activeWorktreeCreations = 0;
const worktreeCreationQueue: Array<() => void> = [];

async function withWorktreeCreationSlot<T>(action: () => Promise<T>): Promise<T> {
  await acquireWorktreeCreationSlot();
  try {
    return await action();
  } finally {
    releaseWorktreeCreationSlot();
  }
}

async function acquireWorktreeCreationSlot(): Promise<void> {
  if (activeWorktreeCreations < MAX_WORKTREE_CREATIONS) {
    activeWorktreeCreations += 1;
    return;
  }
  await new Promise<void>((resolve) => worktreeCreationQueue.push(resolve));
}

function releaseWorktreeCreationSlot(): void {
  const next = worktreeCreationQueue.shift();
  if (next) {
    next();
    return;
  }
  activeWorktreeCreations = Math.max(0, activeWorktreeCreations - 1);
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Provision a worktree (creation only). Caller owns cleanup. */
export async function prepareWorktree(
  sourceCwd: string,
  options: PrepareWorktreeOptions = {},
): Promise<PreparedWorktree> {
  const { worktreeOverride, keepWorktree = "never" } = options;
  if (worktreeOverride === false) return { cwd: sourceCwd };

  const gitRoot = await getGitRootDetailed(sourceCwd);
  if (!gitRoot.ok) {
    if (gitRoot.kind === "not-repo") {
      if (worktreeOverride === true) throw new Error("worktree:true requires cwd to be inside a git repository.");
      return { cwd: sourceCwd };
    }
    const message = formatGitRootError(gitRoot);
    if (worktreeOverride === true) throw new Error(`worktree:true could not verify git repository for worktree isolation: ${message}`);
    // Auto mode is best-effort for non-git paths and odd environments, but
    // never silently: startup continues in-place and records an explicit warning.
    return { cwd: sourceCwd, warning: `git worktree isolation skipped because git repository detection failed: ${message}` };
  }

  const repoRoot = gitRoot.root;
  const config = await readWorktreeConfig(repoRoot);
  if (config.enabled === false && worktreeOverride !== true) return { cwd: sourceCwd };

  const base = config.base ?? "HEAD";
  await validateConfiguredCopies(repoRoot, config.copy, config.exclusions);

  return await withWorktreeCreationSlot(async () => {
    const tempParent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-worktree-"));
    const worktreeRoot = path.join(tempParent, "worktree");

    try {
      await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "--detach", "--quiet", worktreeRoot, base]);

      const copied = await copyConfiguredFiles(repoRoot, worktreeRoot, config.copy, config.exclusions);
      const postCopy = await runPostCopyScripts(worktreeRoot, config.postCopy);
      const relativeCwd = path.relative(repoRoot, sourceCwd);
      const childCwd = relativeCwd ? path.resolve(worktreeRoot, relativeCwd) : worktreeRoot;
      assertInside(worktreeRoot, childCwd, "cwd");
      await fs.promises.mkdir(childCwd, { recursive: true });

      return {
        cwd: childCwd,
        worktree: {
          root: worktreeRoot,
          tempParent,
          originalRoot: repoRoot,
          originalCwd: sourceCwd,
          configPath: config.configPath,
          base,
          copied,
          postCopy,
          keepWorktree,
        },
      };
    } catch (error) {
      if ((keepWorktree === "always" || keepWorktree === "onFailure") && fs.existsSync(worktreeRoot)) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\nRetained failed-prep worktree for inspection: ${worktreeRoot}`);
      }
      try {
        execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreeRoot], { stdio: "ignore", timeout: GIT_CLEANUP_TIMEOUT_MS, killSignal: "SIGKILL" });
      } catch {
        // ignore cleanup failures
      }
      try {
        fs.rmSync(tempParent, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
      throw error;
    }
  });
}

/** Provision a worktree and return a `dispose()` closure for self-contained lifecycle. */
export async function createWorktree(
  sourceCwd: string,
  options: PrepareWorktreeOptions = {},
): Promise<CreatedWorktree> {
  const prepared = await prepareWorktree(sourceCwd, options);
  let disposed = false;
  const dispose = async (status: WorktreeDisposeStatus = "completed"): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const worktree = prepared.worktree;
    if (!worktree) return;
    if (shouldRetainWorktree(worktree, status)) {
      worktree.retained = true;
      return;
    }
    await cleanupWorktreeAsync(worktree);
  };
  return { ...prepared, dispose };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function cleanupWorktreeAsync(worktree: WorktreeInfo): Promise<void> {
  let gitRemoveError: unknown;
  try {
    await execFileAsync("git", ["-C", worktree.originalRoot, "worktree", "remove", "--force", worktree.root]);
  } catch (error) {
    gitRemoveError = error;
  }
  await fs.promises.rm(worktree.tempParent, { recursive: true, force: true });
  if (gitRemoveError) {
    try {
      await execFileAsync("git", ["-C", worktree.originalRoot, "worktree", "prune"]);
    } catch (pruneError) {
      const removeMessage = gitRemoveError instanceof Error ? gitRemoveError.message : String(gitRemoveError);
      const pruneMessage = pruneError instanceof Error ? pruneError.message : String(pruneError);
      throw new Error(`git worktree remove failed (${removeMessage}); prune also failed (${pruneMessage})`);
    }
  }
}

export function shouldRetainWorktree(worktree: WorktreeInfo, status: WorktreeDisposeStatus): boolean {
  if (worktree.keepWorktree === "always") return true;
  if (worktree.keepWorktree === "onFailure") return status === "failed" || status === "cancelled";
  return false;
}

// ---------------------------------------------------------------------------
// Git root detection
// ---------------------------------------------------------------------------

export async function getGitRoot(cwd: string): Promise<string | undefined> {
  const result = await getGitRootDetailed(cwd);
  return result.ok ? result.root : undefined;
}

export async function getGitRootDetailed(cwd: string): Promise<GitRootResult> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const root = stdout.trim();
    return root ? { ok: true, root } : { ok: false, kind: "git-error", message: "git rev-parse returned an empty repository root" };
  } catch (error) {
    const execError = error as { code?: number | string; message?: string; stderr?: string };
    const stderr = String(execError.stderr ?? "").trim();
    const message = execError.message || stderr || String(error);
    if (execError.code === "ENOENT") return { ok: false, kind: "git-unavailable", message, code: execError.code, stderr };
    if (/cannot change to|No such file or directory|not a directory/i.test(stderr) || /ENOENT|ENOTDIR/.test(message)) {
      return { ok: false, kind: "invalid-cwd", message, code: execError.code, stderr };
    }
    if (execError.code === 128 && /not a git repository/i.test(stderr)) return { ok: false, kind: "not-repo" };
    return { ok: false, kind: "git-error", message, code: execError.code, stderr };
  }
}

export function formatGitRootError(result: Exclude<GitRootResult, GitRootOk | GitRootNotRepo>): string {
  return [result.kind, result.code !== undefined ? `code ${result.code}` : undefined, result.stderr || result.message]
    .filter(Boolean)
    .join(": ");
}

// ---------------------------------------------------------------------------
// Config + copy + postCopy internals
// ---------------------------------------------------------------------------

export async function readWorktreeConfig(repoRoot: string): Promise<NormalizedWorktreeEnvConfig> {
  const configPath = path.join(repoRoot, WORKTREE_CONFIG_PATH);
  try {
    const raw = await fs.promises.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${WORKTREE_CONFIG_PATH} must contain a JSON object.`);
    }
    return normalizeWorktreeEnvConfig(parsed as WorktreeEnvConfig, configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultWorktreeEnvConfig();
    throw error;
  }
}

async function validateConfiguredCopies(
  repoRoot: string,
  copy: NormalizedWorktreeCopySpec[],
  exclusions: string[],
): Promise<void> {
  const excludeMatcher = createExcludeMatcher(exclusions);
  for (const spec of copy) {
    if (hasGlobMagic(spec.from)) {
      const matches = await expandCopyGlob(repoRoot, spec.from, excludeMatcher);
      if (matches.length === 0) {
        if (spec.optional) continue;
        throw new Error(`${WORKTREE_CONFIG_PATH}: copy glob matched no files: ${spec.from}`);
      }
      for (const match of matches) {
        await validateCopyTree(repoRoot, resolveRepoPath(repoRoot, match, "copy.from"), excludeMatcher);
      }
      continue;
    }

    const from = resolveRepoPath(repoRoot, spec.from, "copy.from");
    try {
      await fs.promises.access(from, fs.constants.F_OK);
    } catch {
      if (spec.optional) continue;
      throw new Error(`${WORKTREE_CONFIG_PATH}: copy source does not exist: ${spec.from}`);
    }

    if (excludeMatcher(spec.from)) {
      if (spec.optional) continue;
      throw new Error(`${WORKTREE_CONFIG_PATH}: copy source is excluded: ${spec.from}`);
    }

    await validateCopyTree(repoRoot, from, excludeMatcher);
  }
}

async function validateCopyTree(
  repoRoot: string,
  absolutePath: string,
  excludeMatcher: (relativePath: string) => boolean,
): Promise<void> {
  const relative = normalizeRelativePath(path.relative(repoRoot, absolutePath));
  if (relative !== "." && (hasGitMetadataSegment(relative) || excludeMatcher(relative))) return;
  await assertSymlinkTargetInsideRepo(repoRoot, absolutePath, relative);
  const stat = await fs.promises.lstat(absolutePath);
  if (!stat.isDirectory()) return;
  const entries = await fs.promises.readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) await validateCopyTree(repoRoot, path.join(absolutePath, entry.name), excludeMatcher);
}

async function copyConfiguredFiles(
  repoRoot: string,
  worktreeRoot: string,
  copy: NormalizedWorktreeCopySpec[],
  exclusions: string[],
): Promise<string[]> {
  const copied: string[] = [];
  const excludeMatcher = createExcludeMatcher(exclusions);
  for (const spec of copy) {
    if (hasGlobMagic(spec.from)) {
      const matches = await expandCopyGlob(repoRoot, spec.from, excludeMatcher);
      if (matches.length === 0) {
        if (spec.optional) continue;
        throw new Error(`${WORKTREE_CONFIG_PATH}: copy glob matched no files: ${spec.from}`);
      }

      const base = globStaticBase(spec.from);
      for (const match of matches) {
        const relativeToBase = base === "." ? match : path.posix.relative(base, match);
        const destinationRelative = spec.to ? path.posix.join(spec.to, relativeToBase) : match;
        await copyOneRepoPath(repoRoot, worktreeRoot, match, destinationRelative, excludeMatcher);
      }
      copied.push(spec.to && spec.to !== spec.from ? `${spec.from} -> ${spec.to}` : spec.from);
      continue;
    }

    const from = resolveRepoPath(repoRoot, spec.from, "copy.from");
    const to = resolveRepoPath(worktreeRoot, spec.to ?? spec.from, "copy.to");

    try {
      await fs.promises.access(from, fs.constants.F_OK);
    } catch {
      if (spec.optional) continue;
      throw new Error(`${WORKTREE_CONFIG_PATH}: copy source does not exist: ${spec.from}`);
    }

    if (excludeMatcher(spec.from)) {
      if (spec.optional) continue;
      throw new Error(`${WORKTREE_CONFIG_PATH}: copy source is excluded: ${spec.from}`);
    }

    if (samePath(to, worktreeRoot)) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: copy destination may not be the worktree root.`);
    }

    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.rm(to, { recursive: true, force: true });
    await fs.promises.cp(from, to, {
      recursive: true,
      force: true,
      dereference: false,
      filter: createCopyFilter(repoRoot, excludeMatcher),
    });
    copied.push(spec.to && spec.to !== spec.from ? `${spec.from} -> ${spec.to}` : spec.from);
  }
  return copied;
}

async function copyOneRepoPath(
  repoRoot: string,
  worktreeRoot: string,
  sourceRelative: string,
  destinationRelative: string,
  excludeMatcher: (relativePath: string) => boolean,
): Promise<void> {
  const from = resolveRepoPath(repoRoot, sourceRelative, "copy.from");
  const to = resolveRepoPath(worktreeRoot, destinationRelative, "copy.to");
  if (samePath(to, worktreeRoot)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy destination may not be the worktree root.`);
  }
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.rm(to, { recursive: true, force: true });
  await fs.promises.cp(from, to, {
    recursive: true,
    force: true,
    dereference: false,
    filter: createCopyFilter(repoRoot, excludeMatcher),
  });
}

function createCopyFilter(
  repoRoot: string,
  excludeMatcher: (relativePath: string) => boolean,
): (src: string) => Promise<boolean> {
  return async (src: string): Promise<boolean> => {
    const relative = normalizeRelativePath(path.relative(repoRoot, src));
    if (relative !== "." && (hasGitMetadataSegment(relative) || excludeMatcher(relative))) return false;
    await assertSymlinkTargetInsideRepo(repoRoot, src, relative);
    return true;
  };
}

export async function assertSymlinkTargetInsideRepo(repoRoot: string, sourcePath: string, relativePath = normalizeRelativePath(path.relative(repoRoot, sourcePath))): Promise<void> {
  const stat = await fs.promises.lstat(sourcePath);
  if (!stat.isSymbolicLink()) return;

  const linkTarget = await fs.promises.readlink(sourcePath);
  const resolvedTarget = path.isAbsolute(linkTarget)
    ? path.resolve(linkTarget)
    : path.resolve(path.dirname(sourcePath), linkTarget);
  const relativeTarget = path.relative(repoRoot, resolvedTarget);
  if (relativeTarget === "" || (!relativeTarget.startsWith("..") && !path.isAbsolute(relativeTarget))) {
    const normalizedTarget = normalizeRelativePath(relativeTarget);
    if (hasGitMetadataSegment(normalizedTarget)) {
      throw new Error(
        `${WORKTREE_CONFIG_PATH}: refusing to copy symlink ${relativePath} -> ${linkTarget} because its target resolves into .git metadata.`,
      );
    }
    return;
  }

  throw new Error(
    `${WORKTREE_CONFIG_PATH}: refusing to copy symlink ${relativePath} -> ${linkTarget} because its target resolves outside the repo root.`,
  );
}

async function expandCopyGlob(repoRoot: string, pattern: string, excludeMatcher: (relativePath: string) => boolean): Promise<string[]> {
  const matches: string[] = [];
  const start = resolveRepoPathAllowRoot(repoRoot, globStaticBase(pattern), "copy.from");
  if (!fs.existsSync(start)) return matches;

  async function walk(absolutePath: string): Promise<void> {
    const relative = normalizeRelativePath(path.relative(repoRoot, absolutePath));
    if (relative !== "." && (hasGitMetadataSegment(relative) || excludeMatcher(relative))) return;

    const stat = await fs.promises.lstat(absolutePath);
    if (relative !== "." && globMatches(pattern, relative)) matches.push(relative);
    if (!stat.isDirectory()) return;

    const entries = await fs.promises.readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      await walk(path.join(absolutePath, entry.name));
    }
  }

  await walk(start);
  return matches.sort();
}

function createExcludeMatcher(exclusions: string[]): (relativePath: string) => boolean {
  const patterns = exclusions.map((entry) => normalizeRepoRelativePath(entry, "exclude"));
  return (relativePath: string) => {
    const normalized = normalizeRelativePath(relativePath);
    return patterns.some((pattern) => {
      if (globMatches(pattern, normalized) || normalized.startsWith(`${pattern}/`)) return true;
      if (pattern.endsWith("/**")) {
        const directoryPattern = pattern.slice(0, -3);
        return globMatches(directoryPattern, normalized) || normalized.startsWith(`${directoryPattern}/`);
      }
      return false;
    });
  };
}

function hasGlobMagic(input: string): boolean {
  return /[*?]/.test(input);
}

function globStaticBase(pattern: string): string {
  const parts = pattern.split("/");
  const staticParts: string[] = [];
  for (const part of parts) {
    if (hasGlobMagic(part)) break;
    staticParts.push(part);
  }
  return staticParts.length === 0 ? "." : staticParts.join("/");
}

function globMatches(pattern: string, relativePath: string): boolean {
  const regex = globPatternToRegExp(pattern);
  return regex.test(normalizeRelativePath(relativePath));
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      const after = pattern[i + 2];
      if (after === "/") {
        source += "(?:.*\/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(input: string): string {
  return input.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
}

function normalizeRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  return normalized === "" ? "." : normalized;
}

async function runPostCopyScripts(worktreeRoot: string, scripts: NormalizedWorktreePostCopySpec[]): Promise<WorktreeScriptResult[]> {
  const results: WorktreeScriptResult[] = [];
  for (const spec of scripts) {
    const cwd = spec.cwd ? resolveRepoPathAllowRoot(worktreeRoot, spec.cwd, "postCopy.cwd") : worktreeRoot;
    const result: WorktreeScriptResult = {
      command: spec.command,
      cwd: path.relative(worktreeRoot, cwd) || ".",
      optional: spec.optional,
      timeoutMs: spec.timeoutMs,
    };

    try {
      const shell = getShellInvocation(spec.command);
      const { stdout, stderr } = await execFileAsync(shell.command, shell.args, {
        cwd,
        timeout: spec.timeoutMs,
        maxBuffer: 1_000_000,
        env: buildPostCopyEnv(spec.env),
      });
      result.stdout = compactPreview(stdout.trim(), 600, 4);
      result.stderr = compactPreview(stderr.trim(), 600, 4);
      results.push(result);
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; signal?: string };
      result.stdout = compactPreview((execError.stdout ?? "").trim(), 600, 4);
      result.stderr = compactPreview((execError.stderr ?? execError.message ?? "").trim(), 600, 4);
      result.failed = true;
      results.push(result);
      if (!spec.optional) {
        const reason = [
          `command failed${execError.code !== undefined ? ` (code ${execError.code})` : ""}${execError.signal ? ` (signal ${execError.signal})` : ""}`,
          result.stderr ? `stderr: ${result.stderr}` : undefined,
          result.stdout ? `stdout: ${result.stdout}` : undefined,
        ].filter(Boolean).join("; ");
        throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy failed for ${JSON.stringify(spec.command)}: ${reason}`);
      }
    }
  }
  return results;
}

function resolveRepoPath(root: string, relativePath: string, fieldName: string): string {
  const resolved = path.resolve(root, relativePath);
  assertInside(root, resolved, fieldName);
  return resolved;
}

function resolveRepoPathAllowRoot(root: string, relativePath: string, fieldName: string): string {
  const resolved = path.resolve(root, relativePath);
  assertInsideAllowRoot(root, resolved, fieldName);
  return resolved;
}

function assertInside(root: string, candidate: string, fieldName: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} escapes the repo root.`);
}

function assertInsideAllowRoot(root: string, candidate: string, fieldName: string): void {
  assertInside(root, candidate, fieldName);
}

function hasGitMetadataSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some((segment) => segment === ".git");
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

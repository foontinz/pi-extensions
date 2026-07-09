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

import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
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
  /** Cancels repository detection and all provisioning work, but never cleanup. */
  signal?: AbortSignal;
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

/** Cancellation succeeded, but removing the partially prepared worktree did not. */
export class WorktreeStartupCleanupError extends Error {
  override name = "WorktreeStartupCleanupError";

  constructor(
    readonly abortCause: unknown,
    readonly worktree: WorktreeInfo,
    readonly cleanupCause: unknown,
  ) {
    const cleanupMessage = cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause);
    super(`cancelled worktree startup cleanup failed: ${cleanupMessage}`, { cause: abortCause });
  }
}

/** Preparation failed after creating a worktree and verified cleanup also failed. */
export class WorktreePreparationCleanupError extends Error {
  override name = "WorktreePreparationCleanupError";

  constructor(
    readonly preparationCause: unknown,
    readonly worktree: WorktreeInfo,
    readonly cleanupCause: unknown,
  ) {
    const preparationMessage = preparationCause instanceof Error ? preparationCause.message : String(preparationCause);
    const cleanupMessage = cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause);
    super(`worktree preparation failed (${preparationMessage}) and cleanup failed: ${cleanupMessage}`, { cause: preparationCause });
  }
}

// ---------------------------------------------------------------------------
// Shared creation-slot semaphore (process-wide)
// ---------------------------------------------------------------------------

let activeWorktreeCreations = 0;
interface WorktreeCreationWaiter {
  grant: () => boolean;
}
const worktreeCreationQueue: WorktreeCreationWaiter[] = [];
let worktreeCheckpointHook: ((checkpoint: string) => void) | undefined;

function worktreeCheckpoint(checkpoint: string, signal?: AbortSignal): void {
  worktreeCheckpointHook?.(checkpoint);
  throwIfAborted(signal);
}

async function withWorktreeCreationSlot<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await acquireWorktreeCreationSlot(signal);
  try {
    throwIfAborted(signal);
    return await action();
  } finally {
    releaseWorktreeCreationSlot();
  }
}

async function acquireWorktreeCreationSlot(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (activeWorktreeCreations < MAX_WORKTREE_CREATIONS) {
    activeWorktreeCreations += 1;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const waiter: WorktreeCreationWaiter = {
      grant: () => {
        if (settled) return false;
        if (signal?.aborted) {
          settled = true;
          cleanup();
          reject(abortReason(signal));
          return false;
        }
        settled = true;
        cleanup();
        resolve();
        return true;
      },
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const index = worktreeCreationQueue.indexOf(waiter);
      if (index >= 0) worktreeCreationQueue.splice(index, 1);
      cleanup();
      reject(abortReason(signal!));
    };

    worktreeCreationQueue.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Close the check/listener race for signals aborted by unusual synchronous hooks.
    if (signal?.aborted) onAbort();
  });
}

function releaseWorktreeCreationSlot(): void {
  for (;;) {
    const next = worktreeCreationQueue.shift();
    if (!next) {
      activeWorktreeCreations = Math.max(0, activeWorktreeCreations - 1);
      return;
    }
    // A waiter cancelled at handoff does not consume the transferred slot.
    if (next.grant()) return;
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Provision a worktree (creation only). Caller owns cleanup. */
export async function prepareWorktree(
  sourceCwd: string,
  options: PrepareWorktreeOptions = {},
): Promise<PreparedWorktree> {
  const { worktreeOverride, keepWorktree = "never", signal } = options;
  throwIfAborted(signal);
  if (worktreeOverride === false) return { cwd: sourceCwd };

  const gitRoot = await getGitRootDetailed(sourceCwd, signal);
  throwIfAborted(signal);
  if (!gitRoot.ok) {
    if (gitRoot.kind === "not-repo") {
      if (worktreeOverride === true) {
        throw new Error(
          `worktree isolation (worktree:true) requires a git repository, but "${sourceCwd}" is not inside one. ` +
            `Run from a git repo, or set worktree:false to run in-place.`,
        );
      }
      return { cwd: sourceCwd };
    }
    const message = formatGitRootError(gitRoot);
    if (worktreeOverride === true) throw new Error(`worktree:true could not verify git repository for worktree isolation: ${message}`);
    // Auto mode is best-effort for non-git paths and odd environments, but
    // never silently: startup continues in-place and records an explicit warning.
    return { cwd: sourceCwd, warning: `git worktree isolation skipped because git repository detection failed: ${message}` };
  }

  const repoRoot = await fs.promises.realpath(gitRoot.root);
  throwIfAborted(signal);
  const config = await readWorktreeConfig(repoRoot, signal);
  if (config.enabled === false && worktreeOverride !== true) return { cwd: sourceCwd };

  // Git canonicalizes `--show-toplevel`, so canonicalize the source cwd too.
  // Validate and calculate its repo-relative location before provisioning: an
  // aliased cwd must map into the new worktree, and an invalid one must fail
  // without first creating a worktree.
  const canonicalSourceCwd = await fs.promises.realpath(sourceCwd);
  throwIfAborted(signal);
  assertInside(repoRoot, canonicalSourceCwd, "cwd");
  const relativeCwd = path.relative(repoRoot, canonicalSourceCwd);

  const base = config.base ?? "HEAD";
  await validateConfiguredCopies(repoRoot, config.copy, config.exclusions, signal);

  return await withWorktreeCreationSlot(async () => {
    throwIfAborted(signal);
    const tempParent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-worktree-"));
    const worktreeRoot = path.join(tempParent, "worktree");
    const partialWorktree: WorktreeInfo = {
      root: worktreeRoot,
      tempParent,
      originalRoot: repoRoot,
      originalCwd: sourceCwd,
      configPath: config.configPath,
      base,
      copied: [],
      postCopy: [],
      keepWorktree,
    };

    try {
      throwIfAborted(signal);
      await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "--detach", "--quiet", worktreeRoot, base], { signal });
      worktreeCheckpoint("git-add-complete", signal);

      partialWorktree.copied = await copyConfiguredFiles(repoRoot, worktreeRoot, config.copy, config.exclusions, signal);
      partialWorktree.postCopy = await runPostCopyScripts(worktreeRoot, config.postCopy, signal);
      const childCwd = relativeCwd ? path.resolve(worktreeRoot, relativeCwd) : worktreeRoot;
      await fs.promises.mkdir(childCwd, { recursive: true });
      throwIfAborted(signal);

      return { cwd: childCwd, worktree: partialWorktree };
    } catch (error) {
      if (signal?.aborted) {
        // Startup cancellation never honors retention: no caller has accepted
        // ownership of this worktree, so leaving it behind would leak resources.
        partialWorktree.keepWorktree = "never";
        delete partialWorktree.retained;
        try {
          await cleanupPreparationWorktree(partialWorktree);
        } catch (cleanupError) {
          throw new WorktreeStartupCleanupError(abortReason(signal), partialWorktree, cleanupError);
        }
        throw abortReason(signal);
      }

      if ((keepWorktree === "always" || keepWorktree === "onFailure") && fs.existsSync(worktreeRoot)) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\nRetained failed-prep worktree for inspection: ${worktreeRoot}`);
      }
      try {
        // Cleanup is ownership-critical after provisioning. Unlike the old
        // synchronous best-effort path, cleanupWorktreeAsync verifies that Git
        // no longer registers the worktree before allowing preparation to fail.
        await cleanupPreparationWorktree(partialWorktree);
      } catch (cleanupError) {
        throw new WorktreePreparationCleanupError(error, partialWorktree, cleanupError);
      }
      throw error;
    }
  }, signal);
}

/** Provision a worktree and return a `dispose()` closure for self-contained lifecycle. */
export async function createWorktree(
  sourceCwd: string,
  options: PrepareWorktreeOptions = {},
): Promise<CreatedWorktree> {
  const prepared = await prepareWorktree(sourceCwd, options);
  if (options.signal?.aborted) {
    const worktree = prepared.worktree;
    if (worktree) {
      worktree.keepWorktree = "never";
      delete worktree.retained;
      try {
        await cleanupPreparationWorktree(worktree);
      } catch (cleanupError) {
        throw new WorktreeStartupCleanupError(abortReason(options.signal), worktree, cleanupError);
      }
    }
    throw abortReason(options.signal);
  }
  let disposed = false;
  const dispose = async (status: WorktreeDisposeStatus = "completed"): Promise<void> => {
    if (disposed) return;
    const worktree = prepared.worktree;
    if (worktree && !shouldRetainWorktree(worktree, status)) {
      await cleanupCreatedWorktree(worktree);
    } else if (worktree) {
      worktree.retained = true;
    }
    // A failed cleanup leaves ownership with the caller so a later dispose()
    // can retry. Mark disposal complete only after cleanup/retention succeeds.
    disposed = true;
  };
  return { ...prepared, dispose };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let cleanupPreparationWorktree: (worktree: WorktreeInfo) => Promise<void> = cleanupWorktreeAsync;
/** Test seam for retryable CreatedWorktree disposal. */
let cleanupCreatedWorktree: (worktree: WorktreeInfo) => Promise<void> = cleanupWorktreeAsync;

export async function cleanupWorktreeAsync(worktree: WorktreeInfo): Promise<void> {
  const failures: string[] = [];
  const gitOptions = { timeout: GIT_CLEANUP_TIMEOUT_MS, killSignal: "SIGKILL" as const };
  // Git stores a canonical path. Keep using that spelling after the worktree has
  // been deleted, when Git can no longer resolve an aliased input path itself.
  const gitWorktreeRoot = await canonicalizeMissingPath(worktree.root);

  // `worktree remove --force` still refuses a locked worktree. Unlock first so a
  // normal lock does not turn cleanup into a stale registration.
  try {
    await execFileAsync("git", ["-C", worktree.originalRoot, "worktree", "unlock", gitWorktreeRoot], gitOptions);
  } catch (error) {
    // "not locked" and already-unregistered worktrees are both harmless if the
    // remove/verification below succeeds.
    failures.push(`unlock failed (${errorMessage(error)})`);
  }

  try {
    await execFileAsync("git", ["-C", worktree.originalRoot, "worktree", "remove", "--force", gitWorktreeRoot], gitOptions);
  } catch (error) {
    failures.push(`remove failed (${errorMessage(error)})`);
  }

  let filesystemError: unknown;
  try {
    await fs.promises.rm(worktree.tempParent, { recursive: true, force: true });
  } catch (error) {
    filesystemError = error;
  }

  let registered = await isWorktreeRegistered(worktree.originalRoot, worktree.root);
  if (registered) {
    try {
      // A deleted worktree directory can leave prunable administrative data.
      // Expire it now, but never treat prune's exit status as proof of cleanup.
      await execFileAsync("git", ["-C", worktree.originalRoot, "worktree", "prune", "--expire", "now"], gitOptions);
    } catch (error) {
      failures.push(`prune failed (${errorMessage(error)})`);
    }
    registered = await isWorktreeRegistered(worktree.originalRoot, worktree.root);
  }

  if (registered) {
    throw new Error(`git worktree registration still exists for ${worktree.root}; ${failures.join("; ") || "remove/prune did not unregister it"}`);
  }
  if (filesystemError) {
    throw new Error(`worktree directory removal failed (${errorMessage(filesystemError)})`);
  }
}

async function isWorktreeRegistered(repoRoot: string, worktreeRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"], {
      timeout: GIT_CLEANUP_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const registeredRoots = String(stdout)
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length));
    const expected = await canonicalizeMissingPath(worktreeRoot);
    for (const registeredRoot of registeredRoots) {
      if (samePath(await canonicalizeMissingPath(registeredRoot), expected)) return true;
    }
    return false;
  } catch (error) {
    throw new Error(`could not verify git worktree registration for ${worktreeRoot}: ${errorMessage(error)}`);
  }
}

/** Resolve aliases in the nearest existing ancestor even after the worktree was deleted. */
async function canonicalizeMissingPath(candidatePath: string): Promise<string> {
  const unresolved: string[] = [];
  let candidate = path.resolve(candidatePath);
  for (;;) {
    try {
      return path.join(await fs.promises.realpath(candidate), ...unresolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(candidate);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === candidate) return path.resolve(candidatePath);
      unresolved.unshift(path.basename(candidate));
      candidate = parent;
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

export async function getGitRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await getGitRootDetailed(cwd, signal);
  return result.ok ? result.root : undefined;
}

export async function getGitRootDetailed(cwd: string, signal?: AbortSignal): Promise<GitRootResult> {
  throwIfAborted(signal);
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { signal });
    throwIfAborted(signal);
    const root = stdout.trim();
    return root ? { ok: true, root } : { ok: false, kind: "git-error", message: "git rev-parse returned an empty repository root" };
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
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

export async function readWorktreeConfig(repoRoot: string, signal?: AbortSignal): Promise<NormalizedWorktreeEnvConfig> {
  const configPath = path.join(repoRoot, WORKTREE_CONFIG_PATH);
  throwIfAborted(signal);
  try {
    const raw = await fs.promises.readFile(configPath, { encoding: "utf-8", signal });
    throwIfAborted(signal);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${WORKTREE_CONFIG_PATH} must contain a JSON object.`);
    }
    return normalizeWorktreeEnvConfig(parsed as WorktreeEnvConfig, configPath);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultWorktreeEnvConfig();
    throw error;
  }
}

async function validateConfiguredCopies(
  repoRoot: string,
  copy: NormalizedWorktreeCopySpec[],
  exclusions: string[],
  signal?: AbortSignal,
): Promise<void> {
  const excludeMatcher = createExcludeMatcher(exclusions);
  for (const spec of copy) {
    worktreeCheckpoint(`validate-copy:${spec.from}`, signal);
    if (hasGlobMagic(spec.from)) {
      const matches = await expandCopyGlob(repoRoot, spec.from, excludeMatcher, signal);
      if (matches.length === 0) {
        if (spec.optional) continue;
        throw new Error(`${WORKTREE_CONFIG_PATH}: copy glob matched no files: ${spec.from}`);
      }
      for (const match of matches) {
        await validateCopyTree(repoRoot, resolveRepoPath(repoRoot, match, "copy.from"), excludeMatcher, signal);
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

    await validateCopyTree(repoRoot, from, excludeMatcher, signal);
  }
}

async function validateCopyTree(
  repoRoot: string,
  absolutePath: string,
  excludeMatcher: (relativePath: string) => boolean,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const relative = normalizeRelativePath(path.relative(repoRoot, absolutePath));
  if (relative !== "." && (hasGitMetadataSegment(relative) || excludeMatcher(relative))) return;
  await assertSymlinkTargetInsideRepo(repoRoot, absolutePath, relative);
  const stat = await fs.promises.lstat(absolutePath);
  if (!stat.isDirectory()) return;
  const entries = await fs.promises.readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) await validateCopyTree(repoRoot, path.join(absolutePath, entry.name), excludeMatcher, signal);
}

async function copyConfiguredFiles(
  repoRoot: string,
  worktreeRoot: string,
  copy: NormalizedWorktreeCopySpec[],
  exclusions: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const copied: string[] = [];
  const excludeMatcher = createExcludeMatcher(exclusions);
  for (const spec of copy) {
    worktreeCheckpoint(`copy:${spec.from}`, signal);
    if (hasGlobMagic(spec.from)) {
      const matches = await expandCopyGlob(repoRoot, spec.from, excludeMatcher, signal);
      if (matches.length === 0) {
        if (spec.optional) continue;
        throw new Error(`${WORKTREE_CONFIG_PATH}: copy glob matched no files: ${spec.from}`);
      }

      const base = globStaticBase(spec.from);
      for (const match of matches) {
        const relativeToBase = base === "." ? match : path.posix.relative(base, match);
        const destinationRelative = spec.to ? path.posix.join(spec.to, relativeToBase) : match;
        await copyOneRepoPath(repoRoot, worktreeRoot, match, destinationRelative, excludeMatcher, signal);
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
    await copyPathAbortable(repoRoot, from, to, excludeMatcher, signal);
    throwIfAborted(signal);
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
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const from = resolveRepoPath(repoRoot, sourceRelative, "copy.from");
  const to = resolveRepoPath(worktreeRoot, destinationRelative, "copy.to");
  if (samePath(to, worktreeRoot)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy destination may not be the worktree root.`);
  }
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.rm(to, { recursive: true, force: true });
  await copyPathAbortable(repoRoot, from, to, excludeMatcher, signal);
  throwIfAborted(signal);
}

async function copyPathAbortable(
  repoRoot: string,
  from: string,
  to: string,
  excludeMatcher: (relativePath: string) => boolean,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const relative = normalizeRelativePath(path.relative(repoRoot, from));
  if (relative !== "." && (hasGitMetadataSegment(relative) || excludeMatcher(relative))) return;
  await assertSymlinkTargetInsideRepo(repoRoot, from, relative);
  const stat = await fs.promises.lstat(from);
  throwIfAborted(signal);

  if (stat.isDirectory()) {
    await fs.promises.mkdir(to, { recursive: true, mode: stat.mode });
    const entries = await fs.promises.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      await copyPathAbortable(repoRoot, path.join(from, entry.name), path.join(to, entry.name), excludeMatcher, signal);
    }
    throwIfAborted(signal);
    await fs.promises.chmod(to, stat.mode);
    await fs.promises.utimes(to, stat.atime, stat.mtime);
    return;
  }

  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  if (stat.isSymbolicLink()) {
    const target = await fs.promises.readlink(from);
    let type: "junction" | "file" | undefined;
    if (process.platform === "win32") {
      try {
        // Windows needs an explicit link kind. A dangling link cannot be
        // stat-followed, so preserve it as the safe file-link default.
        type = (await fs.promises.stat(from)).isDirectory() ? "junction" : "file";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        type = "file";
      }
    }
    await fs.promises.symlink(target, to, type);
    return;
  }

  if (!stat.isFile()) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy source is not a regular file, directory, or symlink: ${relative}`);
  }

  const checkpoint = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        worktreeCheckpoint(`copy-file-chunk:${relative}`, signal);
        callback(null, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  await pipeline(
    fs.createReadStream(from),
    checkpoint,
    fs.createWriteStream(to, { flags: "w", mode: stat.mode }),
    { signal },
  );
  throwIfAborted(signal);
  await fs.promises.chmod(to, stat.mode);
  await fs.promises.utimes(to, stat.atime, stat.mtime);
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

async function expandCopyGlob(
  repoRoot: string,
  pattern: string,
  excludeMatcher: (relativePath: string) => boolean,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
  const matches: string[] = [];
  const start = resolveRepoPathAllowRoot(repoRoot, globStaticBase(pattern), "copy.from");
  if (!fs.existsSync(start)) return matches;

  async function walk(absolutePath: string): Promise<void> {
    throwIfAborted(signal);
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

async function runPostCopyScripts(
  worktreeRoot: string,
  scripts: NormalizedWorktreePostCopySpec[],
  signal?: AbortSignal,
): Promise<WorktreeScriptResult[]> {
  const results: WorktreeScriptResult[] = [];
  for (const spec of scripts) {
    worktreeCheckpoint(`postCopy:${spec.command}`, signal);
    const cwd = spec.cwd ? resolveRepoPathAllowRoot(worktreeRoot, spec.cwd, "postCopy.cwd") : worktreeRoot;
    const result: WorktreeScriptResult = {
      command: spec.command,
      cwd: path.relative(worktreeRoot, cwd) || ".",
      optional: spec.optional,
      timeoutMs: spec.timeoutMs,
    };

    try {
      const shell = getShellInvocation(spec.command);
      const { stdout, stderr } = await runPostCopyProcess(shell.command, shell.args, {
        cwd,
        timeoutMs: spec.timeoutMs,
        env: buildPostCopyEnv(spec.env),
        signal,
      });
      throwIfAborted(signal);
      result.stdout = compactPreview(stdout.trim(), 600, 4);
      result.stderr = compactPreview(stderr.trim(), 600, 4);
      results.push(result);
    } catch (error) {
      // Cancellation is never an optional script failure: stop provisioning and
      // let the outer resource owner remove the partially prepared worktree.
      throwIfAborted(signal);
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

interface PostCopyProcessOptions {
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

function runPostCopyProcess(
  command: string,
  args: string[],
  options: PostCopyProcessOptions,
): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let terminated = false;
    let settled = false;
    let outputError: Error | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    const maxBuffer = 1_000_000;

    const terminateTree = (): void => {
      if (terminated) return;
      terminated = true;
      const pid = child?.pid;
      try {
        if (process.platform !== "win32" && pid) {
          // `detached` below makes the shell the leader of a fresh process group,
          // so a negative pid reaches the shell and all non-detached descendants.
          process.kill(-pid, "SIGKILL");
        } else {
          child?.kill("SIGKILL");
        }
      } catch {
        // The process may have exited between the callback and kill. On Windows,
        // importantly, never attempt a negative-pid kill.
      }
    };
    const onAbort = () => terminateTree();
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdoutChunks).toString(), stderr: Buffer.concat(stderrChunks).toString() });
    };
    const collect = (chunks: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > maxBuffer) {
        outputError ??= new Error(`postCopy output exceeded ${maxBuffer} bytes`);
        terminateTree();
        return;
      }
      chunks.push(buffer);
    };

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(error);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => collect(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => collect(stderrChunks, chunk));
    child.once("error", finish);
    child.once("close", (code, processSignal) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (outputError) {
        Object.assign(outputError, { stdout, stderr, code, signal: processSignal });
        finish(outputError);
      } else if (code === 0) {
        finish();
      } else {
        const error = new Error(`postCopy process exited with code ${code ?? "unknown"}${processSignal ? ` (signal ${processSignal})` : ""}`);
        Object.assign(error, { stdout, stderr, code: code ?? undefined, signal: processSignal ?? undefined });
        finish(error);
      }
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs > 0) timeout = setTimeout(terminateTree, options.timeoutMs);
    // Close the spawn/listener race.
    if (options.signal?.aborted) onAbort();
  });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Deterministic seams for cancellation/resource-ownership regression tests. */
export const __worktreeTest = {
  maxCreations: MAX_WORKTREE_CREATIONS,
  withCreationSlot<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withWorktreeCreationSlot(action, signal);
  },
  setPreparationCleanup(cleanup: ((worktree: WorktreeInfo) => Promise<void>) | undefined): void {
    cleanupPreparationWorktree = cleanup ?? cleanupWorktreeAsync;
  },
  setCreatedWorktreeCleanup(cleanup: ((worktree: WorktreeInfo) => Promise<void>) | undefined): void {
    cleanupCreatedWorktree = cleanup ?? cleanupWorktreeAsync;
  },
  setCheckpointHook(hook: ((checkpoint: string) => void) | undefined): void {
    worktreeCheckpointHook = hook;
  },
};

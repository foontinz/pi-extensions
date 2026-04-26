import * as path from "node:path";
import type {
  NormalizedWorktreeCopySpec,
  NormalizedWorktreeEnvConfig,
  NormalizedWorktreePostCopySpec,
  WorktreeCopyObject,
  WorktreeEnvConfig,
  WorktreeKeepMode,
  WorktreePostCopyObject,
} from "./types.js";

export const WORKTREE_CONFIG_PATH = path.join(".pi", "worktree.json");
export const POST_COPY_DEFAULT_TIMEOUT_MS = 120_000;
export const POST_COPY_MAX_TIMEOUT_MS = 30 * 60 * 1000;

export function defaultWorktreeEnvConfig(configPath?: string): NormalizedWorktreeEnvConfig {
  return { copy: [], exclusions: [], postCopy: [], keepWorktree: "never", configPath };
}

export function normalizeWorktreeEnvConfig(config: WorktreeEnvConfig, configPath?: string): NormalizedWorktreeEnvConfig {
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: enabled must be a boolean.`);
  }
  if (config.base !== undefined && typeof config.base !== "string") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: base must be a string.`);
  }
  const base = config.base?.trim();
  if (config.base !== undefined && !base) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: base must be a non-empty git revision.`);
  }
  if (config.copy !== undefined && !Array.isArray(config.copy)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy must be an array.`);
  }
  if (config.exclude !== undefined && !Array.isArray(config.exclude)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: exclude must be an array.`);
  }
  if (config.exclusions !== undefined && !Array.isArray(config.exclusions)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: exclusions must be an array.`);
  }
  if (config.exclude !== undefined && config.exclusions !== undefined) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: use either exclude or exclusions, not both.`);
  }
  if ((config.exclude ?? config.exclusions)?.some((entry) => typeof entry !== "string")) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: exclude entries must be strings.`);
  }
  if (config.postCopy !== undefined && !Array.isArray(config.postCopy)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy must be an array.`);
  }
  if (config.postCopyScripts !== undefined && !Array.isArray(config.postCopyScripts)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopyScripts must be an array.`);
  }
  if (config.postCopy !== undefined && config.postCopyScripts !== undefined) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: use either postCopy or postCopyScripts, not both.`);
  }

  return {
    enabled: config.enabled,
    base,
    copy: (config.copy ?? []).map(normalizeCopySpec),
    exclusions: (config.exclude ?? config.exclusions ?? []).map((entry) => normalizeRepoRelativePath(entry, "exclude")),
    postCopy: (config.postCopy ?? config.postCopyScripts ?? []).map(normalizePostCopySpec),
    keepWorktree: normalizeKeepWorktree(config.keepWorktree),
    configPath,
  };
}

function normalizeCopySpec(entry: string | WorktreeCopyObject): NormalizedWorktreeCopySpec {
  if (typeof entry === "string") return { from: normalizeRepoRelativePath(entry, "copy"), optional: false };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy entries must be strings or objects.`);
  }
  if (typeof entry.from !== "string") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy object requires a non-empty string "from".`);
  }
  if (entry.to !== undefined && typeof entry.to !== "string") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy object "to" must be a non-empty string.`);
  }
  if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: copy object "optional" must be a boolean.`);
  }
  return {
    from: normalizeRepoRelativePath(entry.from, "copy.from"),
    to: entry.to === undefined ? undefined : normalizeRepoRelativePath(entry.to, "copy.to"),
    optional: entry.optional ?? false,
  };
}

function normalizePostCopySpec(entry: string | WorktreePostCopyObject): NormalizedWorktreePostCopySpec {
  if (typeof entry === "string") return { command: normalizeCommand(entry, "postCopy"), optional: false, timeoutMs: POST_COPY_DEFAULT_TIMEOUT_MS };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy entries must be strings or objects.`);
  }
  if (typeof entry.command !== "string") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object requires a non-empty string "command".`);
  }
  if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object "cwd" must be a string.`);
  }
  if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object "optional" must be a boolean.`);
  }
  if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1 || entry.timeoutMs > POST_COPY_MAX_TIMEOUT_MS)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object "timeoutMs" must be an integer from 1 to ${POST_COPY_MAX_TIMEOUT_MS}.`);
  }
  if (entry.env !== undefined) {
    if (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env)) {
      throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object "env" must be an object of string values.`);
    }
    for (const [key, value] of Object.entries(entry.env)) {
      if (!key || typeof value !== "string") {
        throw new Error(`${WORKTREE_CONFIG_PATH}: postCopy object "env" must be an object of string values.`);
      }
    }
  }
  return {
    command: normalizeCommand(entry.command, "postCopy.command"),
    cwd: entry.cwd === undefined ? undefined : normalizeRepoRelativePathAllowRoot(entry.cwd, "postCopy.cwd"),
    optional: entry.optional ?? false,
    timeoutMs: entry.timeoutMs ?? POST_COPY_DEFAULT_TIMEOUT_MS,
    env: entry.env,
  };
}

function normalizeCommand(input: string, fieldName: string): string {
  const command = input.trim();
  if (!command) throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must be a non-empty command.`);
  return command;
}

function normalizeKeepWorktree(value: WorktreeEnvConfig["keepWorktree"]): WorktreeKeepMode {
  if (value === undefined || value === false) return "never";
  if (value === true) return "always";
  if (value === "never" || value === "always" || value === "onFailure") return value;
  throw new Error(`${WORKTREE_CONFIG_PATH}: keepWorktree must be a boolean or one of "never", "always", "onFailure".`);
}

export function normalizeRepoRelativePath(input: string, fieldName: string): string {
  const raw = input.trim();
  if (!raw) throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must be a non-empty relative path.`);
  if (path.isAbsolute(raw) || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must be relative to the repo root: ${input}`);
  }
  const normalized = canonicalRepoRelativePath(raw);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must stay inside the repo and may not target the repo root: ${input}`);
  }
  if (hasGitMetadataSegment(normalized)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: refusing to copy .git metadata paths: ${input}`);
  }
  return normalized;
}

export function normalizeRepoRelativePathAllowRoot(input: string, fieldName: string): string {
  const raw = input.trim();
  if (!raw) throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must be a non-empty relative path.`);
  if (path.isAbsolute(raw) || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must be relative to the repo root: ${input}`);
  }
  const normalized = canonicalRepoRelativePath(raw);
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: ${fieldName} must stay inside the repo: ${input}`);
  }
  if (hasGitMetadataSegment(normalized)) {
    throw new Error(`${WORKTREE_CONFIG_PATH}: refusing to use .git metadata paths: ${input}`);
  }
  return normalized === "." ? "." : normalized;
}

function canonicalRepoRelativePath(input: string): string {
  const normalized = path.posix.normalize(input.replace(/\\/g, "/"));
  if (normalized === "./") return ".";
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function hasGitMetadataSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some((segment) => segment === ".git");
}

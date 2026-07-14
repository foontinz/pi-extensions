import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const HOME_ENV = "PR_BABYSIT_HOME";
export const TMUX_SOCKET_ENV = "PR_BABYSIT_TMUX_SOCKET";

export const DEFAULT_GITHUB_HOST = "github.com";

export interface ParsedPrKey {
  host: string;
  owner: string;
  repo: string;
  number: number;
  key: string;
}

export interface AppPaths {
  home: string;
  configFile: string;
  ownerTokenFile: string;
  slotsDir: string;
  prsDir: string;
  reposDir: string;
  worktreesDir: string;
}

export interface PrPaths {
  dirName: string;
  prDir: string;
  stateFile: string;
  eventsFile: string;
  controlDir: string;
  sessionsDir: string;
  runsDir: string;
  worktreePath: string;
}

const OWNER_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const REPO_PATTERN = /^[a-z\d_.-]{1,100}$/i;

export function normalizeGithubHost(input: string): string {
  const host = input.trim().toLowerCase();
  if (host === "" || /[\s/#?@]/.test(host)) throw new Error(`Invalid GitHub hostname: ${JSON.stringify(input)}`);
  let url: URL;
  try {
    url = new URL(`https://${host}`);
  } catch {
    throw new Error(`Invalid GitHub hostname: ${JSON.stringify(input)}`);
  }
  if (url.host.toLowerCase() !== host || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Invalid GitHub hostname: ${JSON.stringify(input)}`);
  }
  return host;
}

export function formatPrKey(
  ownerInput: string,
  repoInput: string,
  number: number,
  hostInput = DEFAULT_GITHUB_HOST,
): string {
  const host = normalizeGithubHost(hostInput);
  const owner = ownerInput.toLowerCase();
  const repo = repoInput.toLowerCase();

  if (!OWNER_PATTERN.test(owner)) {
    throw new Error(`Invalid GitHub owner: ${JSON.stringify(ownerInput)}`);
  }
  if (!REPO_PATTERN.test(repo) || repo === "." || repo === ".." || repo.includes("..")) {
    throw new Error(`Invalid GitHub repository: ${JSON.stringify(repoInput)}`);
  }
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Invalid pull request number: ${number}`);
  }

  return host === DEFAULT_GITHUB_HOST
    ? `${owner}/${repo}#${number}`
    : `${host}/${owner}/${repo}#${number}`;
}

export function parsePrKey(input: string): ParsedPrKey {
  const hash = input.lastIndexOf("#");
  const path = hash < 0 ? "" : input.slice(0, hash);
  const numberText = hash < 0 ? "" : input.slice(hash + 1);
  const parts = path.split("/");
  if ((parts.length !== 2 && parts.length !== 3) || !/^\d+$/.test(numberText)) {
    throw new Error(`Invalid PR key ${JSON.stringify(input)}; expected owner/repo#N or host/owner/repo#N`);
  }
  const [hostInput, owner, repo] = parts.length === 3
    ? [parts[0], parts[1], parts[2]]
    : [DEFAULT_GITHUB_HOST, parts[0], parts[1]];
  if (hostInput === undefined || owner === undefined || repo === undefined) {
    throw new Error(`Invalid PR key ${JSON.stringify(input)}; expected owner/repo#N or host/owner/repo#N`);
  }
  const number = Number(numberText);
  const host = normalizeGithubHost(hostInput);
  const key = formatPrKey(owner, repo, number, host);
  return { host, owner: owner.toLowerCase(), repo: repo.toLowerCase(), number, key };
}

export function encodePrKey(input: string): string {
  const { key } = parsePrKey(input);
  return `pr-v1-${Buffer.from(key, "utf8").toString("base64url")}`;
}

export function decodePrKeyDirName(dirName: string): string {
  if (!dirName.startsWith("pr-v1-")) {
    throw new Error(`Invalid PR directory name: ${dirName}`);
  }
  const payload = dirName.slice("pr-v1-".length);
  if (!/^[A-Za-z\d_-]+$/.test(payload)) {
    throw new Error(`Invalid PR directory name: ${dirName}`);
  }
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  const { key } = parsePrKey(decoded);
  if (encodePrKey(key) !== dirName) {
    throw new Error(`Non-canonical PR directory name: ${dirName}`);
  }
  return key;
}

export function resolveAppHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HOME_ENV];
  if (override !== undefined) {
    if (override.trim() === "") {
      throw new Error(`${HOME_ENV} must not be empty`);
    }
    return isAbsolute(override) ? resolve(override) : resolve(process.cwd(), override);
  }
  return join(homedir(), ".pr-babysitter");
}

export function appPaths(home = resolveAppHome()): AppPaths {
  const absoluteHome = resolve(home);
  return {
    home: absoluteHome,
    configFile: join(absoluteHome, "config.json"),
    ownerTokenFile: join(absoluteHome, "tmux-owner-token"),
    slotsDir: join(absoluteHome, "slots"),
    prsDir: join(absoluteHome, "prs"),
    reposDir: join(absoluteHome, "repos"),
    worktreesDir: join(absoluteHome, "worktrees"),
  };
}

export function repoRootPath(
  ownerInput: string,
  repoInput: string,
  app = appPaths(),
  hostInput = DEFAULT_GITHUB_HOST,
): string {
  const key = formatPrKey(ownerInput, repoInput, 1, hostInput);
  const repository = key.slice(0, key.lastIndexOf("#"));
  return join(app.reposDir, `repo-v1-${Buffer.from(repository, "utf8").toString("base64url")}`);
}

export function prPaths(input: string, app = appPaths()): PrPaths {
  const key = parsePrKey(input).key;
  const dirName = encodePrKey(key);
  const prDir = join(app.prsDir, dirName);
  return {
    dirName,
    prDir,
    stateFile: join(prDir, "state.json"),
    eventsFile: join(prDir, "events.jsonl"),
    controlDir: join(prDir, "control"),
    sessionsDir: join(prDir, "sessions"),
    runsDir: join(prDir, "runs"),
    worktreePath: join(app.worktreesDir, dirName),
  };
}

async function requirePrivateDirectory(path: string, recursive = false): Promise<void> {
  try {
    await mkdir(path, { recursive, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Refusing unsafe application directory: ${path}`);
  }
  await chmod(path, 0o700);
}

export async function ensureAppDirs(app = appPaths()): Promise<void> {
  await requirePrivateDirectory(app.home, true);
  await Promise.all([
    requirePrivateDirectory(app.slotsDir),
    requirePrivateDirectory(app.prsDir),
    requirePrivateDirectory(app.reposDir),
    requirePrivateDirectory(app.worktreesDir),
  ]);
}

export async function ensurePrDirs(paths: PrPaths): Promise<void> {
  await requirePrivateDirectory(paths.prDir);
  await Promise.all([
    requirePrivateDirectory(paths.controlDir),
    requirePrivateDirectory(paths.sessionsDir),
    requirePrivateDirectory(paths.runsDir),
  ]);
}

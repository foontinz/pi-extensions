import { execFile } from "node:child_process";

import { DEFAULT_GITHUB_HOST, formatPrKey, normalizeGithubHost, parsePrKey } from "./paths.ts";

export interface GhRunOptions {
  cwd?: string;
  signal?: AbortSignal;
  host?: string;
}

export interface GhRunResult {
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: readonly string[], options?: GhRunOptions) => Promise<GhRunResult>;

export class GhCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly rateLimited: boolean;
  readonly forbidden: boolean;

  constructor(args: readonly string[], message: string, options: { exitCode?: number | null; stderr?: string } = {}) {
    super(message);
    this.name = "GhCommandError";
    this.args = args;
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr ?? "";
    const diagnostic = `${message}\n${this.stderr}`;
    this.rateLimited = /rate.?limit|secondary rate limit/i.test(diagnostic);
    this.forbidden = /(?:HTTP\s*)?403\b/i.test(diagnostic);
  }
}

export const defaultGhRunner: GhRunner = async (args, options = {}) => {
  try {
    return await new Promise<GhRunResult>((resolve, reject) => {
      const execOptions: {
        encoding: "utf8";
        maxBuffer: number;
        cwd?: string;
        signal?: AbortSignal;
      } = { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 };
      if (options.cwd !== undefined) execOptions.cwd = options.cwd;
      if (options.signal !== undefined) execOptions.signal = options.signal;
      execFile("gh", [...args], execOptions, (error, stdout, stderr) => {
        if (error) {
          reject(
            new GhCommandError(args, stderr.trim() || error.message, {
              exitCode: typeof error.code === "number" ? error.code : null,
              stderr,
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  } catch (error) {
    if (error instanceof GhCommandError) throw error;
    throw new GhCommandError(args, (error as Error).message);
  }
};

export type PrRemoteState = "OPEN" | "CLOSED" | "MERGED";
export type MergeableState = "UNKNOWN" | "MERGEABLE" | "CONFLICTING";

export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
  key: string;
}

export interface PrView extends PrRef {
  url: string;
  title: string;
  state: PrRemoteState;
  isDraft: boolean;
  mergeable: MergeableState;
  mergeStateStatus: string;
  headRefName: string;
  headRefOid: string;
  headRepository: string;
  reviewDecision: string;
  statusCheckRollup: Array<Record<string, unknown>>;
}

export interface ApiComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  actor: string | null;
  raw: Record<string, unknown>;
}

export interface ApiReview {
  id: number;
  body: string;
  state: string;
  submittedAt: string | null;
  actor: string | null;
  raw: Record<string, unknown>;
}

export interface PollSnapshot {
  pr: PrView;
  issueComments: ApiComment[];
  reviewComments: ApiComment[];
  reviews: ApiReview[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return string(value, field);
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const text = string(value, field);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${field} must be a timestamp`);
  return text;
}

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON from ${context}: ${(error as Error).message}`);
  }
}

export function parsePrUrl(input: string): PrRef {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid pull request URL: ${input}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Expected an https://HOST/OWNER/REPO/pull/N URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull" || parts[0] === undefined || parts[1] === undefined || parts[3] === undefined) {
    throw new Error("Expected an https://HOST/OWNER/REPO/pull/N URL");
  }
  const host = normalizeGithubHost(url.host);
  const parsed = parsePrKey(`${host}/${parts[0]}/${parts[1]}#${parts[3]}`);
  return { host, owner: parsed.owner, repo: parsed.repo, number: parsed.number, key: parsed.key };
}

export function parsePrView(value: unknown, expected?: Partial<PrRef>): PrView {
  const item = record(value, "gh pr view");
  const number = positiveInteger(item.number, "gh pr view.number");
  const url = string(item.url, "gh pr view.url");
  const urlRef = parsePrUrl(url);
  if (urlRef.number !== number) throw new Error("gh pr view returned mismatched URL and number");
  if (expected?.number !== undefined && expected.number !== number) throw new Error("gh pr view returned an unexpected PR number");
  if (expected?.host !== undefined && normalizeGithubHost(expected.host) !== urlRef.host) {
    throw new Error("gh pr view returned an unexpected hostname");
  }
  if (expected?.owner !== undefined && expected.owner.toLowerCase() !== urlRef.owner) {
    throw new Error("gh pr view returned an unexpected owner");
  }
  if (expected?.repo !== undefined && expected.repo.toLowerCase() !== urlRef.repo) {
    throw new Error("gh pr view returned an unexpected repository");
  }

  const state = string(item.state, "gh pr view.state") as PrRemoteState;
  if (!(["OPEN", "CLOSED", "MERGED"] as const).includes(state)) throw new Error(`Unknown PR state: ${state}`);
  const mergeable = string(item.mergeable, "gh pr view.mergeable") as MergeableState;
  if (!(["UNKNOWN", "MERGEABLE", "CONFLICTING"] as const).includes(mergeable)) {
    throw new Error(`Unknown mergeable state: ${mergeable}`);
  }
  const checks = item.statusCheckRollup ?? [];
  if (!Array.isArray(checks) || !checks.every(isRecord)) throw new Error("gh pr view.statusCheckRollup must be an array");
  const headRepository = record(item.headRepository, "gh pr view.headRepository");
  const headNameWithOwner = resolveHeadNameWithOwner(headRepository, item.headRepositoryOwner, urlRef);
  const headRepositoryRef = parsePrKey(`${urlRef.host}/${headNameWithOwner}#1`);

  return {
    ...urlRef,
    url,
    title: string(item.title, "gh pr view.title"),
    state,
    isDraft: boolean(item.isDraft, "gh pr view.isDraft"),
    mergeable,
    mergeStateStatus: nullableString(item.mergeStateStatus, "gh pr view.mergeStateStatus") ?? "UNKNOWN",
    headRefName: string(item.headRefName, "gh pr view.headRefName"),
    headRefOid: string(item.headRefOid, "gh pr view.headRefOid"),
    headRepository: `${headRepositoryRef.owner}/${headRepositoryRef.repo}`,
    reviewDecision: nullableString(item.reviewDecision, "gh pr view.reviewDecision") ?? "",
    statusCheckRollup: checks,
  };
}

function resolveHeadNameWithOwner(
  headRepository: Record<string, unknown>,
  headRepositoryOwner: unknown,
  urlRef: PrRef,
): string {
  // Newer GitHub returns nameWithOwner directly.
  const direct = nullableString(headRepository.nameWithOwner, "gh pr view.headRepository.nameWithOwner");
  if (direct !== null) return direct;
  // Older GitHub Enterprise Server omits nameWithOwner. Reconstruct it from the
  // owner + name pair when available, otherwise fall back to the base repo.
  const name = nullableString(headRepository.name, "gh pr view.headRepository.name");
  const owner = isRecord(headRepositoryOwner)
    ? nullableString(headRepositoryOwner.login, "gh pr view.headRepositoryOwner.login")
    : null;
  if (name !== null && owner !== null) return `${owner}/${name}`;
  if (name !== null) return `${urlRef.owner}/${name}`;
  return `${urlRef.owner}/${urlRef.repo}`;
}

function parseComment(value: unknown, field: string): ApiComment {
  const item = record(value, field);
  const user = item.user === null || item.user === undefined ? null : record(item.user, `${field}.user`);
  return {
    id: positiveInteger(item.id, `${field}.id`),
    body: nullableString(item.body, `${field}.body`) ?? "",
    createdAt: timestamp(item.created_at, `${field}.created_at`),
    updatedAt: timestamp(item.updated_at, `${field}.updated_at`),
    actor: user === null ? null : nullableString(user.login, `${field}.user.login`),
    raw: item,
  };
}

function parseReview(value: unknown, field: string): ApiReview {
  const item = record(value, field);
  const user = item.user === null || item.user === undefined ? null : record(item.user, `${field}.user`);
  return {
    id: positiveInteger(item.id, `${field}.id`),
    body: nullableString(item.body, `${field}.body`) ?? "",
    state: string(item.state, `${field}.state`),
    submittedAt: item.submitted_at === null ? null : timestamp(item.submitted_at, `${field}.submitted_at`),
    actor: user === null ? null : nullableString(user.login, `${field}.user.login`),
    raw: item,
  };
}

function flattenPages(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} must return an array`);
  if (value.every(Array.isArray)) return value.flatMap((page) => page as unknown[]);
  return value;
}

const PR_VIEW_FIELDS = [
  "number",
  "url",
  "title",
  "state",
  "isDraft",
  "mergeable",
  "mergeStateStatus",
  "headRefName",
  "headRefOid",
  "headRepository",
  "headRepositoryOwner",
  "reviewDecision",
  "statusCheckRollup",
].join(",");

function repositorySelector(ref: Pick<PrRef, "host" | "owner" | "repo">): string {
  return `${ref.host}/${ref.owner}/${ref.repo}`;
}

function apiArguments(host: string, args: readonly string[]): string[] {
  return ["api", "--hostname", host, ...args];
}

export class GhClient {
  private readonly runner: GhRunner;

  constructor(runner: GhRunner = defaultGhRunner) {
    this.runner = runner;
  }

  private async runJson(args: readonly string[], options?: GhRunOptions): Promise<unknown> {
    let result: GhRunResult;
    try {
      result = await this.runner(args, options);
    } catch (error) {
      if (error instanceof GhCommandError) throw error;
      throw new GhCommandError(args, (error as Error).message);
    }
    return parseJson(result.stdout, `gh ${args.join(" ")}`);
  }

  async currentLogin(options: GhRunOptions = {}): Promise<string> {
    const host = normalizeGithubHost(options.host ?? DEFAULT_GITHUB_HOST);
    const value = record(await this.runJson(apiArguments(host, ["user"]), options), "gh api user");
    return string(value.login, "gh api user.login").toLowerCase();
  }

  async currentRepo(options?: GhRunOptions): Promise<{ host: string; owner: string; repo: string }> {
    const value = record(await this.runJson(["repo", "view", "--json", "nameWithOwner,url"], options), "gh repo view");
    const name = string(value.nameWithOwner, "gh repo view.nameWithOwner");
    const url = string(value.url, "gh repo view.url");
    let host: string;
    try {
      host = normalizeGithubHost(new URL(url).host);
    } catch {
      throw new Error("gh repo view.url must be a valid HTTPS repository URL");
    }
    const parsed = parsePrKey(`${host}/${name}#1`);
    return { host, owner: parsed.owner, repo: parsed.repo };
  }

  async prView(ref: PrRef, options?: GhRunOptions): Promise<PrView> {
    const value = await this.runJson(
      ["pr", "view", String(ref.number), "--repo", repositorySelector(ref), "--json", PR_VIEW_FIELDS],
      options,
    );
    return parsePrView(value, ref);
  }

  async resolvePr(input: string, options: GhRunOptions = {}): Promise<PrView> {
    const trimmed = input.trim();
    let ref: PrRef;
    if (/^https:\/\//i.test(trimmed)) {
      ref = parsePrUrl(trimmed);
    } else if (/^\d+$/.test(trimmed)) {
      const number = Number(trimmed);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid pull request number: ${trimmed}`);
      const repository = await this.currentRepo(options);
      const parsed = parsePrKey(`${repository.host}/${repository.owner}/${repository.repo}#${number}`);
      ref = { ...parsed };
    } else {
      const parsed = parsePrKey(trimmed);
      const legacyKey = trimmed.slice(0, trimmed.lastIndexOf("#")).split("/").length === 2;
      const host = legacyKey && options.host ? normalizeGithubHost(options.host) : parsed.host;
      const key = formatPrKey(parsed.owner, parsed.repo, parsed.number, host);
      ref = { host, owner: parsed.owner, repo: parsed.repo, number: parsed.number, key };
    }
    return this.prView(ref, options);
  }

  private async paged(endpoint: string, host: string, options?: GhRunOptions): Promise<unknown[]> {
    const value = await this.runJson(apiArguments(host, ["--paginate", "--slurp", endpoint]), options);
    return flattenPages(value, `gh api ${endpoint}`);
  }

  async issueComments(ref: PrRef, since: string | null, options?: GhRunOptions): Promise<ApiComment[]> {
    const query = since === null ? "" : `&since=${encodeURIComponent(since)}`;
    const endpoint = `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100${query}`;
    return (await this.paged(endpoint, ref.host, options)).map((item, index) => parseComment(item, `issue comments[${index}]`));
  }

  async reviewComments(ref: PrRef, since: string | null, options?: GhRunOptions): Promise<ApiComment[]> {
    const query = since === null ? "" : `&since=${encodeURIComponent(since)}`;
    const endpoint = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments?per_page=100${query}`;
    return (await this.paged(endpoint, ref.host, options)).map((item, index) => parseComment(item, `review comments[${index}]`));
  }

  async reviews(ref: PrRef, options?: GhRunOptions): Promise<ApiReview[]> {
    const endpoint = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`;
    return (await this.paged(endpoint, ref.host, options)).map((item, index) => parseReview(item, `reviews[${index}]`));
  }

  async pollSnapshot(ref: PrRef, cursors: { issueCommentsSince: string | null; reviewCommentsSince: string | null }, options?: GhRunOptions): Promise<PollSnapshot> {
    const [pr, issueComments, reviewComments, reviews] = await Promise.all([
      this.prView(ref, options),
      this.issueComments(ref, cursors.issueCommentsSince, options),
      this.reviewComments(ref, cursors.reviewCommentsSince, options),
      this.reviews(ref, options),
    ]);
    return { pr, issueComments, reviewComments, reviews };
  }

  async rateLimitResetAt(options: GhRunOptions = {}): Promise<Date | null> {
    const host = normalizeGithubHost(options.host ?? DEFAULT_GITHUB_HOST);
    const value = record(await this.runJson(apiArguments(host, ["rate_limit"]), options), "gh api rate_limit");
    const resources = record(value.resources, "gh api rate_limit.resources");
    const resets: number[] = [];
    for (const [name, candidate] of Object.entries(resources)) {
      if (!isRecord(candidate)) continue;
      const remaining = candidate.remaining;
      const reset = candidate.reset;
      if (remaining === 0 && typeof reset === "number" && Number.isSafeInteger(reset) && reset >= 0) {
        resets.push(reset);
      } else if (name === "core" && remaining === undefined && typeof reset === "number" && Number.isSafeInteger(reset)) {
        resets.push(reset);
      }
    }
    return resets.length === 0 ? null : new Date(Math.max(...resets) * 1_000);
  }
}

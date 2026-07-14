import { createHash } from "node:crypto";

import { type ApiComment, type ApiReview, type GhRunOptions, type PollSnapshot, type PrRef } from "./gh.ts";
import { type AppPaths, appPaths, parsePrKey } from "./paths.ts";
import {
  appendEventRecords,
  type EventRecord,
  type JsonValue,
  type PrState,
  savePrState,
} from "./state.ts";

const FAILED_CHECK_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
  "ERROR",
]);
const PASSED_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export type TerminalPrState = "CLOSED" | "MERGED";

export interface PollDiff {
  events: EventRecord[];
  cursors: PrState["cursors"];
  terminalState: TerminalPrState | null;
  initialized: boolean;
}

export interface PollOnceResult extends PollDiff {
  snapshot: PollSnapshot;
}

export interface SnapshotClient {
  pollSnapshot(ref: PrRef, cursors: Pick<PrState["cursors"], "issueCommentsSince" | "reviewCommentsSince">, options?: GhRunOptions): Promise<PollSnapshot>;
}

function json(value: unknown, field = "value"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => json(entry, `${field}[${index}]`));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, json(entry, `${field}.${key}`)]),
    );
  }
  throw new Error(`${field} is not JSON serializable`);
}

function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) throw new Error(`Invalid timestamp: ${value}`);
  return new Date(milliseconds).toISOString();
}

function bodySummary(body: string): string {
  const flattened = body.replace(/\s+/g, " ").trim();
  return flattened.length <= 180 ? flattened : `${flattened.slice(0, 177)}...`;
}

function ignored(actor: string | null, _body: string, ownLogin: string): boolean {
  // The reply marker is public and attacker-controlled. Only authenticated
  // authorship may suppress a comment; copied markers from others stay queued.
  return actor?.toLowerCase() === ownLogin.toLowerCase();
}

interface AdvancedComments {
  fresh: ApiComment[];
  since: string | null;
  idsAtSince: number[];
}

function advanceComments(
  comments: readonly ApiComment[],
  since: string | null,
  idsAtSince: readonly number[],
): AdvancedComments {
  const oldSince = since === null ? null : normalizeTimestamp(since);
  const oldMilliseconds = oldSince === null ? Number.NEGATIVE_INFINITY : Date.parse(oldSince);
  const seenAtCursor = new Set(idsAtSince);
  const ordered = [...comments].sort((left, right) => {
    const byTime = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
    return byTime === 0 ? left.id - right.id : byTime;
  });

  const fresh = ordered.filter((comment) => {
    const updated = Date.parse(comment.updatedAt);
    return updated > oldMilliseconds || (updated === oldMilliseconds && !seenAtCursor.has(comment.id));
  });

  let newestMilliseconds = oldMilliseconds;
  for (const comment of ordered) newestMilliseconds = Math.max(newestMilliseconds, Date.parse(comment.updatedAt));
  const ids = new Set<number>();
  if (newestMilliseconds === oldMilliseconds) {
    for (const id of idsAtSince) ids.add(id);
  }
  for (const comment of ordered) {
    if (Date.parse(comment.updatedAt) === newestMilliseconds) ids.add(comment.id);
  }

  return {
    fresh,
    since: Number.isFinite(newestMilliseconds) ? new Date(newestMilliseconds).toISOString() : null,
    idsAtSince: [...ids].sort((left, right) => left - right),
  }; 
}

interface NormalizedCheck {
  type: string;
  name: string;
  status: string;
  conclusion: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase() : "";
}

function normalizeChecks(checks: readonly Record<string, unknown>[]): NormalizedCheck[] {
  return checks
    .map((check) => ({
      type: typeof check.__typename === "string" ? check.__typename : "Unknown",
      name:
        typeof check.name === "string"
          ? check.name
          : typeof check.context === "string"
            ? check.context
            : "unknown",
      status: text(check.status ?? check.state),
      conclusion: text(check.conclusion ?? check.state),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function checksState(checks: readonly Record<string, unknown>[]): {
  hash: string | null;
  settled: boolean;
  failed: boolean;
} {
  if (checks.length === 0) return { hash: null, settled: false, failed: false };
  const normalized = normalizeChecks(checks);
  const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  let settled = true;
  let failed = false;

  for (const check of normalized) {
    if (check.type === "StatusContext" || check.status === check.conclusion) {
      if (["PENDING", "EXPECTED", ""].includes(check.conclusion)) settled = false;
      else if (FAILED_CHECK_CONCLUSIONS.has(check.conclusion)) failed = true;
      else if (!PASSED_CHECK_CONCLUSIONS.has(check.conclusion)) settled = false;
      continue;
    }
    if (check.status !== "COMPLETED" || check.conclusion === "") settled = false;
    else if (FAILED_CHECK_CONCLUSIONS.has(check.conclusion)) failed = true;
    else if (!PASSED_CHECK_CONCLUSIONS.has(check.conclusion)) settled = false;
  }
  return { hash, settled, failed };
}

function issueCommentEvent(comment: ApiComment): EventRecord {
  return {
    id: `comment:${comment.id}:${normalizeTimestamp(comment.updatedAt)}`,
    type: "comment",
    observedAt: normalizeTimestamp(comment.createdAt),
    actor: comment.actor,
    summary: `Issue comment${comment.actor ? ` by @${comment.actor}` : ""}: ${bodySummary(comment.body)}`,
    raw: json(comment.raw, "comment.raw"),
    runAttempts: 0,
  };
}

function reviewCommentEvent(comment: ApiComment): EventRecord {
  return {
    id: `review_comment:${comment.id}:${normalizeTimestamp(comment.updatedAt)}`,
    type: "review_comment",
    observedAt: normalizeTimestamp(comment.createdAt),
    actor: comment.actor,
    summary: `Review comment${comment.actor ? ` by @${comment.actor}` : ""}: ${bodySummary(comment.body)}`,
    raw: json(comment.raw, "reviewComment.raw"),
    runAttempts: 0,
  };
}

function reviewEvent(review: ApiReview, observedAt: string): EventRecord {
  return {
    id: `review:${review.id}`,
    type: "review",
    observedAt: review.submittedAt === null ? observedAt : normalizeTimestamp(review.submittedAt),
    actor: review.actor,
    summary: `Review ${review.state}${review.actor ? ` by @${review.actor}` : ""}${review.body ? `: ${bodySummary(review.body)}` : ""}`,
    raw: json(review.raw, "review.raw"),
    runAttempts: 0,
  };
}

function transitionEvent(
  id: string,
  type: "ci_failed" | "ci_passed" | "conflict",
  summary: string,
  observedAt: string,
  raw: unknown,
): EventRecord {
  return { id, type, observedAt, actor: null, summary, raw: json(raw, `${type}.raw`), runAttempts: 0 };
}

export function diffPollSnapshot(
  state: Pick<PrState, "cursors" | "pendingEvents" | "lastRun">,
  snapshot: PollSnapshot,
  ownLogin: string,
  observedAtInput = new Date().toISOString(),
): PollDiff {
  const observedAt = normalizeTimestamp(observedAtInput);
  const baseline = state.cursors.initializedAt === null;
  const issue = advanceComments(
    snapshot.issueComments,
    state.cursors.issueCommentsSince,
    state.cursors.issueCommentIdsAtSince,
  );
  const reviewComments = advanceComments(
    snapshot.reviewComments,
    state.cursors.reviewCommentsSince,
    state.cursors.reviewCommentIdsAtSince,
  );
  const previousReviewId = state.cursors.lastReviewId;
  const maximumReviewId = snapshot.reviews.reduce((maximum, review) => Math.max(maximum, review.id), previousReviewId ?? 0);
  const checks = checksState(snapshot.pr.statusCheckRollup);
  const headChanged = state.cursors.headOid !== null && state.cursors.headOid !== snapshot.pr.headRefOid;
  const terminalState = snapshot.pr.state === "OPEN" ? null : snapshot.pr.state;
  const events: EventRecord[] = [];

  if (!baseline && terminalState === null) {
    for (const comment of issue.fresh) {
      if (!ignored(comment.actor, comment.body, ownLogin)) events.push(issueCommentEvent(comment));
    }
    for (const comment of reviewComments.fresh) {
      if (!ignored(comment.actor, comment.body, ownLogin)) events.push(reviewCommentEvent(comment));
    }
    for (const review of snapshot.reviews) {
      if (previousReviewId !== null && review.id > previousReviewId && !ignored(review.actor, review.body, ownLogin)) {
        events.push(reviewEvent(review, observedAt));
      }
    }
    if (
      checks.settled &&
      checks.hash !== null &&
      (checks.hash !== state.cursors.checksHash || headChanged)
    ) {
      events.push(
        transitionEvent(
          `ci:${snapshot.pr.headRefOid}:${checks.hash}`,
          checks.failed ? "ci_failed" : "ci_passed",
          checks.failed ? "CI checks settled with failures" : "CI checks settled successfully",
          observedAt,
          snapshot.pr.statusCheckRollup,
        ),
      );
    }
    if (
      snapshot.pr.mergeable === "CONFLICTING" &&
      (state.cursors.mergeable !== "CONFLICTING" || headChanged)
    ) {
      events.push(
        transitionEvent(
          `conflict:${snapshot.pr.headRefOid}`,
          "conflict",
          "Pull request has merge conflicts",
          observedAt,
          { mergeable: snapshot.pr.mergeable, mergeStateStatus: snapshot.pr.mergeStateStatus, headOid: snapshot.pr.headRefOid },
        ),
      );
    }
  }

  const alreadyQueued = new Set([
    ...state.pendingEvents.map((event) => event.id),
    ...(state.lastRun?.eventIds ?? []),
  ]);
  const uniqueEvents = events.filter((event) => !alreadyQueued.has(event.id));
  const cursors: PrState["cursors"] = {
    initializedAt: state.cursors.initializedAt ?? observedAt,
    issueCommentsSince: issue.since,
    issueCommentIdsAtSince: issue.idsAtSince,
    reviewCommentsSince: reviewComments.since,
    reviewCommentIdsAtSince: reviewComments.idsAtSince,
    lastReviewId: maximumReviewId === 0 ? null : maximumReviewId,
    checksHash: checks.hash,
    mergeable: snapshot.pr.mergeable,
    headOid: snapshot.pr.headRefOid,
    prState: snapshot.pr.state,
  };

  return { events: uniqueEvents, cursors, terminalState, initialized: baseline };
}

export async function pollOnce(
  client: SnapshotClient,
  state: PrState,
  ownLogin: string,
  app: AppPaths = appPaths(),
  options: { observedAt?: Date; signal?: AbortSignal } = {},
): Promise<PollOnceResult> {
  const parsed = parsePrKey(state.key);
  const ref: PrRef = { host: parsed.host, owner: parsed.owner, repo: parsed.repo, number: parsed.number, key: parsed.key };
  const observedAt = (options.observedAt ?? new Date()).toISOString();
  const ghOptions: GhRunOptions = {};
  if (options.signal !== undefined) ghOptions.signal = options.signal;
  const snapshot = await client.pollSnapshot(ref, state.cursors, ghOptions);
  const diff = diffPollSnapshot(state, snapshot, ownLogin, observedAt);

  const nextState = structuredClone(state);
  nextState.cursors = diff.cursors;
  nextState.url = snapshot.pr.url;
  nextState.headRefName = snapshot.pr.headRefName;
  nextState.pendingEvents.push(...diff.events);
  nextState.consecutiveErrors = 0;
  nextState.lastError = null;
  nextState.status = "watching";

  // The event log is idempotent. Write it first, then atomically advance state;
  // an interrupted write can be retried without losing or duplicating an event.
  await appendEventRecords(nextState.key, diff.events, app);
  await savePrState(nextState, app);
  Object.assign(state, nextState);

  return { ...diff, snapshot };
}

export async function recordPollError(state: PrState, error: Error, app: AppPaths = appPaths()): Promise<void> {
  state.consecutiveErrors += 1;
  state.lastError = error.message;
  if (state.consecutiveErrors >= 5) state.status = "error";
  await savePrState(state, app);
}

export function backoffMilliseconds(baseIntervalSeconds: number, consecutiveErrors: number): number {
  const exponent = Math.max(0, consecutiveErrors - 1);
  return Math.min(15 * 60_000, baseIntervalSeconds * 1_000 * 2 ** exponent);
}

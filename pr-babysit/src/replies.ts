import type { ApiComment, GhRunOptions, PrRef } from "./gh.ts";
import { parsePrKey } from "./paths.ts";
import type { EventRecord } from "./state.ts";

export type ReplyTarget = { host: string } & (
  | { kind: "issue_comment"; eventId: string; sourceId: number; sourceUrl: string; endpoint: string }
  | { kind: "review_comment"; eventId: string; sourceId: number; endpoint: string }
  | { kind: "review"; eventId: string; sourceId: number; sourceUrl: string; endpoint: string }
);

export interface ReplyReceipt {
  eventId: string;
  replyId: number;
  kind: ReplyTarget["kind"];
}

export interface ReplyVerificationClient {
  currentLogin(options?: GhRunOptions): Promise<string>;
  issueComments(ref: PrRef, since: string | null, options?: GhRunOptions): Promise<ApiComment[]>;
  reviewComments(ref: PrRef, since: string | null, options?: GhRunOptions): Promise<ApiComment[]>;
}

function numericEventId(event: EventRecord, prefix: string): number {
  const match = new RegExp(`^${prefix}:(\\d+)(?::|$)`).exec(event.id);
  if (!match?.[1]) throw new Error(`Invalid ${event.type} event ID for reply routing`);
  return Number(match[1]);
}

export function requiredReplyTargets(key: string, events: readonly EventRecord[]): ReplyTarget[] {
  const parsed = parsePrKey(key);
  const repository = `repos/${parsed.owner}/${parsed.repo}`;
  const prUrl = `https://${parsed.host}/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;
  return events.flatMap((event): ReplyTarget[] => {
    if (event.type === "comment") {
      const sourceId = numericEventId(event, "comment");
      return [{
        host: parsed.host,
        kind: "issue_comment",
        eventId: event.id,
        sourceId,
        sourceUrl: `${prUrl}#issuecomment-${sourceId}`,
        endpoint: `${repository}/issues/${parsed.number}/comments`,
      }];
    }
    if (event.type === "review_comment") {
      const sourceId = numericEventId(event, "review_comment");
      return [{
        host: parsed.host,
        kind: "review_comment",
        eventId: event.id,
        sourceId,
        endpoint: `${repository}/pulls/${parsed.number}/comments/${sourceId}/replies`,
      }];
    }
    if (event.type === "review") {
      const sourceId = numericEventId(event, "review");
      return [{
        host: parsed.host,
        kind: "review",
        eventId: event.id,
        sourceId,
        sourceUrl: `${prUrl}#pullrequestreview-${sourceId}`,
        endpoint: `${repository}/issues/${parsed.number}/comments`,
      }];
    }
    return [];
  });
}

function rawReplyParent(comment: ApiComment): number | null {
  const value = comment.raw.in_reply_to_id;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function verifyReplySnapshot(
  key: string,
  events: readonly EventRecord[],
  runId: string,
  ownLogin: string,
  issueComments: readonly ApiComment[],
  reviewComments: readonly ApiComment[],
): ReplyReceipt[] {
  const targets = requiredReplyTargets(key, events);
  const marker = `<!-- pr-babysitter:run=${runId} -->`;
  const own = ownLogin.toLowerCase();
  const usedIssueReplies = new Set<number>();
  const usedReviewReplies = new Set<number>();
  const receipts: ReplyReceipt[] = [];
  const missing: string[] = [];

  for (const target of targets) {
    if (target.kind === "review_comment") {
      const reply = reviewComments.find((comment) =>
        !usedReviewReplies.has(comment.id) &&
        comment.actor?.toLowerCase() === own &&
        comment.body.includes(marker) &&
        rawReplyParent(comment) === target.sourceId
      );
      if (!reply) {
        missing.push(target.eventId);
        continue;
      }
      usedReviewReplies.add(reply.id);
      receipts.push({ eventId: target.eventId, replyId: reply.id, kind: target.kind });
      continue;
    }

    const attribution = target.kind === "review"
      ? `Reply to review ${target.sourceUrl}:`
      : `Reply to ${target.sourceUrl}:`;
    const reply = issueComments.find((comment) =>
      !usedIssueReplies.has(comment.id) &&
      comment.actor?.toLowerCase() === own &&
      comment.body.includes(marker) &&
      comment.body.startsWith(attribution)
    );
    if (!reply) {
      missing.push(target.eventId);
      continue;
    }
    usedIssueReplies.add(reply.id);
    receipts.push({ eventId: target.eventId, replyId: reply.id, kind: target.kind });
  }

  if (missing.length > 0) {
    throw new Error(`Agent did not post a separate verified reply for: ${missing.join(", ")}`);
  }
  return receipts;
}

export async function verifyRequiredReplies(
  client: ReplyVerificationClient,
  key: string,
  events: readonly EventRecord[],
  runId: string,
  options: GhRunOptions = {},
): Promise<ReplyReceipt[]> {
  const targets = requiredReplyTargets(key, events);
  if (targets.length === 0) return [];
  const parsed = parsePrKey(key);
  const ref: PrRef = { host: parsed.host, owner: parsed.owner, repo: parsed.repo, number: parsed.number, key: parsed.key };
  const ghOptions: GhRunOptions = { ...options, host: parsed.host };
  const ownLogin = await client.currentLogin(ghOptions);
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [issueComments, reviewComments] = await Promise.all([
      client.issueComments(ref, null, ghOptions),
      client.reviewComments(ref, null, ghOptions),
    ]);
    try {
      return verifyReplySnapshot(key, events, runId, ownLogin, issueComments, reviewComments);
    } catch (error) {
      lastError = error as Error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError ?? new Error("Unable to verify agent replies");
}

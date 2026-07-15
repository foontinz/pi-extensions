import assert from "node:assert/strict";
import test from "node:test";

import type { ApiComment } from "../src/gh.ts";
import { replyEventMarker, requiredReplyTargets, verifyReplySnapshot, verifyRequiredReplies } from "../src/replies.ts";
import type { EventRecord } from "../src/state.ts";

const runId = "00000000-0000-4000-8000-000000000001";
const marker = `<!-- pr-babysitter:run=${runId} -->`;

function event(id: string, type: EventRecord["type"], raw: Record<string, unknown> = {}): EventRecord {
  return {
    id,
    type,
    observedAt: "2026-01-01T00:00:00.000Z",
    actor: "reviewer",
    summary: "request",
    raw: raw as EventRecord["raw"],
    runAttempts: 0,
  };
}

function comment(id: number, body: string, actor = "owner", raw: Record<string, unknown> = {}): ApiComment {
  return {
    id,
    body,
    actor,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    raw: { id, ...raw },
  };
}

const events = [
  event("comment:11:2026-01-01T00:00:00.000Z", "comment"),
  event("comment:12:2026-01-01T00:00:00.000Z", "comment"),
  event("review_comment:21:2026-01-01T00:00:00.000Z", "review_comment"),
  event("review:31", "review", { body: "Please handle this." }),
];

test("reply verification requires a distinct authored response for every trusted target", () => {
  const issue = [
    comment(101, `Reply to https://github.com/owner/repo/pull/1#issuecomment-11: fixed ${marker}`),
    comment(102, `Reply to https://github.com/owner/repo/pull/1#issuecomment-12: explained ${marker}`),
    comment(103, `Reply to review https://github.com/owner/repo/pull/1#pullrequestreview-31: done ${marker}`),
  ];
  const review = [comment(201, `Threaded response ${marker}`, "owner", { in_reply_to_id: 21 })];
  const receipts = verifyReplySnapshot("owner/repo#1", events, runId, "OWNER", issue, review);
  assert.deepEqual(receipts.map((receipt) => [receipt.eventId, receipt.replyId]), [
    [events[0]?.id, 101],
    [events[1]?.id, 102],
    [events[2]?.id, 201],
    [events[3]?.id, 103],
  ]);
  assert.equal(requiredReplyTargets("owner/repo#1", events).length, 4);
});

test("nested review comments verify against the GitHub thread root parent", () => {
  const nested = event("review_comment:22:2026-01-01T00:00:00.000Z", "review_comment", { in_reply_to_id: 21 });
  const review = [comment(202, `Nested threaded response ${marker}`, "owner", { in_reply_to_id: 21 })];
  const receipts = verifyReplySnapshot("owner/repo#1", [nested], runId, "owner", [], review);
  assert.deepEqual(receipts, [{ eventId: nested.id, replyId: 202, kind: "review_comment" }]);
});

test("stable event markers let retries reuse already-posted replies without double-posting", () => {
  const retryRunId = "11111111-1111-4111-8111-111111111111";
  const targetEvent = events[0]!;
  const previousRunReply = comment(
    104,
    `Reply to https://github.com/owner/repo/pull/1#issuecomment-11: fixed ${replyEventMarker(targetEvent.id)} <!-- pr-babysitter:run=${retryRunId} -->`,
  );
  const receipts = verifyReplySnapshot("owner/repo#1", [targetEvent], runId, "owner", [previousRunReply], []);
  assert.deepEqual(receipts, [{ eventId: targetEvent.id, replyId: 104, kind: "issue_comment" }]);
});

test("blank review bodies do not require a global pull-request reply", () => {
  const blank = event("review:32", "review", { body: "  \n" });
  assert.deepEqual(requiredReplyTargets("owner/repo#1", [blank]), []);
});

test("Enterprise reply links and API verification preserve the explicit hostname", async () => {
  const enterpriseEvent = event("comment:11:2026-01-01T00:00:00.000Z", "comment");
  const target = requiredReplyTargets("ghe.example.test/owner/repo#1", [enterpriseEvent])[0];
  assert.equal(target?.kind, "issue_comment");
  assert.equal(target?.sourceUrl, "https://ghe.example.test/owner/repo/pull/1#issuecomment-11");
  const seenHosts: Array<string | undefined> = [];
  const body = `Reply to ${target?.sourceUrl}: fixed ${marker}`;
  const receipts = await verifyRequiredReplies({
    async currentLogin(options) { seenHosts.push(options?.host); return "owner"; },
    async issueComments(_ref, _since, options) { seenHosts.push(options?.host); return [comment(101, body)]; },
    async reviewComments(_ref, _since, options) { seenHosts.push(options?.host); return []; },
  }, "ghe.example.test/owner/repo#1", [enterpriseEvent], runId);
  assert.equal(receipts[0]?.replyId, 101);
  assert.deepEqual(seenHosts, ["ghe.example.test", "ghe.example.test", "ghe.example.test"]);
});

test("combined, external, missing, and top-level review replies do not satisfy routing", () => {
  const combined = comment(
    101,
    `Reply to https://github.com/owner/repo/pull/1#issuecomment-11 and https://github.com/owner/repo/pull/1#issuecomment-12 ${marker}`,
  );
  assert.throws(
    () => verifyReplySnapshot("owner/repo#1", events.slice(0, 2), runId, "owner", [combined], []),
    new RegExp(events[1]?.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "missing"),
  );
  assert.throws(
    () => verifyReplySnapshot("owner/repo#1", events.slice(0, 1), runId, "owner", [comment(102, `Reply to https://github.com/owner/repo/pull/1#issuecomment-11 ${marker}`, "attacker")], []),
    /did not post/,
  );
  assert.throws(
    () => verifyReplySnapshot("owner/repo#1", events.slice(2, 3), runId, "owner", [comment(103, `Top-level response ${marker}`)], []),
    /did not post/,
  );
});

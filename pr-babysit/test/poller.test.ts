import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { PollSnapshot } from "../src/gh.ts";
import { appPaths, prPaths } from "../src/paths.ts";
import {
  backoffMilliseconds,
  diffPollSnapshot,
  pollOnce,
  recordPollError,
  type SnapshotClient,
} from "../src/poller.ts";
import { createPrState, loadPrState, type PrState } from "../src/state.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function fixture(name: string): Promise<PollSnapshot> {
  return JSON.parse(await readFile(join(fixtures, `poller-${name}.json`), "utf8")) as PollSnapshot;
}

function apply(state: PrState, result: ReturnType<typeof diffPollSnapshot>): void {
  state.cursors = result.cursors;
  state.pendingEvents.push(...result.events);
}

test("baseline and repeated snapshots emit each external event exactly once", async () => {
  const state = createPrState({ key: "owner/repo#1" });
  const baseline = diffPollSnapshot(state, await fixture("baseline"), "foontinz", "2026-01-01T00:10:00Z");
  assert.equal(baseline.initialized, true);
  assert.deepEqual(baseline.events, []);
  assert.equal(baseline.cursors.lastReviewId, 10);
  apply(state, baseline);

  const changedSnapshot = await fixture("changes");
  const changed = diffPollSnapshot(state, changedSnapshot, "foontinz", "2026-01-01T00:15:00Z");
  assert.deepEqual(changed.events.map((event) => event.type), ["comment", "comment", "comment", "review_comment", "review"]);
  assert.deepEqual(changed.events.map((event) => event.actor), ["bob", "charlie", "dave", "erin", "frank"]);
  assert.deepEqual(changed.cursors.issueCommentIdsAtSince, [2, 3, 4, 5]);
  apply(state, changed);

  const repeated = diffPollSnapshot(state, changedSnapshot, "foontinz", "2026-01-01T00:16:00Z");
  assert.deepEqual(repeated.events, []);

  const sameTimestampArrival = structuredClone(changedSnapshot);
  sameTimestampArrival.issueComments.push({
    id: 6,
    body: "Late page item at the cursor timestamp",
    createdAt: "2026-01-01T00:11:00.000Z",
    updatedAt: "2026-01-01T00:11:00.000Z",
    actor: "gina",
    raw: { id: 6 },
  });
  const late = diffPollSnapshot(state, sameTimestampArrival, "foontinz", "2026-01-01T00:17:00Z");
  assert.deepEqual(late.events.map((event) => event.actor), ["gina"]);
  assert.deepEqual(late.cursors.issueCommentIdsAtSince, [2, 3, 4, 5, 6]);
});

test("tagging the owner login escalates directly instead of queueing agent work", async () => {
  const state = createPrState({ key: "owner/repo#1" });
  apply(state, diffPollSnapshot(state, await fixture("baseline"), "foontinz", "2026-01-01T00:10:00Z"));

  const snapshot = structuredClone(await fixture("changes"));
  snapshot.issueComments[1]!.body = "Please check this @foontinz";
  snapshot.issueComments[1]!.raw = { ...snapshot.issueComments[1]!.raw, html_url: "https://github.com/owner/repo/pull/1#issuecomment-2" };
  const diff = diffPollSnapshot(state, snapshot, "foontinz", "2026-01-01T00:15:00Z");

  assert.equal(diff.escalationRequests.length, 1);
  assert.equal(diff.escalationRequests[0]?.eventId, "comment:2:2026-01-01T00:11:00.000Z");
  assert.match(diff.escalationRequests[0]?.reason ?? "", /@foontinz was mentioned/);
  assert.deepEqual(diff.events.map((event) => event.actor), ["charlie", "dave", "erin", "frank"]);
});

test("pollOnce persists direct mention escalations without pending events", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-poller-mention-"));
  const app = appPaths(home);
  const state = createPrState({ key: "owner/repo#1" });
  const baseline = await fixture("baseline");
  const mention = structuredClone(baseline);
  mention.issueComments.push({
    id: 77,
    body: "Can you check this @foontinz?",
    createdAt: "2026-01-01T00:11:00.000Z",
    updatedAt: "2026-01-01T00:11:00.000Z",
    actor: "alice",
    raw: { id: 77, html_url: "https://github.com/owner/repo/pull/1#issuecomment-77" },
  });
  const snapshots = [baseline, mention];
  const client: SnapshotClient = {
    async pollSnapshot() {
      const next = snapshots.shift();
      if (!next) throw new Error("fixture exhausted");
      return next;
    },
  };

  await pollOnce(client, state, "foontinz", app, { observedAt: new Date("2026-01-01T00:10:00Z") });
  const result = await pollOnce(client, state, "foontinz", app, { observedAt: new Date("2026-01-01T00:12:00Z") });

  assert.deepEqual(result.events, []);
  assert.equal(result.createdEscalations.length, 1);
  const persisted = await loadPrState(state.key, app);
  assert.equal(persisted?.pendingEvents.length, 0);
  assert.equal(persisted?.escalations.length, 1);
  assert.match(persisted?.escalations[0]?.details ?? "", /issuecomment-77/);
});

test("empty review bodies do not emit redundant global review events", async () => {
  const state = createPrState({ key: "owner/repo#1" });
  apply(state, diffPollSnapshot(state, await fixture("baseline"), "foontinz", "2026-01-01T00:10:00Z"));

  const snapshot = structuredClone(await fixture("baseline"));
  snapshot.reviews.push({
    id: 11,
    body: "   \n",
    state: "COMMENTED",
    submittedAt: "2026-01-01T00:11:00.000Z",
    actor: "frank",
    raw: { id: 11, body: "   \n" },
  });
  const diff = diffPollSnapshot(state, snapshot, "foontinz", "2026-01-01T00:12:00Z");
  assert.deepEqual(diff.events, []);
  assert.equal(diff.cursors.lastReviewId, 11);
});

test("CI fires only after settlement, conflict flips once per head, and closure stops", async () => {
  const state = createPrState({ key: "owner/repo#1" });
  apply(state, diffPollSnapshot(state, await fixture("baseline"), "foontinz", "2026-01-01T00:10:00Z"));
  apply(state, diffPollSnapshot(state, await fixture("changes"), "foontinz", "2026-01-01T00:15:00Z"));

  const failed = diffPollSnapshot(state, await fixture("failed"), "foontinz", "2026-01-01T00:20:00Z");
  assert.deepEqual(failed.events.map((event) => event.type), ["ci_failed"]);
  apply(state, failed);
  assert.deepEqual(diffPollSnapshot(state, await fixture("failed"), "foontinz").events, []);

  const passedSnapshot = await fixture("passed");
  const passed = diffPollSnapshot(state, passedSnapshot, "foontinz", "2026-01-01T00:21:00Z");
  assert.deepEqual(passed.events.map((event) => event.type), ["ci_passed"]);
  apply(state, passed);

  const sameChecksNewHead = structuredClone(passedSnapshot);
  sameChecksNewHead.pr.headRefOid = "cccccccccccccccccccccccccccccccccccccccc";
  const newHead = diffPollSnapshot(state, sameChecksNewHead, "foontinz", "2026-01-01T00:21:30Z");
  assert.deepEqual(newHead.events.map((event) => event.type), ["ci_passed"]);
  apply(state, newHead);

  const conflictSnapshot = await fixture("conflict");
  const conflict = diffPollSnapshot(state, conflictSnapshot, "foontinz", "2026-01-01T00:22:00Z");
  assert.deepEqual(conflict.events.map((event) => event.type), ["conflict"]);
  apply(state, conflict);
  assert.deepEqual(diffPollSnapshot(state, conflictSnapshot, "foontinz").events, []);

  const closed = diffPollSnapshot(state, await fixture("closed"), "foontinz", "2026-01-01T00:30:00Z");
  assert.equal(closed.terminalState, "MERGED");
  assert.deepEqual(closed.events, []);
});

test("pollOnce persists cursors, pending events, and JSONL before returning", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-poller-"));
  const app = appPaths(home);
  const state = createPrState({ key: "owner/repo#1" });
  const snapshots = [await fixture("baseline"), await fixture("changes"), await fixture("changes")];
  const client: SnapshotClient = {
    async pollSnapshot() {
      const next = snapshots.shift();
      if (!next) throw new Error("fixture exhausted");
      return next;
    },
  };

  await pollOnce(client, state, "foontinz", app, { observedAt: new Date("2026-01-01T00:10:00Z") });
  const second = await pollOnce(client, state, "foontinz", app, { observedAt: new Date("2026-01-01T00:15:00Z") });
  assert.equal(second.events.length, 5);
  const persisted = await loadPrState(state.key, app);
  assert.equal(persisted?.pendingEvents.length, 5);
  const lines = (await readFile(prPaths(state.key, app).eventsFile, "utf8")).trim().split("\n");
  assert.equal(lines.length, 5);

  const third = await pollOnce(client, state, "foontinz", app, { observedAt: new Date("2026-01-01T00:16:00Z") });
  assert.equal(third.events.length, 0);
  assert.equal((await readFile(prPaths(state.key, app).eventsFile, "utf8")).trim().split("\n").length, 5);
});

test("empty baselines do not miss second-resolution arrivals and failed event-log writes retry safely", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-poller-retry-"));
  const app = appPaths(home);
  const state = createPrState({ key: "owner/repo#1" });
  const empty = structuredClone(await fixture("baseline"));
  empty.issueComments = [];
  empty.reviews = [];
  empty.pr.statusCheckRollup = [];
  const arrival = structuredClone(empty);
  arrival.issueComments = [{
    id: 77,
    body: "Arrived in the baseline timestamp second",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    actor: "alice",
    raw: { id: 77 },
  }];
  let snapshot = empty;
  const client: SnapshotClient = { async pollSnapshot() { return snapshot; } };

  await pollOnce(client, state, "foontinz", app, { observedAt: new Date("2026-01-01T00:00:00.500Z") });
  assert.equal(state.cursors.issueCommentsSince, null);
  snapshot = arrival;
  const eventPath = prPaths(state.key, app).eventsFile;
  await mkdir(eventPath);
  await assert.rejects(
    pollOnce(client, state, "foontinz", app, { observedAt: new Date("2026-01-01T00:01:00Z") }),
  );
  assert.equal(state.pendingEvents.length, 0);
  assert.equal((await loadPrState(state.key, app))?.pendingEvents.length, 0);

  await rm(eventPath, { recursive: true });
  const retry = await pollOnce(client, state, "foontinz", app, { observedAt: new Date("2026-01-01T00:02:00Z") });
  assert.deepEqual(retry.events.map((event) => event.id), ["comment:77:2026-01-01T00:00:00.000Z"]);
  assert.equal((await loadPrState(state.key, app))?.pendingEvents.length, 1);
  assert.equal((await readFile(eventPath, "utf8")).trim().split("\n").length, 1);
});

test("poll errors persist exponential backoff and enter error after five failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-poller-error-"));
  const app = appPaths(home);
  const state = createPrState({ key: "owner/repo#1" });
  for (let attempt = 0; attempt < 5; attempt += 1) await recordPollError(state, new Error("network down"), app);
  assert.equal(state.status, "error");
  assert.equal(state.consecutiveErrors, 5);
  assert.equal((await loadPrState(state.key, app))?.lastError, "network down");
  assert.equal(backoffMilliseconds(60, 1), 60_000);
  assert.equal(backoffMilliseconds(60, 5), 15 * 60_000);
  assert.equal(backoffMilliseconds(60, 50), 15 * 60_000);
});

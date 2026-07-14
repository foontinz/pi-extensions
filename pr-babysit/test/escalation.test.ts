import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acknowledgeEscalation, addEscalation, consumeEscalationFile, parseEscalationSentinel } from "../src/escalation.ts";
import { notifyEscalation } from "../src/notify.ts";
import { appPaths } from "../src/paths.ts";
import { createPrState, loadPrState, savePrState } from "../src/state.ts";

test("escalation file and fallback sentinel are strict and bounded", async () => {
  const control = await mkdtemp(join(tmpdir(), "pr-babysit-escalation-"));
  await writeFile(join(control, "escalation.json"), JSON.stringify({ reason: " Need help ", details: " Unsafe request " }));
  assert.deepEqual(await consumeEscalationFile(control), {
    reason: "Need help",
    details: "Unsafe request",
    source: "file",
  });
  assert.equal(parseEscalationSentinel("x [[BABYSIT_ESCALATE: Human decision needed]]")?.reason, "Human decision needed");
  assert.equal(parseEscalationSentinel("ordinary output"), null);

  const outside = await mkdtemp(join(tmpdir(), "pr-babysit-escalation-outside-"));
  const redirected = join(control, "redirected");
  await symlink(outside, redirected);
  await assert.rejects(consumeEscalationFile(redirected), /control directory/);
  await rm(redirected);
});

test("acknowledgement is durable and idempotent", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-ack-"));
  const app = appPaths(home);
  const state = createPrState({ key: "owner/repo#1" });
  const escalation = addEscalation(state, { reason: "Blocked", details: "Need approval" }, null);
  await savePrState(state, app);
  const watcherSnapshot = await loadPrState(state.key, app);
  const first = await acknowledgeEscalation(escalation.id, app);
  assert.equal(first.escalation.acknowledged, true);
  assert.equal((await acknowledgeEscalation(escalation.id, app)).escalation.acknowledged, true);
  assert.ok(watcherSnapshot);
  watcherSnapshot.status = "watching";
  await savePrState(watcherSnapshot, app);
  const persisted = await loadPrState(state.key, app);
  assert.equal(persisted?.status, "watching");
  assert.equal(persisted?.escalations[0]?.acknowledged, true);
});

test("macOS notifications use argv-safe AppleScript escaping", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const sent = await notifyEscalation('PR "title"', "line one\nline two", {
    platform: "darwin",
    runner: async (executable, args) => { calls.push({ executable, args: [...args] }); },
  });
  assert.equal(sent, true);
  assert.equal(calls[0]?.executable, "osascript");
  assert.deepEqual(calls[0]?.args.slice(0, 1), ["-e"]);
  assert.match(calls[0]?.args[1] ?? "", /PR \\"title\\"/);
  assert.doesNotMatch(calls[0]?.args[1] ?? "", /\n/);
  assert.equal(await notifyEscalation("title", "message", { platform: "linux" }), false);
});

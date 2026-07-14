import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appPaths, ensureAppDirs, prPaths } from "../src/paths.ts";
import {
  archivePrState,
  createPrState,
  listPrStates,
  loadPrState,
  parsePrState,
  savePrState,
  writeJsonAtomic,
} from "../src/state.ts";

test("initial state round-trips through strict atomic persistence", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-state-"));
  const app = appPaths(home);
  const state = createPrState({ key: "Owner/Repo#7" }, new Date("2026-01-02T03:04:05.000Z"));
  assert.equal(state.key, "owner/repo#7");
  assert.equal(state.status, "initializing");
  assert.equal(state.pendingEvents.length, 0);
  const enterprise = createPrState({ key: "GHE.Example.test/Owner/Repo#8" });
  assert.equal(enterprise.key, "ghe.example.test/owner/repo#8");
  assert.equal(enterprise.url, "https://ghe.example.test/owner/repo/pull/8");

  await savePrState(state, app);
  assert.deepEqual(await loadPrState(state.key, app), state);
  assert.equal((await stat(prPaths(state.key, app).stateFile)).mode & 0o777, 0o600);
  assert.equal((await listPrStates(app))[0]?.state?.key, state.key);
});

test("state rejects schema/key corruption instead of defaulting", async () => {
  const base = createPrState({ key: "owner/repo#1" });
  const legacy = structuredClone(base) as unknown as { cursors: Record<string, unknown> };
  delete legacy.cursors.initializedAt;
  delete legacy.cursors.issueCommentIdsAtSince;
  delete legacy.cursors.reviewCommentIdsAtSince;
  delete legacy.cursors.prState;
  assert.deepEqual(parsePrState(legacy).cursors.issueCommentIdsAtSince, []);
  assert.throws(() => parsePrState({ ...base, schemaVersion: 99 }), /Unsupported/);
  assert.throws(() => parsePrState(base, "owner/repo#2"), /does not match/);
  assert.throws(() => parsePrState({ ...base, consecutiveErrors: -1 }), /non-negative/);

  const home = await mkdtemp(join(tmpdir(), "pr-babysit-state-bad-"));
  const app = appPaths(home);
  const path = prPaths(base.key, app).stateFile;
  await writeJsonAtomic(path, { broken: true });
  await assert.rejects(loadPrState(base.key, app), /Invalid state/);
});

test("atomic replacement remains complete and unwatch archives history", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-state-atomic-"));
  const app = appPaths(home);
  const state = createPrState({ key: "owner/repo#9" });
  await savePrState(state, app);
  state.status = "watching";
  await savePrState(state, app);
  assert.equal(JSON.parse(await readFile(prPaths(state.key, app).stateFile, "utf8")).status, "watching");
  assert.deepEqual((await readdir(prPaths(state.key, app).prDir)).filter((name) => name.endsWith(".tmp")), []);

  const archive = await archivePrState(state.key, app);
  assert.ok(archive?.includes("state.unwatched."));
  assert.equal(parsePrState(JSON.parse(await readFile(archive!, "utf8"))).key, state.key);
  assert.equal(await loadPrState(state.key, app), undefined);
  await assert.rejects(writeJsonAtomic(join(home, "undefined.json"), undefined), /not JSON serializable/);
});

test("state listing refuses encoded PR directories that are symlinks", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-state-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "pr-babysit-state-outside-"));
  const app = appPaths(home);
  const state = createPrState({ key: "owner/repo#10" });
  await ensureAppDirs(app);
  await writeJsonAtomic(join(outside, "state.json"), state);
  await symlink(outside, prPaths(state.key, app).prDir);

  await assert.rejects(loadPrState(state.key, app), /unsafe PR state directory/);
  await assert.rejects(archivePrState(state.key, app), /unsafe PR state directory/);
  const listed = await listPrStates(app);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.state, undefined);
  assert.match(listed[0]?.error?.message ?? "", /not a real directory/);
});

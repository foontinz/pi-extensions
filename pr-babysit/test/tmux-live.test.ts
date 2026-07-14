import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { appPaths } from "../src/paths.ts";
import { ensurePrPane, isPaneLive, killPrPane, setPaneLabel } from "../src/tmux.ts";

const exec = promisify(execFile);
const enabled = process.env.PR_BABYSIT_LIVE_TMUX === "1";

test("isolated tmux server creates, reuses, tiles, labels, and safely kills an exact pane", { skip: !enabled }, async () => {
  const socket = `pr-babysit-test-${process.pid}-${Date.now()}`;
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-tmux-"));
  const app = appPaths(home);
  const env = { ...process.env, PR_BABYSIT_HOME: home, PR_BABYSIT_TMUX_SOCKET: socket };
  const launch = {
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: home,
    env: { PR_BABYSIT_HOME: home, PR_BABYSIT_TMUX_SOCKET: socket },
  };

  try {
    const first = await ensurePrPane("owner/repo#1", launch, null, app, env);
    assert.equal(first.disposition, "created");
    assert.equal(await isPaneLive(first.ref, "owner/repo#1", env), true);
    assert.equal(await setPaneLabel(first.ref, "owner/repo#1", "#1\u001b watching", env), true);

    const again = await ensurePrPane("owner/repo#1", launch, first.ref, app, env);
    assert.equal(again.disposition, "reused");
    assert.equal(again.ref.paneId, first.ref.paneId);

    const second = await ensurePrPane("owner/repo#2", launch, null, app, env);
    assert.notEqual(second.ref.paneId, first.ref.paneId);

    const concurrent = await Promise.all([
      ensurePrPane("owner/repo#3", launch, null, app, env),
      ensurePrPane("owner/repo#3", launch, null, app, env),
    ]);
    assert.equal(concurrent[0].ref.paneId, concurrent[1].ref.paneId);
    assert.deepEqual(new Set(concurrent.map((item) => item.disposition)), new Set(["created", "adopted"]));

    const panes = await exec("tmux", ["-L", socket, "list-panes", "-a", "-F", "#{pane_id} #{@pr_babysit_key}"]);
    assert.match(panes.stdout, /owner\/repo#1/);
    assert.match(panes.stdout, /owner\/repo#2/);

    const tampered = { ...first.ref, paneToken: "00000000-0000-0000-0000-000000000000" };
    assert.equal(await killPrPane(tampered, "owner/repo#1", env, app), "ownership-mismatch");
    assert.equal(await isPaneLive(first.ref, "owner/repo#1", env), true);

    assert.equal(await killPrPane(first.ref, "owner/repo#1", env, app), "killed");
    assert.equal(await isPaneLive(first.ref, "owner/repo#1", env), false);
    assert.equal(await isPaneLive(second.ref, "owner/repo#2", env), true);
  } finally {
    await exec("tmux", ["-L", socket, "kill-server"]).catch(() => undefined);
  }
});

test("tmux launch never interprets an executable as shell text", { skip: !enabled }, async () => {
  const socket = `pr-babysit-injection-${process.pid}-${Date.now()}`;
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-injection-"));
  const sentinel = join(home, "shell-injection-sentinel");
  const app = appPaths(home);
  const env = { ...process.env, PR_BABYSIT_HOME: home, PR_BABYSIT_TMUX_SOCKET: socket };

  try {
    await assert.rejects(
      ensurePrPane(
        "owner/repo#1",
        { executable: `/bin/true; /usr/bin/touch ${sentinel}`, args: [], cwd: home },
        null,
        app,
        env,
      ),
    );
    await assert.rejects(access(sentinel), { code: "ENOENT" });
  } finally {
    await exec("tmux", ["-L", socket, "kill-server"]).catch(() => undefined);
  }
});

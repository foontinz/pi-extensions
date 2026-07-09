import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";
import { __subagentsTest } from "../index.js";
import { __worktreeTest, cleanupWorktreeAsync, createWorktree, prepareWorktree } from "../workspace/create-worktree.js";

const execFile = promisify(execFileCallback);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.afterEach(() => {
  __worktreeTest.setCheckpointHook(undefined);
  __worktreeTest.setPreparationCleanup(undefined);
  __worktreeTest.setCreatedWorktreeCleanup(undefined);
});

test("worktree config normalizes postCopy", () => {
  assert.throws(
    () => __subagentsTest.normalizeWorktreeEnvConfig({ postCopy: [{ command: "   " }] }),
    /postCopy\.command must be a non-empty command/,
  );

  const normalized = __subagentsTest.normalizeWorktreeEnvConfig({
    copy: [{ from: "./src/../src", to: "snapshot/./src", optional: true }],
    exclude: ["./dist/**"],
    postCopy: [{ command: " npm install --ignore-scripts ", cwd: "./", timeoutMs: 1234, optional: true, env: { FOO: "secret" } }],
  });

  assert.deepEqual(normalized.copy, [{ from: "src", to: "snapshot/src", optional: true }]);
  assert.deepEqual(normalized.exclusions, ["dist/**"]);
  assert.equal(normalized.postCopy[0]?.command, "npm install --ignore-scripts");
  assert.equal(normalized.postCopy[0]?.cwd, ".");
  assert.equal(normalized.postCopy[0]?.timeoutMs, 1234);
  assert.equal(normalized.keepWorktree, "never");
});

test("postCopy environment is minimal plus explicit env", () => {
  const env = __subagentsTest.buildPostCopyEnv({ CUSTOM_KEY: "custom-value" });
  assert.equal(env.CUSTOM_KEY, "custom-value");
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

test("postCopy uses a portable non-login POSIX shell", () => {
  const invocation = __subagentsTest.getShellInvocation("echo portable");
  assert.equal(invocation.command, "/bin/sh");
  assert.deepEqual(invocation.args, ["-c", "echo portable"]);
});

test("worktree override false runs in-place even inside a git repo", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-off-test-"));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    await execFile("git", ["-C", repoRoot, "init"]);

    const prepared = await __subagentsTest.prepareWorktreeForSpawn(repoRoot, "agent_test", {} as any, false);
    assert.equal(prepared.cwd, repoRoot);
    assert.equal(prepared.worktree, undefined);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("worktree maps a symlink-aliased repo cwd into the child worktree", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-alias-test-"));
  let created: Awaited<ReturnType<typeof createWorktree>> | undefined;
  try {
    const repoRoot = path.join(temp, "repo");
    const nestedCwd = path.join(repoRoot, "nested");
    await fs.mkdir(nestedCwd, { recursive: true });
    await fs.writeFile(path.join(nestedCwd, "tracked.txt"), "tracked\n");
    await execFile("git", ["-C", repoRoot, "init"]);
    await execFile("git", ["-C", repoRoot, "add", "."]);
    await execFile("git", [
      "-C", repoRoot,
      "-c", "user.name=Subagents Test",
      "-c", "user.email=subagents@example.invalid",
      "commit", "-m", "initial",
    ]);

    const repoAlias = path.join(temp, "repo-alias");
    await fs.symlink(repoRoot, repoAlias, process.platform === "win32" ? "junction" : "dir");
    const aliasedCwd = path.join(repoAlias, "nested");

    const inPlace = await createWorktree(aliasedCwd, { worktreeOverride: false });
    assert.equal(inPlace.cwd, aliasedCwd);
    assert.equal(inPlace.worktree, undefined);
    await inPlace.dispose();

    created = await createWorktree(aliasedCwd, { worktreeOverride: true });
    const worktree = created.worktree;
    assert.ok(worktree);
    assert.equal(created.cwd, path.join(worktree.root, "nested"));
    assert.equal(worktree.originalRoot, await fs.realpath(repoRoot));
    assert.equal(worktree.originalCwd, aliasedCwd);
  } finally {
    try {
      if (created) await created.dispose();
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
});

test("worktree creation semaphore removes cancelled waiters without losing a slot", async () => {
  let entered = 0;
  let resolveAllEntered!: () => void;
  const allEntered = new Promise<void>((resolve) => { resolveAllEntered = resolve; });
  let releaseHolders!: () => void;
  const holdersReleased = new Promise<void>((resolve) => { releaseHolders = resolve; });
  const holders = Array.from({ length: __worktreeTest.maxCreations }, () =>
    __worktreeTest.withCreationSlot(async () => {
      entered += 1;
      if (entered === __worktreeTest.maxCreations) resolveAllEntered();
      await holdersReleased;
    }));
  await allEntered;

  const controller = new AbortController();
  let queuedActionRan = false;
  const queued = __worktreeTest.withCreationSlot(async () => { queuedActionRan = true; }, controller.signal);
  controller.abort(new Error("cancelled while queued"));
  await assert.rejects(queued, /cancelled while queued/);
  assert.equal(queuedActionRan, false);

  releaseHolders();
  await Promise.all(holders);
  await __worktreeTest.withCreationSlot(async () => {});
});

test("cancellation after git worktree add cleans partial worktree despite retention", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-cancel-test-"));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "tracked\n");
    await execFile("git", ["-C", repoRoot, "init"]);
    await execFile("git", ["-C", repoRoot, "add", "."]);
    await execFile("git", [
      "-C", repoRoot,
      "-c", "user.name=Subagents Test",
      "-c", "user.email=subagents@example.invalid",
      "commit", "-m", "initial",
    ]);

    const controller = new AbortController();
    __worktreeTest.setCheckpointHook((checkpoint) => {
      if (checkpoint === "git-add-complete") controller.abort(new Error("cancelled after add"));
    });
    await assert.rejects(
      prepareWorktree(repoRoot, { worktreeOverride: true, keepWorktree: "always", signal: controller.signal }),
      /cancelled after add/,
    );

    const listed = await execFile("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
    assert.equal((listed.stdout.match(/^worktree /gm) ?? []).length, 1);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("cleanup unlocks a worktree and verifies its Git registration is removed", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-locked-cleanup-test-"));
  let created: Awaited<ReturnType<typeof createWorktree>> | undefined;
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "tracked\n");
    await execFile("git", ["-C", repoRoot, "init"]);
    await execFile("git", ["-C", repoRoot, "add", "."]);
    await execFile("git", [
      "-C", repoRoot,
      "-c", "user.name=Subagents Test",
      "-c", "user.email=subagents@example.invalid",
      "commit", "-m", "initial",
    ]);

    created = await createWorktree(repoRoot, { worktreeOverride: true });
    assert.ok(created.worktree);
    await execFile("git", ["-C", repoRoot, "worktree", "lock", created.worktree.root]);
    await created.dispose();

    const listed = await execFile("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
    assert.equal(listed.stdout.includes(created.worktree.root), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("CreatedWorktree disposal retries cleanup after a transient failure", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-dispose-retry-test-"));
  let created: Awaited<ReturnType<typeof createWorktree>> | undefined;
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "tracked\n");
    await execFile("git", ["-C", repoRoot, "init"]);
    await execFile("git", ["-C", repoRoot, "add", "."]);
    await execFile("git", [
      "-C", repoRoot,
      "-c", "user.name=Subagents Test",
      "-c", "user.email=subagents@example.invalid",
      "commit", "-m", "initial",
    ]);

    created = await createWorktree(repoRoot, { worktreeOverride: true });
    assert.ok(created.worktree);
    let cleanupAttempts = 0;
    __worktreeTest.setCreatedWorktreeCleanup(async (worktree) => {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error("transient cleanup failure");
      await cleanupWorktreeAsync(worktree);
    });

    await assert.rejects(created.dispose(), /transient cleanup failure/);
    assert.equal(cleanupAttempts, 1);
    await created.dispose();
    assert.equal(cleanupAttempts, 2);

    const listed = await execFile("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
    assert.equal(listed.stdout.includes(created.worktree.root), false);
    created = undefined;
  } finally {
    __worktreeTest.setCreatedWorktreeCleanup(undefined);
    if (created) await created.dispose().catch(() => {});
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("cleanup rejects when prune succeeds but a locked stale registration remains", { skip: process.platform === "win32" }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-stale-cleanup-test-"));
  let worktree: NonNullable<Awaited<ReturnType<typeof createWorktree>>["worktree"]> | undefined;
  let adminDir: string | undefined;
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "tracked\n");
    await execFile("git", ["-C", repoRoot, "init"]);
    await execFile("git", ["-C", repoRoot, "add", "."]);
    await execFile("git", [
      "-C", repoRoot,
      "-c", "user.name=Subagents Test",
      "-c", "user.email=subagents@example.invalid",
      "commit", "-m", "initial",
    ]);

    const created = await createWorktree(repoRoot, { worktreeOverride: true });
    assert.ok(created.worktree);
    worktree = created.worktree;
    await execFile("git", ["-C", repoRoot, "worktree", "lock", worktree.root]);
    const adminEntries = await fs.readdir(path.join(repoRoot, ".git", "worktrees"));
    assert.equal(adminEntries.length, 1);
    adminDir = path.join(repoRoot, ".git", "worktrees", adminEntries[0]!);
    await fs.chmod(adminDir, 0o555);

    await assert.rejects(cleanupWorktreeAsync(worktree), /worktree registration still exists/);
    const stillListed = await execFile("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
    assert.equal(stillListed.stdout.includes(worktree.root), true);

    // Restoring the administrative directory makes the same cleanup retryable.
    await fs.chmod(adminDir, 0o755);
    await cleanupWorktreeAsync(worktree);
    const afterRetry = await execFile("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
    assert.equal(afterRetry.stdout.includes(worktree.root), false);
    worktree = undefined;
  } finally {
    if (adminDir) await fs.chmod(adminDir, 0o755).catch(() => {});
    if (worktree) await cleanupWorktreeAsync(worktree).catch(() => {});
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("regular-file copy aborts between chunks instead of waiting for the whole file", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-copy-cancel-test-"));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, ".pi"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "tracked\n");
    await fs.writeFile(path.join(repoRoot, "large.bin"), Buffer.alloc(2 * 1024 * 1024, 0x61));
    await fs.writeFile(path.join(repoRoot, ".pi", "worktree.json"), JSON.stringify({ copy: ["large.bin"] }));
    await execFile("git", ["-C", repoRoot, "init"]);
    await execFile("git", ["-C", repoRoot, "add", "tracked.txt"]);
    await execFile("git", [
      "-C", repoRoot,
      "-c", "user.name=Subagents Test",
      "-c", "user.email=subagents@example.invalid",
      "commit", "-m", "initial",
    ]);

    const controller = new AbortController();
    __worktreeTest.setCheckpointHook((checkpoint) => {
      if (checkpoint === "copy-file-chunk:large.bin") controller.abort(new Error("cancelled during file copy"));
    });
    await assert.rejects(
      prepareWorktree(repoRoot, { worktreeOverride: true, signal: controller.signal }),
      /cancelled during file copy/,
    );

    const listed = await execFile("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
    assert.equal((listed.stdout.match(/^worktree /gm) ?? []).length, 1);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("regular-file copy preserves executable mode and timestamps", { skip: process.platform === "win32" }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-copy-metadata-test-"));
  let created: Awaited<ReturnType<typeof createWorktree>> | undefined;
  try {
    const repoRoot = path.join(temp, "repo");
    const source = path.join(repoRoot, "script.sh");
    const sourceTime = new Date("2020-01-02T03:04:05.000Z");
    await fs.mkdir(path.join(repoRoot, ".pi"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "tracked\n");
    await fs.writeFile(source, "#!/bin/sh\necho copied\n");
    await fs.chmod(source, 0o751);
    await fs.utimes(source, sourceTime, sourceTime);
    await fs.writeFile(path.join(repoRoot, ".pi", "worktree.json"), JSON.stringify({ copy: ["script.sh"] }));
    await execFile("git", ["-C", repoRoot, "init"]);
    await execFile("git", ["-C", repoRoot, "add", "tracked.txt"]);
    await execFile("git", [
      "-C", repoRoot,
      "-c", "user.name=Subagents Test",
      "-c", "user.email=subagents@example.invalid",
      "commit", "-m", "initial",
    ]);

    created = await createWorktree(repoRoot, { worktreeOverride: true });
    const copied = await fs.stat(path.join(created.cwd, "script.sh"));
    assert.equal(copied.mode & 0o777, 0o751);
    assert.ok(Math.abs(copied.mtimeMs - sourceTime.getTime()) < 1_000);
  } finally {
    try {
      if (created) await created.dispose();
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
});

test("postCopy cancellation kills POSIX shell descendants", { skip: process.platform === "win32" }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-postcopy-cancel-test-"));
  try {
    const repoRoot = path.join(temp, "repo");
    const marker = path.join(temp, "descendant-survived");
    const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "leaked"), 500)`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childCode)} & wait`;
    await fs.mkdir(path.join(repoRoot, ".pi"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "tracked\n");
    await fs.writeFile(path.join(repoRoot, ".pi", "worktree.json"), JSON.stringify({ postCopy: [{ command }] }));
    await execFile("git", ["-C", repoRoot, "init"]);
    await execFile("git", ["-C", repoRoot, "add", "tracked.txt"]);
    await execFile("git", [
      "-C", repoRoot,
      "-c", "user.name=Subagents Test",
      "-c", "user.email=subagents@example.invalid",
      "commit", "-m", "initial",
    ]);

    const controller = new AbortController();
    __worktreeTest.setCheckpointHook((checkpoint) => {
      if (checkpoint.startsWith("postCopy:")) {
        setTimeout(() => controller.abort(new Error("cancelled postCopy")), 100);
      }
    });
    await assert.rejects(
      prepareWorktree(repoRoot, { worktreeOverride: true, signal: controller.signal }),
      /cancelled postCopy/,
    );
    await delay(650);
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("worktree override true requires a git repo", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-required-test-"));
  try {
    await assert.rejects(
      __subagentsTest.prepareWorktreeForSpawn(temp, "agent_test", {} as any, true),
      /worktree isolation \(worktree:true\) requires a git repository/,
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("auto worktree mode warns and runs in-place when git detection errors", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-git-error-test-"));
  const invalidCwd = path.join(temp, "missing");
  try {
    const gitRoot = await __subagentsTest.getGitRootDetailed(invalidCwd);
    assert.equal(gitRoot.ok, false);
    assert.equal(gitRoot.kind, "invalid-cwd");

    const prepared = await __subagentsTest.prepareWorktreeForSpawn(invalidCwd, "agent_test", {} as any, undefined);
    assert.equal(prepared.cwd, invalidCwd);
    assert.match(prepared.warning ?? "", /git worktree isolation skipped/);

    await assert.rejects(
      __subagentsTest.prepareWorktreeForSpawn(invalidCwd, "agent_test", {} as any, true),
      /could not verify git repository for worktree isolation/,
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("worktree config ignores keepWorktree from .pi/worktree.json", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-json-test-"));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, ".pi"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".pi", "worktree.env"), JSON.stringify({ enabled: false }));
    await fs.writeFile(path.join(repoRoot, ".pi", "worktree.json"), JSON.stringify({ copy: ["README.md"], keepWorktree: "onFailure" }));

    const config = await __subagentsTest.readWorktreeConfig(repoRoot);
    assert.deepEqual(config.copy, [{ from: "README.md", optional: false }]);
    assert.equal(config.keepWorktree, "never");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("outbound copy symlinks are rejected", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-symlink-test-"));
  try {
    const repoRoot = path.join(temp, "repo");
    const outside = path.join(temp, "outside.txt");
    await fs.mkdir(repoRoot);
    await fs.writeFile(outside, "outside");
    const linkPath = path.join(repoRoot, "leak");
    await fs.symlink(outside, linkPath);

    await assert.rejects(
      __subagentsTest.assertSymlinkTargetInsideRepo(repoRoot, linkPath, "leak"),
      /refusing to copy symlink leak/,
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("symlinks into .git metadata are rejected", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-gitlink-test-"));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".git", "config"), "[core]\n");
    const linkPath = path.join(repoRoot, "git-config-link");
    await fs.symlink(path.join(repoRoot, ".git", "config"), linkPath);

    await assert.rejects(
      __subagentsTest.assertSymlinkTargetInsideRepo(repoRoot, linkPath, "git-config-link"),
      /target resolves into \.git metadata/,
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { __subagentsTest } from "../index.js";

test("worktree config normalizes postCopy before prompting", () => {
  assert.throws(
    () => __subagentsTest.normalizeWorktreeEnvConfig({ postCopy: [{ command: "   " }] }),
    /postCopy\.command must be a non-empty command/,
  );

  const normalized = __subagentsTest.normalizeWorktreeEnvConfig({
    copy: [{ from: "./src/../src", to: "snapshot/./src", optional: true }],
    exclude: ["./dist/**"],
    postCopy: [{ command: " npm install --ignore-scripts ", cwd: "./", timeoutMs: 1234, optional: true, env: { FOO: "secret" } }],
    keepWorktree: "onFailure",
  });

  assert.deepEqual(normalized.copy, [{ from: "src", to: "snapshot/src", optional: true }]);
  assert.deepEqual(normalized.exclusions, ["dist/**"]);
  assert.equal(normalized.postCopy[0]?.command, "npm install --ignore-scripts");
  assert.equal(normalized.postCopy[0]?.cwd, ".");
  assert.equal(normalized.postCopy[0]?.timeoutMs, 1234);
  assert.equal(normalized.keepWorktree, "onFailure");
});

test("postCopy confirmation shows normalized metadata but hides env values", () => {
  const details = __subagentsTest.formatPostCopyConfirmationDetails("/repo/.pi/worktree.env", [
    { command: "npm install", cwd: ".", timeoutMs: 120_000, optional: false, env: { NPM_TOKEN: "super-secret" } },
  ]);

  assert.match(details, /command: npm install/);
  assert.match(details, /cwd: \./);
  assert.match(details, /timeoutMs: 120000/);
  assert.match(details, /optional: false/);
  assert.match(details, /env keys: NPM_TOKEN/);
  assert.doesNotMatch(details, /super-secret/);
  assert.match(details, /minimal inherited environment/);
});

test("postCopy environment is minimal plus explicit env", () => {
  const env = __subagentsTest.buildPostCopyEnv({ CUSTOM_KEY: "custom-value" });
  assert.equal(env.CUSTOM_KEY, "custom-value");
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
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

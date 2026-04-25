import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";
import { __subagentsTest } from "../index.js";

const execFile = promisify(execFileCallback);

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
  const details = __subagentsTest.formatPostCopyConfirmationDetails("/repo/.pi/worktree.json", [
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

test("worktree override true requires a git repo", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-required-test-"));
  try {
    await assert.rejects(
      __subagentsTest.prepareWorktreeForSpawn(temp, "agent_test", {} as any, true),
      /worktree:true requires cwd to be inside a git repository/,
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

test("worktree config is read from .pi/worktree.json only", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-worktree-json-test-"));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, ".pi"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".pi", "worktree.env"), JSON.stringify({ enabled: false }));
    await fs.writeFile(path.join(repoRoot, ".pi", "worktree.json"), JSON.stringify({ copy: ["README.md"], keepWorktree: "onFailure" }));

    const config = await __subagentsTest.readWorktreeConfig(repoRoot);
    assert.deepEqual(config.copy, [{ from: "README.md", optional: false }]);
    assert.equal(config.keepWorktree, "onFailure");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("postCopy trust is remembered for the same repo and exact normalized scripts", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-postcopy-trust-test-"));
  const previousStore = process.env.PI_SUBAGENTS_POSTCOPY_TRUST_STORE;
  process.env.PI_SUBAGENTS_POSTCOPY_TRUST_STORE = path.join(temp, "trust.json");
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(repoRoot);
    const scripts = [
      { command: "npm install --ignore-scripts", cwd: ".", timeoutMs: 120_000, optional: false, env: { B: "2", A: "1" } },
    ];

    const before = await __subagentsTest.getPostCopyTrust(repoRoot, scripts);
    assert.equal(before.trusted, false);

    await __subagentsTest.rememberPostCopyTrust(before);

    const after = await __subagentsTest.getPostCopyTrust(repoRoot, [
      { command: "npm install --ignore-scripts", cwd: ".", timeoutMs: 120_000, optional: false, env: { A: "1", B: "2" } },
    ]);
    assert.equal(after.trusted, true);

    const changed = await __subagentsTest.getPostCopyTrust(repoRoot, [
      { command: "npm install", cwd: ".", timeoutMs: 120_000, optional: false, env: { A: "1", B: "2" } },
    ]);
    assert.equal(changed.trusted, false);
  } finally {
    if (previousStore === undefined) delete process.env.PI_SUBAGENTS_POSTCOPY_TRUST_STORE;
    else process.env.PI_SUBAGENTS_POSTCOPY_TRUST_STORE = previousStore;
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

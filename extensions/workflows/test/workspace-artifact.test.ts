import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WorkspaceArtifactStore } from "../workspace/artifact-store.js";
import type { ProvisionedWorktreeResult } from "../workspace/types.js";

const execFile = promisify(execFileCallback);

interface Fixture {
  temp: string;
  repo: string;
  provisioned: ProvisionedWorktreeResult;
  store: WorkspaceArtifactStore;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFile("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
}

async function fixture(): Promise<Fixture> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-artifact-test-"));
  const repo = path.join(temp, "repo");
  await fs.mkdir(repo);
  await git(repo, "init", "--initial-branch=main");
  await git(repo, "config", "user.name", "Workspace Test");
  await git(repo, "config", "user.email", "workspace@example.invalid");
  await fs.writeFile(path.join(repo, "staged.txt"), "base staged\n");
  await fs.writeFile(path.join(repo, "unstaged.txt"), "base unstaged\n");
  await fs.writeFile(path.join(repo, "delete.txt"), "delete me\n");
  await fs.writeFile(path.join(repo, "rename.txt"), "rename me\n");
  await fs.writeFile(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3, 4]));
  await fs.writeFile(path.join(repo, "conflict.txt"), "common\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");

  const tempParent = path.join(temp, "provisioned");
  const root = path.join(tempParent, "worktree");
  await fs.mkdir(tempParent);
  await git(repo, "worktree", "add", "--detach", root, "HEAD");
  return {
    temp,
    repo,
    provisioned: {
      cwd: root,
      worktree: { root, tempParent, originalRoot: repo, originalCwd: repo, base: "HEAD" },
    },
    store: new WorkspaceArtifactStore(path.join(temp, "artifact-store"), { gitTimeoutMs: 20_000 }),
  };
}

async function removeFixture(value: Fixture): Promise<void> {
  await fs.rm(value.temp, { recursive: true, force: true });
}

test("clean workspace is durably captured and release is idempotent", async () => {
  const value = await fixture();
  try {
    const lease = await value.store.register(value.provisioned);
    assert.match(lease.id, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(lease.state, "active");
    assert.ok(lease.baseline?.bundleSha256);

    const artifact = await value.store.release(lease.id);
    assert.ok(artifact);
    assert.equal(artifact.manifest.files["full.patch"].bytes, 0);
    assert.equal((await value.store.getLease(lease.id)).state, "cleaned");
    await assert.rejects(fs.access(value.provisioned.worktree!.root), { code: "ENOENT" });

    const repeated = await value.store.release(lease.id);
    assert.equal(repeated?.id, artifact.id);
  } finally {
    await removeFixture(value);
  }
});

test("captures and reapplies staged, unstaged, untracked, binary, delete, rename, mode and symlink changes", { skip: process.platform === "win32" }, async () => {
  const value = await fixture();
  let integration: Awaited<ReturnType<WorkspaceArtifactStore["apply"]>> | undefined;
  try {
    const lease = await value.store.register(value.provisioned);
    const root = value.provisioned.worktree!.root;
    await fs.writeFile(path.join(root, "staged.txt"), "staged result\n");
    await git(root, "add", "staged.txt");
    await fs.writeFile(path.join(root, "unstaged.txt"), "unstaged result\n");
    await fs.writeFile(path.join(root, "new file.txt"), "untracked\n");
    await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 255, 9, 0, 8, 7]));
    await fs.rm(path.join(root, "delete.txt"));
    await git(root, "mv", "rename.txt", "renamed.txt");
    await fs.writeFile(path.join(root, "executable.sh"), "#!/bin/sh\necho ok\n");
    await fs.chmod(path.join(root, "executable.sh"), 0o755);
    await fs.symlink("unstaged.txt", path.join(root, "result-link"));

    const artifact = await value.store.capture(lease.id);
    assert.match(await fs.readFile(path.join(artifact.directory, "full.patch"), "utf8"), /GIT binary patch/);
    assert.ok(artifact.manifest.status.some((entry) => entry.status.startsWith("R") && entry.path === "renamed.txt"));
    assert.ok(artifact.manifest.originalStatus.some((entry) => entry.status === "??" && entry.path === "new file.txt"));
    assert.equal((await value.store.getLease(lease.id)).state, "captured");

    integration = await value.store.apply(artifact.id, value.repo);
    assert.equal(integration.state, "applied");
    assert.equal(await fs.readFile(path.join(integration.root, "staged.txt"), "utf8"), "staged result\n");
    assert.equal(await fs.readFile(path.join(integration.root, "unstaged.txt"), "utf8"), "unstaged result\n");
    assert.equal(await fs.readFile(path.join(integration.root, "new file.txt"), "utf8"), "untracked\n");
    assert.deepEqual(await fs.readFile(path.join(integration.root, "binary.bin")), Buffer.from([0, 255, 9, 0, 8, 7]));
    await assert.rejects(fs.access(path.join(integration.root, "delete.txt")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(integration.root, "renamed.txt"), "utf8"), "rename me\n");
    assert.equal((await fs.stat(path.join(integration.root, "executable.sh"))).mode & 0o111, 0o111);
    assert.equal(await fs.readlink(path.join(integration.root, "result-link")), "unstaged.txt");

    await value.store.releaseApplied(integration.integrationId);
    integration = undefined;
    await value.store.release(lease.id);
    assert.equal((await value.store.getLease(lease.id)).state, "cleaned");
  } finally {
    if (integration) await value.store.releaseApplied(integration.integrationId).catch(() => {});
    await removeFixture(value);
  }
});

test("tampered artifact prevents cleanup and leaves workspace recoverable", async () => {
  const value = await fixture();
  try {
    const lease = await value.store.register(value.provisioned);
    await fs.writeFile(path.join(value.provisioned.worktree!.root, "unstaged.txt"), "important result\n");
    const artifact = await value.store.capture(lease.id);
    await fs.appendFile(path.join(artifact.directory, "full.patch"), "tampered\n");

    await assert.rejects(value.store.release(lease.id), /hash verification/);
    assert.equal((await value.store.getLease(lease.id)).state, "recovery_required");
    assert.equal(await fs.readFile(path.join(value.provisioned.worktree!.root, "unstaged.txt"), "utf8"), "important result\n");

    const discarded = await value.store.discard(lease.id);
    assert.equal(discarded.state, "discarded");
    await assert.rejects(fs.access(value.provisioned.worktree!.root), { code: "ENOENT" });
    assert.equal((await value.store.discard(lease.id)).state, "discarded");
  } finally {
    await removeFixture(value);
  }
});

test("release refuses to delete changes made after artifact capture", async () => {
  const value = await fixture();
  try {
    const lease = await value.store.register(value.provisioned);
    const file = path.join(value.provisioned.worktree!.root, "unstaged.txt");
    await fs.writeFile(file, "captured version\n");
    await value.store.capture(lease.id);
    await fs.writeFile(file, "later important version\n");
    await assert.rejects(value.store.release(lease.id), /changed after artifact capture/);
    assert.equal((await value.store.getLease(lease.id)).state, "recovery_required");
    assert.equal(await fs.readFile(file, "utf8"), "later important version\n");
  } finally { await removeFixture(value); }
});

test("untracked nested repositories are retained as unsupported instead of silently captured", async () => {
  const value = await fixture();
  try {
    const lease = await value.store.register(value.provisioned);
    const nested = path.join(value.provisioned.worktree!.root, "nested");
    await fs.mkdir(nested);
    await git(nested, "init");
    await fs.writeFile(path.join(nested, "important.txt"), "important\n");
    await assert.rejects(value.store.capture(lease.id), /nested repository.*unsupported/i);
    assert.equal((await value.store.getLease(lease.id)).state, "retained");
    assert.equal(await fs.readFile(path.join(nested, "important.txt"), "utf8"), "important\n");
  } finally { await removeFixture(value); }
});

test("integration release uses opaque durable IDs and owner checks", async () => {
  const value = await fixture();
  try {
    const lease = await value.store.register(value.provisioned);
    await fs.writeFile(path.join(value.provisioned.worktree!.root, "unstaged.txt"), "change\n");
    const artifact = await value.store.capture(lease.id);
    const integration = await value.store.apply(artifact.id, value.repo, "HEAD", "owner-a");
    await assert.rejects(value.store.releaseApplied(integration.integrationId, "owner-b"), /another owner/);
    assert.equal((await fs.stat(integration.root)).isDirectory(), true);
    await value.store.releaseApplied(integration.integrationId, "owner-a");
    await value.store.releaseApplied(integration.integrationId, "owner-a");
    await assert.rejects(value.store.releaseApplied("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "owner-a"), /ENOENT|no such file/i);
  } finally { await removeFixture(value); }
});

test("three-way apply retains a fresh integration worktree on conflict", async () => {
  const value = await fixture();
  let integration: Awaited<ReturnType<WorkspaceArtifactStore["apply"]>> | undefined;
  try {
    const lease = await value.store.register(value.provisioned);
    await fs.writeFile(path.join(value.provisioned.worktree!.root, "conflict.txt"), "workspace side\n");
    const artifact = await value.store.capture(lease.id);

    await fs.writeFile(path.join(value.repo, "conflict.txt"), "upstream side\n");
    await git(value.repo, "add", "conflict.txt");
    await git(value.repo, "commit", "-m", "upstream conflict");

    integration = await value.store.apply(artifact.id, value.repo);
    assert.equal(integration.state, "conflicted");
    assert.deepEqual(integration.conflicts, ["conflict.txt"]);
    assert.match(await fs.readFile(path.join(integration.root, "conflict.txt"), "utf8"), /<<<<<<< ours/);
    assert.equal((await fs.stat(integration.root)).isDirectory(), true);
  } finally {
    if (integration) await value.store.releaseApplied(integration.integrationId).catch(() => {});
    await removeFixture(value);
  }
});

test("explicit discard is the only path that removes dirty unverified work", async () => {
  const value = await fixture();
  try {
    const lease = await value.store.register(value.provisioned);
    await fs.writeFile(path.join(value.provisioned.worktree!.root, "untracked.txt"), "throw away\n");
    const discarded = await value.store.discard(lease.id);
    assert.equal(discarded.state, "discarded");
    assert.equal(discarded.artifactId, undefined);
    await assert.rejects(fs.access(value.provisioned.worktree!.root), { code: "ENOENT" });
  } finally {
    await removeFixture(value);
  }
});

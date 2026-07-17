import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AppliedWorkspace,
  ArtifactFileRecord,
  ArtifactStatusEntry,
  BaselineRecord,
  ProvisionedWorktreeResult,
  WorkspaceArtifact,
  WorkspaceArtifactManifest,
  WorkspaceArtifactStoreOptions,
  WorkspaceLeaseRecord,
  WorkspaceLeaseState,
} from "./types.js";

const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

interface GitResult { stdout: Buffer; stderr: Buffer }
interface Snapshot { tree: string; commit: string; indexPath: string }

/** Durable owner for worktrees provisioned by subagents/workspace/create-worktree. */
export class WorkspaceArtifactStore {
  readonly root: string;
  readonly maxArtifactBytes: number;
  readonly gitTimeoutMs: number;

  constructor(root: string, options: WorkspaceArtifactStoreOptions = {}) {
    this.root = path.resolve(root);
    this.maxArtifactBytes = boundedInteger(options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES, 1, 1024 * 1024 * 1024, "maxArtifactBytes");
    this.gitTimeoutMs = boundedInteger(options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, 100, 10 * 60_000, "gitTimeoutMs");
  }

  /** Persist a post-provision snapshot. The input is structurally compatible with createWorktree/prepareWorktree. */
  async register(provisioned: ProvisionedWorktreeResult): Promise<WorkspaceLeaseRecord> {
    const worktree = provisioned.worktree;
    if (!worktree) throw new Error("a provisioned git worktree is required");
    await this.initialize();

    const id = opaqueId();
    const leaseDir = this.leaseDir(id);
    await fs.mkdir(leaseDir, { recursive: false, mode: 0o700 });
    const now = new Date().toISOString();
    const [workspaceRoot, tempParent, repositoryRoot, cwd] = await Promise.all([
      fs.realpath(worktree.root),
      fs.realpath(worktree.tempParent),
      fs.realpath(worktree.originalRoot),
      fs.realpath(provisioned.cwd),
    ]);
    let record: WorkspaceLeaseRecord = {
      version: 1,
      id,
      state: "provisioning",
      workspaceRoot,
      tempParent,
      repositoryRoot,
      cwd,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeLease(record);

    try {
      await this.validateOwnedWorktree(record);
      const head = await this.gitText(record.workspaceRoot, ["rev-parse", "HEAD"]);
      const repositoryId = await this.repositoryId(record.repositoryRoot);
      const snapshot = await this.createSnapshot(record.workspaceRoot, head, leaseDir, "baseline");
      const baselineRef = `refs/pi-workspace-artifacts/baselines/${id}`;
      await this.git(record.repositoryRoot, ["update-ref", baselineRef, snapshot.commit]);
      const bundlePath = path.join(leaseDir, "baseline.bundle.tmp");
      try {
        await this.git(record.repositoryRoot, ["bundle", "create", bundlePath, baselineRef]);
        const bundleFile = await this.fileRecord(bundlePath);
        this.assertArtifactSize(bundleFile.bytes);
        await this.git(record.repositoryRoot, ["bundle", "verify", bundlePath]);
        await this.syncFile(bundlePath);
        await fs.rename(bundlePath, path.join(leaseDir, "baseline.bundle"));
        await this.syncDirectory(leaseDir);
        const baseline: BaselineRecord = {
          repositoryId,
          provisioningBase: head,
          commit: snapshot.commit,
          tree: snapshot.tree,
          bundleSha256: bundleFile.sha256,
          bundleBytes: bundleFile.bytes,
          ref: baselineRef,
        };
        record = await this.transition(record, "active", { baseline });
        return record;
      } finally {
        await fs.rm(bundlePath, { force: true }).catch(() => {});
        await fs.rm(snapshot.indexPath, { force: true }).catch(() => {});
      }
    } catch (error) {
      await this.transition(record, "recovery_required", { reason: errorMessage(error) }).catch(() => {});
      throw error;
    }
  }

  async getLease(id: string): Promise<WorkspaceLeaseRecord> {
    this.assertId(id);
    return await this.readJson<WorkspaceLeaseRecord>(path.join(this.leaseDir(id), "record.json"));
  }

  /** Capture without deleting the source worktree. Useful when cleanup is managed separately. */
  async capture(id: string): Promise<WorkspaceArtifact> {
    return await this.withLeaseLock(id, async () => {
      const record = await this.getLease(id);
      if (record.state === "captured" || record.state === "cleanup_pending" || record.state === "cleaned") {
        if (!record.artifactId) throw new Error(`lease ${id} has no artifact id`);
        return await this.verifyArtifact(record.artifactId);
      }
      if (record.state === "discarded") throw new Error(`lease ${id} was explicitly discarded`);
      return await this.captureLocked(record);
    });
  }

  /** Verify, capture if needed, then remove the worktree. Safe to call repeatedly. */
  async release(id: string): Promise<WorkspaceArtifact | undefined> {
    return await this.withLeaseLock(id, async () => {
      let record = await this.getLease(id);
      if (record.state === "discarded") return undefined;
      if (record.state === "cleaned") {
        return record.artifactId ? await this.verifyArtifact(record.artifactId) : undefined;
      }

      let artifact: WorkspaceArtifact;
      if (record.artifactId && ["captured", "cleanup_pending", "recovery_required"].includes(record.state)) {
        try {
          artifact = await this.verifyArtifact(record.artifactId);
        } catch (error) {
          await this.transition(record, "recovery_required", { reason: `artifact verification failed: ${errorMessage(error)}` });
          throw error;
        }
      } else {
        artifact = await this.captureLocked(record);
      }

      record = await this.getLease(id);
      record = await this.transition(record, "cleanup_pending");
      try {
        await this.cleanupOwnedWorktree(record);
        await this.deleteBaselineRef(record);
        await this.transition(record, "cleaned", { reason: undefined });
        return artifact;
      } catch (error) {
        await this.transition(record, "recovery_required", { reason: `verified artifact retained; cleanup failed: ${errorMessage(error)}` });
        throw error;
      }
    });
  }

  /** Keep a workspace in place. A later capture/release may resume it. */
  async retain(id: string, reason = "retained by caller"): Promise<WorkspaceLeaseRecord> {
    return await this.withLeaseLock(id, async () => {
      const record = await this.getLease(id);
      if (["cleaned", "discarded"].includes(record.state)) return record;
      return await this.transition(record, "retained", { reason });
    });
  }

  /** The only operation allowed to delete an unverified changed workspace. */
  async discard(id: string): Promise<WorkspaceLeaseRecord> {
    return await this.withLeaseLock(id, async () => {
      let record = await this.getLease(id);
      if (record.state === "discarded" || record.state === "cleaned") return record;
      try {
        await this.cleanupOwnedWorktree(record, true);
        await this.deleteBaselineRef(record);
        record = await this.transition(record, "discarded", { reason: "explicit discard" });
        return record;
      } catch (error) {
        await this.transition(record, "recovery_required", { reason: `explicit discard cleanup failed: ${errorMessage(error)}` });
        throw error;
      }
    });
  }

  async verifyArtifact(id: string): Promise<WorkspaceArtifact> {
    this.assertId(id);
    const directory = this.artifactDir(id);
    const manifestPath = path.join(directory, "manifest.json");
    const manifestFile = await this.fileRecord(manifestPath);
    const manifest = await this.readJson<WorkspaceArtifactManifest>(manifestPath);
    if (manifest.version !== 1 || manifest.artifactId !== id || !ID_PATTERN.test(manifest.leaseId)) {
      throw new Error(`invalid artifact manifest for ${id}`);
    }
    this.validateManifestPaths(manifest);
    for (const name of ["full.patch", "snapshot.bundle"] as const) {
      const expected = manifest.files[name];
      const actual = await this.fileRecord(path.join(directory, name));
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        throw new Error(`artifact ${id} failed hash verification for ${name}`);
      }
      this.assertArtifactSize(actual.bytes);
    }
    const lease = await this.getLease(manifest.leaseId);
    if (!lease.baseline || lease.baseline.repositoryId !== manifest.repositoryId) throw new Error("artifact repository identity does not match its lease");
    if (lease.artifactId && (lease.artifactId !== id || lease.artifactManifestSha256 !== manifestFile.sha256)) {
      throw new Error(`artifact ${id} manifest failed durable hash verification`);
    }
    await this.git(lease.repositoryRoot, ["bundle", "verify", path.join(directory, "snapshot.bundle")]);
    return { id, directory, manifest };
  }

  /** Apply into a newly-created detached integration worktree. Conflicted worktrees are always retained. */
  async apply(id: string, repositoryRoot: string, base = "HEAD"): Promise<AppliedWorkspace> {
    const artifact = await this.verifyArtifact(id);
    const repo = await fs.realpath(repositoryRoot);
    if ((await this.repositoryId(repo)) !== artifact.manifest.repositoryId) throw new Error("artifact belongs to a different repository");

    // Import the snapshot and baseline objects without trusting or installing bundle refs.
    await this.git(repo, ["bundle", "unbundle", path.join(artifact.directory, "snapshot.bundle")]);
    for (const object of [artifact.manifest.provisioningBase, artifact.manifest.baselineCommit]) {
      await this.git(repo, ["cat-file", "-e", `${object}^{commit}`]).catch(() => {
        throw new Error(`artifact base object is unavailable or invalid: ${object}`);
      });
    }
    const importedBaselineTree = await this.gitText(repo, ["show", "-s", "--format=%T", artifact.manifest.baselineCommit]);
    if (importedBaselineTree !== artifact.manifest.baselineTree) throw new Error("artifact baseline tree hash mismatch after bundle import");
    const importedTree = await this.gitText(repo, ["show", "-s", "--format=%T", artifact.manifest.snapshotCommit]);
    if (importedTree !== artifact.manifest.snapshotTree) throw new Error("artifact snapshot hash mismatch after bundle import");
    const importedParent = await this.gitText(repo, ["rev-parse", `${artifact.manifest.snapshotCommit}^`]);
    if (importedParent !== artifact.manifest.baselineCommit) throw new Error("artifact snapshot is not based on the recorded baseline");

    const tempParent = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workflow-integration-"));
    const worktreeRoot = path.join(tempParent, "worktree");
    let added = false;
    try {
      await this.git(repo, ["worktree", "add", "--detach", "--quiet", worktreeRoot, base]);
      added = true;
      const addedPaths = new Set([
        ...artifact.manifest.originalStatus.filter((item) => item.status === "??").map((item) => item.path),
        ...artifact.manifest.status.filter((item) => item.status === "A").map((item) => item.path),
      ]);
      for (const addedPath of addedPaths) {
        const target = confinedPath(worktreeRoot, addedPath);
        if (await exists(target)) throw new Error(`untracked path collision: ${addedPath}`);
      }

      if (artifact.manifest.files["full.patch"].bytes === 0) {
        return { artifactId: id, state: "applied", root: worktreeRoot, tempParent, repositoryRoot: repo, conflicts: [] };
      }
      const result = await this.git(worktreeRoot, ["apply", "--3way", "--binary", path.join(artifact.directory, "full.patch")], true);
      if (result.ok) return { artifactId: id, state: "applied", root: worktreeRoot, tempParent, repositoryRoot: repo, conflicts: [] };
      const conflicts = splitNul((await this.git(worktreeRoot, ["diff", "--name-only", "--diff-filter=U", "-z"])).stdout)
        .map((item) => validateRelativePath(item));
      if (conflicts.length > 0) {
        return { artifactId: id, state: "conflicted", root: worktreeRoot, tempParent, repositoryRoot: repo, conflicts };
      }
      throw new Error(`git apply failed: ${result.stderr.toString("utf8").trim()}`);
    } catch (error) {
      // Conflicts return above. Other failed integrations have no useful state and are safely removed.
      if (added) await this.git(repo, ["worktree", "remove", "--force", worktreeRoot], true).catch(() => ({ ok: false as const, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
      await fs.rm(tempParent, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /** Idempotent cleanup for a successful integration worktree returned by apply(). */
  async releaseApplied(applied: AppliedWorkspace): Promise<void> {
    if (await exists(applied.root)) await this.git(applied.repositoryRoot, ["worktree", "remove", "--force", applied.root], true);
    await fs.rm(applied.tempParent, { recursive: true, force: true });
  }

  private async captureLocked(initial: WorkspaceLeaseRecord): Promise<WorkspaceArtifact> {
    let record = initial;
    if (!record.baseline) throw new Error(`lease ${record.id} has no durable baseline`);
    const baseline = record.baseline;
    if (!["active", "retained", "recovery_required", "capturing"].includes(record.state)) {
      throw new Error(`cannot capture lease ${record.id} in state ${record.state}`);
    }
    await this.validateOwnedWorktree(record);

    const unresolved = await this.git(record.workspaceRoot, ["ls-files", "-u", "-z"]);
    const porcelain = await this.git(record.workspaceRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    if (unresolved.stdout.length > 0) {
      await this.transition(record, "retained", { reason: "unresolved index entries" });
      throw new Error("workspace retained: unresolved index entries cannot be captured safely");
    }
    if (hasDirtySubmodule(porcelain.stdout)) {
      await this.transition(record, "retained", { reason: "dirty or unresolved submodule" });
      throw new Error("workspace retained: dirty or unresolved submodules are not captured");
    }

    record = await this.transition(record, "capturing", { reason: undefined });
    const artifactId = opaqueId();
    const staging = path.join(this.root, "staging", `${artifactId}.tmp`);
    await fs.mkdir(staging, { recursive: false, mode: 0o700 });
    let snapshot: Snapshot | undefined;
    const bundleRef = `refs/pi-workspace-artifacts/snapshots/${artifactId}`;
    try {
      await this.restoreBaseline(record);
      snapshot = await this.createSnapshot(record.workspaceRoot, baseline.commit, staging, "snapshot");
      const patch = (await this.git(record.workspaceRoot, [
        "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--find-renames", baseline.commit, "--",
      ], false, { GIT_INDEX_FILE: snapshot.indexPath })).stdout;
      this.assertArtifactSize(patch.length);
      await fs.writeFile(path.join(staging, "full.patch"), patch, { mode: 0o600 });

      await this.git(record.repositoryRoot, ["update-ref", bundleRef, snapshot.commit]);
      const bundlePath = path.join(staging, "snapshot.bundle");
      await this.git(record.repositoryRoot, ["bundle", "create", bundlePath, bundleRef]);
      const bundleFile = await this.fileRecord(bundlePath);
      this.assertArtifactSize(bundleFile.bytes);
      await this.git(record.repositoryRoot, ["bundle", "verify", bundlePath]);

      const nameStatus = await this.git(record.workspaceRoot, [
        "diff", "--cached", "--name-status", "-z", "--find-renames", baseline.commit, "--",
      ], false, { GIT_INDEX_FILE: snapshot.indexPath });
      const manifest: WorkspaceArtifactManifest = {
        version: 1,
        artifactId,
        leaseId: record.id,
        repositoryId: baseline.repositoryId,
        provisioningBase: baseline.provisioningBase,
        baselineCommit: baseline.commit,
        baselineTree: baseline.tree,
        snapshotCommit: snapshot.commit,
        snapshotTree: snapshot.tree,
        bundleRef,
        sourceHead: await this.gitText(record.workspaceRoot, ["rev-parse", "HEAD"]),
        createdAt: new Date().toISOString(),
        status: parseNameStatus(nameStatus.stdout),
        originalStatus: parsePorcelainV1((await this.git(record.workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout),
        files: {
          "full.patch": await this.fileRecord(path.join(staging, "full.patch")),
          "snapshot.bundle": bundleFile,
        },
      };
      this.validateManifestPaths(manifest);
      const totalArtifactBytes = manifest.files["full.patch"].bytes + manifest.files["snapshot.bundle"].bytes;
      this.assertArtifactSize(totalArtifactBytes);
      const manifestPath = path.join(staging, "manifest.json");
      await this.atomicJson(manifestPath, manifest);
      const manifestDigest = (await this.fileRecord(manifestPath)).sha256;
      await Promise.all([
        this.syncFile(path.join(staging, "full.patch")),
        this.syncFile(path.join(staging, "snapshot.bundle")),
        this.syncFile(manifestPath),
      ]);
      await this.syncDirectory(staging);
      await fs.rename(staging, this.artifactDir(artifactId));
      await this.syncDirectory(path.join(this.root, "artifacts"));

      // Reopen from its final name, anchor the manifest in the durable lease,
      // then verify again before making cleanup possible.
      await this.verifyArtifact(artifactId);
      await this.transition(record, "captured", { artifactId, artifactManifestSha256: manifestDigest, reason: undefined });
      return await this.verifyArtifact(artifactId);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      await this.transition(record, "recovery_required", { reason: `capture failed; workspace retained: ${errorMessage(error)}` }).catch(() => {});
      throw error;
    } finally {
      if (snapshot) await fs.rm(snapshot.indexPath, { force: true }).catch(() => {});
      await this.git(record.repositoryRoot, ["update-ref", "-d", bundleRef], true).catch(() => ({ ok: false as const, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    }
  }

  private async createSnapshot(worktreeRoot: string, parent: string, directory: string, label: string): Promise<Snapshot> {
    const indexPath = path.join(directory, `${label}.index`);
    await fs.rm(indexPath, { force: true });
    const env = { GIT_INDEX_FILE: indexPath };
    await this.git(worktreeRoot, ["read-tree", parent], false, env);
    await this.git(worktreeRoot, ["add", "-A", "--", "."], false, env);
    const tree = await this.gitText(worktreeRoot, ["write-tree"], env);
    const commit = await this.gitText(worktreeRoot, ["commit-tree", tree, "-p", parent], env, Buffer.from(`pi workspace ${label}\n`));
    return { tree, commit, indexPath };
  }

  private async restoreBaseline(record: WorkspaceLeaseRecord): Promise<void> {
    if (!record.baseline) throw new Error("baseline missing");
    const bundlePath = path.join(this.leaseDir(record.id), "baseline.bundle");
    const actual = await this.fileRecord(bundlePath);
    if (actual.sha256 !== record.baseline.bundleSha256 || actual.bytes !== record.baseline.bundleBytes) throw new Error("durable baseline bundle failed hash verification");
    await this.git(record.repositoryRoot, ["bundle", "verify", bundlePath]);
    await this.git(record.repositoryRoot, ["bundle", "unbundle", bundlePath]);
    const tree = await this.gitText(record.repositoryRoot, ["show", "-s", "--format=%T", record.baseline.commit]);
    if (tree !== record.baseline.tree) throw new Error("durable baseline tree hash mismatch");
    await this.git(record.repositoryRoot, ["update-ref", record.baseline.ref, record.baseline.commit]);
  }

  private async validateOwnedWorktree(record: WorkspaceLeaseRecord): Promise<void> {
    const workspace = await fs.realpath(record.workspaceRoot);
    const repo = await fs.realpath(record.repositoryRoot);
    const parent = await fs.realpath(record.tempParent);
    if (workspace !== record.workspaceRoot || repo !== record.repositoryRoot || parent !== record.tempParent) throw new Error("worktree paths must be canonical");
    if (!isInside(parent, workspace) || workspace === parent || !isInside(workspace, record.cwd)) throw new Error("worktree result paths are not confined");
    const listed = splitNul((await this.git(repo, ["worktree", "list", "--porcelain", "-z"])).stdout)
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length));
    if (!listed.includes(workspace)) throw new Error("workspace is not a registered worktree of the source repository");
  }

  private async cleanupOwnedWorktree(record: WorkspaceLeaseRecord, allowUnverified = false): Promise<void> {
    await this.validateOwnedWorktree(record);
    const status = await this.git(record.workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status.stdout.length > 0 && !allowUnverified && !record.artifactId) {
      throw new Error("refusing to delete changed workspace without a verified artifact");
    }
    if (record.artifactId && !allowUnverified) await this.verifyArtifact(record.artifactId);
    await this.git(record.repositoryRoot, ["worktree", "unlock", record.workspaceRoot], true);
    const removed = await this.git(record.repositoryRoot, ["worktree", "remove", "--force", record.workspaceRoot], true);
    if (!removed.ok) throw new Error(`git worktree removal failed: ${removed.stderr.toString("utf8").trim()}`);
    await fs.rm(record.tempParent, { recursive: true, force: true });
    const listed = (await this.git(record.repositoryRoot, ["worktree", "list", "--porcelain", "-z"])).stdout.toString("utf8");
    if (listed.includes(record.workspaceRoot)) throw new Error("worktree registration remains after cleanup");
  }

  private async deleteBaselineRef(record: WorkspaceLeaseRecord): Promise<void> {
    if (record.baseline) await this.git(record.repositoryRoot, ["update-ref", "-d", record.baseline.ref], true);
  }

  private async repositoryId(repo: string): Promise<string> {
    const commonValue = await this.gitText(repo, ["rev-parse", "--git-common-dir"]);
    const commonDirectory = await fs.realpath(path.isAbsolute(commonValue) ? commonValue : path.resolve(repo, commonValue));
    const format = await this.gitText(repo, ["rev-parse", "--show-object-format"]);
    // The canonical common git directory identifies one repository while still
    // accepting any of its linked worktrees. Clones are deliberately distinct.
    return createHash("sha256").update(`git:${format}\n${commonDirectory}\n`).digest("hex");
  }

  private validateManifestPaths(manifest: WorkspaceArtifactManifest): void {
    for (const hash of [manifest.provisioningBase, manifest.baselineCommit, manifest.baselineTree, manifest.snapshotCommit, manifest.snapshotTree]) {
      if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error("manifest contains an invalid git object id");
    }
    for (const entry of [...manifest.status, ...manifest.originalStatus]) {
      validateRelativePath(entry.path);
      if (entry.originalPath) validateRelativePath(entry.originalPath);
    }
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(path.join(this.root, "leases"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.root, "artifacts"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.root, "staging"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.root, "locks"), { recursive: true, mode: 0o700 });
  }

  private async transition(record: WorkspaceLeaseRecord, state: WorkspaceLeaseState, changes: Partial<WorkspaceLeaseRecord> = {}): Promise<WorkspaceLeaseRecord> {
    const next: WorkspaceLeaseRecord = { ...record, ...changes, state, updatedAt: new Date().toISOString() };
    if (changes.reason === undefined) delete next.reason;
    await this.writeLease(next);
    return next;
  }

  private async writeLease(record: WorkspaceLeaseRecord): Promise<void> {
    await this.atomicJson(path.join(this.leaseDir(record.id), "record.json"), record);
  }

  private async atomicJson(file: string, value: unknown): Promise<void> {
    const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    if (data.length > MAX_JSON_BYTES) throw new Error("record exceeds JSON size limit");
    const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await this.syncDirectory(path.dirname(file));
  }

  private async syncFile(file: string): Promise<void> {
    const handle = await fs.open(file, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async syncDirectory(directory: string): Promise<void> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(directory, "r");
      await handle.sync();
    } catch (error) {
      // Directory fsync is unsupported on some filesystems/platforms. Only
      // suppress the documented unsupported-operation cases.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private async readJson<T>(file: string): Promise<T> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) throw new Error(`unsafe or oversized record: ${file}`);
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  }

  private async fileRecord(file: string): Promise<ArtifactFileRecord> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`artifact member is not a regular file: ${file}`);
    const data = await fs.readFile(file);
    return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
  }

  private assertArtifactSize(bytes: number): void {
    if (bytes > this.maxArtifactBytes) throw new Error(`artifact member exceeds ${this.maxArtifactBytes} bytes`);
  }

  private async withLeaseLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.assertId(id);
    await this.initialize();
    const lock = path.join(this.root, "locks", `${id}.lock`);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`lease ${id} is busy`);
      throw error;
    }
    try {
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
      return await action();
    } finally {
      await handle.close();
      await fs.rm(lock, { force: true });
    }
  }

  private leaseDir(id: string): string { return path.join(this.root, "leases", id); }
  private artifactDir(id: string): string { return path.join(this.root, "artifacts", id); }
  private assertId(id: string): void { if (!ID_PATTERN.test(id)) throw new Error("invalid opaque workspace id"); }

  private async gitText(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: Buffer): Promise<string> {
    return (await this.git(cwd, args, false, env, input)).stdout.toString("utf8").trim();
  }

  private git(cwd: string, args: string[], allowFailure: true, env?: NodeJS.ProcessEnv, input?: Buffer): Promise<GitResult & { ok: boolean }>;
  private git(cwd: string, args: string[], allowFailure?: false, env?: NodeJS.ProcessEnv, input?: Buffer): Promise<GitResult>;
  private git(cwd: string, args: string[], allowFailure = false, env?: NodeJS.ProcessEnv, input?: Buffer): Promise<GitResult | (GitResult & { ok: boolean })> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", ["-C", cwd, ...args], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let killedForLimit = false;
      const collect = (target: Buffer[], chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > this.maxArtifactBytes) {
          killedForLimit = true;
          child.kill("SIGKILL");
        } else target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), this.gitTimeoutMs);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
        if (killedForLimit) return reject(new Error(`git output exceeded ${this.maxArtifactBytes} bytes`));
        if (code === 0) return resolve(allowFailure ? { ...result, ok: true } : result);
        if (allowFailure) return resolve({ ...result, ok: false });
        reject(new Error(`git ${args[0] ?? "command"} failed (${code}): ${result.stderr.toString("utf8").trim()}`));
      });
      if (input) child.stdin.end(input); else child.stdin.end();
    });
  }
}

function opaqueId(): string { return randomBytes(24).toString("base64url"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function splitNul(data: Buffer): string[] { return data.toString("utf8").split("\0").filter(Boolean); }
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function confinedPath(root: string, relative: string): string {
  validateRelativePath(relative);
  const resolved = path.resolve(root, relative);
  if (!isInside(root, resolved)) throw new Error(`path escapes workspace: ${relative}`);
  return resolved;
}
function validateRelativePath(input: string): string {
  if (!input || input.includes("\0") || path.isAbsolute(input) || input.split(/[\\/]/).some((part) => part === ".." || part === ".git")) {
    throw new Error(`unsafe artifact path: ${JSON.stringify(input)}`);
  }
  return input;
}
function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function parseNameStatus(data: Buffer): ArtifactStatusEntry[] {
  const fields = splitNul(data);
  const result: ArtifactStatusEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!;
    if (/^[RC]/.test(status)) {
      const originalPath = validateRelativePath(fields[index++] ?? "");
      const currentPath = validateRelativePath(fields[index++] ?? "");
      result.push({ status, path: currentPath, originalPath });
    } else {
      result.push({ status, path: validateRelativePath(fields[index++] ?? "") });
    }
  }
  return result;
}

function parsePorcelainV1(data: Buffer): ArtifactStatusEntry[] {
  const fields = splitNul(data);
  const result: ArtifactStatusEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const field = fields[index++]!;
    if (field.length < 4) throw new Error("invalid git status output");
    const status = field.slice(0, 2);
    const currentPath = validateRelativePath(field.slice(3));
    if (status.includes("R") || status.includes("C")) {
      result.push({ status, path: currentPath, originalPath: validateRelativePath(fields[index++] ?? "") });
    } else result.push({ status, path: currentPath });
  }
  return result;
}

function hasDirtySubmodule(porcelain: Buffer): boolean {
  for (const field of splitNul(porcelain)) {
    if (!/^[12u] /.test(field)) continue;
    const parts = field.split(" ");
    const submodule = parts[2];
    if (submodule?.startsWith("S") && submodule !== "S...") return true;
    if (field.startsWith("u ") && parts.slice(3, 6).some((mode) => mode === "160000")) return true;
  }
  return false;
}

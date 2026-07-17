export type WorkspaceLeaseState =
  | "provisioning"
  | "active"
  | "capturing"
  | "captured"
  | "cleanup_pending"
  | "cleaned"
  | "retained"
  | "recovery_required"
  | "discarded";

/** Structural subset of subagents/workspace/create-worktree's result. */
export interface ProvisionedWorktreeResult {
  cwd: string;
  worktree?: {
    root: string;
    tempParent: string;
    originalRoot: string;
    originalCwd: string;
    base: string;
  };
}

export interface BaselineRecord {
  repositoryId: string;
  provisioningBase: string;
  commit: string;
  tree: string;
  bundleSha256: string;
  bundleBytes: number;
  ref: string;
}

export interface WorkspaceLeaseRecord {
  version: 1;
  id: string;
  state: WorkspaceLeaseState;
  workspaceRoot: string;
  tempParent: string;
  repositoryRoot: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  baseline?: BaselineRecord;
  artifactId?: string;
  artifactManifestSha256?: string;
  reason?: string;
}

export interface ArtifactStatusEntry {
  status: string;
  path: string;
  originalPath?: string;
}

export interface ArtifactFileRecord {
  sha256: string;
  bytes: number;
}

export interface WorkspaceArtifactManifest {
  version: 1;
  artifactId: string;
  leaseId: string;
  repositoryId: string;
  provisioningBase: string;
  baselineCommit: string;
  baselineTree: string;
  snapshotCommit: string;
  snapshotTree: string;
  bundleRef: string;
  sourceHead: string;
  createdAt: string;
  status: ArtifactStatusEntry[];
  originalStatus: ArtifactStatusEntry[];
  files: {
    "full.patch": ArtifactFileRecord;
    "snapshot.bundle": ArtifactFileRecord;
  };
}

export interface WorkspaceArtifact {
  id: string;
  directory: string;
  manifest: WorkspaceArtifactManifest;
}

export interface IntegrationWorkspaceRecord {
  version: 1;
  integrationId: string;
  artifactId: string;
  ownerSessionId?: string;
  ownerRunId?: string;
  purpose: "artifact-apply" | "cache-replay";
  state: "provisioning" | "applied" | "conflicted" | "cleanup_pending" | "cleaned" | "recovery_required";
  root: string;
  tempParent: string;
  repositoryRoot: string;
  targetRef: string;
  conflicts: string[];
  createdAt: string;
  updatedAt: string;
  reason?: string;
}

export interface AppliedWorkspace {
  integrationId: string;
  artifactId: string;
  state: "applied" | "conflicted";
  root: string;
  tempParent: string;
  repositoryRoot: string;
  conflicts: string[];
}

export interface WorkspaceArtifactStoreOptions {
  maxArtifactBytes?: number;
  gitTimeoutMs?: number;
}

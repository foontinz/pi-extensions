export interface WorktreeCopyObject {
  from: string;
  to?: string;
  optional?: boolean;
}

export interface WorktreePostCopyObject {
  command: string;
  cwd?: string;
  optional?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export type WorktreeKeepMode = "never" | "always" | "onFailure";

export interface WorktreeEnvConfig {
  enabled?: boolean;
  base?: string;
  copy?: Array<string | WorktreeCopyObject>;
  exclude?: string[];
  exclusions?: string[];
  postCopy?: Array<string | WorktreePostCopyObject>;
  postCopyScripts?: Array<string | WorktreePostCopyObject>;
  keepWorktree?: boolean | WorktreeKeepMode;
}

export interface WorktreeScriptResult {
  command: string;
  cwd: string;
  optional: boolean;
  timeoutMs: number;
  stdout?: string;
  stderr?: string;
  failed?: boolean;
}

export type NormalizedWorktreeCopySpec = Required<Pick<WorktreeCopyObject, "from" | "optional">> & { to?: string };
export type NormalizedWorktreePostCopySpec = Required<Pick<WorktreePostCopyObject, "command" | "optional" | "timeoutMs">> & Pick<WorktreePostCopyObject, "cwd" | "env">;

export interface NormalizedWorktreeEnvConfig {
  enabled?: boolean;
  base?: string;
  copy: NormalizedWorktreeCopySpec[];
  exclusions: string[];
  postCopy: NormalizedWorktreePostCopySpec[];
  keepWorktree: WorktreeKeepMode;
  configPath?: string;
}

export interface WorktreeInfo {
  root: string;
  tempParent: string;
  originalRoot: string;
  originalCwd: string;
  configPath?: string;
  base: string;
  copied: string[];
  postCopy: WorktreeScriptResult[];
  keepWorktree: WorktreeKeepMode;
  retained?: boolean;
}

export interface GitRootOk {
  ok: true;
  root: string;
}

export interface GitRootNotRepo {
  ok: false;
  kind: "not-repo";
}

export interface GitRootError {
  ok: false;
  kind: "git-unavailable" | "invalid-cwd" | "git-error";
  message: string;
  code?: number | string;
  stderr?: string;
}

export type GitRootResult = GitRootOk | GitRootNotRepo | GitRootError;

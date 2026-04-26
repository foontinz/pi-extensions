import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { NormalizedWorktreePostCopySpec } from "./types.js";

export interface PostCopyTrustStore {
  version: 1;
  trusted: Record<string, PostCopyTrustRecord>;
}

export interface PostCopyTrustRecord {
  repoRoot: string;
  repoKey: string;
  scriptsHash: string;
  trustedAt: number;
}

export interface PostCopyTrustDecision extends PostCopyTrustRecord {
  trustKey: string;
  trusted: boolean;
}

export interface PostCopyTrustStoreOptions {
  defaultStorePath: string;
  envPathKey?: string;
}

export async function getPostCopyTrust(
  repoRoot: string,
  scripts: NormalizedWorktreePostCopySpec[],
  options: PostCopyTrustStoreOptions,
): Promise<PostCopyTrustDecision> {
  const canonicalRepoRoot = await canonicalizePath(repoRoot);
  const repoKey = hashJson({ repoRoot: canonicalRepoRoot });
  const scriptsHash = hashJson(normalizePostCopySpecsForTrust(scripts));
  const trustKey = hashJson({ repoKey, scriptsHash });
  const store = await readPostCopyTrustStore(options);
  const record = store.trusted[trustKey];
  return {
    repoRoot: canonicalRepoRoot,
    repoKey,
    scriptsHash,
    trustedAt: record?.trustedAt ?? Date.now(),
    trustKey,
    trusted: record?.repoKey === repoKey && record.scriptsHash === scriptsHash,
  };
}

export async function rememberPostCopyTrust(decision: PostCopyTrustDecision, options: PostCopyTrustStoreOptions): Promise<void> {
  const storePath = getPostCopyTrustStorePath(options);
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  await withFileMutationQueue(storePath, async () => {
    const store = await readPostCopyTrustStore(options);
    store.trusted[decision.trustKey] = {
      repoRoot: decision.repoRoot,
      repoKey: decision.repoKey,
      scriptsHash: decision.scriptsHash,
      trustedAt: Date.now(),
    };
    await fs.promises.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  });
}

async function readPostCopyTrustStore(options: PostCopyTrustStoreOptions): Promise<PostCopyTrustStore> {
  const storePath = getPostCopyTrustStorePath(options);
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyPostCopyTrustStore();
    const trusted = (parsed as { trusted?: unknown }).trusted;
    if (!trusted || typeof trusted !== "object" || Array.isArray(trusted)) return emptyPostCopyTrustStore();
    const sanitized: Record<string, PostCopyTrustRecord> = {};
    for (const [key, value] of Object.entries(trusted)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Partial<PostCopyTrustRecord>;
      if (
        typeof record.repoRoot !== "string" ||
        typeof record.repoKey !== "string" ||
        typeof record.scriptsHash !== "string" ||
        typeof record.trustedAt !== "number"
      ) continue;
      sanitized[key] = { repoRoot: record.repoRoot, repoKey: record.repoKey, scriptsHash: record.scriptsHash, trustedAt: record.trustedAt };
    }
    return { version: 1, trusted: sanitized };
  } catch {
    return emptyPostCopyTrustStore();
  }
}

function emptyPostCopyTrustStore(): PostCopyTrustStore {
  return { version: 1, trusted: {} };
}

function getPostCopyTrustStorePath(options: PostCopyTrustStoreOptions): string {
  const envPath = options.envPathKey ? process.env[options.envPathKey] : undefined;
  return envPath || options.defaultStorePath;
}

async function canonicalizePath(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function normalizePostCopySpecsForTrust(scripts: NormalizedWorktreePostCopySpec[]): unknown {
  return scripts.map((script) => ({
    command: script.command,
    cwd: script.cwd ?? ".",
    optional: script.optional,
    timeoutMs: script.timeoutMs,
    env: sortObject(script.env ?? {}),
  }));
}

function sortObject(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

import { mkdir, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import type { WorkflowRunRecordV1 } from "./contracts.js";
import type { WorkflowRunStore } from "./run-store.js";

export interface RetentionResult { pruned: string[]; retained: Array<{ runId: string; reason: string }> }

/** Manifest-aware pruning. Rename-to-trash makes deletion recoverable/atomic at the run-root boundary. */
export async function pruneWorkflowRuns(store: WorkflowRunStore, now = Date.now()): Promise<RetentionResult> {
  const entries = await store.scan();
  const records = entries.filter((entry): entry is typeof entry & { record: WorkflowRunRecordV1 } => entry.state === "ok" && Boolean(entry.record));
  const referenced = new Set(records.flatMap((entry) => [entry.record.parentRunId, entry.record.resumeFromRunId].filter((value): value is string => Boolean(value))));
  const trash = path.join(store.root, ".trash");
  await mkdir(trash, { recursive: true, mode: 0o700 });
  const result: RetentionResult = { pruned: [], retained: [] };
  for (const { runId, record } of records) {
    const reason = retentionReason(record, referenced, now);
    if (reason) { result.retained.push({ runId, reason }); continue; }
    const source = store.paths(runId).runDir;
    const destination = path.join(trash, `${runId}.${now}`);
    try {
      await store.writeTombstone(runId, { prunedAt: now, ...(record.expiresAt !== undefined ? { expiredAt: record.expiresAt } : {}) });
      await rename(source, destination);
      await rm(destination, { recursive: true, force: true });
      result.pruned.push(runId);
    } catch (error) {
      result.retained.push({ runId, reason: `prune failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return result;
}

function retentionReason(record: WorkflowRunRecordV1, referenced: Set<string>, now: number): string | undefined {
  if (!["completed", "failed", "cancelled"].includes(record.status)) return `status ${record.status}`;
  if (record.pinned) return "pinned";
  if (record.notification.state !== "delivered") return "pending notification";
  if (record.cleanup.status !== "completed") return `cleanup ${record.cleanup.status}`;
  if (record.artifacts.some((artifact) => artifact.state === "pending" || artifact.state === "recovery_required")) return "owned artifact";
  if (record.artifacts.some((artifact) => artifact.kind === "workspace" && artifact.state === "verified")) return "unapplied workspace artifact";
  if (referenced.has(record.runId)) return "retained lineage reference";
  if (record.expiresAt === undefined || record.expiresAt > now) return "not expired";
  return undefined;
}

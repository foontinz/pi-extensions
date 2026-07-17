import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import type { JsonValue } from "../core/canonical-json.js";
import { cloneCanonicalJson } from "../core/canonical-json.js";
import { MAX_JOURNAL_BYTES, MAX_JOURNAL_RECORD_BYTES } from "../core/limits.js";
import type { WorkflowRunStore } from "../core/run-store.js";

export interface WorkflowJournalRecordV1 {
  version: 1;
  sequence: number;
  eventId: string;
  attemptId: string;
  nodeId: string;
  type: "node-intent" | "node-result" | "node-skip" | "terminal";
  payload: JsonValue;
  checksum: string;
}
export interface WorkflowReplayEntry { fingerprint: string; result: JsonValue; artifactIds?: string[] }

export class WorkflowJournal {
  constructor(private readonly store: WorkflowRunStore) {}

  async append(runId: string, input: Omit<WorkflowJournalRecordV1, "version" | "eventId" | "checksum"> & { eventId?: string }): Promise<WorkflowJournalRecordV1> {
    const base = {
      version: 1 as const,
      sequence: input.sequence,
      eventId: input.eventId ?? randomUUID(),
      attemptId: input.attemptId,
      nodeId: input.nodeId,
      type: input.type,
      payload: cloneCanonicalJson(input.payload),
    };
    const record: WorkflowJournalRecordV1 = { ...base, checksum: checksum(base) };
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_JOURNAL_RECORD_BYTES) throw new Error("journal record exceeds byte limit");
    await this.store.appendJournal(runId, record as unknown as JsonValue);
    return record;
  }

  /** Accept the longest checksummed prefix. Only one torn final record is repairable. */
  async recover(runId: string): Promise<WorkflowJournalRecordV1[]> {
    const file = this.store.paths(runId, true).journal!;
    const info = await stat(file);
    if (info.size > MAX_JOURNAL_BYTES) throw new Error("journal exceeds total byte limit");
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const records: WorkflowJournalRecordV1[] = [];
    let validBytes = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      try {
        const record = JSON.parse(line) as WorkflowJournalRecordV1;
        validateRecord(record, records.length ? records.at(-1)!.sequence + 1 : 1);
        records.push(record);
        validBytes += Buffer.byteLength(`${line}\n`);
      } catch (error) {
        if (index !== lines.length - 1) throw new Error(`interior journal corruption at record ${index + 1}`, { cause: error });
        const handle = await open(file, "r+");
        try { await handle.truncate(validBytes); await handle.sync(); } finally { await handle.close(); }
      }
    }
    return records;
  }

  replayIndex(records: readonly WorkflowJournalRecordV1[]): Map<string, WorkflowReplayEntry> {
    const map = new Map<string, WorkflowReplayEntry>();
    for (const record of records) {
      if (record.type !== "node-result" || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) continue;
      const payload = record.payload as Record<string, JsonValue>;
      if (payload.cachePolicy !== "pure" || typeof payload.fingerprint !== "string" || !("result" in payload)) continue;
      map.set(record.nodeId, {
        fingerprint: payload.fingerprint,
        result: cloneCanonicalJson(payload.result),
        ...(Array.isArray(payload.artifactIds) ? { artifactIds: payload.artifactIds.filter((item): item is string => typeof item === "string") } : {}),
      });
    }
    return map;
  }
}

export async function claimWorkflowResume(store: WorkflowRunStore, runId: string): Promise<() => Promise<void>> {
  const lock = `${store.paths(runId).runDir}/resume.lock`;
  let handle;
  try { handle = await open(lock, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`workflow ${runId} already has an active resume claim`); throw error; }
  await handle.writeFile(`${process.pid}\n`); await handle.sync(); await handle.close();
  let released = false;
  return async () => { if (released) return; released = true; await rm(lock, { force: true }); };
}

function validateRecord(record: WorkflowJournalRecordV1, expectedSequence: number): void {
  if (!record || record.version !== 1 || record.sequence !== expectedSequence || typeof record.eventId !== "string" || typeof record.attemptId !== "string" || typeof record.nodeId !== "string") throw new Error("invalid journal envelope");
  const { checksum: actual, ...base } = record;
  if (actual !== checksum(base)) throw new Error("journal checksum mismatch");
}
function checksum(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

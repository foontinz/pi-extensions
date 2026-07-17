import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { cloneCanonicalJson, type JsonValue } from "./canonical-json.js";
import type { DurableWorkflowEvent, WorkflowNotificationRecordV1, WorkflowRunRecordV1 } from "./contracts.js";
import type { EncodedWorkflowOutput } from "./output-encoder.js";
import {
  MAX_EVENT_FILE_BYTES,
  MAX_EVENT_RECORD_BYTES,
  MAX_EVENT_RECORDS,
  MAX_JOURNAL_BYTES,
  MAX_JOURNAL_RECORD_BYTES,
  MAX_OUTPUT_BYTES,
  WORKFLOW_EVENT_SCHEMA_VERSION,
  WORKFLOW_RUN_SCHEMA_VERSION,
} from "./limits.js";
import { assertWorkflowRunInvariants } from "./reducer.js";

export interface WorkflowRunPaths {
  runDir: string;
  run: string;
  script: string;
  output: string;
  events: string;
  notification: string;
  agents: string;
  artifacts: string;
  journal?: string;
}
export interface RunScanEntry {
  runId: string;
  state: "ok" | "corrupt" | "unsupported_schema";
  record?: WorkflowRunRecordV1;
  error?: string;
}
export class UnsupportedWorkflowSchemaError extends Error { override name = "UnsupportedWorkflowSchemaError" }

/** Process-wide queues serialize all writers targeting the same durable run. */
const writerQueues = new Map<string, Promise<void>>();

export class WorkflowRunStore {
  readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }

  paths(runId: string, resumable = false): WorkflowRunPaths {
    validateRunId(runId);
    const runDir = path.join(this.root, runId);
    return {
      runDir,
      run: path.join(runDir, "run.json"),
      script: path.join(runDir, "script.js"),
      output: path.join(runDir, "output.json"),
      events: path.join(runDir, "events.jsonl"),
      notification: path.join(runDir, "notification.json"),
      agents: path.join(runDir, "agents"),
      artifacts: path.join(runDir, "artifacts"),
      ...(resumable ? { journal: path.join(runDir, "journal.jsonl") } : {}),
    };
  }

  /** Initial record and copied provenance become durable before execution can start. */
  async createRun(record: WorkflowRunRecordV1, copiedSource: string): Promise<WorkflowRunPaths> {
    assertWorkflowRunInvariants(record);
    if (record.status !== "created" || record.recordRevision !== 0) throw new Error("initial workflow record must be revision 0 created");
    const paths = this.paths(record.runId, record.metadata.resumable);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return this.withRunWriter(record.runId, async () => {
      await mkdir(paths.runDir, { mode: 0o700 });
      try {
        await Promise.all([mkdir(paths.agents, { mode: 0o700 }), mkdir(paths.artifacts, { mode: 0o700 })]);
        await atomicWrite(paths.script, copiedSource);
        const copiedHash = createHash("sha256").update(copiedSource).digest("hex");
        if (copiedHash !== record.source.sha256) throw new Error("copied workflow source hash does not match run provenance");
        await atomicWrite(paths.run, jsonLine(record));
        await atomicWrite(paths.notification, jsonLine(record.notification));
        await Promise.all([createEmpty(paths.events), ...(paths.journal ? [createEmpty(paths.journal)] : [])]);
        await syncDirectory(paths.runDir);
        return paths;
      } catch (error) {
        await rm(paths.runDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async readRun(runId: string): Promise<WorkflowRunRecordV1> {
    const value = JSON.parse(await readBounded(this.paths(runId).run, 16 * 1024 * 1024)) as any;
    if (typeof value?.schemaVersion === "number" && value.schemaVersion > WORKFLOW_RUN_SCHEMA_VERSION) {
      throw new UnsupportedWorkflowSchemaError(`unsupported future workflow schema ${value.schemaVersion}`);
    }
    assertWorkflowRunInvariants(value);
    return structuredClone(value);
  }

  async writeRun(record: WorkflowRunRecordV1): Promise<void> {
    assertWorkflowRunInvariants(record);
    await this.withRunWriter(record.runId, async () => {
      await requireRunDirectory(this.paths(record.runId).runDir);
      const current = await this.readRun(record.runId);
      if (record.recordRevision < current.recordRevision) throw new Error("refusing to replace run snapshot with an older revision");
      await atomicWrite(this.paths(record.runId).run, jsonLine(record));
    });
  }

  async appendEvent(event: DurableWorkflowEvent): Promise<void> {
    validateRunId(event.runId);
    if (event.schemaVersion !== WORKFLOW_EVENT_SCHEMA_VERSION || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error("invalid durable workflow event envelope");
    const snapshot = jsonLine(event);
    if (Buffer.byteLength(snapshot) > MAX_EVENT_RECORD_BYTES) throw new Error("workflow event exceeds record byte limit");
    await this.withRunWriter(event.runId, async () => {
      await assertAppendCapacity(this.paths(event.runId).events, snapshot, MAX_EVENT_FILE_BYTES, MAX_EVENT_RECORDS);
      await appendDurable(this.paths(event.runId).events, snapshot);
    });
  }
  async readEvents(runId: string): Promise<DurableWorkflowEvent[]> { return readJsonLines<DurableWorkflowEvent>(this.paths(runId).events, MAX_EVENT_FILE_BYTES); }

  async writeOutput(runId: string, output: EncodedWorkflowOutput): Promise<void> {
    const snapshot = jsonLine(output);
    if (Buffer.byteLength(snapshot) > MAX_OUTPUT_BYTES) throw new Error("encoded workflow output exceeds output limit");
    await this.withRunWriter(runId, async () => atomicWrite(this.paths(runId).output, snapshot));
  }
  async readOutput(runId: string): Promise<EncodedWorkflowOutput> {
    return cloneCanonicalJson(JSON.parse(await readBounded(this.paths(runId).output, MAX_OUTPUT_BYTES))) as unknown as EncodedWorkflowOutput;
  }

  async writeNotification(runId: string, notification: WorkflowNotificationRecordV1): Promise<void> {
    await this.withRunWriter(runId, async () => atomicWrite(this.paths(runId).notification, jsonLine(notification)));
  }

  async appendJournal(runId: string, entry: JsonValue): Promise<void> {
    const paths = this.paths(runId, true);
    const detached = cloneCanonicalJson(entry);
    const snapshot = jsonLine(detached);
    if (Buffer.byteLength(snapshot) > MAX_JOURNAL_RECORD_BYTES) throw new Error("journal record exceeds byte limit");
    await this.withRunWriter(runId, async () => {
      if (!paths.journal) throw new Error("journal unavailable");
      await assertAppendCapacity(paths.journal, snapshot, MAX_JOURNAL_BYTES);
      await appendDurable(paths.journal, snapshot);
    });
  }
  async readJournal(runId: string): Promise<JsonValue[]> {
    const record = await this.readRun(runId);
    if (!record.metadata.resumable) throw new Error("workflow is not resumable");
    return readJsonLines<JsonValue>(this.paths(runId, true).journal!, MAX_JOURNAL_BYTES);
  }

  async scan(): Promise<RunScanEntry[]> {
    let entries: string[];
    try { entries = await readdir(this.root); } catch { return []; }
    const results: RunScanEntry[] = [];
    for (const runId of entries) {
      try { validateRunId(runId); } catch { continue; }
      try { results.push({ runId, state: "ok", record: await this.readRun(runId) }); }
      catch (error) {
        results.push({
          runId,
          state: error instanceof UnsupportedWorkflowSchemaError ? "unsupported_schema" : "corrupt",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  withRunWriter<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const key = this.paths(runId).runDir;
    const previous = writerQueues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    const tail = result.then(() => undefined, () => undefined);
    writerQueues.set(key, tail);
    void tail.finally(() => { if (writerQueues.get(key) === tail) writerQueues.delete(key); });
    return result;
  }
}
export const RunStore = WorkflowRunStore;

async function atomicWrite(destination: string, contents: string): Promise<void> {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
async function appendDurable(destination: string, contents: string): Promise<void> {
  const handle = await open(destination, "a", 0o600);
  try { await handle.writeFile(contents, "utf8"); await handle.sync(); } finally { await handle.close(); }
}
async function createEmpty(destination: string): Promise<void> {
  const handle = await open(destination, "wx", 0o600);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try { handle = await open(directory, "r"); await handle.sync(); }
  catch (error) { if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  finally { await handle?.close().catch(() => undefined); }
}
async function assertAppendCapacity(file: string, addition: string, maxBytes: number, maxRecords?: number): Promise<void> {
  const info = await stat(file);
  if (info.size + Buffer.byteLength(addition) > maxBytes) throw new Error("append-only workflow file exceeds byte limit");
  if (maxRecords !== undefined) {
    const current = await readBounded(file, maxBytes);
    if (current.split("\n").filter(Boolean).length >= maxRecords) throw new Error("workflow event count limit exceeded");
  }
}
async function requireRunDirectory(directory: string): Promise<void> { if (!(await stat(directory)).isDirectory()) throw new Error(`workflow run path is not a directory: ${directory}`); }
async function readBounded(file: string, maxBytes: number): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > maxBytes) throw new Error(`workflow file is unsafe or exceeds ${maxBytes} bytes: ${file}`);
  return readFile(file, "utf8");
}
async function readJsonLines<T>(file: string, maxBytes: number): Promise<T[]> {
  const contents = await readBounded(file, maxBytes);
  if (!contents) return [];
  return contents.split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch (error) { throw new SyntaxError(`invalid JSONL at ${file}:${index + 1}`, { cause: error }); }
  });
}
function jsonLine(value: unknown): string { return `${JSON.stringify(cloneCanonicalJson(value))}\n`; }
function validateRunId(runId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new TypeError("runId must be a full UUID");
}

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { cloneCanonicalJson, type JsonValue } from "./canonical-json.js";
import type { DurableWorkflowEvent, WorkflowRunRecord } from "./contracts.js";
import type { EncodedWorkflowOutput } from "./output-encoder.js";
import { assertWorkflowRunInvariants } from "./reducer.js";

export interface WorkflowRunPaths {
  runDir: string;
  run: string;
  events: string;
  output: string;
  journal: string;
}

/** Process-wide queues also serialize independent store instances targeting the same run. */
const writerQueues = new Map<string, Promise<void>>();

export class WorkflowRunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  paths(runId: string): WorkflowRunPaths {
    validateRunId(runId);
    const runDir = path.join(this.root, runId);
    return {
      runDir,
      run: path.join(runDir, "run.json"),
      events: path.join(runDir, "events.jsonl"),
      output: path.join(runDir, "output.json"),
      journal: path.join(runDir, "journal.jsonl"),
    };
  }

  async createRun(record: WorkflowRunRecord): Promise<WorkflowRunPaths> {
    assertWorkflowRunInvariants(record);
    const snapshot = jsonLine(record);
    const paths = this.paths(record.id);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return this.withRunWriter(record.id, async () => {
      await mkdir(paths.runDir, { mode: 0o700 });
      try {
        await atomicWrite(paths.run, snapshot);
        await Promise.all([createEmpty(paths.events), createEmpty(paths.journal)]);
        return paths;
      } catch (error) {
        await rm(paths.runDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async readRun(runId: string): Promise<WorkflowRunRecord> {
    const value = JSON.parse(await readFile(this.paths(runId).run, "utf8")) as unknown;
    assertWorkflowRunInvariants(value);
    return structuredClone(value);
  }

  async writeRun(record: WorkflowRunRecord): Promise<void> {
    assertWorkflowRunInvariants(record);
    const snapshot = jsonLine(record);
    await this.withRunWriter(record.id, async () => {
      await requireRunDirectory(this.paths(record.id).runDir);
      await atomicWrite(this.paths(record.id).run, snapshot);
    });
  }

  async appendEvent(event: DurableWorkflowEvent): Promise<void> {
    validateRunId(event.runId);
    const snapshot = jsonLine(event);
    await this.withRunWriter(event.runId, async () => {
      await appendDurable(this.paths(event.runId).events, snapshot);
    });
  }

  async readEvents(runId: string): Promise<DurableWorkflowEvent[]> {
    return readJsonLines<DurableWorkflowEvent>(this.paths(runId).events);
  }

  async writeOutput(runId: string, output: EncodedWorkflowOutput): Promise<void> {
    validateRunId(runId);
    const snapshot = jsonLine(output);
    await this.withRunWriter(runId, async () => {
      await requireRunDirectory(this.paths(runId).runDir);
      await atomicWrite(this.paths(runId).output, snapshot);
    });
  }

  async readOutput(runId: string): Promise<EncodedWorkflowOutput> {
    const value = JSON.parse(await readFile(this.paths(runId).output, "utf8")) as unknown;
    return cloneCanonicalJson(value) as unknown as EncodedWorkflowOutput;
  }

  /** Append a recovery decision/checkpoint. Entries are strict canonical JSON. */
  async appendJournal(runId: string, entry: JsonValue): Promise<void> {
    validateRunId(runId);
    const detached = cloneCanonicalJson(entry);
    await this.withRunWriter(runId, async () => {
      await appendDurable(this.paths(runId).journal, jsonLine(detached));
    });
  }

  async readJournal(runId: string): Promise<JsonValue[]> {
    return readJsonLines<JsonValue>(this.paths(runId).journal);
  }

  /** Run an arbitrary store transaction behind this run's single writer. */
  withRunWriter<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const key = this.paths(runId).runDir;
    const previous = writerQueues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    const tail = result.then(() => undefined, () => undefined);
    writerQueues.set(key, tail);
    void tail.finally(() => {
      if (writerQueues.get(key) === tail) writerQueues.delete(key);
    });
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
    await handle.close();
    handle = undefined;
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
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createEmpty(destination: string): Promise<void> {
  const handle = await open(destination, "wx", 0o600);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Some platforms/filesystems do not permit directory fsync. File fsync and
    // atomic rename still provide the strongest available behavior there.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function requireRunDirectory(directory: string): Promise<void> {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`workflow run path is not a directory: ${directory}`);
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  const contents = await readFile(file, "utf8");
  if (contents.length === 0) return [];
  return contents.split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch (error) { throw new SyntaxError(`invalid JSONL at ${file}:${index + 1}`, { cause: error }); }
  });
}

function jsonLine(value: unknown): string {
  return JSON.stringify(cloneCanonicalJson(value)) + "\n";
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) || runId === "." || runId === "..") {
    throw new TypeError("runId must be a safe 1-128 character identifier");
  }
}

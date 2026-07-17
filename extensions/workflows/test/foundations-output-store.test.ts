import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DurableWorkflowEvent } from "../core/contracts.js";
import { createWorkflowRunRecord } from "../core/reducer.js";
import { encodeWorkflowOutput } from "../core/output-encoder.js";
import { WorkflowRunStore } from "../core/run-store.js";

test("tagged output preserves special values, cycles, aliases, and built-ins", () => {
  const shared = { answer: 42 };
  const error = new Error("bad", { cause: shared });
  const root: Record<string, unknown> = {
    bigint: 12n,
    missing: undefined,
    nan: NaN,
    infinity: Infinity,
    date: new Date("2020-01-02T03:04:05.000Z"),
    error,
    map: new Map([[shared, new Set([1, 2])]]),
    binary: new Uint8Array([1, 2, 3]),
    first: shared,
    second: shared,
  };
  root.self = root;

  const encoded = encodeWorkflowOutput(root);
  const json = JSON.stringify(encoded);
  assert.equal(encoded.truncated, false);
  assert.match(json, /"bigint"/);
  assert.match(json, /"undefined"/);
  assert.match(json, /"NaN"/);
  assert.match(json, /"date"/);
  assert.match(json, /"error"/);
  assert.match(json, /"map"/);
  assert.match(json, /"set"/);
  assert.match(json, /"typed-array"/);
  assert.match(json, /"ref"/);
});

test("output limits produce explicit tags and an actually bounded envelope", () => {
  const deep: { next?: unknown; text: string; bytes: Uint8Array; many: number[] } = {
    text: "é".repeat(100), bytes: new Uint8Array(100), many: Array.from({ length: 100 }, (_, index) => index),
  };
  deep.next = { next: { next: { value: true } } };
  const encoded = encodeWorkflowOutput(deep, {
    maxBytes: 256,
    maxDepth: 2,
    maxNodes: 20,
    maxCollectionItems: 3,
    maxStringBytes: 8,
    maxBinaryBytes: 4,
  });
  assert.equal(encoded.truncated, true);
  assert.ok(encoded.truncations > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(encoded), "utf8") <= 256);
});

test("run store creates durable layout, atomically replaces snapshots, and serializes appends", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "workflow-store-"));
  try {
    const store = new WorkflowRunStore(path.join(temporary, "runs"));
    const record = createWorkflowRunRecord({
      id: "hermetic-run",
      input: { source: { kind: "inline", script: "return 1" }, args: { safe: true } },
      createdAt: 100,
    });
    const paths = await store.createRun(record);
    assert.deepEqual((await readdir(paths.runDir)).sort(), ["events.jsonl", "journal.jsonl", "run.json"]);
    assert.deepEqual(await store.readRun(record.id), record);

    const events: DurableWorkflowEvent[] = Array.from({ length: 50 }, (_, index) => ({
      schemaVersion: 1,
      runId: record.id,
      sequence: index + 1,
      timestamp: 101 + index,
      event: { type: "RunStarted" },
    }));
    await Promise.all(events.map((event) => store.appendEvent(event)));
    assert.deepEqual((await store.readEvents(record.id)).map((event) => event.sequence), events.map((event) => event.sequence));

    await Promise.all(Array.from({ length: 30 }, (_, index) => store.appendJournal(record.id, { index })));
    assert.deepEqual((await store.readJournal(record.id)).map((entry) => (entry as { index: number }).index), Array.from({ length: 30 }, (_, i) => i));

    const output = encodeWorkflowOutput({ ok: true });
    await store.writeOutput(record.id, output);
    assert.deepEqual(await store.readOutput(record.id), output);
    assert.equal(JSON.parse(await readFile(paths.output, "utf8")).encoding, "tagged-json-v1");
    assert.equal((await readdir(paths.runDir)).some((name) => name.endsWith(".tmp")), false);

    await assert.rejects(() => store.appendJournal(record.id, { bad: Infinity } as never), /non-finite/);
    assert.throws(() => store.paths("../escape"), /runId/);
    await assert.rejects(() => store.createRun(record), /EEXIST/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

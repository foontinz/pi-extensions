import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import usageExtension from "../index.js";
import { loadUsageData } from "../core.js";

interface AssistantLineOptions {
  id?: string;
  timestamp?: string;
  model?: string;
  total?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function assistantLine({
  id = "entry",
  timestamp = "2026-07-10T12:00:00.000Z",
  model = "test-model",
  total = 1,
  input = 0.1,
  output = 0.2,
  cacheRead = 0,
  cacheWrite = 0,
}: AssistantLineOptions = {}): string {
  return JSON.stringify({
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      model,
      usage: { cost: { total, input, output, cacheRead, cacheWrite } },
    },
  });
}

async function withAgentDir(run: (root: string, agentDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-usage-test-"));
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(agentDir, { recursive: true });
  try {
    await run(root, agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSession(dir: string, name: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

test("/usage scans SessionManager's effective session directory and caches under getAgentDir", async () => {
  await withAgentDir(async (root, agentDir) => {
    const configuredSessions = join(root, "configured-sessions");
    const defaultSessions = join(agentDir, "sessions");
    await writeSession(configuredSessions, "configured.jsonl", assistantLine({ id: "configured", total: 1.25 }));
    await writeSession(defaultSessions, "ignored.jsonl", assistantLine({ id: "ignored", total: 99 }));

    let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    usageExtension({
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        assert.equal(name, "usage");
        command = options;
      },
    } as unknown as Parameters<typeof usageExtension>[0]);

    await command!.handler("", {
      sessionManager: { getSessionDir: () => configuredSessions },
      ui: {
        notify() {},
        custom: async () => undefined,
      },
    });

    const cache = JSON.parse(await readFile(join(agentDir, "usage-cache.json"), "utf8")) as {
      files: Array<[string, unknown]>;
    };
    assert.deepEqual(cache.files.map(([path]) => path), [join(configuredSessions, "configured.jsonl")]);
  });
});

test("rescans a changed growing file instead of assuming its old contents are an append-only prefix", async () => {
  await withAgentDir(async (root) => {
    const sessions = join(root, "sessions");
    const file = await writeSession(sessions, "active.jsonl", `${assistantLine({ id: "old", total: 1 })}\n`);
    assert.equal((await loadUsageData(sessions)).grand.total, 1);

    await writeFile(file, `${assistantLine({ id: "replacement", total: 2 })}\n${assistantLine({ id: "new", total: 3 })}\n`, "utf8");
    // Ensure a coarse filesystem timestamp cannot make this look unchanged.
    const later = new Date(Date.now() + 2_000);
    await utimes(file, later, later);

    const data = await loadUsageData(sessions);
    assert.equal(data.grand.total, 5);
    assert.equal(data.grand.turns, 2);
  });
});

test("reads a complete final JSONL record without a trailing newline", async () => {
  await withAgentDir(async (root) => {
    const sessions = join(root, "sessions");
    await writeSession(sessions, "final-line.jsonl", assistantLine({ id: "final", total: 4.5 }));

    const data = await loadUsageData(sessions);
    assert.equal(data.grand.total, 4.5);
    assert.equal(data.grand.turns, 1);
  });
});

test("isolates a missing or unreadable session path from valid session files", async () => {
  await withAgentDir(async (root) => {
    const sessions = join(root, "sessions");
    await writeSession(sessions, "valid.jsonl", assistantLine({ id: "valid", total: 2 }));
    await symlink(join(sessions, "does-not-exist"), join(sessions, "broken.jsonl"));

    const data = await loadUsageData(sessions);
    assert.equal(data.grand.total, 2);
    assert.equal(data.grand.turns, 1);
  });
});

test("deduplicates copied assistant entry IDs and safely aggregates a __proto__ model", async () => {
  await withAgentDir(async (root) => {
    const sessions = join(root, "sessions");
    await writeSession(
      sessions,
      "source.jsonl",
      `${assistantLine({ id: "copied", model: "__proto__", total: 1 })}\n${assistantLine({ id: "unique", total: 2 })}\n`,
    );
    await writeSession(
      join(sessions, "fork"),
      "clone.jsonl",
      `${assistantLine({ id: "copied", model: "__proto__", total: 1 })}\n`,
    );

    const data = await loadUsageData(sessions);
    assert.equal(data.grand.total, 3);
    assert.equal(data.grand.turns, 2);
    assert.deepEqual(data.models.get("__proto__"), {
      turns: 1,
      input: 0.1,
      output: 0.2,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1,
    });
    assert.equal((Object.prototype as { turns?: unknown }).turns, undefined);
  });
});

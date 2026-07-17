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
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
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
  inputTokens = 100,
  outputTokens = 50,
  reasoningTokens = 0,
}: AssistantLineOptions = {}): string {
  return JSON.stringify({
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      model,
      usage: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: reasoningTokens,
        cost: { total, input, output, cacheRead, cacheWrite },
      },
    },
  });
}

function sessionHeaderLine(cwd: string, timestamp = "2026-07-10T11:00:00.000Z"): string {
  return JSON.stringify({ type: "session", version: 3, id: "session-id", timestamp, cwd });
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
    assert.equal((await loadUsageData(sessions)).grand.cost.total, 1);

    await writeFile(file, `${assistantLine({ id: "replacement", total: 2 })}\n${assistantLine({ id: "new", total: 3 })}\n`, "utf8");
    // Ensure a coarse filesystem timestamp cannot make this look unchanged.
    const later = new Date(Date.now() + 2_000);
    await utimes(file, later, later);

    const data = await loadUsageData(sessions);
    assert.equal(data.grand.cost.total, 5);
    assert.equal(data.grand.turns, 2);
  });
});

test("reads a complete final JSONL record without a trailing newline", async () => {
  await withAgentDir(async (root) => {
    const sessions = join(root, "sessions");
    await writeSession(sessions, "final-line.jsonl", assistantLine({ id: "final", total: 4.5 }));

    const data = await loadUsageData(sessions);
    assert.equal(data.grand.cost.total, 4.5);
    assert.equal(data.grand.turns, 1);
  });
});

test("isolates a missing or unreadable session path from valid session files", async () => {
  await withAgentDir(async (root) => {
    const sessions = join(root, "sessions");
    await writeSession(sessions, "valid.jsonl", assistantLine({ id: "valid", total: 2 }));
    await symlink(join(sessions, "does-not-exist"), join(sessions, "broken.jsonl"));

    const data = await loadUsageData(sessions);
    assert.equal(data.grand.cost.total, 2);
    assert.equal(data.grand.turns, 1);
  });
});

test("aggregates token counts and groups entries by session-header project", async () => {
  await withAgentDir(async (root) => {
    const sessions = join(root, "sessions");
    await writeSession(
      join(sessions, "--Users-alice-dev-app--"),
      "a.jsonl",
      `${sessionHeaderLine("/Users/alice/dev/app")}\n` +
      `${assistantLine({ id: "a1", total: 1, inputTokens: 1000, outputTokens: 200, reasoningTokens: 30 })}\n` +
      `${assistantLine({ id: "a2", total: 2, inputTokens: 500, outputTokens: 100 })}\n`,
    );
    // No header: project falls back to the containing directory name.
    await writeSession(join(sessions, "--Users-alice-dev-other--"), "b.jsonl", `${assistantLine({ id: "b1", total: 4 })}\n`);

    const data = await loadUsageData(sessions);
    assert.equal(data.grand.cost.total, 7);
    assert.equal(data.grand.tokens.input, 1600);
    assert.equal(data.grand.tokens.output, 350);
    assert.equal(data.grand.tokens.reasoning, 30);

    const app = data.projects.get("/Users/alice/dev/app");
    assert.ok(app);
    assert.equal(app.turns, 2);
    assert.equal(app.cost.total, 3);
    assert.equal(app.tokens.input, 1500);

    const other = data.projects.get("--Users-alice-dev-other--");
    assert.ok(other);
    assert.equal(other.cost.total, 4);
  });
});

test("token counts survive the on-disk cache round trip", async () => {
  await withAgentDir(async (root) => {
    const sessions = join(root, "sessions");
    await writeSession(
      join(sessions, "proj"),
      "a.jsonl",
      `${sessionHeaderLine("/Users/alice/proj")}\n${assistantLine({ id: "a1", total: 1, inputTokens: 777 })}\n`,
    );

    const first = await loadUsageData(sessions);
    assert.equal(first.grand.tokens.input, 777);

    // Second load resolves entirely from the cache (stamps unchanged).
    const second = await loadUsageData(sessions);
    assert.equal(second.grand.tokens.input, 777);
    assert.equal(second.projects.get("/Users/alice/proj")?.turns, 1);
  });
});

test("counts zero-cost turns with tokens but skips turns with neither cost nor tokens", async () => {
  await withAgentDir(async (root) => {
    const sessions = join(root, "sessions");
    await writeSession(
      sessions,
      "free-model.jsonl",
      `${assistantLine({ id: "free", model: "local-model", total: 0, input: 0, output: 0, inputTokens: 500, outputTokens: 40 })}\n` +
      `${assistantLine({ id: "empty", total: 0, input: 0, output: 0, inputTokens: 0, outputTokens: 0 })}\n` +
      `${assistantLine({ id: "paid", total: 2 })}\n`,
    );

    const data = await loadUsageData(sessions);
    assert.equal(data.grand.turns, 2);
    assert.equal(data.grand.cost.total, 2);
    assert.equal(data.grand.tokens.input, 600);

    const free = data.models.get("local-model");
    assert.ok(free);
    assert.equal(free.turns, 1);
    assert.equal(free.cost.total, 0);
    assert.equal(free.tokens.input, 500);
  });
});

test("attributes forked history to the original project regardless of file-walk order", async () => {
  await withAgentDir(async (root) => {
    const sessions = join(root, "sessions");
    // The fork's directory sorts before the original's, so the walk sees the
    // fork first; the original must still win via its earlier session start.
    await writeSession(
      join(sessions, "a-fork-project"),
      "2026-07-12T10-00-00-000Z_fork.jsonl",
      `${sessionHeaderLine("/Users/alice/fork-target", "2026-07-12T10:00:00.000Z")}\n` +
      `${assistantLine({ id: "copied", total: 5 })}\n`,
    );
    await writeSession(
      join(sessions, "z-original-project"),
      "2026-07-10T10-00-00-000Z_orig.jsonl",
      `${sessionHeaderLine("/Users/alice/original", "2026-07-10T10:00:00.000Z")}\n` +
      `${assistantLine({ id: "copied", total: 5 })}\n`,
    );

    const data = await loadUsageData(sessions);
    assert.equal(data.grand.turns, 1);
    assert.equal(data.grand.cost.total, 5);
    assert.equal(data.projects.get("/Users/alice/original")?.cost.total, 5);
    assert.equal(data.projects.get("/Users/alice/fork-target"), undefined);
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
    assert.equal(data.grand.cost.total, 3);
    assert.equal(data.grand.turns, 2);
    const proto = data.models.get("__proto__");
    assert.ok(proto);
    assert.equal(proto.turns, 1);
    assert.equal(proto.cost.total, 1);
    assert.equal(proto.cost.input, 0.1);
    assert.equal(proto.cost.output, 0.2);
    assert.equal((Object.prototype as { turns?: unknown }).turns, undefined);
  });
});

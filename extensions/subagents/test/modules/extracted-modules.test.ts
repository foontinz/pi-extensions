import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { getLogWindow } from "../../output/log-window.js";
import { previewToolResult } from "../../output/message-format.js";
import { parseOptionalNonNegativeIntegerEnv } from "../../platform/env.js";
import { validateToolSelection } from "../../policy/tool-selection.js";
import { formatJobSummaryLine, summarizeJob } from "../../tool-output/format-poll.js";
import { compactJobState, formatStatusTable, type StatusTheme } from "../../ui/status-widget.js";
import { getPostCopyTrust, rememberPostCopyTrust } from "../../workspace/post-copy-trust.js";
import { normalizeWorktreeEnvConfig } from "../../workspace/worktree-config.js";

const plainTheme: StatusTheme = { fg: (_role, text) => text };

test("extracted tool selection module validates default and rejected tools directly", () => {
  const defaultSelection = validateToolSelection(["bash", "find", "ls", "read"], undefined);
  assert.equal(defaultSelection.ok, true);
  assert.deepEqual(defaultSelection.tools, ["read", "find", "ls"]);

  const rejected = validateToolSelection(["read"], ["read", "bash"]);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /not active/);
});

test("extracted env parser handles unset, invalid, and valid non-negative integers", () => {
  assert.equal(parseOptionalNonNegativeIntegerEnv("MISSING", 7, {}), 7);
  assert.equal(parseOptionalNonNegativeIntegerEnv("BAD", 7, { BAD: "-1" }), 7);
  assert.equal(parseOptionalNonNegativeIntegerEnv("OK", 7, { OK: "12.9" }), 12);
});

test("extracted log window reports truncation and expired cursors directly", () => {
  const window = getLogWindow([{ seq: 5 }, { seq: 6 }, { seq: 7 }], 0, 2);
  assert.deepEqual(window.logs.map((entry) => entry.seq), [5, 6]);
  assert.equal(window.logWindowStartSeq, 5);
  assert.equal(window.logWindowEndSeq, 7);
  assert.equal(window.logsTruncated, true);
  assert.equal(window.cursorExpired, true);
});

test("extracted message formatter handles unknown and malformed tool results", () => {
  assert.equal(previewToolResult("hello"), "hello");
  assert.equal(previewToolResult({ content: [{ type: "text", text: "ok" }, { type: "image" }, { bogus: true }] }), "ok [image]");
  assert.equal(previewToolResult({ content: [{ type: "text", text: 123 }] }), "");

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(previewToolResult(circular), "[object Object]");
});

test("extracted worktree config normalizer is directly importable", () => {
  const normalized = normalizeWorktreeEnvConfig({
    copy: [{ from: "./src/../src", optional: true }],
    exclude: ["./dist/**"],
    postCopy: [{ command: " npm install ", cwd: ".", timeoutMs: 123 }],
    keepWorktree: "onFailure",
  });

  assert.deepEqual(normalized.copy, [{ from: "src", to: undefined, optional: true }]);
  assert.deepEqual(normalized.exclusions, ["dist/**"]);
  assert.equal(normalized.postCopy[0]?.command, "npm install");
  assert.equal(normalized.keepWorktree, "onFailure");
});

test("extracted postCopy trust store remembers canonical script configs directly", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagents-direct-trust-test-"));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(repoRoot);
    const options = { defaultStorePath: path.join(temp, "trust.json") };
    const first = await getPostCopyTrust(repoRoot, [
      { command: "npm install", cwd: ".", timeoutMs: 120_000, optional: false, env: { B: "2", A: "1" } },
    ], options);
    assert.equal(first.trusted, false);

    await rememberPostCopyTrust(first, options);

    const second = await getPostCopyTrust(repoRoot, [
      { command: "npm install", cwd: ".", timeoutMs: 120_000, optional: false, env: { A: "1", B: "2" } },
    ], options);
    assert.equal(second.trusted, true);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("extracted poll formatter exposes a named summary contract", () => {
  const summary = summarizeJob({
    id: "agent_abc_deadbeef",
    label: "review",
    task: "task",
    effectiveTools: ["read"],
    cwd: "/repo",
    sourceCwd: "/repo",
    supervisor: "tmux",
    status: "running",
    startedAt: 1_000,
    updatedAt: 1_000,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    messageCount: 0,
    nextSeq: 3,
    logs: [],
  }, {
    suggestedPollIntervalMs: 15_000,
    rawLogLimitBytes: 1_000,
    rawLogSizes: { total: 0 },
  });

  assert.equal(summary.nextSeq, 2);
  assert.match(formatJobSummaryLine(summary), /agent_abc_deadbeef \[running\]/);
});

test("extracted status widget uses a narrow theme interface", () => {
  const rows = formatStatusTable([
    {
      id: "agent_abc_deadbeef",
      label: "review agent",
      status: "completed",
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now(),
      finishedAt: Date.now(),
      finalOutput: "final result",
    },
  ], plainTheme, () => undefined);

  assert.equal(rows[0], "subagents");
  assert.match(rows.join("\n"), /review-agent/);
  assert.equal(compactJobState({ id: "a", label: "b", status: "failed", startedAt: 1, updatedAt: 1, cleanupError: "bad cleanup" }, () => undefined), "cleanup-failed bad cleanup");
});

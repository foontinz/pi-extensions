import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { JOB_RECORD_SCHEMA_VERSION, emptyUsageStats, initialLogCursor } from "../../core/types.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-tool-contracts-"));
process.env.PI_SUBAGENTS_STORE_DIR = path.join(tmpRoot, "store");
process.env.PI_SUBAGENTS_MAX_RUNNING = "1";
process.env.PI_SUBAGENTS_MAX_RUNNING_PER_REPO = "1";

const { default: subagentsExtension, __subagentsTest } = await import("../../index.js");

type RegisteredTool = { execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: () => void, ctx: any) => Promise<any> | any; renderCall?: (...args: any[]) => any; renderResult?: (...args: any[]) => any };

function registerTools(activeTools = ["read", "grep", "find", "ls"]): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    on() {},
    registerTool(tool: RegisteredTool & { name: string }) {
      tools.set(tool.name, tool);
    },
    getActiveTools() {
      return activeTools;
    },
  };
  subagentsExtension(pi as any);
  return tools;
}

const tools = registerTools();
const cwd = fs.mkdtempSync(path.join(tmpRoot, "cwd-"));
const ctx = { cwd, hasUI: false };

function textOf(result: any): string {
  return result.content?.map((part: any) => part.text ?? "").join("\n") ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "subagents-test@example.com"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Subagents Test"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(repo, "README.md"), "test repo\n", "utf-8");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "file.txt"), "source\n", "utf-8");
  execFileSync("git", ["add", "README.md", "src/file.txt"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  return fs.realpathSync(repo);
}

function createFakeTmux(config: Record<string, unknown> = {}) {
  const binDir = fs.mkdtempSync(path.join(tmpRoot, "fake-tmux-bin-"));
  const statePath = path.join(binDir, "state.json");
  const initialState = { sessions: {}, sendKeysOk: true, killOk: true, ...config };
  fs.writeFileSync(statePath, JSON.stringify(initialState), "utf-8");
  const tmuxPath = path.join(binDir, "tmux");
  fs.writeFileSync(tmuxPath, `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
function readState() { return JSON.parse(fs.readFileSync(statePath, "utf-8")); }
function writeState(state) { fs.writeFileSync(statePath, JSON.stringify(state), "utf-8"); }
function valueAfter(args, flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
function exitPathFromScript(script) {
  const quoted = [...script.matchAll(/> '([^']+\\.exit)'/g)];
  if (quoted.length > 0) return quoted[quoted.length - 1][1];
  const unquoted = [...script.matchAll(/> ([^ ;]+\\.exit)/g)];
  return unquoted.length > 0 ? unquoted[unquoted.length - 1][1] : undefined;
}
const args = process.argv.slice(2);
const command = args[0];
let state = readState();
if (command === "-V") { console.log("tmux 3.4-fake"); process.exit(0); }
if (command === "new-session") {
  const session = valueAfter(args, "-s");
  const cwd = valueAfter(args, "-c");
  const script = args[args.length - 1] || "";
  if (!session || state.newSessionOk === false) process.exit(1);
  state.sessions[session] = { cwd, script, exitCodePath: exitPathFromScript(script) };
  writeState(state);
  process.exit(0);
}
if (command === "has-session") {
  const session = valueAfter(args, "-t");
  process.exit(session && state.sessions[session] ? 0 : 1);
}
if (command === "list-sessions") {
  for (const session of Object.keys(state.sessions)) console.log(session);
  process.exit(0);
}
if (command === "send-keys") {
  const session = valueAfter(args, "-t");
  if (!session || !state.sessions[session] || state.sendKeysOk === false) process.exit(1);
  if (state.exitOnSendKeys) {
    const exitPath = state.sessions[session].exitCodePath;
    if (exitPath) fs.writeFileSync(exitPath, String(state.exitOnSendKeysCode ?? 130) + "\\n", "utf-8");
    delete state.sessions[session];
    writeState(state);
  }
  process.exit(0);
}
if (command === "kill-session") {
  const session = valueAfter(args, "-t");
  if (!session || !state.sessions[session] || state.killOk === false) process.exit(1);
  if (state.exitOnKill) {
    const exitPath = state.sessions[session].exitCodePath;
    if (exitPath) fs.writeFileSync(exitPath, String(state.exitOnKillCode ?? 137) + "\\n", "utf-8");
  }
  delete state.sessions[session];
  writeState(state);
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  return {
    binDir,
    statePath,
    readState() {
      return JSON.parse(fs.readFileSync(statePath, "utf-8"));
    },
    setState(patch: Record<string, unknown>) {
      fs.writeFileSync(statePath, JSON.stringify({ ...this.readState(), ...patch }), "utf-8");
    },
  };
}

async function withFakeTmux<T>(config: Record<string, unknown>, action: (fake: ReturnType<typeof createFakeTmux>) => Promise<T>): Promise<T> {
  const fake = createFakeTmux(config);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fake.binDir}${path.delimiter}${previousPath ?? ""}`;
  __subagentsTest.resetTmuxAvailabilityCache();
  try {
    return await action(fake);
  } finally {
    process.env.PATH = previousPath;
    __subagentsTest.resetTmuxAvailabilityCache();
  }
}

function appendJsonl(filePath: string, events: unknown[]) {
  fs.appendFileSync(filePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8");
}

function jobFor(id: string): any {
  const job = __subagentsTest.getJob(id);
  assert.ok(job);
  return job;
}

function exitCodePathFor(id: string): string {
  const job = jobFor(id);
  assert.ok(job.exitCodePath);
  return job.exitCodePath;
}

function assistantEndEvent(text: string) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { total: 0.001 } },
    },
  };
}

function toolEndEvent() {
  return { type: "tool_execution_end", toolName: "read", args: { path: "x" }, result: { content: [{ type: "text", text: "tool output" }] }, isError: false };
}

function makeStatusCtx() {
  const calls: any[] = [];
  return {
    cwd,
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus(key: string, value: string | undefined) { calls.push({ kind: "status", key, value }); },
      setWidget(key: string, value: string[] | undefined, options?: unknown) { calls.push({ kind: "widget", key, value, options }); },
    },
    calls,
  } as any;
}

function makeJob(overrides: Record<string, any> = {}) {
  const now = overrides.startedAt ?? 1_700_000_000_000;
  const id = overrides.id ?? "agent_contract_1";
  const phase = overrides.phase ?? overrides.status ?? "running";
  const status = overrides.status ?? (phase === "completed" || phase === "failed" || phase === "cancelled" ? phase : "running");
  const terminal = status === "running" ? undefined : {
    phase: status,
    reason: status === "completed" ? "completed" : status === "cancelled" ? "stop" : "error",
    finishedAt: overrides.finishedAt ?? now + 1_000,
    exitCode: status === "completed" ? 0 : 1,
    message: overrides.errorMessage,
    error: status === "failed" ? overrides.errorMessage : undefined,
  };
  const record = {
    schemaVersion: JOB_RECORD_SCHEMA_VERSION,
    id,
    label: overrides.label ?? "contract job",
    task: overrides.task ?? "do contract work",
    sourceCwd: overrides.sourceCwd ?? cwd,
    cwd: overrides.cwd ?? cwd,
    phase,
    cleanupPhase: overrides.cleanupPhase ?? "none",
    supervisor: overrides.supervisor ?? "process",
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now,
    startedAt: now,
    terminal,
    logCursor: initialLogCursor(),
    usage: emptyUsageStats(),
  };
  return {
    record,
    id,
    label: record.label,
    task: record.task,
    effectiveTools: overrides.effectiveTools ?? ["read"],
    cwd: record.cwd,
    sourceCwd: record.sourceCwd,
    repoKey: overrides.repoKey ?? record.sourceCwd,
    command: "pi",
    args: [],
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    finishedAt: terminal?.finishedAt,
    status,
    phase,
    cleanupPhase: record.cleanupPhase,
    terminal,
    exitCode: terminal?.exitCode,
    messageCount: overrides.messageCount ?? 0,
    logs: overrides.logs ?? [],
    nextSeq: overrides.nextSeq ?? ((overrides.logs?.length ?? 0) + 1),
    stderr: "",
    stdoutBuffer: "",
    stderrBuffer: "",
    latestAssistantText: overrides.latestAssistantText ?? "",
    pendingAssistantDelta: "",
    lastAssistantDeltaLogAt: 0,
    finalOutput: overrides.finalOutput,
    errorMessage: overrides.errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    supervisor: overrides.supervisor ?? "process",
    stdoutOffset: 0,
    stderrOffset: 0,
    waiters: new Set<() => void>(),
    closeWaiters: new Set<() => void>(),
    ...overrides,
  } as any;
}

test.beforeEach(() => {
  __subagentsTest.clearJobs();
  fs.rmSync(process.env.PI_SUBAGENTS_STORE_DIR!, { recursive: true, force: true });
});

test.after(() => {
  __subagentsTest.clearJobs();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("poll_agent list mode characterizes empty and populated output", async () => {
  const empty = await tools.get("poll_agent")!.execute("call", {}, new AbortController().signal, () => {}, ctx);
  assert.equal(textOf(empty), "No background agent jobs are known in this Pi session.");
  assert.deepEqual(empty.details.jobs, []);

  __subagentsTest.putJob(makeJob({ id: "agent_contract_list", label: "listed" }));
  const populated = await tools.get("poll_agent")!.execute("call", {}, new AbortController().signal, () => {}, ctx);
  assert.match(textOf(populated), /^agent_contract_list \[running\] adhoc age=/);
  assert.match(textOf(populated), /label=listed/);
  assert.equal(populated.details.jobs[0].id, "agent_contract_list");
  assert.equal(populated.details.jobs[0].status, "running");
});

test("poll_agent unknown id returns known ids and summary details", async () => {
  __subagentsTest.putJob(makeJob({ id: "agent_known" }));
  const result = await tools.get("poll_agent")!.execute("call", { id: "agent_missing" }, new AbortController().signal, () => {}, ctx);
  assert.equal(textOf(result), "Unknown agent job id: agent_missing. Known ids: agent_known");
  assert.equal(result.details.id, "agent_missing");
  assert.deepEqual(result.details.jobs.map((job: any) => job.id), ["agent_known"]);
});

test("poll_agent summary/logs/full modes expose cursor metadata and final-output preview", async () => {
  __subagentsTest.putJob(makeJob({
    id: "agent_modes",
    status: "completed",
    phase: "completed",
    logs: [
      { seq: 3, timestamp: 1_700_000_000_100, level: "info", text: "started" },
      { seq: 4, timestamp: 1_700_000_000_200, level: "assistant", text: "assistant: done" },
    ],
    nextSeq: 5,
    finalOutput: "final answer\nwith details",
  }));

  const summary = await tools.get("poll_agent")!.execute("call", { id: "agent_modes", sinceSeq: 0 }, new AbortController().signal, () => {}, ctx);
  assert.match(textOf(summary), /agent_modes \[completed\]/);
  assert.match(textOf(summary), /nextSeq: 4; newEvents: 2; logWindow: 3-4/);
  assert.match(textOf(summary), /warning: sinceSeq 0 predates retained logs/);
  assert.match(textOf(summary), /result: final answer/);
  assert.equal(summary.details.nextSeq, 4);
  assert.equal(summary.details.logWindowStartSeq, 3);
  assert.equal(summary.details.logWindowEndSeq, 4);
  assert.equal(summary.details.logsTruncated, false);
  assert.equal(summary.details.cursorExpired, true);
  assert.equal(summary.details.logs, undefined);

  const logs = await tools.get("poll_agent")!.execute("call", { id: "agent_modes", sinceSeq: 2, verbosity: "logs", maxLogEntries: 1 }, new AbortController().signal, () => {}, ctx);
  assert.match(textOf(logs), /nextSeq: 3 \(more logs available; poll again with this sinceSeq\); logWindow: 3-4/);
  assert.match(textOf(logs), /\s+3 \d\d:\d\d:\d\d info\s+started/);
  assert.equal(logs.details.logs.length, 1);
  assert.equal(logs.details.nextSeq, 3);
  assert.equal(logs.details.logsTruncated, true);
  assert.equal(logs.details.hasMoreLogs, true);
  assert.equal(logs.details.finalOutput, "final answer / with details");

  const full = await tools.get("poll_agent")!.execute("call", { id: "agent_modes", verbosity: "full" }, new AbortController().signal, () => {}, ctx);
  assert.match(textOf(full), /Final output:\nfinal answer\nwith details/);
  assert.equal(full.details.finalOutput, "final answer\nwith details");
});

test("poll_agent waitMs long-poll returns after a running job update", async () => {
  const job = makeJob({ id: "agent_wait", nextSeq: 1 });
  __subagentsTest.putJob(job);
  const started = Date.now();
  const pending = tools.get("poll_agent")!.execute("call", { id: "agent_wait", sinceSeq: 0, verbosity: "logs", waitMs: 5_000 }, new AbortController().signal, () => {}, ctx);
  setTimeout(() => {
    job.logs.push({ seq: 1, timestamp: Date.now(), level: "info", text: "arrived" });
    job.nextSeq = 2;
    for (const waiter of job.waiters) waiter();
  }, 25);
  const result = await pending;
  assert.ok(Date.now() - started < 1_000);
  assert.match(textOf(result), /\s+1 \d\d:\d\d:\d\d info\s+arrived/);
  assert.equal(result.details.nextSeq, 1);
});

test("stop_agent characterizes unknown, terminal, and repeated-stop responses", async () => {
  const unknown = await tools.get("stop_agent")!.execute("call", { id: "agent_nope" }, new AbortController().signal, () => {}, ctx);
  assert.equal(textOf(unknown), "Unknown agent job id: agent_nope. Known ids: none");
  assert.deepEqual(unknown.details, {});

  __subagentsTest.putJob(makeJob({ id: "agent_done", status: "completed", phase: "completed", finalOutput: "done" }));
  const completed = await tools.get("stop_agent")!.execute("call", { id: "agent_done" }, new AbortController().signal, () => {}, ctx);
  assert.equal(textOf(completed), "Agent agent_done is already completed.");
  assert.equal(completed.details.id, "agent_done");
  assert.equal(completed.details.status, "completed");

  const repeated = await tools.get("stop_agent")!.execute("call", { id: "agent_done", reason: "again" }, new AbortController().signal, () => {}, ctx);
  assert.equal(textOf(repeated), "Agent agent_done is already completed.");
});

test("run_agent characterizes public refusal paths before launch", async () => {
  const unknownAgent = await tools.get("run_agent")!.execute("call", { task: "x", agent: "missing" }, new AbortController().signal, () => {}, ctx);
  assert.match(textOf(unknownAgent), /^Unknown agent "missing"\. Available agents for scope "user":/);
  assert.deepEqual(unknownAgent.details.availableAgents, []);

  const invalidTools = await tools.get("run_agent")!.execute("call", { task: "x", tools: ["read", "bash"] }, new AbortController().signal, () => {}, ctx);
  assert.equal(textOf(invalidTools), "Refusing to start subagent with tools not active in the parent session: bash. Active tools: find, grep, ls, read.");
  assert.deepEqual(invalidTools.details.requestedTools, ["bash", "read"]);

  __subagentsTest.putJob(makeJob({ id: "agent_capacity", repoKey: cwd }));
  const capacity = await tools.get("run_agent")!.execute("call", { task: "x" }, new AbortController().signal, () => {}, ctx);
  assert.match(textOf(capacity), /Refusing to start subagent: 1 running jobs already meet PI_SUBAGENTS_MAX_RUNNING=1/);
  assert.equal(capacity.details.running, 1);
  assert.equal(capacity.details.maxRunning, 1);
});

test("run_agent pre-start failure returns a failed job contract when tmux is unavailable", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(tmpRoot, "empty-path-"));
  __subagentsTest.resetTmuxAvailabilityCache();
  try {
    const result = await tools.get("run_agent")!.execute("call", { task: "x", label: "no tmux", worktree: false }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(result), /^Failed to start background agent agent_/);
    assert.match(textOf(result), /Status: failed/);
    assert.match(textOf(result), /Label: no tmux/);
    assert.match(textOf(result), /Error: (Cannot start subagent: tmux is required|failed to start tmux subagent: spawn tmux ENOENT)/);
    assert.equal(result.details.status, "failed");
    assert.equal(result.details.phase, "failed");
    assert.equal(result.details.label, "no tmux");
    assert.match(result.details.errorMessage, /(tmux is required|spawn tmux ENOENT)/);
  } finally {
    process.env.PATH = previousPath;
    __subagentsTest.resetTmuxAvailabilityCache();
  }
});

test("run_agent successful start text/details are characterized with fake tmux", async () => {
  await withFakeTmux({}, async (fake) => {
    const result = await tools.get("run_agent")!.execute("call", { task: "successful fake start", label: "fake success", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(result), /^Started background agent agent_/);
    assert.match(textOf(result), /Status: running/);
    assert.match(textOf(result), /Label: fake success/);
    assert.match(textOf(result), /Supervisor: tmux \(pi-agent_/);
    assert.match(textOf(result), /Tools: find, grep, ls, read/);
    assert.match(textOf(result), /Attach: tmux attach -t pi-agent_/);
    assert.match(textOf(result), new RegExp(`CWD: ${escapeRegExp(cwd)}`));
    assert.match(textOf(result), /Poll later with: poll_agent\(\{ id: "agent_/);
    assert.equal(result.details.status, "running");
    assert.equal(result.details.phase, "running");
    assert.equal(result.details.label, "fake success");
    assert.equal(result.details.cwd, cwd);
    assert.equal(result.details.worktree, undefined);
    const session = fake.readState().sessions[result.details.tmuxSession];
    assert.ok(session);
    assert.match(session.script, /PI_SUBAGENTS_CHILD=1 .* --mode json -p --no-session/);
  });
});

test("stop_agent running job Ctrl-C path finalizes when fake tmux writes an exit code", async () => {
  await withFakeTmux({ exitOnSendKeys: true, exitOnSendKeysCode: 130 }, async () => {
    const started = await tools.get("run_agent")!.execute("call", { task: "stop me", label: "stop ctrl-c", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    const result = await tools.get("stop_agent")!.execute("call", { id: started.details.id, reason: "test stop", waitMs: 100 }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(result), /^Stopped agent agent_/);
    assert.match(textOf(result), /Output drained before finalizing:/);
    assert.equal(result.details.status, "cancelled");
    assert.equal(result.details.phase, "cancelled");
    assert.equal(result.details.exitCode, 130);
    assert.equal(result.details.stopReason, "test stop");
  });
});

test("stop_agent hard-kill fallback after waitMs is characterized", async () => {
  await withFakeTmux({}, async (fake) => {
    const started = await tools.get("run_agent")!.execute("call", { task: "hard kill me", label: "hard kill", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    const result = await tools.get("stop_agent")!.execute("call", { id: started.details.id, reason: "force stop", waitMs: 0 }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(result), /^Stopped agent agent_/);
    assert.equal(result.details.status, "cancelled");
    assert.equal(result.details.phase, "cancelled");
    assert.equal(result.details.stopReason, "force stop");
    assert.equal(fake.readState().sessions[started.details.tmuxSession], undefined);
  });
});

test("stop_agent tmux kill failure keeps job running and reports failure text", async () => {
  await withFakeTmux({ sendKeysOk: false, killOk: false }, async (fake) => {
    const started = await tools.get("run_agent")!.execute("call", { task: "unstoppable", label: "kill fails", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    const result = await tools.get("stop_agent")!.execute("call", { id: started.details.id, reason: "cannot stop", waitMs: 0 }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(result), /^Failed to stop agent agent_/);
    assert.match(textOf(result), /it is still marked running/);
    assert.match(textOf(result), /Check logs and tmux session pi-agent_/);
    assert.equal(result.details.status, "running");
    assert.equal(result.details.phase, "stopping");
    assert.ok(fake.readState().sessions[started.details.tmuxSession]);
  });
});

test("poll_agent extracts assistant final output from child JSONL and reports no-output jobs", async () => {
  await withFakeTmux({}, async () => {
    const assistant = await tools.get("run_agent")!.execute("call", { task: "assistant output", label: "assistant out", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    appendJsonl(assistant.details.stdoutPath, [assistantEndEvent("answer from assistant")]);
    fs.writeFileSync(exitCodePathFor(assistant.details.id), "0\n", "utf-8");
    const assistantPoll = await tools.get("poll_agent")!.execute("call", { id: assistant.details.id, verbosity: "full" }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(assistantPoll), /Final output:\nanswer from assistant/);
    assert.equal(assistantPoll.details.job.status, "completed");
    assert.equal(assistantPoll.details.finalOutput, "answer from assistant");
    assert.equal(assistantPoll.details.job.messageCount, 1);
    assert.equal(assistantPoll.details.job.usage.turns, 1);

    const noOutput = await tools.get("run_agent")!.execute("call", { task: "no assistant output", label: "no output", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    appendJsonl(noOutput.details.stdoutPath, [{ type: "agent_start" }, { type: "agent_end" }]);
    fs.writeFileSync(exitCodePathFor(noOutput.details.id), "0\n", "utf-8");
    const noOutputPoll = await tools.get("poll_agent")!.execute("call", { id: noOutput.details.id, verbosity: "full" }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(noOutputPoll), /Final output:\n\(no final assistant output\)/);
    assert.equal(noOutputPoll.details.job.status, "completed");
    assert.equal(noOutputPoll.details.finalOutput, undefined);
  });
});

test("poll_agent keeps tool-only turns out of final output", async () => {
  await withFakeTmux({}, async () => {
    const started = await tools.get("run_agent")!.execute("call", { task: "tool only", label: "tool only", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    appendJsonl(started.details.stdoutPath, [toolEndEvent()]);
    fs.writeFileSync(exitCodePathFor(started.details.id), "0\n", "utf-8");
    const result = await tools.get("poll_agent")!.execute("call", { id: started.details.id, verbosity: "logs" }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(result), /✓ read: tool output/);
    assert.match(textOf(result), /Final output preview:\n\(no final assistant output\)/);
    assert.equal(result.details.job.status, "completed");
    assert.equal(result.details.finalOutput, undefined);
  });
});

test("poll_agent characterizes large final-output preview versus full output", async () => {
  await withFakeTmux({}, async () => {
    const large = `start ${"x".repeat(1_600)} tail-marker`;
    const started = await tools.get("run_agent")!.execute("call", { task: "large output", label: "large", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    appendJsonl(started.details.stdoutPath, [assistantEndEvent(large)]);
    fs.writeFileSync(exitCodePathFor(started.details.id), "0\n", "utf-8");

    const summary = await tools.get("poll_agent")!.execute("call", { id: started.details.id }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(summary), /result: start x+/);
    assert.match(textOf(summary), /full: poll_agent\(\{ id: "agent_.*", verbosity: "full" \}\)/);
    assert.equal(summary.details.finalOutput?.includes("tail-marker"), false);

    const full = await tools.get("poll_agent")!.execute("call", { id: started.details.id, verbosity: "full" }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(full), /Final output:\nstart /);
    assert.match(textOf(full), /tail-marker/);
    assert.equal(full.details.finalOutput, large);
  });
});

test("status widget formatting characterizes running and terminal rows", () => {
  const statusCtx = makeStatusCtx();
  const rows = __subagentsTest.formatStatusTable([
    makeJob({ id: "agent_alpha_11111111", label: "running job", status: "running", latestAssistantText: "checking repository files" }),
    makeJob({ id: "agent_beta_22222222", label: "completed job", status: "completed", phase: "completed", finalOutput: "ship final patch", finishedAt: 1_700_000_010_000 }),
    makeJob({ id: "agent_gamma_33333333", label: "failed job", status: "failed", phase: "failed", errorMessage: "boom stack trace", finishedAt: 1_700_000_010_000 }),
    makeJob({ id: "agent_delta_44444444", label: "cancelled job", status: "cancelled", phase: "cancelled", stopReason: "user requested stop", finishedAt: 1_700_000_010_000 }),
    makeJob({ id: "agent_epsilon_55555555", label: "cleanup pending", status: "failed", phase: "failed", cleanupPhase: "pending", cleanupPending: true, finishedAt: 1_700_000_010_000 }),
  ], statusCtx);
  const table = rows.join("\n");
  assert.match(table, /^subagents\nid\s+agent/);
  assert.match(table, /11111111\s+running-job\s+\d\d:\d\d\s+\d+(?::\d\d){1,2}\s+running\s+running checking repository files/);
  assert.match(table, /22222222\s+completed-job\s+\d\d:\d\d\s+\d+(?::\d\d){1,2}\s+completed\s+done ship final patch/);
  assert.match(table, /33333333\s+failed-job\s+\d\d:\d\d\s+\d+(?::\d\d){1,2}\s+failed\s+failed boom stack trace/);
  assert.match(table, /44444444\s+cancelled-job\s+\d\d:\d\d\s+\d+(?::\d\d){1,2}\s+cancelled\s+stopped user requested stop/);
  assert.match(table, /55555555\s+cleanup-pending\s+\d\d:\d\d\s+\d+(?::\d\d){1,2}\s+failed\s+cleanup-pending/);
});

test("status widget terminal visibility window hides expired terminal jobs", () => {
  const statusCtx = makeStatusCtx();
  __subagentsTest.setCallbackHarness(undefined, statusCtx);
  const recent = makeJob({ id: "agent_recent_aaaaaaaa", label: "recent", status: "completed", phase: "completed", finishedAt: Date.now() - 1_000 });
  const expired = makeJob({ id: "agent_expired_bbbbbbbb", label: "expired", status: "failed", phase: "failed", finishedAt: Date.now() - 60_000 });
  __subagentsTest.putJob(recent);
  __subagentsTest.putJob(expired);

  __subagentsTest.refreshSubagentStatus();
  const widget = statusCtx.calls.findLast((call: any) => call.kind === "widget");
  assert.ok(widget);
  const rendered = widget.value.join("\n");
  assert.match(rendered, /aaaaaaaa/);
  assert.doesNotMatch(rendered, /bbbbbbbb/);
  const status = statusCtx.calls.findLast((call: any) => call.kind === "status");
  assert.equal(status.value, "agents: 1 recent");
});

test("run_agent public worktree false/true/auto behavior is characterized", async () => {
  const repo = createGitRepo();
  const repoCwd = path.join(repo, "src");
  await withFakeTmux({}, async (fake) => {
    const inPlace = await tools.get("run_agent")!.execute("call", { task: "in place", label: "in place", cwd: repoCwd, worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, { ...ctx, cwd });
    assert.match(textOf(inPlace), new RegExp(`CWD: ${escapeRegExp(repoCwd)}`));
    assert.equal(inPlace.details.cwd, repoCwd);
    assert.equal(inPlace.details.worktree, undefined);
    assert.equal(fake.readState().sessions[inPlace.details.tmuxSession].cwd, repoCwd);
    __subagentsTest.clearJobs();
    fs.rmSync(process.env.PI_SUBAGENTS_STORE_DIR!, { recursive: true, force: true });

    const isolated = await tools.get("run_agent")!.execute("call", { task: "isolated", label: "isolated", cwd: repoCwd, worktree: true, timeoutMs: 0 }, new AbortController().signal, () => {}, { ...ctx, cwd });
    assert.match(textOf(isolated), /Status: running/);
    assert.notEqual(isolated.details.cwd, repoCwd);
    assert.equal(isolated.details.worktree.originalRoot, repo);
    assert.equal(isolated.details.worktree.originalCwd, repoCwd);
    assert.equal(isolated.details.worktree.base, "HEAD");
    assert.match(isolated.details.worktree.root, /worktree$/);
    assert.equal(fake.readState().sessions[isolated.details.tmuxSession].cwd, isolated.details.cwd);
    __subagentsTest.clearJobs();
    fs.rmSync(process.env.PI_SUBAGENTS_STORE_DIR!, { recursive: true, force: true });

    const automatic = await tools.get("run_agent")!.execute("call", { task: "auto isolated", label: "auto isolated", cwd: repoCwd, timeoutMs: 0 }, new AbortController().signal, () => {}, { ...ctx, cwd });
    assert.match(textOf(automatic), /Status: running/);
    assert.notEqual(automatic.details.cwd, repoCwd);
    assert.equal(automatic.details.worktree.originalRoot, repo);
    assert.equal(automatic.details.worktree.originalCwd, repoCwd);
  });
});

test("run_agent worktree:true refusal at public layer is characterized", async () => {
  await withFakeTmux({}, async () => {
    const result = await tools.get("run_agent")!.execute("call", { task: "must isolate", label: "must isolate", cwd, worktree: true, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(result), /^Failed to start background agent agent_/);
    assert.match(textOf(result), /Status: failed/);
    assert.match(textOf(result), /Error: run_agent worktree:true requires cwd to be inside a git repository\./);
    assert.equal(result.details.status, "failed");
    assert.equal(result.details.phase, "failed");
    assert.match(result.details.errorMessage, /worktree:true requires cwd/);
  });
});

test("tool renderCall/renderResult output is characterized", async () => {
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
  const runCall = tools.get("run_agent")!.renderCall!({ task: "x".repeat(100), agent: "adhoc" }, theme);
  assert.match(runCall.text, /^run_agent adhoc\n  x{80}…$/);

  await withFakeTmux({}, async () => {
    const runResult = await tools.get("run_agent")!.execute("call", { task: "render result", label: "render", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    const renderedRunResult = tools.get("run_agent")!.renderResult!(runResult, {}, theme);
    assert.match(renderedRunResult.text, /^↗ agent_.* running\nStarted background agent agent_/);

    const pollResult = await tools.get("poll_agent")!.execute("call", { id: runResult.details.id }, new AbortController().signal, () => {}, ctx);
    const pollCall = tools.get("poll_agent")!.renderCall!({ id: runResult.details.id }, theme);
    assert.equal(pollCall.text, `poll_agent ${runResult.details.id}`);
    const renderedPollResult = tools.get("poll_agent")!.renderResult!(pollResult, {}, theme);
    assert.match(renderedPollResult.text, new RegExp(`^running ${escapeRegExp(runResult.details.id)}\\n`));
  });
});

test("stop_agent tmux unavailable during stop reports failure and keeps job running", async () => {
  await withFakeTmux({}, async () => {
    const started = await tools.get("run_agent")!.execute("call", { task: "tmux disappears", label: "tmux gone", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    const previousPath = process.env.PATH;
    process.env.PATH = fs.mkdtempSync(path.join(tmpRoot, "tmux-gone-path-"));
    __subagentsTest.resetTmuxAvailabilityCache();
    try {
      const result = await tools.get("stop_agent")!.execute("call", { id: started.details.id, reason: "tmux disappeared", waitMs: 0 }, new AbortController().signal, () => {}, ctx);
      assert.match(textOf(result), /^Failed to stop agent agent_/);
      assert.match(textOf(result), /it is still marked running/);
      assert.match(textOf(result), /Check logs and tmux session pi-agent_/);
      assert.equal(result.details.status, "running");
      assert.equal(result.details.phase, "stopping");
    } finally {
      process.env.PATH = previousPath;
      __subagentsTest.resetTmuxAvailabilityCache();
    }
  });
});

test("poll_agent surfaces and quarantines corrupt and unsupported persisted records", async () => {
  const jobsDir = path.join(process.env.PI_SUBAGENTS_STORE_DIR!, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const corruptPath = path.join(jobsDir, "agent_bad_corrupt.json");
  const unsupportedPath = path.join(jobsDir, "agent_future_schema.json");
  const callbackPath = path.join(jobsDir, "agent_callback.callback.json");
  fs.writeFileSync(corruptPath, "{not json", "utf-8");
  fs.writeFileSync(unsupportedPath, JSON.stringify({ schemaVersion: 999, id: "agent_future_schema" }), "utf-8");
  fs.writeFileSync(callbackPath, JSON.stringify({ delivered: false }), "utf-8");

  const result = await tools.get("poll_agent")!.execute("call", {}, new AbortController().signal, () => {}, ctx);
  assert.match(textOf(result), /No background agent jobs are known/);
  assert.match(textOf(result), /Store warnings:/);
  assert.match(textOf(result), /corrupt: .*agent_bad_corrupt\.json: failed to parse job record JSON/);
  assert.match(textOf(result), /unsupported: .*agent_future_schema\.json: unsupported job record schemaVersion 999/);
  assert.equal(result.details.jobs.length, 0);
  assert.equal(result.details.warnings.length, 2);
  assert.deepEqual(result.details.warnings.map((warning: any) => warning.kind).sort(), ["corrupt", "unsupported"]);
  assert.equal(fs.existsSync(corruptPath), false);
  assert.equal(fs.existsSync(unsupportedPath), false);
  assert.ok(fs.readdirSync(jobsDir).some((name) => /^agent_bad_corrupt\.json\.corrupt\./.test(name)));
  assert.ok(fs.readdirSync(jobsDir).some((name) => /^agent_future_schema\.json\.unsupported\./.test(name)));
  assert.equal(fs.existsSync(callbackPath), true);
});

test("poll_agent surfaces job-specific persisted-record warnings", async () => {
  const jobsDir = path.join(process.env.PI_SUBAGENTS_STORE_DIR!, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const badPath = path.join(jobsDir, "agent_specific.json");
  fs.writeFileSync(badPath, "{bad", "utf-8");

  const result = await tools.get("poll_agent")!.execute("call", { id: "agent_specific" }, new AbortController().signal, () => {}, ctx);
  assert.match(textOf(result), /Unknown agent job id: agent_specific/);
  assert.match(textOf(result), /Store warnings:/);
  assert.match(textOf(result), /agent_specific\.json/);
  assert.equal(result.details.id, "agent_specific");
  assert.equal(result.details.warnings.length, 1);
  assert.equal(result.details.warnings[0].kind, "corrupt");
});

test("session boundary stops running fake tmux jobs", async () => {
  await withFakeTmux({}, async (fake) => {
    const started = await tools.get("run_agent")!.execute("call", { task: "session bounded", label: "session bounded", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    assert.ok(fake.readState().sessions[started.details.tmuxSession]);

    await __subagentsTest.stopRunningJobsForSessionBoundary("session ended", 0);

    const job = jobFor(started.details.id);
    assert.equal(job.status, "cancelled");
    assert.equal(job.phase, "cancelled");
    assert.equal(job.stopReason, "session ended");
    assert.equal(fake.readState().sessions[started.details.tmuxSession], undefined);
  });
});

test("new session load stops orphan persisted running jobs instead of adopting them", async () => {
  await withFakeTmux({}, async (fake) => {
    const started = await tools.get("run_agent")!.execute("call", { task: "orphan", label: "orphan", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    assert.ok(fake.readState().sessions[started.details.tmuxSession]);

    __subagentsTest.clearJobs();
    __subagentsTest.loadPersistedJobs();
    assert.equal(jobFor(started.details.id).status, "running");

    await __subagentsTest.stopRunningJobsForSessionBoundary("previous session ended", 0);

    const job = jobFor(started.details.id);
    assert.equal(job.status, "cancelled");
    assert.equal(job.phase, "cancelled");
    assert.equal(job.stopReason, "previous session ended");
    assert.equal(fake.readState().sessions[started.details.tmuxSession], undefined);
  });
});

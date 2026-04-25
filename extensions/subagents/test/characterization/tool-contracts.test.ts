import assert from "node:assert/strict";
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
    assert.match(textOf(result), new RegExp(`CWD: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(textOf(result), /Poll later with: poll_agent\(\{ id: "agent_/);
    assert.equal(result.details.status, "running");
    assert.equal(result.details.phase, "running");
    assert.equal(result.details.label, "fake success");
    assert.equal(result.details.cwd, cwd);
    assert.equal(result.details.worktree, undefined);
    assert.ok(fake.readState().sessions[result.details.tmuxSession]);
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

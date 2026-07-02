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
const ctx = {
  cwd,
  hasUI: false,
  sessionManager: {
    getSessionId: () => "session-contract",
    getSessionFile: () => path.join(tmpRoot, "session-contract.jsonl"),
  },
};
__subagentsTest.bindOwnerToContext(ctx as any);

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

interface FakeLaunch {
  cwd: string;
  tools: string[];
  appendSystemPrompt?: string;
  onEvent: (event: any) => void;
  onDone: (outcome: { aborted: boolean; error?: string }) => void;
}

// Installs a fake in-process launcher that stays "running" until aborted, and
// records each launch. Completion is driven explicitly by the test.
function installFakeLauncher() {
  const launched: FakeLaunch[] = [];
  __subagentsTest.setInProcessLauncher((opts: any) => {
    launched.push(opts);
    return { abort() { opts.onDone({ aborted: true }); }, modelResolved: true };
  });
  return {
    launched,
    last() { return launched[launched.length - 1]!; },
    dispose() { __subagentsTest.setInProcessLauncher(undefined); },
  };
}

function jobFor(id: string): any {
  const job = __subagentsTest.getJob(id);
  assert.ok(job);
  return job;
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
    owner: overrides.owner ?? __subagentsTest.getCurrentOwner()!,
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
    owner: record.owner,
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

test("list_agents has no args and does not list project markdown agents", async () => {
  const agentsDir = path.join(cwd, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "project-only-unique.md"), `---\nname: project-only-unique\ndescription: Project-only agent\n---\n\nProject prompt.\n`, "utf-8");

  const result = await tools.get("list_agents")!.execute("call", {}, new AbortController().signal, () => {}, ctx);
  assert.match(textOf(result), /^Available user-owned agents:/);
  assert.doesNotMatch(textOf(result), /project-only-unique/);
  assert.equal(result.details.agents.some((agent: any) => agent.name === "project-only-unique"), false);
  assert.equal(result.details.agents.some((agent: any) => agent.source !== "user"), false);
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
  assert.match(textOf(unknownAgent), /^Unknown user-owned agent "missing"\. Available agents:/);
  assert.deepEqual(unknownAgent.details.availableAgents, []);

  const invalidTools = await tools.get("run_agent")!.execute("call", { task: "x", tools: ["read", "bash"] }, new AbortController().signal, () => {}, ctx);
  assert.equal(textOf(invalidTools), "Refusing to start subagent with tools not active in the parent session: bash. Active tools: find, grep, ls, read.");
  assert.deepEqual(invalidTools.details.requestedTools, ["read", "bash"]);

  __subagentsTest.putJob(makeJob({ id: "agent_capacity", repoKey: cwd }));
  const capacity = await tools.get("run_agent")!.execute("call", { task: "x" }, new AbortController().signal, () => {}, ctx);
  assert.match(textOf(capacity), /Refusing to start subagent: 1 running jobs already meet PI_SUBAGENTS_MAX_RUNNING=1/);
  assert.equal(capacity.details.running, 1);
  assert.equal(capacity.details.maxRunning, 1);
});



test("run_agent default in-process supervisor start + completion is characterized", async () => {
  const events: Array<Record<string, unknown>> = [];
  let captured: any;
  __subagentsTest.setInProcessLauncher((opts: any) => {
    captured = opts;
    // Drive a successful in-process run: emit a final assistant message then finish.
    opts.onEvent({ type: "agent_start" });
    opts.onEvent(assistantEndEvent('{"output":"in-process answer"}'));
    // Defer completion to a macrotask so the start result is observed as running,
    // matching the real async prompt lifecycle.
    setTimeout(() => opts.onDone({ aborted: false }), 5);
    return { abort() { events.push({ aborted: true }); }, modelResolved: true };
  });
  try {
    const started = await tools.get("run_agent")!.execute("call", { task: "do in-process", label: "inproc", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    assert.match(textOf(started), /^Started background agent agent_/);
    assert.match(textOf(started), /Supervisor: in-process/);
    assert.doesNotMatch(textOf(started), /Attach: tmux/);
    assert.doesNotMatch(textOf(started), /PID:/);
    assert.equal(started.details.status, "running");
    assert.equal(started.details.tmuxSession, undefined);
    // The combined append prompt carries the JSON addendum.
    assert.match(captured.appendSystemPrompt, /Return only valid JSON/);
    assert.deepEqual(captured.tools, ["read", "grep", "find", "ls"]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const job = __subagentsTest.getJob(started.details.id);
    assert.ok(job);
    assert.equal(job.status, "completed");
    assert.ok(job.result);
    assert.equal(job.result.output, '{"output":"in-process answer"}');
    assert.deepEqual(job.result.structuredOutput, { output: "in-process answer" });
    assert.equal(job.result.error, undefined);
  } finally {
    __subagentsTest.setInProcessLauncher(undefined);
    __subagentsTest.clearJobs();
  }
});

test("stop_agent aborts an in-process job and finalizes as cancelled", async () => {
  let abortCalled = false;
  let doneCb: ((outcome: { aborted: boolean; error?: string }) => void) | undefined;
  __subagentsTest.setInProcessLauncher((opts: any) => {
    doneCb = opts.onDone;
    return { abort() { abortCalled = true; doneCb?.({ aborted: true }); }, modelResolved: true };
  });
  try {
    const started = await tools.get("run_agent")!.execute("call", { task: "long task", label: "inproc-stop", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    assert.equal(started.details.status, "running");
    const stopped = await tools.get("stop_agent")!.execute("call", { id: started.details.id, reason: "user stop", waitMs: 200 }, new AbortController().signal, () => {}, ctx);
    assert.ok(abortCalled);
    assert.match(textOf(stopped), /^Stopped agent agent_/);
    assert.equal(stopped.details.status, "cancelled");
    assert.equal(stopped.details.phase, "cancelled");
  } finally {
    __subagentsTest.setInProcessLauncher(undefined);
    __subagentsTest.clearJobs();
  }
});

test("in-process job timeout finalizes as failed via abort", async () => {
  __subagentsTest.setInProcessLauncher((opts: any) => {
    // Never completes on its own; only resolves when aborted (e.g. by timeout).
    return { abort() { opts.onDone({ aborted: true }); }, modelResolved: true };
  });
  try {
    const started = await tools.get("run_agent")!.execute("call", { task: "slow", label: "inproc-timeout", worktree: false, timeoutMs: 30 }, new AbortController().signal, () => {}, ctx);
    assert.equal(started.details.status, "running");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const job = __subagentsTest.getJob(started.details.id);
    assert.ok(job);
    assert.equal(job.status, "failed");
    assert.equal(job.terminal?.reason, "timeout");
  } finally {
    __subagentsTest.setInProcessLauncher(undefined);
    __subagentsTest.clearJobs();
  }
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
  const fake = installFakeLauncher();
  try {
    const inPlace = await tools.get("run_agent")!.execute("call", { task: "in place", label: "in place", cwd: repoCwd, worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, { ...ctx, cwd });
    assert.match(textOf(inPlace), new RegExp(`CWD: ${escapeRegExp(repoCwd)}`));
    assert.equal(inPlace.details.cwd, repoCwd);
    assert.equal(inPlace.details.worktree, undefined);
    assert.equal(fake.last().cwd, repoCwd);
    __subagentsTest.clearJobs();
    fs.rmSync(process.env.PI_SUBAGENTS_STORE_DIR!, { recursive: true, force: true });

    const isolated = await tools.get("run_agent")!.execute("call", { task: "isolated", label: "isolated", cwd: repoCwd, worktree: true, timeoutMs: 0 }, new AbortController().signal, () => {}, { ...ctx, cwd });
    assert.match(textOf(isolated), /Status: running/);
    assert.notEqual(isolated.details.cwd, repoCwd);
    assert.equal(isolated.details.worktree.originalRoot, repo);
    assert.equal(isolated.details.worktree.originalCwd, repoCwd);
    assert.equal(isolated.details.worktree.base, "HEAD");
    assert.match(isolated.details.worktree.root, /worktree$/);
    assert.equal(fake.last().cwd, isolated.details.cwd);
    __subagentsTest.clearJobs();
    fs.rmSync(process.env.PI_SUBAGENTS_STORE_DIR!, { recursive: true, force: true });

    const automatic = await tools.get("run_agent")!.execute("call", { task: "auto isolated", label: "auto isolated", cwd: repoCwd, timeoutMs: 0 }, new AbortController().signal, () => {}, { ...ctx, cwd });
    assert.match(textOf(automatic), /Status: running/);
    assert.notEqual(automatic.details.cwd, repoCwd);
    assert.equal(automatic.details.worktree.originalRoot, repo);
    assert.equal(automatic.details.worktree.originalCwd, repoCwd);
  } finally {
    fake.dispose();
  }
});

test("run_agent worktree:true refusal at public layer is characterized", async () => {
  const result = await tools.get("run_agent")!.execute("call", { task: "must isolate", label: "must isolate", cwd, worktree: true, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
  assert.match(textOf(result), /^Failed to start background agent agent_/);
  assert.match(textOf(result), /Status: failed/);
  assert.match(textOf(result), /Error: worktree:true requires cwd to be inside a git repository\./);
  assert.equal(result.details.status, "failed");
  assert.equal(result.details.phase, "failed");
  assert.match(result.details.errorMessage, /worktree:true requires cwd/);
});

test("tool renderCall/renderResult output is characterized", async () => {
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
  const runCall = tools.get("run_agent")!.renderCall!({ task: "x".repeat(100), agent: "adhoc" }, theme);
  assert.match(runCall.text, /^run_agent adhoc\n  x{80}…$/);

  const listCall = tools.get("list_agents")!.renderCall!({}, theme);
  assert.equal(listCall.text, "list_agents");
  const listResult = await tools.get("list_agents")!.execute("call", {}, new AbortController().signal, () => {}, ctx);
  const renderedListResult = tools.get("list_agents")!.renderResult!(listResult, {}, theme);
  assert.equal(renderedListResult.text, textOf(listResult));

  const fake = installFakeLauncher();
  try {
    const runResult = await tools.get("run_agent")!.execute("call", { task: "render result", label: "render", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    const renderedRunResult = tools.get("run_agent")!.renderResult!(runResult, {}, theme);
    assert.match(renderedRunResult.text, /^↗ agent_.* running\nStarted background agent agent_/);
  } finally {
    fake.dispose();
  }
});


test("session boundary stops running in-process jobs", async () => {
  const fake = installFakeLauncher();
  try {
    const started = await tools.get("run_agent")!.execute("call", { task: "session bounded", label: "session bounded", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    assert.equal(jobFor(started.details.id).status, "running");

    await __subagentsTest.stopRunningJobsForSessionBoundary("session ended", 0);

    const job = jobFor(started.details.id);
    assert.equal(job.status, "cancelled");
    assert.equal(job.phase, "cancelled");
    assert.equal(job.stopReason, "session ended");
  } finally {
    fake.dispose();
  }
});

test("new session load abandons orphan persisted in-process jobs as failed", async () => {
  const fake = installFakeLauncher();
  try {
    const started = await tools.get("run_agent")!.execute("call", { task: "orphan", label: "orphan", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    assert.equal(jobFor(started.details.id).status, "running");

    // Simulate a parent restart: drop in-memory state and rehydrate from disk.
    // In-process subagents cannot survive a restart, so the record is abandoned.
    __subagentsTest.clearJobs();
    __subagentsTest.loadPersistedJobs();

    const job = jobFor(started.details.id);
    assert.equal(job.status, "failed");
    assert.match(job.errorMessage, /did not survive the parent Pi session restart/);
  } finally {
    fake.dispose();
  }
});

test("session_start for a different session stops old owner jobs before rebinding", async () => {
  const fake = installFakeLauncher();
  try {
    const started = await tools.get("run_agent")!.execute("call", { task: "old owner", label: "old owner", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
    assert.equal(jobFor(started.details.id).status, "running");

    const nextCtx = {
      ...ctx,
      sessionManager: {
        getSessionId: () => "session-contract-next",
        getSessionFile: () => path.join(tmpRoot, "session-contract-next.jsonl"),
      },
    };
    await __subagentsTest.handleSubagentsSessionStart(nextCtx as any);

    const job = __subagentsTest.getJob(started.details.id);
    assert.ok(!job || job.status === "cancelled");
  } finally {
    fake.dispose();
  }
});




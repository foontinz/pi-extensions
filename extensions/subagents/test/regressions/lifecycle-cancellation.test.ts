import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-regressions-"));
process.env.PI_SUBAGENTS_STORE_DIR = path.join(tmpRoot, "store");

const { JOB_RECORD_SCHEMA_VERSION, emptyUsageStats, initialLogCursor } = await import("../../core/types.js");
const {
  callbackMarkerPathForStore,
  capacityLockPathForStore,
  capacityReservationPathForStore,
  ensureJobStoreDirsFor,
  jobStatePathForStore,
  storePathsForOwner,
  withOwnerCapacityLock,
} = await import("../../core/job-store.js");
const { hydrateJobRecord, serializeJobRecord } = await import("../../core/hydration.js");
const { __worktreeTest } = await import("../../workspace/create-worktree.js");
const { default: subagentsExtension, __subagentsTest } = await import("../../index.js");

type Tool = { execute: (id: string, params: any, signal: AbortSignal, update: () => void, ctx: any) => Promise<any> };
const tools = new Map<string, Tool>();
const eventHandlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
subagentsExtension({
  on(event: string, handler: (event: unknown, ctx: any) => Promise<void>) { eventHandlers.set(event, handler); },
  registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
  getActiveTools() { return ["read"]; },
} as any);

const cwd = fs.mkdtempSync(path.join(tmpRoot, "cwd-"));
const ctx = {
  cwd,
  hasUI: false,
  sessionManager: {
    getSessionId: () => "session-regressions",
    getSessionFile: () => path.join(tmpRoot, "session-regressions.jsonl"),
  },
};

function createGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "subagents-test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Subagents Test"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  return fs.realpathSync(repo);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runningRecord(owner: any, id: string, sourceCwd = cwd, worktree?: any) {
  const now = Date.now() - 1_000;
  return {
    schemaVersion: JOB_RECORD_SCHEMA_VERSION,
    id,
    owner,
    label: id,
    task: "persisted task",
    sourceCwd,
    cwd: worktree?.root ?? sourceCwd,
    phase: "running" as const,
    cleanupPhase: "none" as const,
    supervisor: "process" as const,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    worktree,
    logCursor: initialLogCursor(),
    usage: emptyUsageStats(),
  };
}

function terminalRecord(owner: any, id: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now() - 1_000;
  return {
    ...runningRecord(owner, id),
    phase: "completed" as const,
    cleanupPhase: "complete" as const,
    terminal: { phase: "completed" as const, reason: "natural-exit" as const, finishedAt: now, exitCode: 0 },
    ...overrides,
  };
}

function writeRecord(owner: any, record: any): string {
  const store = storePathsForOwner(owner);
  ensureJobStoreDirsFor(store);
  const statePath = jobStatePathForStore(store, record.id);
  fs.writeFileSync(statePath, serializeJobRecord(record), { mode: 0o600 });
  return statePath;
}

test.beforeEach(() => {
  __subagentsTest.clearJobs();
  __subagentsTest.setInProcessLauncher(undefined);
  __subagentsTest.setWorktreeCleanup(undefined);
  __worktreeTest.setCheckpointHook(undefined);
  __worktreeTest.setPreparationCleanup(undefined);
  fs.rmSync(process.env.PI_SUBAGENTS_STORE_DIR!, { recursive: true, force: true });
  __subagentsTest.bindOwnerToContext(ctx as any);
});

test.after(() => {
  __subagentsTest.clearJobs();
  __subagentsTest.setInProcessLauncher(undefined);
  __subagentsTest.setWorktreeCleanup(undefined);
  __worktreeTest.setCheckpointHook(undefined);
  __worktreeTest.setPreparationCleanup(undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("owner directory identity is stable across process instance ids", () => {
  assert.equal(
    __subagentsTest.ownerIdFor("instance-before-restart", "same-session"),
    __subagentsTest.ownerIdFor("instance-after-restart", "same-session"),
  );
  assert.notEqual(
    __subagentsTest.ownerIdFor("instance", "session-a"),
    __subagentsTest.ownerIdFor("instance", "session-b"),
  );
});

test("run_agent rejects an already-cancelled call before capacity or launch", async () => {
  let launches = 0;
  __subagentsTest.setInProcessLauncher((opts: any) => {
    launches += 1;
    return { abort() {}, forceAbort() {}, dispose() {}, modelResolved: true };
  });
  const controller = new AbortController();
  controller.abort(new Error("cancelled before reservation"));

  await assert.rejects(
    tools.get("run_agent")!.execute("call", { task: "must not launch", worktree: false }, controller.signal, () => {}, ctx),
    /cancelled before reservation/,
  );
  assert.equal(launches, 0);
});

test("an aborted capacity reservation does not wedge the reservation mutex", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled capacity reservation"));
  await assert.rejects(
    __subagentsTest.reserveSubagentCapacity(cwd, controller.signal),
    /cancelled capacity reservation/,
  );

  const next = await __subagentsTest.reserveSubagentCapacity(cwd, new AbortController().signal);
  assert.equal(next.ok, true);
  if (next.ok) next.release();
});

test("run_agent cancellation during supervisor startup force-terminalizes the discoverable record", async () => {
  const controller = new AbortController();
  let forceCalls = 0;
  let jobId = "";
  __subagentsTest.setInProcessLauncher((opts: any) => {
    jobId = opts.sessionId;
    controller.abort(new Error("cancelled during startup"));
    return {
      abort() {},
      forceAbort() { forceCalls += 1; },
      dispose() {},
      modelResolved: true,
    };
  });

  await assert.rejects(
    tools.get("run_agent")!.execute("call", { task: "startup race", worktree: false, timeoutMs: 0 }, controller.signal, () => {}, ctx),
    /cancelled during startup/,
  );
  const job = __subagentsTest.getJob(jobId);
  assert.ok(job);
  assert.equal(forceCalls, 1);
  assert.equal(job.status, "cancelled");
  assert.equal(job.phase, "cancelled");
});

test("the acknowledged background job detaches from the execute signal and keeps retention", async () => {
  const repo = createGitRepo();
  const controller = new AbortController();
  let detachCalls = 0;
  let finish!: (outcome: { aborted: boolean; error?: string }) => void;
  __subagentsTest.setInProcessLauncher((opts: any) => {
    finish = opts.onDone;
    return {
      abort() {},
      forceAbort() {},
      dispose() {},
      detachStartupSignal() { detachCalls += 1; },
      modelResolved: true,
    };
  });

  let worktree: any;
  try {
    const started = await tools.get("run_agent")!.execute(
      "call",
      { task: "outlive parent turn", cwd: repo, worktree: true, keepWorktree: "always", timeoutMs: 0 },
      controller.signal,
      () => {},
      ctx,
    );
    worktree = __subagentsTest.getJob(started.details.id)!.worktree;
    assert.equal(detachCalls, 1);

    controller.abort(new Error("completed parent turn disposed"));
    finish({ aborted: false });
    const job = __subagentsTest.getJob(started.details.id)!;
    assert.equal(job.status, "completed");
    assert.equal(job.cleanupPhase, "retained");
    assert.equal(job.worktree?.retained, true);
    assert.equal(job.worktree?.keepWorktree, "always");
    assert.equal(fs.existsSync(worktree.root), true);
  } finally {
    if (worktree?.root && fs.existsSync(worktree.root)) {
      try { execFileSync("git", ["worktree", "remove", "--force", worktree.root], { cwd: repo, stdio: "ignore" }); } catch {}
      if (worktree.tempParent) fs.rmSync(worktree.tempParent, { recursive: true, force: true });
    }
  }
});

test("run_agent cancellation during worktree preparation ignores retention and cleans", async () => {
  const repo = createGitRepo();
  let launches = 0;
  __subagentsTest.setInProcessLauncher(() => {
    launches += 1;
    return { abort() {}, forceAbort() {}, dispose() {}, modelResolved: true };
  });
  const controller = new AbortController();
  __worktreeTest.setCheckpointHook((checkpoint) => {
    if (checkpoint === "git-add-complete") controller.abort(new Error("cancelled during worktree prep"));
  });

  await assert.rejects(
    tools.get("run_agent")!.execute(
      "call",
      { task: "cancel worktree prep", cwd: repo, worktree: true, keepWorktree: "always", timeoutMs: 0 },
      controller.signal,
      () => {},
      ctx,
    ),
    /cancelled during worktree prep/,
  );

  assert.equal(launches, 0);
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf-8" });
  assert.equal((worktrees.match(/^worktree /gm) ?? []).length, 1);
});

test("owner changes during prepared-worktree startup persist cleanup retry under the initiating owner", async () => {
  const repo = createGitRepo();
  const initiatingOwner = __subagentsTest.getCurrentOwner()!;
  const nextCtx = {
    ...ctx,
    sessionManager: {
      getSessionId: () => "session-regressions-next-owner",
      getSessionFile: () => path.join(tmpRoot, "session-regressions-next-owner.jsonl"),
    },
  };
  let cleanupAttempts = 0;
  __subagentsTest.setWorktreeCleanup(async () => {
    cleanupAttempts += 1;
    throw new Error("cleanup temporarily unavailable");
  });
  __worktreeTest.setCheckpointHook((checkpoint) => {
    if (checkpoint !== "git-add-complete") return;
    __worktreeTest.setCheckpointHook(undefined);
    __subagentsTest.bindOwnerToContext(nextCtx as any);
  });

  const result = await tools.get("run_agent")!.execute(
    "call",
    { task: "owner changes during prep", cwd: repo, worktree: true, keepWorktree: "always", timeoutMs: 0 },
    new AbortController().signal,
    () => {},
    ctx,
  );
  const job = __subagentsTest.getJob(result.details.id)!;
  await waitUntil(() => cleanupAttempts >= 2);

  assert.equal(result.details.status, "cancelled");
  assert.equal(job.owner.id, initiatingOwner.id);
  assert.equal(job.cleanupPending, true);
  assert.equal(job.worktree?.keepWorktree, "never");
  const initiatingState = jobStatePathForStore(storePathsForOwner(initiatingOwner), job.id);
  const currentState = jobStatePathForStore(storePathsForOwner(__subagentsTest.getCurrentOwner()!), job.id);
  assert.equal(fs.existsSync(initiatingState), true);
  assert.equal(fs.existsSync(currentState), false);
  const persisted = hydrateJobRecord(fs.readFileSync(initiatingState, "utf-8"));
  assert.equal(persisted.owner.id, initiatingOwner.id);
  assert.equal(persisted.cleanupPhase, "failed");
  assert.equal(persisted.worktree?.keepWorktree, "never");

  __subagentsTest.setWorktreeCleanup(undefined);
  await __subagentsTest.retryWorktreeCleanup(job);
  assert.equal(job.cleanupPhase, "complete");
  assert.equal(fs.existsSync(job.worktree!.root), false);
});

test("failed cancelled-startup cleanup is persisted for retry", async () => {
  const repo = createGitRepo();
  const controller = new AbortController();
  const retryAttempted = new Promise<void>((resolve) => {
    __subagentsTest.setWorktreeCleanup(async () => {
      resolve();
      throw new Error("retry cleanup unavailable");
    });
  });
  __worktreeTest.setPreparationCleanup(async () => {
    throw new Error("initial cleanup unavailable");
  });
  __worktreeTest.setCheckpointHook((checkpoint) => {
    if (checkpoint === "git-add-complete") controller.abort(new Error("cancel startup with cleanup failure"));
  });

  await assert.rejects(
    tools.get("run_agent")!.execute(
      "call",
      { task: "persist cleanup", cwd: repo, worktree: true, keepWorktree: "always", timeoutMs: 0 },
      controller.signal,
      () => {},
      ctx,
    ),
    /cancel startup with cleanup failure/,
  );
  await retryAttempted;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const owner = __subagentsTest.getCurrentOwner()!;
  const store = storePathsForOwner(owner);
  const stateFiles = fs.readdirSync(store.jobsDir).filter((name) => name.endsWith(".json") && !name.endsWith(".callback.json"));
  assert.equal(stateFiles.length, 1);
  const persisted = hydrateJobRecord(fs.readFileSync(path.join(store.jobsDir, stateFiles[0]!), "utf-8"));
  assert.equal(persisted.phase, "cancelled");
  assert.equal(persisted.cleanupPhase, "failed");
  assert.equal(persisted.worktree?.keepWorktree, "never");
  const job = __subagentsTest.getJob(persisted.id)!;
  assert.equal(job.cleanupPending, true);

  __subagentsTest.setWorktreeCleanup(undefined);
  await __subagentsTest.retryWorktreeCleanup(job);
  assert.equal(job.cleanupPhase, "complete");
  assert.equal(fs.existsSync(persisted.worktree!.root), false);
});

test("stop and timeout force terminalization when cooperative abort never settles", async () => {
  let abortCalls = 0;
  let forceCalls = 0;
  __subagentsTest.setInProcessLauncher(() => ({
    abort() { abortCalls += 1; },
    forceAbort() { forceCalls += 1; },
    dispose() {},
    modelResolved: true,
  }));

  const repo = createGitRepo();
  const first = await tools.get("run_agent")!.execute("call", { task: "hang stop", cwd: repo, worktree: true, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
  const worktreeRoot = first.details.worktree.root as string;
  const stopped = await tools.get("stop_agent")!.execute("stop", { id: first.details.id, reason: "forced stop", waitMs: 10 }, new AbortController().signal, () => {}, ctx);
  assert.equal(stopped.details.status, "cancelled");
  assert.equal(stopped.details.phase, "cancelled");
  await waitUntil(() => __subagentsTest.getJob(first.details.id)?.cleanupPhase === "complete");
  assert.equal(fs.existsSync(worktreeRoot), false);

  const second = await tools.get("run_agent")!.execute("call", { task: "hang timeout", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
  const timedOutJob = __subagentsTest.getJob(second.details.id)!;
  await __subagentsTest.stopAgentJob(timedOutJob, "deadline", 10, "timeout");
  assert.equal(timedOutJob.status, "failed");
  assert.equal(timedOutJob.terminal?.reason, "timeout");
  assert.equal(abortCalls, 2);
  assert.equal(forceCalls, 2);
});

test("stale session_start cannot stop jobs bound by a newer session_start", async () => {
  const firstCtx = {
    ...ctx,
    sessionManager: {
      getSessionId: () => "session-regressions-stale-start-first",
      getSessionFile: () => path.join(tmpRoot, "session-regressions-stale-start-first.jsonl"),
    },
  };
  const secondCtx = {
    ...ctx,
    sessionManager: {
      getSessionId: () => "session-regressions-stale-start-second",
      getSessionFile: () => path.join(tmpRoot, "session-regressions-stale-start-second.jsonl"),
    },
  };
  let firstBound!: () => void;
  let releaseFirst!: () => void;
  const firstIsBound = new Promise<void>((resolve) => { firstBound = resolve; });
  const firstMayContinue = new Promise<void>((resolve) => { releaseFirst = resolve; });
  __subagentsTest.setSessionStartHook(async (hookCtx: any) => {
    if (hookCtx !== firstCtx) return;
    firstBound();
    await firstMayContinue;
  });
  __subagentsTest.setInProcessLauncher((opts: any) => ({
    abort() { opts.onDone({ aborted: true }); },
    forceAbort() { opts.onDone({ aborted: true }); },
    dispose() {},
    detachStartupSignal() {},
    modelResolved: true,
  }));

  try {
    const staleStart = __subagentsTest.handleSubagentsSessionStart(firstCtx as any);
    await firstIsBound;
    await __subagentsTest.handleSubagentsSessionStart(secondCtx as any);
    const started = await tools.get("run_agent")!.execute(
      "call",
      { task: "must survive stale start", worktree: false, timeoutMs: 0 },
      new AbortController().signal,
      () => {},
      secondCtx,
    );

    releaseFirst();
    await staleStart;
    const job = __subagentsTest.getJob(started.details.id)!;
    assert.equal(__subagentsTest.getCurrentOwner()?.sessionId, secondCtx.sessionManager.getSessionId());
    assert.equal(job.status, "running");
    await __subagentsTest.stopAgentJob(job, "test cleanup", 0);
  } finally {
    __subagentsTest.setSessionStartHook(undefined);
  }
});

test("stale session_shutdown does not stop or clear the newer session owner", async () => {
  await __subagentsTest.handleSubagentsSessionStart(ctx as any);
  const nextCtx = {
    ...ctx,
    sessionManager: {
      getSessionId: () => "session-regressions-new-current",
      getSessionFile: () => path.join(tmpRoot, "session-regressions-new-current.jsonl"),
    },
  };
  await __subagentsTest.handleSubagentsSessionStart(nextCtx as any);
  const nextOwner = __subagentsTest.getCurrentOwner()!;
  __subagentsTest.setInProcessLauncher((opts: any) => ({
    abort() { opts.onDone({ aborted: true }); },
    forceAbort() { opts.onDone({ aborted: true }); },
    dispose() {},
    detachStartupSignal() {},
    modelResolved: true,
  }));

  try {
    const started = await tools.get("run_agent")!.execute(
      "call",
      { task: "new owner job", worktree: false, timeoutMs: 0 },
      new AbortController().signal,
      () => {},
      nextCtx,
    );
    await eventHandlers.get("session_shutdown")!({}, ctx);

    assert.equal(__subagentsTest.getCurrentOwner()?.id, nextOwner.id);
    assert.equal(__subagentsTest.getJob(started.details.id)?.status, "running");
    await __subagentsTest.stopAgentJob(__subagentsTest.getJob(started.details.id)!, "test cleanup", 0);
  } finally {
    __subagentsTest.setOwnerHarness(undefined);
  }
});

test("assistant stopReason length finalizes run_agent as failed", async () => {
  __subagentsTest.setInProcessLauncher((opts: any) => {
    opts.onEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "truncated" }], stopReason: "length" },
    });
    setImmediate(() => opts.onDone({ aborted: false }));
    return { abort() {}, forceAbort() {}, dispose() {}, modelResolved: true };
  });
  const started = await tools.get("run_agent")!.execute("call", { task: "length", worktree: false, timeoutMs: 0 }, new AbortController().signal, () => {}, ctx);
  await waitUntil(() => __subagentsTest.getJob(started.details.id)?.status !== "running");
  const job = __subagentsTest.getJob(started.details.id)!;
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage!, /length limit/);
});

test("capacity includes live jobs from another process sharing the stable owner directory", async () => {
  const owner = __subagentsTest.getCurrentOwner()!;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(child.pid);
  const foreignOwner = { ...owner, instanceId: "foreign-live-instance", parentPid: child.pid };
  writeRecord(foreignOwner, runningRecord(foreignOwner, "agent_foreign_live_capacity"));

  try {
    const capacity = await __subagentsTest.reserveSubagentCapacity(cwd, new AbortController().signal, owner);
    assert.equal(capacity.details.running, 1);
    assert.equal(capacity.details.runningForRepo, 1);
    if (capacity.ok) capacity.release();
  } finally {
    child.kill("SIGKILL");
  }
});

test("owner capacity lock excludes a concurrent process", async () => {
  const owner = __subagentsTest.getCurrentOwner()!;
  const store = storePathsForOwner(owner);
  ensureJobStoreDirsFor(store);
  const readyPath = path.join(tmpRoot, `capacity-lock-ready-${Date.now()}`);
  const lockPath = capacityLockPathForStore(store);
  const child = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const lockPath = ${JSON.stringify(lockPath)};
    const readyPath = ${JSON.stringify(readyPath)};
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, process.pid + "\\n" + Date.now() + "\\n", "utf8");
    fs.writeFileSync(readyPath, "ready");
    setTimeout(() => { fs.closeSync(fd); fs.rmSync(lockPath, { force: true }); }, 250);
  `], { stdio: "ignore" });

  try {
    await waitUntil(() => fs.existsSync(readyPath));
    const startedAt = Date.now();
    let entered = false;
    withOwnerCapacityLock(store, () => { entered = true; });
    assert.equal(entered, true);
    assert.ok(Date.now() - startedAt >= 125, "the owner lock must wait for the child process claim");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(readyPath, { force: true });
    fs.rmSync(lockPath, { force: true });
  }
});

test("capacity counts durable reservations and prunes claims from dead processes", async () => {
  const owner = __subagentsTest.getCurrentOwner()!;
  const store = storePathsForOwner(owner);
  ensureJobStoreDirsFor(store);
  const activeId = "reserve_active_capacity_test";
  const activePath = capacityReservationPathForStore(store, activeId);
  fs.writeFileSync(activePath, JSON.stringify({
    schemaVersion: 1,
    id: activeId,
    ownerId: owner.id,
    instanceId: owner.instanceId,
    parentPid: process.pid,
    repoKey: cwd,
    createdAt: Date.now(),
  }) + "\n");

  const counted = await __subagentsTest.reserveSubagentCapacity(cwd, new AbortController().signal, owner);
  assert.equal(counted.details.running, 1);
  assert.equal(counted.details.runningForRepo, 1);
  if (counted.ok) counted.release();
  fs.rmSync(activePath, { force: true });

  const deadId = "reserve_dead_capacity_test";
  const deadPath = capacityReservationPathForStore(store, deadId);
  fs.writeFileSync(deadPath, JSON.stringify({
    schemaVersion: 1,
    id: deadId,
    ownerId: owner.id,
    instanceId: "dead-instance",
    parentPid: 2_147_483_647,
    repoKey: cwd,
    createdAt: Date.now(),
  }) + "\n");

  const pruned = await __subagentsTest.reserveSubagentCapacity(cwd, new AbortController().signal, owner);
  assert.equal(pruned.details.running, 0);
  assert.equal(fs.existsSync(deadPath), false);
  assert.equal(pruned.ok, true);
  if (pruned.ok) pruned.release();
});

test("restart migrates matching legacy owners, abandons running jobs, and retries cleanup", async () => {
  const repo = createGitRepo();
  const prepared = await __subagentsTest.prepareWorktreeForSpawn(repo, "legacy", ctx as any, true, "never");
  assert.ok(prepared.worktree);
  const legacyOwner = {
    version: 1 as const,
    id: "owner_legacy_random_process_component",
    instanceId: "dead-instance",
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    parentPid: 2_147_483_647,
    cwd,
  };
  const id = "agent_legacy_restart";
  writeRecord(legacyOwner, runningRecord(legacyOwner, id, repo, prepared.worktree));
  const legacyRoot = storePathsForOwner(legacyOwner).root;

  __subagentsTest.clearJobs();
  __subagentsTest.setOwnerHarness(undefined);
  await __subagentsTest.handleSubagentsSessionStart(ctx as any);

  const current = __subagentsTest.getCurrentOwner()!;
  const job = __subagentsTest.getJob(id);
  assert.ok(job);
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage!, /did not survive/);
  assert.equal(fs.existsSync(legacyRoot), false);
  assert.equal(fs.existsSync(jobStatePathForStore(storePathsForOwner(current), id)), true);
  await waitUntil(() => job.cleanupPhase === "complete");
  assert.equal(fs.existsSync(prepared.worktree!.root), false);
});

test("owner migration leaves conflicting source records and artifacts intact", async () => {
  const current = __subagentsTest.getCurrentOwner()!;
  const legacyOwner = {
    ...current,
    id: "owner_conflicting_legacy_identity",
    instanceId: "dead-instance",
    parentPid: 2_147_483_647,
  };
  const id = "agent_owner_collision";
  const sourceState = writeRecord(legacyOwner, terminalRecord(legacyOwner, id, { task: "source task" }));
  const targetState = writeRecord(current, terminalRecord(current, id, { task: "destination task" }));
  const sourceStore = storePathsForOwner(legacyOwner);
  const targetStore = storePathsForOwner(current);
  const sourceLog = path.join(sourceStore.logsDir, `${id}.stderr.log`);
  const targetLog = path.join(targetStore.logsDir, `${id}.stderr.log`);
  const sourceMarker = callbackMarkerPathForStore(sourceStore, id);
  const targetMarker = callbackMarkerPathForStore(targetStore, id);
  const sourceSession = path.join(sourceStore.sessionsDir, id, "source.jsonl");
  const targetSessionDir = path.join(targetStore.sessionsDir, id);
  fs.writeFileSync(sourceLog, "source log\n");
  fs.writeFileSync(targetLog, "destination log\n");
  fs.writeFileSync(sourceMarker, JSON.stringify({ id, ownerId: legacyOwner.id, state: "pending" }) + "\n");
  fs.mkdirSync(path.dirname(sourceSession), { recursive: true });
  fs.writeFileSync(sourceSession, "source transcript\n");

  await __subagentsTest.revisitStaleOwnerArtifacts(current);

  assert.equal(hydrateJobRecord(fs.readFileSync(targetState, "utf-8")).task, "destination task");
  assert.equal(hydrateJobRecord(fs.readFileSync(sourceState, "utf-8")).task, "source task");
  assert.equal(fs.readFileSync(targetLog, "utf-8"), "destination log\n");
  assert.equal(fs.readFileSync(sourceLog, "utf-8"), "source log\n");
  assert.equal(fs.existsSync(sourceMarker), true);
  assert.equal(fs.existsSync(targetMarker), false);
  assert.equal(fs.readFileSync(sourceSession, "utf-8"), "source transcript\n");
  assert.equal(fs.existsSync(targetSessionDir), false);
});

test("terminal pruning preserves jobs whose callback marker is pending", () => {
  const current = __subagentsTest.getCurrentOwner()!;
  const base = Date.now() - 100_000;
  const statePaths: string[] = [];
  for (let index = 0; index < 52; index++) {
    const id = `agent_prune_callback_${index.toString().padStart(2, "0")}`;
    const finishedAt = base + index;
    statePaths.push(writeRecord(current, terminalRecord(current, id, {
      createdAt: finishedAt - 1_000,
      updatedAt: finishedAt,
      terminal: { phase: "completed", reason: "natural-exit", finishedAt, exitCode: 0 },
    })));
  }
  const pendingId = "agent_prune_callback_00";
  const pendingMarker = callbackMarkerPathForStore(storePathsForOwner(current), pendingId);
  fs.writeFileSync(pendingMarker, JSON.stringify({
    id: pendingId,
    ownerId: current.id,
    state: "pending",
    pendingAt: base,
    attempts: 0,
  }) + "\n");

  __subagentsTest.loadPersistedJobs();

  assert.equal(fs.existsSync(statePaths[0]!), true, "pending callback payload must survive pruning");
  assert.equal(fs.existsSync(pendingMarker), true);
  assert.equal(fs.existsSync(statePaths[1]!), false, "the oldest pruneable terminal job is removed instead");
});

test("dead stable-owner metadata is claimed durably without duplicate callbacks", () => {
  const current = __subagentsTest.getCurrentOwner()!;
  const deadOwner = {
    ...current,
    instanceId: "dead-stable-instance",
    parentPid: 2_147_483_647,
  };
  const id = "agent_adopt_metadata";
  const statePath = writeRecord(deadOwner, terminalRecord(deadOwner, id));
  const store = storePathsForOwner(current);
  fs.writeFileSync(callbackMarkerPathForStore(store, id), JSON.stringify({
    id,
    ownerId: current.id,
    state: "pending",
    pendingAt: Date.now(),
    attempts: 0,
  }) + "\n");
  const sent: string[] = [];
  __subagentsTest.setCallbackHarness({
    sendUserMessage(message: string) { sent.push(message); },
  } as any, {
    hasUI: true,
    isIdle: () => true,
    ui: { notify() {} },
  } as any);

  try {
    __subagentsTest.loadPersistedJobs();
    __subagentsTest.loadPersistedJobs();
    __subagentsTest.flushPendingFinishedCallbacks();

    const adopted = hydrateJobRecord(fs.readFileSync(statePath, "utf-8"));
    assert.deepEqual(adopted.owner, current);
    assert.equal(sent.length, 1);
    assert.equal(__subagentsTest.readCallbackMarker(id)?.state, "delivered");
  } finally {
    __subagentsTest.setCallbackHarness(undefined, undefined);
  }
});

test("retained cleanup phase is persisted during terminal hydration", () => {
  const current = __subagentsTest.getCurrentOwner()!;
  const id = "agent_retain_hydration";
  const worktree = {
    root: path.join(tmpRoot, "retained-worktree"),
    tempParent: path.join(tmpRoot, "retained-parent"),
    originalRoot: cwd,
    originalCwd: cwd,
    base: "HEAD",
    copied: [],
    postCopy: [],
    keepWorktree: "always" as const,
  };
  const statePath = writeRecord(current, terminalRecord(current, id, {
    cwd: worktree.root,
    cleanupPhase: "none",
    worktree,
  }));

  __subagentsTest.loadPersistedJobs();

  const hydrated = __subagentsTest.getJob(id)!;
  assert.equal(hydrated.cleanupPhase, "retained");
  const persisted = hydrateJobRecord(fs.readFileSync(statePath, "utf-8"));
  assert.equal(persisted.cleanupPhase, "retained");
  assert.equal(persisted.worktree?.retained, true);
});

test("stale-owner revisit does not migrate or prune artifacts owned by a live process", async () => {
  const current = __subagentsTest.getCurrentOwner()!;
  const liveOwner = {
    ...current,
    id: "owner_live_legacy_identity",
    parentPid: process.pid,
  };
  const id = "agent_live_owner";
  const statePath = writeRecord(liveOwner, runningRecord(liveOwner, id));

  await __subagentsTest.revisitStaleOwnerArtifacts(current);

  assert.equal(fs.existsSync(statePath), true);
  assert.equal(fs.existsSync(jobStatePathForStore(storePathsForOwner(current), id)), false);
});

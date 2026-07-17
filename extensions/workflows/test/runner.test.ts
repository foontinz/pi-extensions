import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { emptyUsageStats, type SubagentResult, type TerminalReason } from "../../subagents/core/types.js";
import { WorktreeStartupCleanupError } from "../../subagents/workspace/create-worktree.js";
import { WorkflowRunner } from "../index.js";

function ok(output: string, structured?: unknown): SubagentResult {
  return { output, structuredOutput: structured, usage: { ...emptyUsageStats(), input: 10, output: 5, turns: 1 } };
}

function fail(message: string, reason: TerminalReason = "error"): SubagentResult {
  return { output: "", usage: emptyUsageStats(), error: { reason, message } };
}

function makeRunner(exec: (task: string) => Promise<SubagentResult>, args?: unknown) {
  const controller = new AbortController();
  return new WorkflowRunner("/tmp", args, controller.signal, () => {}, async (o) => exec(o.task));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function initRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "f.txt"), "hi");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
  return fs.realpathSync(repo);
}

test("parallel fans out and aggregates usage", async () => {
  let calls = 0;
  const runner = makeRunner(async (task) => { calls++; return ok(task.toUpperCase()); });
  const result = await runner.run(`return await parallel(["a","b","c"], (x) => agent(x));`);
  assert.deepEqual(result, ["A", "B", "C"]);
  assert.equal(calls, 3);
  assert.equal(runner.launchedCount, 3);
  assert.equal(runner.usage.input, 30);
  assert.equal(runner.usage.turns, 3);
});

test("agent thinking inherits the root level and supports per-agent overrides", async () => {
  const controller = new AbortController();
  const observed: Array<string | undefined> = [];
  const runner = new WorkflowRunner(
    "/tmp",
    undefined,
    controller.signal,
    () => {},
    async (options) => {
      observed.push(options.thinkingLevel);
      return ok(options.task);
    },
    undefined,
    "",
    "",
    undefined,
    1_000,
    async () => { throw new Error("unused worktree factory"); },
    "high",
  );

  await runner.run(`
    await agent("inherit");
    await agent("override", { thinking: "off" });
    await agent("maximum", { thinking: "max" });
  `);
  assert.deepEqual(observed, ["high", "off", "max"]);
});

test("agent rejects invalid thinking levels", async () => {
  const runner = makeRunner(async (task) => ok(task));
  await assert.rejects(runner.run(`return await agent("bad", { thinking: "turbo" });`), /invalid workflow agent thinking level/);
});

test("pipeline chains stage functions", async () => {
  const runner = makeRunner(async (task) => ok(`${task}!`));
  const result = await runner.run(`return await pipeline(["x"], [ (v) => agent("a:"+v), (v) => agent("b:"+v) ]);`);
  assert.deepEqual(result, ["b:a:x!!"]);
});

test("agent returns null on failure and records it", async () => {
  const runner = makeRunner(async () => fail("boom"));
  const result = await runner.run(`return await agent("do");`);
  assert.equal(result, null);
  assert.equal(runner.failuresList.length, 1);
  assert.match(runner.failuresList[0].reason, /boom/);
});

test("schema result uses the typed same-session StructuredOutput outcome", async () => {
  const controller = new AbortController();
  let calls = 0;
  let forwardedSchema: unknown;
  const runner = new WorkflowRunner(
    "/tmp",
    undefined,
    controller.signal,
    () => {},
    async (options) => {
      calls += 1;
      forwardedSchema = options.schema;
      return {
        ...ok("ignored assistant text"),
        structuredOutput: { answer: 42 },
        structuredOutputOutcome: { status: "accepted", value: { answer: 42 }, submissions: 2 },
      };
    },
  );
  const result = await runner.run(`return await agent("q", { schema: { required: ["answer"] }, retries: 9 });`);
  assert.deepEqual(result, { answer: 42 });
  assert.deepEqual(forwardedSchema, { required: ["answer"] });
  assert.equal(calls, 1, "schema correction must not start replacement child sessions");
});

test("schema missing/exhausted outcomes fail deterministically", async () => {
  const outcomes: SubagentResult["structuredOutputOutcome"][] = [
    { status: "missing", submissions: 1, diagnostics: ["invalid"] },
    { status: "exhausted", reason: "max-submissions", submissions: 5, diagnostics: ["invalid"] },
  ];
  for (const outcome of outcomes) {
    const runner = makeRunner(async () => ({ ...ok("ignored"), structuredOutputOutcome: outcome }));
    const result = await runner.run(`return await agent("q", { schema: { type: "object" } });`);
    assert.equal(result, null);
    assert.match(runner.failuresList[0]!.reason, /structured output (missing|exhausted)/);
  }
});

test("without a schema agent returns exact text even when it looks like JSON", async () => {
  const exact = "  {\"answer\":42}\n";
  const runner = makeRunner(async () => ok(exact, { answer: 42 }));
  assert.equal(await runner.run(`return await agent("q");`), exact);
});

test("ordinary executor errors are not retried", async () => {
  let calls = 0;
  const runner = makeRunner(async () => {
    calls++;
    return fail("boom");
  });
  const result = await runner.run(`return await agent("q", { retries: 5 });`);
  assert.equal(result, null);
  assert.equal(calls, 1);
  assert.match(runner.failuresList[0].reason, /boom/);
});

test("run joins agent promises even when the script does not await them", async () => {
  let settled = false;
  const runner = makeRunner(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    settled = true;
    return ok("done");
  });
  const result = await runner.run(`agent("detached"); return "script output";`);
  assert.equal(result, "script output");
  assert.equal(settled, true, "detached agent must settle before run() resolves");
});

test("join includes agents launched by detached agent continuations", async () => {
  const completed: string[] = [];
  const runner = makeRunner(async (task) => {
    if (task === "second") await new Promise((resolve) => setTimeout(resolve, 20));
    completed.push(task);
    return ok(task);
  });
  const result = await runner.run(`agent("first").then(() => agent("second")); return "done";`);
  assert.equal(result, "done");
  assert.deepEqual(completed, ["first", "second"]);
});

test("detached derived-chain rejection fails the workflow without unhandledRejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const runner = makeRunner(async () => ok("done"));
    await assert.rejects(
      runner.run(`agent("first").then(() => { throw new Error("detached chain boom"); }); return "too early";`),
      /detached chain boom/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("native Promise.all detached continuation failures fail the workflow", async () => {
  const runner = makeRunner(async () => ok("done"));
  await assert.rejects(
    runner.run(`
      Promise.all([agent("first")]).then(() => { throw new Error("native Promise.all boom"); });
      return "must not win";
    `),
    /native Promise\.all boom/,
  );
});

test("detached async IIFE with an active timer finishes before the result", async () => {
  const runner = makeRunner(async () => ok("unused"));
  await assert.rejects(
    runner.run(`
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        throw new Error("detached IIFE boom");
      })();
      return "must not win";
    `),
    /detached IIFE boom/,
  );
});

test("unawaited helper failures are not silently lost", async (t) => {
  const cases = [
    {
      name: "parallel",
      script: `void parallel(["p"], async (value) => { await agent(value); throw new Error("detached parallel boom"); }); return "early";`,
      message: /detached parallel boom/,
    },
    {
      name: "pipeline",
      script: `void pipeline(["p"], [async (value) => { await agent(value); throw new Error("detached pipeline boom"); }]); return "early";`,
      message: /detached pipeline boom/,
    },
    {
      name: "workflow",
      script: `void workflow('await agent("nested"); throw new Error("detached workflow boom");'); return "early";`,
      message: /detached workflow boom/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const runner = makeRunner(async (task) => ok(task));
      await assert.rejects(runner.run(entry.script), entry.message);
    });
  }
});

test("nested workflow() keeps using the same agent hooks", async () => {
  const runner = makeRunner(async (task) => ok(task.toUpperCase()));
  const result = await runner.run(`return await workflow('return await agent("nested");');`);
  assert.equal(result, "NESTED");
});

test("caught nested workflow errors remain caught", async () => {
  const runner = makeRunner(async () => ok("unused"));
  const result = await runner.run(`
    try {
      await workflow('throw new Error("expected nested error");');
    } catch (error) {
      return "caught: " + error.message;
    }
  `);
  assert.equal(result, "caught: expected nested error");
});

test("parent join does not rethrow an agent RPC error caught by workflow code", async () => {
  const controller = new AbortController();
  const runner = new WorkflowRunner(
    "/tmp",
    undefined,
    controller.signal,
    () => {},
    async () => ok("unused"),
    undefined,
    "",
    "",
    undefined,
    1_000,
    async () => { throw new Error("expected worktree RPC error"); },
  );
  const result = await runner.run(`
    try {
      await agent("bad", { worktree: true });
    } catch (error) {
      return "caught: " + error.message;
    }
  `);
  assert.match(String(result), /caught: .*expected worktree RPC error/);
});

test("caught worktree disposal failures remain terminal and are recorded", async () => {
  const controller = new AbortController();
  const runner = new WorkflowRunner(
    "/tmp",
    undefined,
    controller.signal,
    () => {},
    async () => ok("done"),
    undefined,
    "",
    "",
    undefined,
    1_000,
    async () => ({
      cwd: "/tmp/isolated-worktree",
      dispose: async () => { throw new Error("injected cleanup failure"); },
    }),
  );

  await assert.rejects(
    runner.run(`
      try {
        await agent("isolated", { label: "isolated", worktree: true });
      } catch (error) {
        return "script caught: " + error.message;
      }
    `),
    /agent isolated: worktree disposal failed: injected cleanup failure/,
  );
  assert.equal(runner.failuresList.length, 1);
  assert.match(runner.failuresList[0].reason, /worktree disposal failed: injected cleanup failure/);
  assert.equal(runner.snapshot().agents[0].status, "failed");
});

test("failures() is refreshed when an agent response settles", async () => {
  const runner = makeRunner(async () => fail("expected failure"));
  const result = await runner.run(`await agent("bad"); return failures()[0].reason;`);
  assert.match(String(result), /expected failure/);
});

test("terminal script errors abort and drain detached sibling agents", async () => {
  const controller = new AbortController();
  let sawAbort = false;
  let settled = false;
  const runner = new WorkflowRunner("/tmp", undefined, controller.signal, () => {}, async (o) => {
    await new Promise<void>((resolve) => {
      if (o.signal?.aborted) return resolve();
      o.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    sawAbort = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    settled = true;
    return fail("aborted", "stop");
  });

  await assert.rejects(
    runner.run(`agent("slow"); await Promise.resolve(); throw new Error("script boom");`),
    /script boom/,
  );
  assert.equal(sawAbort, true, "sibling executor should receive the terminal abort");
  assert.equal(settled, true, "run() should drain the sibling before rejecting");
});

test("snapshot tracks agent lifecycle, phases and usage", async () => {
  const snaps: number[] = [];
  const controller = new AbortController();
  const runner = new WorkflowRunner(
    "/tmp",
    undefined,
    controller.signal,
    () => {},
    async (o) => ok(o.task.toUpperCase()),
    (snap) => snaps.push(snap.agents.length),
    "run1234",
    "inline",
  );
  await runner.run(`phase("build"); return await parallel(["a","b"], (x) => agent(x, { label: x }));`);
  const final = runner.snapshot();
  assert.equal(final.runId, "run1234");
  assert.deepEqual(final.phases, ["build"]);
  assert.equal(final.agents.length, 2);
  assert.ok(final.agents.every((a) => a.status === "completed"));
  assert.equal(final.launched, 2);
  assert.equal(final.usage.input, 20);
  assert.ok(snaps.length > 0, "onState should be called during the run");
});

test("snapshot exposes each agent's task and latest live activity", async () => {
  const controller = new AbortController();
  const activities: string[] = [];
  const runner = new WorkflowRunner(
    "/tmp",
    undefined,
    controller.signal,
    () => {},
    async (options) => {
      options.onActivity?.("\x1b]2;spoofed\x07\x1b[2J→ read extensions/workflows/index.ts\x00");
      return ok("done");
    },
    (snapshot) => {
      if (snapshot.agents[0]?.activity) activities.push(snapshot.agents[0].activity);
    },
  );
  await runner.run(`return await agent("Inspect workflow rendering in detail", { label: "inspect" });`);
  assert.ok(activities.includes("Inspect workflow rendering in detail"));
  assert.equal(runner.snapshot().agents[0].activity, "→ read extensions/workflows/index.ts");
});

test("snapshot records a failed agent with its reason", async () => {
  const controller = new AbortController();
  const runner = new WorkflowRunner("/tmp", undefined, controller.signal, () => {}, async () => fail("boom"), () => {}, "r", "inline");
  await runner.run(`return await agent("do", { retries: 0, label: "do" });`);
  const view = runner.snapshot().agents[0];
  assert.equal(view.status, "failed");
  assert.match(view.reason ?? "", /boom/);
});

test("phase/log callback exceptions reject instead of escaping uncaught", async (t) => {
  await t.test("phase progress callback", async () => {
    const controller = new AbortController();
    const runner = new WorkflowRunner(
      "/tmp",
      undefined,
      controller.signal,
      () => { throw new Error("phase progress callback boom"); },
      async () => ok("unused"),
    );
    await assert.rejects(runner.run(`phase("build"); return "early";`), /phase progress callback boom/);
  });

  await t.test("log state callback", async () => {
    const controller = new AbortController();
    const runner = new WorkflowRunner(
      "/tmp",
      undefined,
      controller.signal,
      () => {},
      async () => ok("unused"),
      () => { throw new Error("log state callback boom"); },
    );
    await assert.rejects(runner.run(`log("message"); return "early";`), /log state callback boom/);
  });

  await t.test("agent state callback cannot be suppressed by script catch", async () => {
    const controller = new AbortController();
    const runner = new WorkflowRunner(
      "/tmp",
      undefined,
      controller.signal,
      () => {},
      async () => ok("unused"),
      () => { throw new Error("agent state callback boom"); },
    );
    await assert.rejects(
      runner.run(`try { await agent("a"); } catch {} return "must not win";`),
      /agent state callback boom/,
    );
  });
});

test("args() exposes the input value", async () => {
  const runner = makeRunner(async () => ok("x"), { topic: "cats" });
  const result = await runner.run(`return args().topic;`);
  assert.equal(result, "cats");
});

test("agent cap is enforced", async () => {
  const runner = makeRunner(async () => ok("x"));
  await assert.rejects(
    runner.run(`for (let i=0;i<200;i++){ await agent("t"); } return "done";`),
    /agent cap exceeded/,
  );
});

test("agent forwards resolved cwd and tools to executor", async () => {
  const seen: Array<{ cwd: string; tools?: readonly string[] }> = [];
  const controller = new AbortController();
  const runner = new WorkflowRunner("/base", undefined, controller.signal, () => {}, async (o) => {
    seen.push({ cwd: o.cwd, tools: o.tools });
    return ok("done");
  });
  await runner.run(`await agent("a", { cwd: "sub", tools: ["read"] }); return await agent("b");`);
  assert.equal(seen[0].cwd, "/base/sub");
  assert.deepEqual(Array.from(seen[0].tools!), ["read"]);
  assert.equal(seen[1].cwd, "/base");
  assert.deepEqual(Array.from(seen[1].tools!), ["read", "bash"]);
});

test("worktree runs the agent in a dedicated worktree and tears it down", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wf-worktree-"));
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "hi");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
    const realRepo = fs.realpathSync(repo);

    let seenCwd = "";
    const controller = new AbortController();
    const runner = new WorkflowRunner(realRepo, undefined, controller.signal, () => {}, async (o) => {
      seenCwd = o.cwd;
      assert.ok(fs.existsSync(o.cwd), "worktree cwd should exist while the agent runs");
      return { output: "done", usage: emptyUsageStats() };
    });
    const result = await runner.run(`return await agent("a", { worktree: true });`);
    assert.equal(result, "done");
    assert.notEqual(seenCwd, realRepo);
    assert.ok(!fs.existsSync(seenCwd), "worktree should be removed after the agent finishes");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("logDir: writes an events.log timeline and forwards per-agent sessionDir/sessionId", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-log-"));
  try {
    const seen: Array<{ sessionDir?: string; sessionId?: string }> = [];
    const controller = new AbortController();
    const runner = new WorkflowRunner(
      "/base",
      undefined,
      controller.signal,
      () => {},
      async (o) => {
        seen.push({ sessionDir: o.sessionDir, sessionId: o.sessionId });
        return { output: "ok", usage: emptyUsageStats(), sessionFile: path.join(o.sessionDir ?? "", "2026_x.jsonl") };
      },
      () => {},
      "run1234",
      "inline",
      logDir,
    );
    await runner.run(`phase("build"); return await agent("a", { label: "first" });`);

    assert.equal(seen[0].sessionDir, path.join(logDir, "agents"));
    assert.equal(seen[0].sessionId, "run1234-a0");

    const log = fs.readFileSync(path.join(logDir, "events.log"), "utf8");
    assert.match(log, /phase: build/);
    assert.match(log, /agent first started/);
    assert.match(log, /agent first \(#0\) transcript: agents\/2026_x\.jsonl/);
    assert.match(log, /agent first completed/);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("logDir: parallel agents each get a distinct transcript mapping in events.log", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-log-par-"));
  try {
    const controller = new AbortController();
    const runner = new WorkflowRunner(
      "/base",
      undefined,
      controller.signal,
      () => {},
      async (o) => ({ output: "ok", usage: emptyUsageStats(), sessionFile: path.join(o.sessionDir ?? "", `t_${o.sessionId}.jsonl`) }),
      () => {},
      "runpar12",
      "inline",
      logDir,
    );
    await runner.run(`return await parallel(["a","b","c"], (x) => agent(x, { label: x }));`);
    const log = fs.readFileSync(path.join(logDir, "events.log"), "utf8");
    for (const i of [0, 1, 2]) {
      assert.match(log, new RegExp(`transcript: agents/t_runpar12-a${i}\\.jsonl`), `agent #${i} mapped`);
    }
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("no logDir: no sessionDir/sessionId forwarded and no events.log written", async () => {
  const seen: Array<{ sessionDir?: string; sessionId?: string }> = [];
  const controller = new AbortController();
  const runner = new WorkflowRunner("/base", undefined, controller.signal, () => {}, async (o) => {
    seen.push({ sessionDir: o.sessionDir, sessionId: o.sessionId });
    return ok("x");
  }, () => {}, "run1234", "inline");
  await runner.run(`return await agent("a");`);
  assert.equal(seen[0].sessionDir, undefined);
  assert.equal(seen[0].sessionId, undefined);
});

test("aborted workflow stops launching agents", async () => {
  const controller = new AbortController();
  controller.abort();
  const runner = new WorkflowRunner("/base", undefined, controller.signal, () => {}, async () => ok("x"));
  await assert.rejects(runner.run(`return await agent("a");`), /aborted/);
});

test("abort terminates a workflow awaiting a never-settling script promise", async () => {
  const controller = new AbortController();
  const runner = new WorkflowRunner("/tmp", undefined, controller.signal, () => {}, async () => ok("x"));
  const run = runner.run(`return await new Promise(() => {});`);
  setTimeout(() => controller.abort(new Error("stop")), 20);

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        run,
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => reject(new Error("run did not terminate after abort")), 500);
        }),
      ]),
      /workflow aborted/,
    );
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
});

test("abort terminates a workflow with a never-settling executor promise", async () => {
  const controller = new AbortController();
  let started = false;
  const runner = new WorkflowRunner("/tmp", undefined, controller.signal, () => {}, async () => {
    started = true;
    return await new Promise<SubagentResult>(() => {});
  });
  const run = runner.run(`return await agent("stuck");`);
  await waitFor(() => started);
  controller.abort(new Error("stop"));

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        run,
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => reject(new Error("run did not terminate after abort")), 500);
        }),
      ]),
      /workflow aborted/,
    );
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
});

test("synchronous worker execution is bounded", async () => {
  const controller = new AbortController();
  const runner = new WorkflowRunner(
    "/tmp",
    undefined,
    controller.signal,
    () => {},
    async () => ok("x"),
    undefined,
    "",
    "",
    undefined,
    25,
  );
  const started = Date.now();
  await assert.rejects(
    runner.run(`while (true) {}`),
    (error: any) => error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT",
  );
  assert.ok(Date.now() - started < 1_000, "worker termination should stop the synchronous loop promptly");
});

test("worker timeout terminates an infinite loop entered after await", async () => {
  const controller = new AbortController();
  const runner = new WorkflowRunner(
    "/tmp",
    undefined,
    controller.signal,
    () => {},
    async () => ok("x"),
    undefined,
    "",
    "",
    undefined,
    35,
  );
  const started = Date.now();
  await assert.rejects(
    runner.run(`await Promise.resolve(); while (true) {}`),
    (error: any) => error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT",
  );
  assert.ok(Date.now() - started < 1_000, "a post-await loop must not block the parent timeout");
});

test("queued cancellation is abort-aware and does not provision queued worktrees", async () => {
  const repo = initRepo("wf-queued-abort-");
  try {
    const controller = new AbortController();
    let calls = 0;
    const runner = new WorkflowRunner(repo, undefined, controller.signal, () => {}, async (o) => {
      calls++;
      await new Promise<void>((resolve) => {
        if (o.signal?.aborted) return resolve();
        o.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fail("aborted", "stop");
    });
    const run = runner.run(`
      return await parallel(Array.from({ length: 9 }, (_, i) => i),
        (i) => agent("agent-" + i, i === 8 ? { worktree: true } : {}));
    `);

    await waitFor(() => calls === 8);
    assert.equal(runner.snapshot().queued, 1);
    controller.abort(new Error("stop"));
    await assert.rejects(run, /workflow aborted/);
    assert.equal(calls, 8, "the cancelled queued agent must never reach its executor");
    assert.equal(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).match(/^worktree /gm)?.length, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("cancellation aborts in-progress worktree provisioning before executor launch", async () => {
  const controller = new AbortController();
  let provisioning = false;
  let provisioningAborted = false;
  let executorCalls = 0;
  const worktreeFactory = async (_cwd: string, options: { signal?: AbortSignal }) => {
    provisioning = true;
    await new Promise<void>((_resolve, reject) => {
      const signal = options.signal!;
      const onAbort = () => {
        provisioningAborted = true;
        reject(new Error("provisioning aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    throw new Error("unreachable");
  };
  const runner = new WorkflowRunner(
    "/tmp",
    undefined,
    controller.signal,
    () => {},
    async () => { executorCalls++; return ok("x"); },
    undefined,
    "",
    "",
    undefined,
    1_000,
    worktreeFactory,
  );
  const run = runner.run(`return await agent("isolated", { worktree: true });`);
  await waitFor(() => provisioning);
  controller.abort(new Error("stop"));
  await assert.rejects(run, /workflow aborted/);
  assert.equal(provisioningAborted, true);
  assert.equal(executorCalls, 0);
});

test("cancelled worktree startup cleanup failure is recorded and surfaced", async () => {
  const controller = new AbortController();
  let provisioning = false;
  const cleanupFailure = new WorktreeStartupCleanupError(
    new Error("stop"),
    {
      root: "/tmp/partial-worktree",
      tempParent: "/tmp/partial-parent",
      originalRoot: "/tmp/repo",
      originalCwd: "/tmp/repo",
      base: "HEAD",
      copied: [],
      postCopy: [],
      keepWorktree: "never",
    },
    new Error("git remove denied"),
  );
  const worktreeFactory = async (_cwd: string, options: { signal?: AbortSignal }) => {
    provisioning = true;
    await new Promise<void>((resolve) => {
      const signal = options.signal!;
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw cleanupFailure;
  };
  const runner = new WorkflowRunner(
    "/tmp",
    undefined,
    controller.signal,
    () => {},
    async () => ok("unused"),
    undefined,
    "",
    "",
    undefined,
    1_000,
    worktreeFactory,
  );

  const run = runner.run(`return await agent("isolated", { label: "isolated", worktree: true });`);
  await waitFor(() => provisioning);
  controller.abort(new Error("stop"));
  await assert.rejects(
    run,
    (error: unknown) => error === cleanupFailure && /cleanup failed: git remove denied/.test((error as Error).message),
  );
  assert.equal(runner.failuresList.length, 1);
  assert.match(runner.failuresList[0].reason, /cleanup failed: git remove denied/);
  assert.equal(runner.snapshot().agents[0].status, "failed");
});

test("mid-flight abort surfaces as a rejection (not silent nulls)", async () => {
  const controller = new AbortController();
  // Executor resolves only after the workflow signal aborts, mimicking an
  // in-flight subagent that gets cancelled (executor returns a stop error).
  const runner = new WorkflowRunner("/base", undefined, controller.signal, () => {}, async (o) => {
    await new Promise<void>((resolve) => {
      if (o.signal?.aborted) return resolve();
      o.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fail("aborted", "stop");
  });
  const p = runner.run(`return await parallel([1,2,3], (n) => agent("t"+n));`);
  setTimeout(() => controller.abort(new Error("timed out")), 20);
  await assert.rejects(p, /aborted/);
});

test("external cancellation drains real executor cleanup after abort", async () => {
  const controller = new AbortController();
  let started = false;
  let cleanedUp = false;
  const runner = new WorkflowRunner("/base", undefined, controller.signal, () => {}, async (o) => {
    started = true;
    await new Promise<void>((resolve) => {
      if (o.signal?.aborted) return resolve();
      o.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    cleanedUp = true;
    return fail("aborted", "stop");
  });
  const run = runner.run(`return await agent("slow cleanup");`);
  await waitFor(() => started);
  controller.abort(new Error("stop"));
  await assert.rejects(run, /workflow aborted/);
  assert.equal(cleanedUp, true, "runner must await the real executor promise after signalling abort");
});

test("worktree disposal errors reject the run and are recorded", async () => {
  const repo = initRepo("wf-dispose-error-");
  try {
    const controller = new AbortController();
    const runner = new WorkflowRunner(repo, undefined, controller.signal, () => {}, async () => {
      // Removing the original repository makes both `git worktree remove` and
      // its fallback `git worktree prune` fail during disposal.
      fs.rmSync(repo, { recursive: true, force: true });
      return ok("done");
    });

    await assert.rejects(
      runner.run(`return await agent("a", { worktree: true, label: "isolated" });`),
      /worktree disposal failed/,
    );
    assert.equal(runner.failuresList.length, 1);
    assert.match(runner.failuresList[0].reason, /worktree disposal failed/);
    assert.equal(runner.snapshot().agents[0].status, "failed");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

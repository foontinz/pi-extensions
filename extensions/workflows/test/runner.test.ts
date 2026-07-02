import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { emptyUsageStats, type SubagentResult, type TerminalReason } from "../../subagents/core/types.js";
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

test("schema retry succeeds on second attempt", async () => {
  let n = 0;
  const runner = makeRunner(async () => (++n === 1 ? ok("not json") : ok('{"answer":42}', { answer: 42 })));
  const result = await runner.run(`return await agent("q", { schema: { required: ["answer"] } });`);
  assert.deepEqual(result, { answer: 42 });
  assert.equal(n, 2);
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

test("isolate runs the agent in a dedicated worktree and tears it down", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wf-isolate-"));
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
    const result = await runner.run(`return await agent("a", { isolate: true });`);
    assert.equal(result, "done");
    assert.notEqual(seenCwd, realRepo);
    assert.ok(!fs.existsSync(seenCwd), "worktree should be removed after the agent finishes");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("aborted workflow stops launching agents", async () => {
  const controller = new AbortController();
  controller.abort();
  const runner = new WorkflowRunner("/base", undefined, controller.signal, () => {}, async () => ok("x"));
  await assert.rejects(runner.run(`return await agent("a");`), /aborted/);
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

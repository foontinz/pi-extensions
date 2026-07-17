import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalWorkflowWorker,
  type WorkerBudgetSnapshot,
  type WorkerRuntimeHooks,
} from "../runtime/worker.js";

const budget: WorkerBudgetSnapshot = { total: 100, spent: 0, reserved: 0, remaining: 100 };

function runner(agentImpl: WorkerRuntimeHooks["agent"] = async (request) => ({
  value: request.task.toUpperCase(),
  failures: [],
  budget,
})) {
  return new CanonicalWorkflowWorker({
    agent: agentImpl,
    workflow: async (request) => ({ value: request.args, failures: [], budget }),
  });
}

function input(bodySource: string, overrides: Partial<Parameters<CanonicalWorkflowWorker["run"]>[0]> = {}) {
  return {
    bodySource,
    filename: "fixture.workflow.js",
    args: { topic: "cats" },
    phaseIds: ["review", "verify"],
    initialBudget: budget,
    timeoutMs: 1_000,
    resumable: false,
    ...overrides,
  };
}

test("canonical parallel accepts only thunk arrays and preserves source order", async () => {
  const workflow = runner(async (request) => {
    if (request.task === "a") await new Promise((resolve) => setTimeout(resolve, 15));
    return { value: request.task.toUpperCase(), failures: [], budget };
  });
  const result = await workflow.run(input(`return await parallel([
    () => agent("a", {id:"a"}),
    () => agent("b", {id:"b"}),
  ]);`));
  assert.deepEqual(result, ["A", "B"]);
  await assert.rejects(
    workflow.run(input(`return await parallel(["a"], (x) => x);`)),
    (error: any) => error?.code === "PARALLEL_SIGNATURE",
  );
});

test("pipeline is variadic, item-independent, ordered, and null skips later stages", async () => {
  const seen: string[] = [];
  const workflow = runner(async (request) => {
    seen.push(request.task);
    return { value: request.task.includes("drop") ? null : request.task, failures: [], budget };
  });
  const result = await workflow.run(input(`return await pipeline(
    ["keep", "drop"],
    (previous, original, index) => agent(previous, {id:"first:"+index}),
    (previous, original, index) => agent(previous+":"+original, {id:"second:"+index}),
  );`));
  assert.deepEqual(result, ["keep:keep", null]);
  assert.deepEqual(seen.sort(), ["drop", "keep", "keep:keep"].sort());
  await assert.rejects(
    workflow.run(input(`return await pipeline([1], [(x) => x]);`)),
    (error: any) => error?.code === "PIPELINE_SIGNATURE",
  );
});

test("args is immutable data, phase IDs are validated, and agent IDs are required", async () => {
  const phases: string[] = [];
  const workflow = new CanonicalWorkflowWorker({
    agent: async (request) => ({ value: request.phase, failures: [], budget }),
    workflow: async () => ({ value: null, failures: [], budget }),
    phase: (id) => phases.push(id),
  });
  const result = await workflow.run(input(`
    phase("review");
    let mutation;
    try { args.topic = "dogs"; } catch { mutation = "blocked"; }
    return { topic: args.topic, mutation, phase: await agent("x", {id:"x"}) };
  `));
  assert.deepEqual(result, { topic: "cats", mutation: "blocked", phase: "review" });
  assert.deepEqual(phases, ["review"]);
  await assert.rejects(workflow.run(input(`phase("missing");`)), (error: any) => error?.code === "UNKNOWN_PHASE");
  await assert.rejects(workflow.run(input(`return await agent("x", {});`)), (error: any) => error?.code === "AGENT_ID_REQUIRED");
  await assert.rejects(workflow.run(input(`return args();`)), /args is not a function/);
});

test("workflow requires explicit references and clones child args", async () => {
  let observed: unknown;
  const workflow = new CanonicalWorkflowWorker({
    agent: async () => ({ value: null, failures: [], budget }),
    workflow: async (request) => {
      observed = request;
      return { value: request.args, failures: [], budget };
    },
  });
  const result = await workflow.run(input(`return await workflow({scriptPath:"./child.workflow.js"}, {x:1});`));
  assert.deepEqual(result, { x: 1 });
  assert.deepEqual((observed as any).reference, { scriptPath: "./child.workflow.js" });
  await assert.rejects(workflow.run(input(`return await workflow("return 1");`)), (error: any) => error?.code === "WORKFLOW_REFERENCE");
  await assert.rejects(workflow.run(input(`return await workflow({name:"x", scriptPath:"y"});`)), (error: any) => error?.code === "WORKFLOW_REFERENCE");
});

test("failures and budget are immutable snapshots refreshed by RPC", async () => {
  const nextBudget = { total: 100, spent: 12, reserved: 3, remaining: 85 };
  const workflow = runner(async () => ({ value: null, failures: [{ nodeId: "x", reason: "boom" }], budget: nextBudget }));
  const result = await workflow.run(input(`
    await agent("x", {id:"x"});
    const snapshot = failures();
    let immutable = false;
    try { snapshot.push({}); } catch { immutable = true; }
    return { failure: snapshot[0].reason, immutable, spent: budget.spent(), remaining: budget.remaining() };
  `));
  assert.deepEqual(result, { failure: "boom", immutable: true, spent: 12, remaining: 85 });
});

test("detached async failures cannot race a successful worker result", async () => {
  const workflow = runner();
  await assert.rejects(
    workflow.run(input(`agent("x", {id:"x"}).then(() => { throw new Error("detached boom") }); return "early";`)),
    /detached boom/,
  );
  await assert.rejects(
    workflow.run(input(`void (async () => { await new Promise((resolve) => setTimeout(resolve, 10)); throw new Error("timer boom") })(); return "early";`)),
    /timer boom/,
  );
});

test("synchronous parent hook failures terminalize instead of escaping the message callback", async () => {
  const workflow = new CanonicalWorkflowWorker({
    agent: (() => { throw new Error("hook boom"); }) as WorkerRuntimeHooks["agent"],
    workflow: async () => ({ value: null, failures: [], budget }),
  });
  await assert.rejects(workflow.run(input(`return await agent("x", {id:"x"});`)), /hook boom/);
});

test("worker disables string/wasm code generation and enforces the parent deadline", async () => {
  const workflow = runner();
  await assert.rejects(workflow.run(input(`return Function("return 1")();`)), /Code generation from strings disallowed/);
  const started = Date.now();
  await assert.rejects(
    workflow.run(input(`await Promise.resolve(); while (true) {}`, { timeoutMs: 30 })),
    (error: any) => error?.code === "WORKFLOW_DEADLINE",
  );
  assert.ok(Date.now() - started < 1_000);
});

test("resumable workers omit nondeterministic timer globals", async () => {
  const workflow = runner();
  const result = await workflow.run(input(`return {
    date: typeof Date,
    random: typeof Math.random,
    timer: typeof setTimeout,
    race: typeof Promise.race,
  };`, { resumable: true }));
  assert.deepEqual(result, { date: "undefined", random: "undefined", timer: "undefined", race: "undefined" });
});

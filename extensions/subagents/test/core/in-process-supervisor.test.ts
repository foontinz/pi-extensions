import assert from "node:assert/strict";
import test from "node:test";
import {
  __inProcessSupervisorTest,
  startInProcessAgent,
  type InProcessOutcome,
} from "../../supervisor/in-process-supervisor.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    model: {},
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
    ...overrides,
  } as any;
}

test.beforeEach(() => {
  __inProcessSupervisorTest.setModelRuntime(async () => ({
    getModels: () => [],
    hasConfiguredAuth: () => false,
  }) as any);
});

test.afterEach(() => {
  __inProcessSupervisorTest.setCreateAgentSession(undefined);
  __inProcessSupervisorTest.setModelRuntime(undefined);
});

test("execute signal force-aborts pending session startup and disposes a late-created session", async () => {
  let releaseCreate!: (value: { session: any }) => void;
  const createPending = new Promise<{ session: any }>((resolve) => { releaseCreate = resolve; });
  let markCreateStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
  let promptCalls = 0;
  let abortCalls = 0;
  let disposeCalls = 0;
  const session = fakeSession({
    prompt: async () => { promptCalls += 1; },
    abort: async () => { abortCalls += 1; },
    dispose: () => { disposeCalls += 1; },
  });
  __inProcessSupervisorTest.setCreateAgentSession(async () => {
    markCreateStarted();
    return await createPending as any;
  });

  const controller = new AbortController();
  const outcomes: InProcessOutcome[] = [];
  const handle = startInProcessAgent({
    cwd: process.cwd(),
    task: "never launch",
    tools: [],
    signal: controller.signal,
    onEvent: () => {},
    onDone: (outcome) => outcomes.push(outcome),
  });

  await createStarted;
  controller.abort(new Error("tool cancelled"));
  assert.deepEqual(outcomes, [{ aborted: true }]);
  releaseCreate({ session });
  await tick();
  await tick();

  assert.equal(promptCalls, 0);
  assert.equal(abortCalls, 0, "there was no session to abort before startup resolved");
  assert.equal(disposeCalls, 1, "the late-created session is still disposed");
  handle.forceAbort?.();
  handle.dispose?.();
  assert.equal(disposeCalls, 1);
  assert.equal(outcomes.length, 1);
});

test("detaching the startup signal lets the acknowledged job outlive its parent turn", async () => {
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  let finishPrompt!: () => void;
  const prompt = new Promise<void>((resolve) => { finishPrompt = resolve; });
  let abortCalls = 0;
  let disposeCalls = 0;
  const session = fakeSession({
    prompt: () => { promptStarted(); return prompt; },
    abort: async () => { abortCalls += 1; },
    dispose: () => { disposeCalls += 1; },
  });
  __inProcessSupervisorTest.setCreateAgentSession(async () => ({ session }) as any);

  const controller = new AbortController();
  const outcomes: InProcessOutcome[] = [];
  const handle = startInProcessAgent({
    cwd: process.cwd(),
    task: "continue in background",
    tools: [],
    signal: controller.signal,
    onEvent: () => {},
    onDone: (outcome) => outcomes.push(outcome),
  });
  await started;

  handle.detachStartupSignal?.();
  controller.abort(new Error("parent turn completed"));
  await tick();
  assert.equal(abortCalls, 0);
  assert.equal(disposeCalls, 0);
  assert.deepEqual(outcomes, []);

  finishPrompt();
  await tick();
  assert.deepEqual(outcomes, [{ aborted: false }]);
  assert.equal(disposeCalls, 1);
});

test("completion callback failures are retried without duplicating disposal", async () => {
  let completionCalls = 0;
  let disposeCalls = 0;
  const outcomes: InProcessOutcome[] = [];
  const session = fakeSession({ dispose: () => { disposeCalls += 1; } });
  __inProcessSupervisorTest.setCreateAgentSession(async () => ({ session }) as any);

  const handle = startInProcessAgent({
    cwd: process.cwd(),
    task: "complete",
    tools: [],
    onEvent: () => {},
    onDone: (outcome) => {
      completionCalls += 1;
      if (completionCalls === 1) throw new Error("transient owner callback failure");
      outcomes.push(outcome);
    },
  });

  await tick();
  await tick();
  assert.equal(completionCalls, 2);
  assert.deepEqual(outcomes, [{ aborted: false }]);
  assert.equal(disposeCalls, 1);

  handle.dispose?.();
  handle.dispose?.();
  assert.equal(completionCalls, 2);
  assert.equal(disposeCalls, 1);
});

test("forceAbort settles and disposes once when cooperative session.abort never settles", async () => {
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  let abortCalls = 0;
  let disposeCalls = 0;
  const session = fakeSession({
    prompt: () => { promptStarted(); return new Promise<void>(() => {}); },
    abort: () => { abortCalls += 1; return new Promise<void>(() => {}); },
    dispose: () => { disposeCalls += 1; },
  });
  __inProcessSupervisorTest.setCreateAgentSession(async () => ({ session }) as any);

  const outcomes: InProcessOutcome[] = [];
  const handle = startInProcessAgent({
    cwd: process.cwd(),
    task: "hang",
    tools: [],
    onEvent: () => {},
    onDone: (outcome) => outcomes.push(outcome),
  });
  await started;

  handle.abort();
  await tick();
  assert.equal(outcomes.length, 0);
  handle.forceAbort?.();
  handle.forceAbort?.();
  handle.dispose?.();

  assert.equal(abortCalls, 1);
  assert.equal(disposeCalls, 1);
  assert.deepEqual(outcomes, [{ aborted: true }]);
});

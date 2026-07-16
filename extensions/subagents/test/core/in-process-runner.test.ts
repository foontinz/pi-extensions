import assert from "node:assert/strict";
import test from "node:test";
import type { CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import { __inProcessRunnerTest, createBareResourceLoader, resolveModelPattern, runSubagentInProcess } from "../../core/in-process-runner.js";

type ResolverRegistry = NonNullable<Parameters<typeof resolveModelPattern>[1]>;

function modelRegistry(models: Array<{ provider: string; id: string }>, authenticated: string[] = []): ResolverRegistry {
  const authenticatedProviders = new Set(authenticated.map((key) => key.split("/", 1)[0]));
  return {
    getModels: () => models,
    hasConfiguredAuth: (providerId: string) => authenticatedProviders.has(providerId),
  } as unknown as ResolverRegistry;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test.beforeEach(() => {
  __inProcessRunnerTest.setModelRuntime(async () => ({}) as never);
});

test.afterEach(() => {
  __inProcessRunnerTest.setModelRuntime(undefined);
});

function blockFor(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Exercise work that prevents the timeout callback from running.
  }
}

async function settlesPromptly<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setImmediate(() => reject(new Error("run did not settle by the next event-loop turn")))),
  ]);
}

function fakeSession(overrides: Record<string, unknown> = {}): CreateAgentSessionResult["session"] {
  return {
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
    messages: [],
    ...overrides,
  } as unknown as CreateAgentSessionResult["session"];
}

test("resolveModelPattern returns undefined for empty/blank patterns", () => {
  const registry = modelRegistry([]);
  assert.equal(resolveModelPattern(undefined, registry), undefined);
  assert.equal(resolveModelPattern("", registry), undefined);
  assert.equal(resolveModelPattern("   ", registry), undefined);
});

test("resolveModelPattern returns undefined when nothing matches", () => {
  assert.equal(resolveModelPattern("missing/model", modelRegistry([{ provider: "known", id: "model" }])), undefined);
});

test("resolveModelPattern recognizes only registered provider prefixes and preserves the full ID", () => {
  const registry = modelRegistry([
    { provider: "openrouter", id: "anthropic/claude-sonnet-4:free" },
    { provider: "other", id: "unregistered/team/model:free" },
  ]);

  assert.deepEqual(resolveModelPattern("openrouter/anthropic/claude-sonnet-4:free", registry), {
    provider: "openrouter",
    id: "anthropic/claude-sonnet-4:free",
  });
  assert.deepEqual(resolveModelPattern("unregistered/team/model:free", registry), {
    provider: "other",
    id: "unregistered/team/model:free",
  });
});

test("resolveModelPattern prefers auth only within the best match tier", () => {
  const registry = modelRegistry([
    { provider: "first", id: "team/model:free" },
    { provider: "second", id: "team/model:free" },
    { provider: "first", id: "model" },
    { provider: "second", id: "model-plus" },
  ], ["second/team/model:free", "second/model-plus"]);
  assert.deepEqual(resolveModelPattern("team/model:free", registry), { provider: "second", id: "team/model:free" });
  assert.deepEqual(resolveModelPattern("model", registry), { provider: "first", id: "model" });
});

test("resolveModelPattern distinguishes real colon IDs from CLI thinking suffixes", () => {
  const registry = modelRegistry([
    { provider: "gateway", id: "team/model" },
    { provider: "gateway", id: "team/model:free" },
    { provider: "gateway", id: "named:high" },
    { provider: "other", id: "named" },
  ], ["other/named"]);

  assert.deepEqual(resolveModelPattern("team/model:free", registry), { provider: "gateway", id: "team/model:free" });
  assert.deepEqual(resolveModelPattern("team/model:xhigh", registry), { provider: "gateway", id: "team/model" });
  assert.deepEqual(resolveModelPattern("team/model:max", registry), { provider: "gateway", id: "team/model" });
  assert.deepEqual(resolveModelPattern("named:high", registry), { provider: "gateway", id: "named:high" });
});

test("resolveModelPattern falls back to a literal slash ID after known-provider matching fails", () => {
  const registry = modelRegistry([
    { provider: "known", id: "different" },
    { provider: "gateway", id: "known/team/model" },
  ]);
  assert.deepEqual(resolveModelPattern("known/team/model", registry), { provider: "gateway", id: "known/team/model" });
});

test("external abort settles pending creation promptly and disposes a late session", async () => {
  const controller = new AbortController();
  const creation = deferred<CreateAgentSessionResult>();
  const started = deferred<void>();
  let promptCalls = 0;
  let disposeCalls = 0;
  const session = fakeSession({
    prompt: async () => { promptCalls += 1; },
    dispose: () => { disposeCalls += 1; },
  });

  const run = runSubagentInProcess({ task: "must not run", cwd: process.cwd(), signal: controller.signal }, () => {
    started.resolve();
    return creation.promise;
  });
  await started.promise;

  controller.abort();
  const result = await settlesPromptly(run);
  assert.equal(result.error?.reason, "stop");
  assert.equal(promptCalls, 0);
  assert.equal(disposeCalls, 0, "there is no session to dispose before creation finishes");

  creation.resolve({ session } as CreateAgentSessionResult);
  await nextTurn();
  assert.equal(promptCalls, 0);
  assert.equal(disposeCalls, 1);
});

test("timeout covers asynchronous model runtime creation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  __inProcessRunnerTest.setModelRuntime(() => new Promise(() => {}));
  let createCalls = 0;

  const run = runSubagentInProcess(
    { task: "must not run", cwd: process.cwd(), timeoutMs: 50 },
    async () => {
      createCalls += 1;
      return { session: fakeSession() } as CreateAgentSessionResult;
    },
  );
  t.mock.timers.tick(50);

  const result = await settlesPromptly(run);
  assert.equal(result.error?.reason, "timeout");
  assert.equal(result.error?.message, "subagent timed out after 50ms");
  assert.equal(createCalls, 0);
});

test("timeout covers session creation and disposes a late-created session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const creation = deferred<CreateAgentSessionResult>();
  const started = deferred<void>();
  let promptCalls = 0;
  let disposeCalls = 0;
  const session = fakeSession({
    prompt: async () => { promptCalls += 1; },
    dispose: () => { disposeCalls += 1; },
  });

  const run = runSubagentInProcess({ task: "must not run", cwd: process.cwd(), timeoutMs: 50 }, () => {
    started.resolve();
    return creation.promise;
  });
  await started.promise;
  t.mock.timers.tick(50);

  const result = await settlesPromptly(run);
  assert.equal(result.error?.reason, "timeout");
  assert.equal(result.error?.message, "subagent timed out after 50ms");
  assert.equal(promptCalls, 0);

  creation.resolve({ session } as CreateAgentSessionResult);
  await nextTurn();
  assert.equal(disposeCalls, 1);
});

test("external cancellation settles when prompt and abort never resolve and keeps partial state", async () => {
  const controller = new AbortController();
  const promptStarted = deferred<void>();
  const never = new Promise<void>(() => {});
  let abortCalls = 0;
  let disposeCalls = 0;
  const session = fakeSession({
    prompt: () => { promptStarted.resolve(); return never; },
    abort: () => { abortCalls += 1; return never; },
    dispose: () => { disposeCalls += 1; },
    messages: [{ role: "assistant", content: [{ type: "text", text: "partial cancellation output" }] }],
    getSessionStats: () => ({ tokens: { input: 11, output: 7, total: 18 }, cost: 0.25 }),
  });

  const run = runSubagentInProcess(
    { task: "hang", cwd: process.cwd(), signal: controller.signal },
    async (options) => {
      // A transcript snapshot failure must not erase message output or session stats.
      (options!.sessionManager as { getEntries: () => unknown[] }).getEntries = () => { throw new Error("entries unavailable"); };
      return { session } as CreateAgentSessionResult;
    },
  );
  await promptStarted.promise;
  controller.abort();

  const result = await settlesPromptly(run);
  assert.equal(result.error?.reason, "stop");
  assert.equal(result.output, "partial cancellation output");
  assert.equal(result.usage.input, 11);
  assert.equal(result.usage.output, 7);
  assert.equal(result.usage.cost, 0.25);
  assert.equal(abortCalls, 1);
  assert.equal(disposeCalls, 1);
});

test("timeout handles abort and late prompt rejections, and dispose errors cannot replace it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const promptStarted = deferred<void>();
  const prompt = deferred<void>();
  let abortCalls = 0;
  let disposeCalls = 0;
  const session = fakeSession({
    prompt: () => { promptStarted.resolve(); return prompt.promise; },
    abort: () => {
      abortCalls += 1;
      return Promise.reject(new Error("abort failed"));
    },
    dispose: () => {
      disposeCalls += 1;
      throw new Error("dispose failed");
    },
  });

  const run = runSubagentInProcess({ task: "hang", cwd: process.cwd(), timeoutMs: 25 }, async () => ({ session } as CreateAgentSessionResult));
  await promptStarted.promise;
  t.mock.timers.tick(25);

  const result = await settlesPromptly(run);
  assert.equal(result.error?.reason, "timeout");
  assert.equal(abortCalls, 1);
  assert.equal(disposeCalls, 1);

  prompt.reject(new Error("prompt rejected after cancellation"));
  await nextTurn();
});

test("prompt rejection preserves partial output and usage independently", async () => {
  const session = fakeSession({
    prompt: async () => { throw new Error("prompt failed"); },
    messages: [{ role: "assistant", content: [{ type: "text", text: "partial rejection output" }] }],
    getSessionStats: () => ({
      tokens: { input: 13, output: 5, cacheRead: 2, total: 20 },
      cost: 0.5,
      contextUsage: { tokens: 17 },
    }),
  });

  const result = await runSubagentInProcess(
    { task: "fail after output", cwd: process.cwd() },
    async (options) => {
      (options!.sessionManager as { getEntries: () => unknown[] }).getEntries = () => { throw new Error("entries unavailable"); };
      return { session } as CreateAgentSessionResult;
    },
  );

  assert.equal(result.error?.message, "prompt failed");
  assert.equal(result.output, "partial rejection output");
  assert.deepEqual(result.usage, {
    input: 13,
    output: 5,
    cacheRead: 2,
    cacheWrite: 0,
    cost: 0.5,
    contextTokens: 17,
    turns: 1,
  });
});

test("wall-clock deadline catches synchronous session creation and prompt work", async () => {
  let creationPromptCalls = 0;
  const creationSession = fakeSession({ prompt: async () => { creationPromptCalls += 1; } });
  const creationResult = await runSubagentInProcess(
    { task: "too late", cwd: process.cwd(), timeoutMs: 5 },
    async () => {
      blockFor(20);
      return { session: creationSession } as CreateAgentSessionResult;
    },
  );
  assert.equal(creationResult.error?.reason, "timeout");
  assert.equal(creationPromptCalls, 0);

  const promptSession = fakeSession({
    prompt: () => { blockFor(20); },
    messages: [{ role: "assistant", content: [{ type: "text", text: "late output" }] }],
  });
  const promptResult = await runSubagentInProcess(
    { task: "blocks", cwd: process.cwd(), timeoutMs: 5 },
    async () => ({ session: promptSession } as CreateAgentSessionResult),
  );
  assert.equal(promptResult.error?.reason, "timeout");
  assert.equal(promptResult.output, "late output");
});

test("explicit thinking level is forwarded to createAgentSession", async () => {
  let observedThinking: unknown;
  const session = fakeSession({
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  });
  const result = await runSubagentInProcess(
    { task: "finish", cwd: process.cwd(), thinkingLevel: "off" },
    async (options) => {
      observedThinking = options?.thinkingLevel;
      return { session } as CreateAgentSessionResult;
    },
  );
  assert.equal(observedThinking, "off");
  assert.equal(result.output, "done");
});

test("dispose exceptions do not replace a successful result", async () => {
  const session = fakeSession({
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    dispose: () => { throw new Error("dispose failed"); },
  });
  const result = await runSubagentInProcess({ task: "finish", cwd: process.cwd() }, async () => ({ session } as CreateAgentSessionResult));
  assert.equal(result.output, "done");
  assert.equal(result.error, undefined);
});

test("synchronous and asynchronous createSession failures return error results", async () => {
  const synchronous = await runSubagentInProcess(
    { task: "fail", cwd: process.cwd() },
    (() => { throw new Error("sync creation failed"); }) as never,
  );
  assert.equal(synchronous.output, "");
  assert.equal(synchronous.error?.reason, "error");
  assert.equal(synchronous.error?.message, "sync creation failed");

  const asynchronous = await runSubagentInProcess(
    { task: "fail", cwd: process.cwd() },
    async () => { throw new Error("async creation failed"); },
  );
  assert.equal(asynchronous.output, "");
  assert.equal(asynchronous.error?.reason, "error");
  assert.equal(asynchronous.error?.message, "async creation failed");
});

test("bare resource loader keeps pi's default system prompt (undefined) by default", () => {
  const loader = createBareResourceLoader();
  assert.equal(loader.getSystemPrompt(), undefined);
  assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.deepEqual(loader.getExtensions().extensions, []);
  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
});

test("bare resource loader composes an override prompt and append list", () => {
  const loader = createBareResourceLoader("SYSTEM", ["A", "B"]);
  assert.equal(loader.getSystemPrompt(), "SYSTEM");
  assert.deepEqual(loader.getAppendSystemPrompt(), ["A", "B"]);
  // getAppendSystemPrompt returns a fresh array (defensive copy).
  const first = loader.getAppendSystemPrompt();
  first.push("C");
  assert.deepEqual(loader.getAppendSystemPrompt(), ["A", "B"]);
});

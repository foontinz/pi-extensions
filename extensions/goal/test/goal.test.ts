import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import goalExtension from "../index.ts";

type EventHandler = (event: unknown, context: unknown) => void | Promise<void>;
type CommandHandler = (args: string, context: unknown) => void | Promise<void>;

interface Harness {
  branch: unknown[];
  entries: Array<{ customType: string; data: unknown }>;
  notifications: string[];
  sent: Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }>;
  command: CommandHandler;
  emit(event: string, context: unknown): Promise<void>;
}

function createHarness(): Harness {
  const handlers = new Map<string, EventHandler[]>();
  const harness = {
    branch: [] as unknown[],
    entries: [] as Array<{ customType: string; data: unknown }>,
    notifications: [] as string[],
    sent: [] as Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }>,
    command: undefined as unknown as CommandHandler,
    async emit(event: string, context: unknown) {
      for (const handler of handlers.get(event) ?? []) await handler({}, context);
    },
  } satisfies Harness;

  const pi = {
    on(event: string, handler: EventHandler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    appendEntry(customType: string, data: unknown) {
      harness.entries.push({ customType, data });
    },
    sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }) {
      harness.sent.push({ content, options });
    },
    registerCommand(_name: string, options: { handler: CommandHandler }) {
      harness.command = options.handler;
    },
  };

  goalExtension(pi as unknown as ExtensionAPI);
  assert.ok(harness.command, "goal command registered");
  return harness;
}

function createContext(harness: Harness, idle = true) {
  return {
    hasUI: false,
    mode: "print",
    isIdle: () => idle,
    sessionManager: {
      getBranch: () => harness.branch,
    },
    ui: {
      notify(message: string) {
        harness.notifications.push(message);
      },
      setWidget() {},
      setStatus() {},
    },
  };
}

function goalState(overrides: Record<string, unknown> = {}) {
  return {
    goal: "finish the task",
    startedAt: 1,
    iterations: 0,
    turns: 0,
    maxIterations: 3,
    active: true,
    ...overrides,
  };
}

function assistant(text: string, stopReason = "stop") {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
    },
  };
}

test("integration-style lifecycle queues exactly one follow-up continuation after agent_settled", async () => {
  const harness = createHarness();
  const context = createContext(harness);

  await harness.command("finish the task", context);
  assert.equal(harness.sent.length, 1, "headless command starts the first run");

  harness.branch = [assistant("still working")];
  await harness.emit("agent_end", context);
  assert.equal(harness.sent.length, 1, "agent_end cannot enqueue continuation");

  await harness.emit("agent_settled", context);
  assert.equal(harness.sent.length, 2, "settled successful assistant gets one continuation");
  assert.equal(
    harness.sent.filter(
      ({ content, options }) => content.startsWith("Continue working toward the active goal") && options?.deliverAs === "followUp",
    ).length,
    1,
    "one settled run requests exactly one queued continuation",
  );
});

test("requires a successful final assistant and exact final-line sentinels", async () => {
  const harness = createHarness();
  const context = createContext(harness);

  await harness.command("finish the task", context);
  harness.branch = [assistant("[[GOAL_ACHIEVED]]", "error")];
  await harness.emit("agent_settled", context);
  assert.equal(harness.sent.length, 1, "error final state neither completes nor continues");
  assert.equal((harness.entries.at(-1)?.data as { active: boolean }).active, false, "error pauses the goal");

  await harness.command("", context);
  assert.equal(harness.sent.length, 2, "paused goal can be resumed explicitly");

  harness.branch = [assistant("[[GOAL_ACHIEVED]]\nextra")];
  await harness.emit("agent_settled", context);
  assert.equal(harness.sent.length, 3, "non-final sentinel does not complete the goal");

  harness.branch = [assistant("verified\n[[GOAL_ACHIEVED]]")];
  await harness.emit("agent_settled", context);
  assert.equal(harness.sent.length, 3, "exact final achievement sentinel stops the loop");
  assert.deepEqual(harness.entries.at(-1), { customType: "goal-state", data: { active: false } });
});

test("blocks only with an exact final-line blocked sentinel", async () => {
  const harness = createHarness();
  const context = createContext(harness);

  await harness.command("finish the task", context);
  harness.branch = [assistant("[[GOAL_BLOCKED: choose a strategy]] trailing")];
  await harness.emit("agent_settled", context);
  assert.equal(harness.sent.length, 2, "non-final blocked sentinel continues work");

  harness.branch = [assistant("details\n[[GOAL_BLOCKED: choose a strategy]]")];
  await harness.emit("agent_settled", context);
  assert.equal(harness.sent.length, 2, "exact final blocked sentinel pauses the loop");
  assert.equal((harness.entries.at(-1)?.data as { active: boolean }).active, false);
});

test("restores only the active branch and refreshes when /tree changes it", async () => {
  const harness = createHarness();
  const context = createContext(harness);

  harness.branch = [{ type: "custom", customType: "goal-state", data: goalState() }];
  await harness.emit("session_start", context);

  harness.branch = [assistant("continue")];
  await harness.emit("agent_settled", context);
  assert.equal(harness.sent.length, 1, "state restored from active branch");

  harness.branch = [{ type: "custom", customType: "goal-state", data: { active: false } }];
  await harness.emit("session_tree", context);
  harness.branch = [assistant("continue")];
  await harness.emit("agent_settled", context);
  assert.equal(harness.sent.length, 1, "tree refresh does not retain state from old branch");
});

test("malformed persisted state cannot revive an automatic loop", async () => {
  const harness = createHarness();
  const context = createContext(harness);
  harness.branch = [
    { type: "custom", customType: "goal-state", data: goalState({ maxIterations: 501 }) },
  ];

  await harness.emit("session_start", context);
  harness.branch = [assistant("continue")];
  await harness.emit("agent_settled", context);
  assert.equal(harness.sent.length, 0);
});

test("resume resets the iteration budget and busy commands leave state untouched", async () => {
  const harness = createHarness();
  const idleContext = createContext(harness);
  harness.branch = [
    {
      type: "custom",
      customType: "goal-state",
      data: goalState({ iterations: 2, maxIterations: 2, active: false }),
    },
  ];
  await harness.emit("session_start", idleContext);

  await harness.command("", idleContext);
  assert.equal((harness.entries.at(-1)?.data as { iterations: number }).iterations, 0, "resume resets iterations");
  harness.branch = [assistant("continue")];
  await harness.emit("agent_settled", idleContext);
  assert.equal(harness.sent.length, 2, "reset budget permits a fresh continuation");

  const busyHarness = createHarness();
  await busyHarness.command("a different goal", createContext(busyHarness, false));
  assert.equal(busyHarness.entries.length, 0);
  assert.equal(busyHarness.sent.length, 0);
});

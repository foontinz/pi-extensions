import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GoalCheckpointParams } from "../checkpoint-tool.ts";
import goalExtension from "../index.ts";
import {
  GOAL_CHECKPOINT_ENTRY,
  GOAL_CHECKPOINT_TOOL,
  GOAL_CONTROL_MESSAGE,
  createInitialCheckpoint,
  type GoalCheckpointV2,
} from "../state.ts";

type Handler = (event: any, context: any) => unknown | Promise<unknown>;
type CommandHandler = (args: string, context: any) => unknown | Promise<unknown>;
type ToolExecutor = (
  toolCallId: string,
  params: GoalCheckpointParams,
  signal: AbortSignal | undefined,
  onUpdate: (update: unknown) => void,
  context: any,
) => unknown | Promise<unknown>;

type Entry = {
  id: string;
  parentId: string | null;
  type: string;
  [key: string]: unknown;
};

type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

type CompactRequest = {
  customInstructions?: string;
  onComplete?: (result: unknown) => void;
  onError?: (error: Error) => void;
};

interface ToolResult {
  content: unknown;
  details: { checkpoint: GoalCheckpointV2 };
}

/**
 * A small in-memory Pi session. Adapter writes become entries on the active
 * branch, with the same leaf/parent behavior relied on by goal correlation.
 */
class ExtensionHarness {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, CommandHandler>();
  readonly tools = new Map<string, ToolExecutor>();
  readonly notifications: Array<{ message: string; level: string }> = [];
  readonly widgets: Array<{ key: string; value: unknown }> = [];
  readonly statuses: Array<{ key: string; value: unknown }> = [];
  readonly sent: Array<{ entry: Entry; options: Record<string, unknown> | undefined }> = [];
  readonly compactRequests: CompactRequest[] = [];
  readonly timeline: string[] = [];

  branch: Entry[] = [];
  idle = true;
  pending = false;
  sessionFile: string | undefined = "/tmp/goal-session.jsonl";
  usage: ContextUsage | undefined = { tokens: 1_000, contextWindow: 100_000, percent: 1 };
  confirmResult = true;
  appendAttempts = 0;
  failAppendAt: number | undefined;

  private nextId = 1;

  readonly context: any = {
    hasUI: true,
    mode: "tui",
    cwd: "/tmp/project",
    model: undefined,
    modelRegistry: {},
    signal: undefined,
    sessionManager: {
      getBranch: () => this.branch,
      getLeafId: () => this.getLeafId(),
      getLeafEntry: () => this.branch.at(-1),
      getSessionFile: () => this.sessionFile,
    },
    isIdle: () => this.idle,
    hasPendingMessages: () => this.pending,
    getContextUsage: () => this.usage,
    compact: (options: CompactRequest = {}) => {
      this.compactRequests.push(options);
      this.timeline.push("compact:request");
    },
    isProjectTrusted: () => true,
    abort() {},
    shutdown() {},
    getSystemPrompt: () => "base system prompt",
    getSystemPromptOptions: () => ({}),
    waitForIdle: async () => {},
    ui: {
      notify: (message: string, level = "info") => this.notifications.push({ message, level }),
      setWidget: (key: string, value: unknown) => {
        if (typeof value === "function") {
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          const component = value({}, theme);
          this.widgets.push({ key, value: component.render(120) });
          return;
        }
        this.widgets.push({ key, value });
      },
      setStatus: (key: string, value: unknown) => this.statuses.push({ key, value }),
      confirm: async () => this.confirmResult,
    },
  };

  constructor() {
    const api = {
      on: (name: string, handler: Handler) => {
        const handlers = this.handlers.get(name) ?? [];
        handlers.push(handler);
        this.handlers.set(name, handlers);
      },
      registerCommand: (name: string, definition: { handler: CommandHandler }) => {
        this.commands.set(name, definition.handler);
      },
      registerTool: (definition: { name: string; execute: ToolExecutor }) => {
        this.tools.set(definition.name, definition.execute);
      },
      appendEntry: (customType: string, data: unknown) => {
        this.appendAttempts += 1;
        this.timeline.push(`append:${customType}`);
        if (this.appendAttempts === this.failAppendAt) throw new Error("disk full");
        this.append({ type: "custom", customType, data: structuredClone(data) });
      },
      sendMessage: (
        message: { customType: string; content: unknown; display?: boolean; details?: unknown },
        options?: Record<string, unknown>,
      ) => {
        const entry = this.append({
          type: "custom_message",
          customType: message.customType,
          content: structuredClone(message.content),
          display: message.display,
          details: structuredClone(message.details),
        });
        this.sent.push({ entry, options });
        this.timeline.push(`send:${message.customType}`);
      },
    };

    goalExtension(api as unknown as ExtensionAPI);
    assert.ok(this.commands.has("goal"), "goal command registered");
    assert.ok(this.tools.has(GOAL_CHECKPOINT_TOOL), "goal checkpoint tool registered");
    // Pi flushes a session file only after its first assistant message. Seed a
    // completed exchange so durable-goal creation is realistic.
    this.append({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "session ready" }], stopReason: "stop" },
    });
  }

  getLeafId(): string | null {
    return this.branch.at(-1)?.id ?? null;
  }

  append(fields: Omit<Partial<Entry>, "id" | "parentId"> & { type: string }): Entry {
    const entry = {
      ...fields,
      id: `entry-${this.nextId++}`,
      parentId: this.getLeafId(),
    } as Entry;
    this.branch.push(entry);
    return entry;
  }

  replaceBranch(entries: Array<Omit<Partial<Entry>, "id" | "parentId"> & { type: string }>): void {
    this.branch = [];
    for (const entry of entries) this.append(entry);
  }

  async command(args: string): Promise<void> {
    await this.commands.get("goal")!(args, this.context);
  }

  async emit(name: string, event: Record<string, unknown> = {}): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(name) ?? []) {
      results.push(await handler({ type: name, ...event }, this.context));
    }
    return results;
  }

  appendAssistant(text = "working", stopReason = "stop"): Entry {
    return this.append({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason },
    });
  }

  async callCheckpoint(params: GoalCheckpointParams): Promise<ToolResult> {
    const callId = `tool-call-${this.nextId}`;
    this.append({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: GOAL_CHECKPOINT_TOOL, arguments: params }],
        stopReason: "toolUse",
      },
    });
    return await this.tools.get(GOAL_CHECKPOINT_TOOL)!(
      callId,
      params,
      undefined,
      () => {},
      this.context,
    ) as ToolResult;
  }

  appendCheckpointResult(result: ToolResult): Entry {
    return this.append({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `tool-result-${this.nextId}`,
        toolName: GOAL_CHECKPOINT_TOOL,
        content: structuredClone(result.content),
        details: structuredClone(result.details),
        isError: false,
      },
    });
  }

  controls(): Entry[] {
    return this.branch.filter((entry) => entry.type === "custom_message" && entry.customType === GOAL_CONTROL_MESSAGE);
  }

  persistedCheckpoints(): GoalCheckpointV2[] {
    return this.branch
      .filter((entry) => entry.type === "custom" && entry.customType === GOAL_CHECKPOINT_ENTRY)
      .map((entry) => entry.data as GoalCheckpointV2);
  }

  latestPersisted(): GoalCheckpointV2 {
    const checkpoint = this.persistedCheckpoints().at(-1);
    assert.ok(checkpoint, "a durable checkpoint exists");
    return checkpoint;
  }

  completeCompaction(index = this.compactRequests.length - 1): void {
    this.timeline.push("compact:complete-callback");
    this.compactRequests[index]!.onComplete?.({});
  }

  failCompaction(error = new Error("compactor failed"), index = this.compactRequests.length - 1): void {
    this.timeline.push("compact:error-callback");
    this.compactRequests[index]!.onError?.(error);
  }
}

function progress(revision: number, summary = "implemented one bounded step"): GoalCheckpointParams {
  return {
    action: "progress",
    expectedRevision: revision,
    phaseId: "phase-1",
    summary,
    nextAction: "Inspect the result and continue.",
  };
}

function initialPlan(revision: number, summary = "established a bounded rolling plan"): GoalCheckpointParams {
  return {
    action: "set_plan",
    expectedRevision: revision,
    phaseId: "phase-1",
    summary,
    nextAction: "Execute and verify the active phase.",
    acceptanceCriteria: [{ id: "accept-1", description: "The objective is observably satisfied." }],
    phases: [{
      id: "phase-1",
      title: "Execute objective",
      intent: "Perform the bounded work and collect evidence.",
      criteria: [{ id: "phase-criterion-1", description: "The phase has observed evidence." }],
    }],
  };
}

async function createAndObserve(harness: ExtensionHarness, objective = "finish the durable task"): Promise<GoalCheckpointV2> {
  await harness.command(objective);
  assert.equal(harness.controls().length, 1, "creation dispatches one run");
  assert.match(String(harness.controls()[0]?.content ?? ""), /goal_working_packet/i);
  const active = harness.latestPersisted();
  assert.equal(active.scheduler.state, "run_in_flight");
  return active;
}

async function settleWithProgress(
  harness: ExtensionHarness,
  action: GoalCheckpointParams["action"] = "progress",
): Promise<ToolResult> {
  const active = harness.latestPersisted();
  const params: GoalCheckpointParams = active.planVersion === 0
    ? initialPlan(active.revision)
    : action === "goal_candidate_complete"
      ? {
          action,
          expectedRevision: active.revision,
          summary: "The objective is complete and ready for independent verification.",
        }
      : progress(active.revision);
  const result = await harness.callCheckpoint(params);
  harness.appendCheckpointResult(result);
  harness.appendAssistant("Checkpoint recorded.");
  await harness.emit("agent_settled");
  return result;
}

test("create persists its dispatch before sending correlated control", async () => {
  const harness = new ExtensionHarness();
  await harness.command("ship the feature");

  const checkpoints = harness.persistedCheckpoints();
  assert.equal(checkpoints.length, 3);
  const dispatch = checkpoints.at(-2)!;
  const active = checkpoints.at(-1)!;
  const control = harness.controls()[0]!;
  assert.equal(dispatch.scheduler.state, "dispatch_pending");
  assert.deepEqual(control.details, {
    goalId: dispatch.scheduler.dispatch!.goalId,
    epoch: dispatch.scheduler.dispatch!.epoch,
    runId: dispatch.scheduler.dispatch!.runId,
    revision: dispatch.scheduler.dispatch!.revision,
    dispatchId: dispatch.scheduler.dispatch!.dispatchId,
  });
  assert.equal(active.scheduler.state, "run_in_flight");
  assert.equal(control.type, "custom_message");
  assert.match(String(control.content), /goal_working_packet/);
  assert.equal(control.parentId, (harness.branch.at(-2) as Entry).id);
  assert.equal((harness.branch.at(-2) as Entry).parentId, harness.branch.at(-3)!.id);
  assert.deepEqual(harness.timeline.slice(-2), [`append:${GOAL_CHECKPOINT_ENTRY}`, `send:${GOAL_CONTROL_MESSAGE}`]);
  assert.deepEqual(harness.sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(harness.statuses.at(-1)?.value, undefined, "goal UI is not duplicated in the footer");
  const widgetLines = harness.widgets.at(-1)?.value as string[];
  assert.equal(widgetLines.length, 2, "goal widget separates status from the next action");
  assert.ok(widgetLines.every((line) => line.length <= 120), "widget rows never wrap into a text blob");
});

test("no-argument status is observational and never resumes a paused goal", async () => {
  const harness = new ExtensionHarness();
  await harness.command("a durable objective");
  await harness.command("pause");
  const before = {
    entries: harness.branch.length,
    controls: harness.controls().length,
    revision: harness.latestPersisted().revision,
  };

  await harness.command("");

  assert.deepEqual({
    entries: harness.branch.length,
    controls: harness.controls().length,
    revision: harness.latestPersisted().revision,
  }, before);
  assert.equal(harness.latestPersisted().lifecycle, "paused");
  assert.match(harness.notifications.at(-1)?.message ?? "", /objective:/);
});

test("status is not a reserved subcommand", async () => {
  const harness = new ExtensionHarness();

  await harness.command("status");

  assert.equal(harness.latestPersisted().objective, "status");
  assert.equal(harness.controls().length, 1);
});

test("a correlated goal control carries its bounded working packet", async () => {
  const harness = new ExtensionHarness();
  await harness.command("correlate this run");

  const control = harness.controls()[0]!;
  assert.match(String(control.content), /goal_checkpoint/);
  assert.match(String(control.content), /objective="correlate this run"/);
  assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
});

test("goal_checkpoint result details are authoritative and settlement queues one continuation", async () => {
  const harness = new ExtensionHarness();
  const active = await createAndObserve(harness);
  const customWritesBeforeTool = harness.persistedCheckpoints().length;
  const result = await harness.callCheckpoint(initialPlan(active.revision, "authoritative durable progress"));

  assert.equal(
    harness.persistedCheckpoints().length,
    customWritesBeforeTool,
    "tool execution is speculative until Pi appends its result details",
  );
  assert.equal(result.details.checkpoint.ledger.recentProgress.at(-1), "authoritative durable progress");
  harness.appendCheckpointResult(result);
  harness.appendAssistant("Finished this run normally.");
  await harness.emit("agent_settled");

  assert.equal(harness.controls().length, 2, "one settled checkpoint gets one continuation");
  assert.ok(harness.latestPersisted().ledger.recentProgress.includes("authoritative durable progress"));
  assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");

  const entries = harness.branch.length;
  await harness.emit("agent_settled");
  assert.equal(harness.branch.length, entries, "duplicate settlement is ignored");
  assert.equal(harness.controls().length, 2);

  await harness.emit("agent_settled");
  assert.equal(harness.branch.length, entries, "replayed unrelated settlement cannot consume the new lease");
  assert.equal(harness.controls().length, 2);
});

test("session reload and tree navigation pause runnable state and never auto-dispatch", async () => {
  const harness = new ExtensionHarness();
  const reloadState = createInitialCheckpoint("restore after reload", { now: 10 });
  harness.replaceBranch([{ type: "custom", customType: GOAL_CHECKPOINT_ENTRY, data: reloadState }]);

  await harness.emit("session_start");
  assert.equal(harness.latestPersisted().lifecycle, "paused");
  assert.equal(harness.latestPersisted().pauseReason, "interrupted");
  assert.equal(harness.controls().length, 0);

  const treeState = createInitialCheckpoint("restore after tree", { now: 20 });
  harness.replaceBranch([{ type: "custom", customType: GOAL_CHECKPOINT_ENTRY, data: treeState }]);
  await harness.emit("session_tree");
  assert.equal(harness.latestPersisted().lifecycle, "paused");
  assert.equal(harness.latestPersisted().pauseReason, "interrupted");
  assert.equal(harness.controls().length, 0, "tree restoration never starts work automatically");
});

test("persistence failures and ephemeral sessions fail closed while unflushed sessions bootstrap volatile", async () => {
  const failing = new ExtensionHarness();
  failing.failAppendAt = 2;
  await failing.command("must persist before control");
  assert.equal(failing.appendAttempts, 2);
  assert.equal(failing.controls().length, 0);
  assert.match(failing.notifications.at(-1)?.message ?? "", /persistence failed/i);
  assert.ok(failing.widgets.length > 0 && failing.statuses.length > 0, "failure is rendered in UI");

  const ephemeral = new ExtensionHarness();
  ephemeral.sessionFile = undefined;
  await ephemeral.command("cannot be durable");
  assert.equal(ephemeral.branch.length, 1);
  assert.equal(ephemeral.controls().length, 0);
  assert.match(ephemeral.notifications.at(-1)?.message ?? "", /ephemeral/i);

  const unflushed = new ExtensionHarness();
  unflushed.replaceBranch([]);
  await unflushed.command("bootstrap without a prior exchange");
  assert.equal(unflushed.controls().length, 1);
  assert.equal(unflushed.latestPersisted().scheduler.state, "run_in_flight");
  assert.match(unflushed.notifications.at(-1)?.message ?? "", /volatile until the first assistant response/i);
  assert.match(String(unflushed.widgets.at(-1)?.value), /volatile/i);
  assert.equal(unflushed.statuses.at(-1)?.value, undefined);

  unflushed.appendAssistant("First response flushes the in-memory session.");
  await unflushed.emit("agent_settled");
  assert.doesNotMatch(String(unflushed.widgets.at(-1)?.value), /volatile/i);
  assert.ok(unflushed.notifications.some(({ message }) => /now flushed and durable/i.test(message)));
});

test("an ordinary checkpointless assistant message without a sentinel is repaired once, then pauses on repetition", async () => {
  const harness = new ExtensionHarness();
  await createAndObserve(harness);
  harness.appendAssistant("I finished this bounded step but forgot to record the checkpoint.");
  await harness.emit("agent_settled");

  assert.equal(harness.controls().length, 2, "exactly one repair run is dispatched");
  assert.equal(harness.latestPersisted().scheduler.activeRun?.repairAttempt, 1);

  harness.appendAssistant("The repair run also omitted it.");
  await harness.emit("agent_settled");
  assert.equal(harness.controls().length, 2, "there is no repair loop");
  assert.equal(harness.latestPersisted().lifecycle, "paused");
  assert.equal(harness.latestPersisted().pauseReason, "dispatch");
  assert.equal(harness.latestPersisted().scheduler.state, "idle");
});

test("legacy text sentinels remain bounded migration compatibility only", async () => {
  const achieved = new ExtensionHarness();
  await createAndObserve(achieved);
  achieved.appendAssistant("legacy client claim\n[[GOAL_ACHIEVED]]");
  await achieved.emit("agent_settled");
  assert.equal(achieved.latestPersisted().lifecycle, "verifying_goal");
  assert.notEqual(achieved.latestPersisted().lifecycle, "succeeded");
  assert.equal(achieved.controls().length, 1, "legacy achievement never auto-verifies or loops");

  const blocked = new ExtensionHarness();
  await createAndObserve(blocked);
  blocked.appendAssistant("[[GOAL_BLOCKED: choose the migration strategy]]");
  await blocked.emit("agent_settled");
  assert.equal(blocked.latestPersisted().lifecycle, "blocked");
  assert.deepEqual(blocked.latestPersisted().ledger.openQuestions, ["choose the migration strategy"]);
  assert.equal(blocked.controls().length, 1);
});

test("completion is only a verification claim and /goal done explicitly succeeds", async () => {
  const harness = new ExtensionHarness();
  await createAndObserve(harness);
  await settleWithProgress(harness);
  await settleWithProgress(harness, "goal_candidate_complete");

  assert.equal(harness.latestPersisted().lifecycle, "verifying_goal");
  assert.equal(harness.latestPersisted().scheduler.state, "idle");
  assert.notEqual(harness.latestPersisted().lifecycle, "succeeded");

  await harness.command("verify");
  assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
  assert.equal(harness.controls().length, 3);
  await harness.command("done");
  assert.equal(harness.latestPersisted().lifecycle, "succeeded");
  assert.equal(harness.latestPersisted().scheduler.state, "idle");
  assert.match(harness.notifications.at(-1)?.message ?? "", /explicitly accepted/i);
  assert.equal(harness.widgets.at(-1)?.value, undefined, "succeeded goals disappear from the UI");
  assert.equal(harness.statuses.at(-1)?.value, undefined);
});

test("pause and stop commit safely during an autonomous run", async () => {
  const harness = new ExtensionHarness();
  await createAndObserve(harness);

  await harness.command("pause");
  assert.equal(harness.latestPersisted().lifecycle, "paused");
  assert.equal(harness.latestPersisted().scheduler.state, "recovery_required");
  assert.equal(harness.controls().length, 1);

  await harness.command("resume user approved reconciliation");
  assert.equal(harness.latestPersisted().epoch, 2);
  assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
  assert.equal(harness.controls().length, 2);

  await harness.command("stop");
  assert.equal(harness.latestPersisted().lifecycle, "cancelled");
  assert.equal(harness.latestPersisted().scheduler.state, "idle");
  assert.equal(harness.controls().length, 2);
});

test("compaction persists before starting, correlates callbacks, and fails closed", async (t) => {
  await t.test("event is recorded before completion and dispatch follows the callback", async () => {
    const harness = new ExtensionHarness();
    harness.usage = { tokens: 80_000, contextWindow: 100_000, percent: 80 };
    await createAndObserve(harness);
    await settleWithProgress(harness);

    assert.equal(harness.compactRequests.length, 1);
    assert.equal(harness.controls().length, 1, "pending compaction owns continuation");
    const requestIndex = harness.timeline.lastIndexOf("compact:request");
    assert.equal(harness.timeline[requestIndex - 1], `append:${GOAL_CHECKPOINT_ENTRY}`);
    assert.equal(harness.latestPersisted().scheduler.state, "compaction_pending");
    assert.equal(harness.latestPersisted().compaction.tokensBefore, 80_000);

    await harness.emit("session_compact", {
      reason: "manual",
      willRetry: false,
      compactionEntry: { id: "compaction-entry-1", type: "compaction", parentId: harness.getLeafId() },
    });
    assert.equal(harness.latestPersisted().compaction.lastCompactionEntryId, "compaction-entry-1");
    assert.equal(harness.controls().length, 1, "event alone cannot release the lease");

    harness.completeCompaction();
    assert.equal(harness.latestPersisted().compaction.state, "idle");
    assert.equal(harness.latestPersisted().budgets.compactions, 1);
    assert.equal(harness.controls().length, 2, "completion persists, then dispatches");
    const callbackIndex = harness.timeline.indexOf("compact:complete-callback");
    const nextControlIndex = harness.timeline.indexOf(`send:${GOAL_CONTROL_MESSAGE}`, callbackIndex);
    assert.ok(nextControlIndex > callbackIndex);
    assert.equal(harness.timeline[nextControlIndex - 1], `append:${GOAL_CHECKPOINT_ENTRY}`);
  });

  await t.test("onError pauses and never dispatches", async () => {
    const harness = new ExtensionHarness();
    harness.usage = { tokens: 80_000, contextWindow: 100_000, percent: 80 };
    await createAndObserve(harness);
    await settleWithProgress(harness);
    harness.failCompaction();

    assert.equal(harness.latestPersisted().lifecycle, "paused");
    assert.equal(harness.latestPersisted().pauseReason, "compaction");
    assert.equal(harness.latestPersisted().compaction.state, "failed");
    assert.equal(harness.controls().length, 1);

    await harness.command("resume");
    assert.equal(harness.latestPersisted().compaction.state, "idle");
    assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
    assert.equal(harness.controls().length, 2, "failed compaction can be explicitly recovered");
  });

  await t.test("tokens null never triggers immediate recompaction", async () => {
    const harness = new ExtensionHarness();
    harness.usage = { tokens: null, contextWindow: 100_000, percent: null };
    await createAndObserve(harness);
    await settleWithProgress(harness);

    assert.equal(harness.compactRequests.length, 0);
    assert.equal(harness.controls().length, 2, "normal continuation remains available");
  });
});

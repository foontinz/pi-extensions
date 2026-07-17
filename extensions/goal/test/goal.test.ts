import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import type { GoalCheckpointParams } from "../checkpoint-tool.ts";
import goalExtension from "../index.ts";
import {
  GOAL_CHECKPOINT_ENTRY,
  GOAL_CHECKPOINT_TOOL,
  GOAL_CONTROL_MESSAGE,
  GOAL_RESUME_TOOL,
  createInitialCheckpoint,
  type GoalCheckpointV2,
} from "../state.ts";

type Handler = (event: any, context: any) => unknown | Promise<unknown>;
type CommandHandler = (args: string, context: any) => unknown | Promise<unknown>;
type ToolExecutor = (
  toolCallId: string,
  params: any,
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

interface ResumeToolResult {
  content: unknown;
  details: {
    goalId: string;
    epoch: number;
    revision: number;
    userEntryId?: string;
  };
  terminate?: boolean;
}

/**
 * A small in-memory Pi session. Adapter writes become entries on the active
 * branch, with the same leaf/parent behavior relied on by goal correlation.
 */
class ExtensionHarness {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, CommandHandler>();
  readonly tools = new Map<string, ToolExecutor>();
  readonly toolParameters = new Map<string, unknown>();
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
  private lastCheckpointToolCallId: string | undefined;

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
      registerTool: (definition: { name: string; execute: ToolExecutor; parameters?: unknown }) => {
        this.tools.set(definition.name, definition.execute);
        this.toolParameters.set(definition.name, definition.parameters);
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
    assert.ok(this.tools.has(GOAL_RESUME_TOOL), "goal resume tool registered");
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

  async preflightTool(toolName: string, input: Record<string, unknown> = {}): Promise<any> {
    const [result] = await this.emit("tool_call", {
      toolCallId: `preflight-${this.nextId++}`,
      toolName,
      input,
    });
    return result;
  }

  appendAssistant(text = "working", stopReason = "stop"): Entry {
    return this.append({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason },
    });
  }

  appendUser(text: string): Entry {
    return this.append({
      type: "message",
      message: { role: "user", content: [{ type: "text", text }] },
    });
  }

  appendCustomMessage(customType: string, details: unknown, content = "typed extension notification"): Entry {
    return this.append({
      type: "custom_message",
      customType,
      content,
      display: true,
      details: structuredClone(details),
    });
  }

  async beginUserPrompt(text: string): Promise<unknown[]> {
    const results = await this.emit("before_agent_start", {
      prompt: text,
      images: [],
      systemPrompt: "base system prompt",
      systemPromptOptions: {},
    });
    this.appendUser(text);
    return results;
  }

  async callCheckpoint(params: GoalCheckpointParams): Promise<ToolResult> {
    const callId = `tool-call-${this.nextId}`;
    this.lastCheckpointToolCallId = callId;
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
        toolCallId: this.lastCheckpointToolCallId ?? `tool-result-${this.nextId}`,
        toolName: GOAL_CHECKPOINT_TOOL,
        content: structuredClone(result.content),
        details: structuredClone(result.details),
        isError: false,
      },
    });
  }

  async callResume(): Promise<ResumeToolResult> {
    const params = {};
    const callId = `resume-call-${this.nextId}`;
    this.append({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: GOAL_RESUME_TOOL, arguments: params }],
        stopReason: "toolUse",
      },
    });
    const result = await this.tools.get(GOAL_RESUME_TOOL)!(
      callId,
      params,
      undefined,
      () => {},
      this.context,
    ) as ResumeToolResult;
    this.append({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: GOAL_RESUME_TOOL,
        content: structuredClone(result.content),
        details: structuredClone(result.details),
        isError: false,
      },
    });
    return result;
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

async function enterWaitingExternal(
  harness: ExtensionHarness,
  question = "Should the release target staging or production?",
  waitFor?: GoalCheckpointParams["waitFor"],
): Promise<GoalCheckpointV2> {
  await createAndObserve(harness);
  await settleWithProgress(harness);
  const active = harness.latestPersisted();
  const result = await harness.callCheckpoint({
    action: "waiting_external",
    expectedRevision: active.revision,
    phaseId: active.activePhaseId,
    summary: "Engineering is paused for the user's deployment decision.",
    nextAction: `Await the dependency: ${question}`,
    openQuestions: [question],
    ...(waitFor ? { waitFor } : {}),
  });
  harness.appendCheckpointResult(result);
  harness.appendAssistant("Waiting for the user's answer.");
  await harness.emit("agent_settled");
  assert.equal(harness.latestPersisted().lifecycle, "waiting_external");
  assert.equal(harness.latestPersisted().scheduler.state, "idle");
  return harness.latestPersisted();
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
  assert.doesNotMatch(widgetLines[0]!, /CTX|ctx\s+[?0-9]/, "Pi already renders context usage globally");
  assert.match(widgetLines[0]!, /RUN 1\/30$/, "the run budget occupies the rightmost header position");
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

test("goal_resume exposes an empty strict parameter object", () => {
  const harness = new ExtensionHarness();
  const schema = harness.toolParameters.get(GOAL_RESUME_TOOL) as Parameters<typeof Check>[0];
  assert.equal(Check(schema, {}), true);
  assert.equal(Check(schema, { goalId: "copied", expectedEpoch: 1, expectedRevision: 1 }), false);
});

test("an ordinary user answer can durably resume a waiting goal without a slash command", async () => {
  const harness = new ExtensionHarness();
  const waiting = await enterWaitingExternal(harness);
  const controlsBefore = harness.controls().length;
  const checkpointsBefore = harness.persistedCheckpoints().length;

  const hookResults = await harness.beginUserPrompt("Use staging.");
  const guidance = hookResults
    .map((result) => (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? "")
    .join("\n");
  assert.match(guidance, /goal_resume/);
  assert.match(guidance, /Should the release target staging or production\?/);
  assert.match(guidance, /Do not call goal_resume for clarification questions/);
  assert.equal(harness.persistedCheckpoints().length, checkpointsBefore, "guidance is observational");
  assert.equal(harness.latestPersisted().lifecycle, "waiting_external");

  harness.idle = false;
  const result = await harness.callResume();
  assert.equal(result.terminate, true);
  assert.equal(harness.controls().length, controlsBefore, "tool execution never dispatches re-entrantly");
  assert.equal(harness.latestPersisted().lifecycle, "recovering");
  assert.equal(harness.latestPersisted().epoch, waiting.epoch);
  assert.equal(harness.latestPersisted().budgets.epochRuns, waiting.budgets.epochRuns);
  assert.equal(harness.latestPersisted().budgets.totalRuns, waiting.budgets.totalRuns);
  assert.match(harness.latestPersisted().ledger.nextAction ?? "", /Use staging\./);
  assert.doesNotMatch(JSON.stringify(result.content), new RegExp(waiting.goalId));
  assert.doesNotMatch(JSON.stringify(result.content), /epoch|revision/i);
  const afterResumeMutation = await harness.preflightTool("edit");
  assert.equal(afterResumeMutation?.block, true);
  assert.match(afterResumeMutation?.reason ?? "", /goal_resume must be the final tool call/);

  harness.idle = true;
  await harness.emit("agent_settled");
  assert.equal(harness.controls().length, controlsBefore + 1);
  assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
  assert.equal(harness.latestPersisted().epoch, waiting.epoch);
  assert.equal(harness.latestPersisted().budgets.epochRuns, waiting.budgets.epochRuns + 1);

  const entries = harness.branch.length;
  await harness.emit("agent_settled");
  assert.equal(harness.branch.length, entries, "replayed settlement cannot dispatch twice");
});

test("a clarification question leaves a waiting goal untouched", async () => {
  const harness = new ExtensionHarness();
  const waiting = await enterWaitingExternal(harness);
  const before = {
    controls: harness.controls().length,
    checkpoints: harness.persistedCheckpoints().length,
    revision: waiting.revision,
    epoch: waiting.epoch,
  };

  const hookResults = await harness.beginUserPrompt("What do you mean by production?");
  assert.match(
    hookResults.map((result) => (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? "").join("\n"),
    /Do not call goal_resume for clarification questions/,
  );
  harness.appendAssistant("Production means the live customer-facing environment.");
  await harness.emit("agent_settled");

  assert.equal(harness.latestPersisted().lifecycle, "waiting_external");
  assert.equal(harness.latestPersisted().scheduler.state, "idle");
  assert.deepEqual({
    controls: harness.controls().length,
    checkpoints: harness.persistedCheckpoints().length,
    revision: harness.latestPersisted().revision,
    epoch: harness.latestPersisted().epoch,
  }, before);
});

test("goal_resume rejects an acknowledgement turn that already used another tool", async () => {
  const harness = new ExtensionHarness();
  const waiting = await enterWaitingExternal(harness);
  await harness.beginUserPrompt("Use staging.");
  assert.equal(await harness.preflightTool("read"), undefined, "clarification tools remain available");
  await assert.rejects(() => harness.callResume(), /must be the only tool call/);
  assert.equal(harness.latestPersisted().eventId, waiting.eventId);
  assert.equal(harness.latestPersisted().lifecycle, "waiting_external");
});

test("background completion between the wait checkpoint and run settlement wakes exactly once", async () => {
  const harness = new ExtensionHarness();
  await createAndObserve(harness);
  await settleWithProgress(harness);
  const active = harness.latestPersisted();
  const controlsBefore = harness.controls().length;

  const result = await harness.callCheckpoint({
    action: "waiting_external",
    expectedRevision: active.revision,
    phaseId: active.activePhaseId,
    summary: "Started one owned background task.",
    nextAction: "Wait for bg_003.",
    waitFor: { kind: "background_task", id: "bg_003" },
  });
  const waitCheckpoint = result.details.checkpoint;
  harness.appendCheckpointResult(result);
  harness.appendCustomMessage("enhanced-bash-background", {
    jobs: [{ id: "bg_003", kind: "bash", status: "exited", exitCode: 0 }],
    monitorEvents: [],
  });
  harness.appendAssistant("The typed completion arrived; checkpoint settlement remains authoritative.");
  await harness.emit("agent_settled");

  const woke = harness.latestPersisted();
  assert.equal(harness.controls().length, controlsBefore + 1);
  assert.equal(woke.scheduler.state, "run_in_flight");
  assert.equal(woke.lifecycle, "recovering");
  assert.equal(woke.waitFor, undefined);
  assert.equal(woke.epoch, waitCheckpoint.epoch, "machine wake does not refresh the epoch");
  assert.match(woke.ledger.nextAction ?? "", /background_task bg_003 completed/);

  const entries = harness.branch.length;
  await harness.emit("agent_settled");
  assert.equal(harness.branch.length, entries);
  assert.equal(harness.controls().length, controlsBefore + 1);
});

test("typed completion matching ignores stale, unrelated, malformed, and prose-only callbacks", async () => {
  const harness = new ExtensionHarness();
  await createAndObserve(harness);
  await settleWithProgress(harness);
  const controlsBefore = harness.controls().length;

  harness.appendCustomMessage("enhanced-bash-background", {
    jobs: [{ id: "bg_stale", kind: "bash", status: "exited", exitCode: 0 }],
  }, "stale completion before the wait checkpoint");
  const active = harness.latestPersisted();
  const result = await harness.callCheckpoint({
    action: "waiting_external",
    expectedRevision: active.revision,
    phaseId: active.activePhaseId,
    summary: "Wait for the current generation of bg_stale.",
    nextAction: "Wait for typed terminal metadata.",
    waitFor: { kind: "background_task", id: "bg_stale" },
  });
  harness.appendCheckpointResult(result);
  harness.appendAssistant("Waiting after recording the correlation.");
  await harness.emit("agent_settled");
  assert.equal(harness.latestPersisted().lifecycle, "waiting_external", "pre-checkpoint completion is stale");

  harness.appendCustomMessage("enhanced-bash-background", {
    jobs: [{ id: "bg_other", kind: "bash", status: "exited", exitCode: 0 }],
  });
  harness.appendCustomMessage("enhanced-bash-background", {
    jobs: [{ id: "bg_stale", kind: "bash", status: "running", exitCode: 0 }],
  });
  harness.appendCustomMessage("enhanced-bash-background", {
    jobs: [{ id: "bg_stale", status: "exited", exitCode: "0" }],
  });
  harness.appendCustomMessage("enhanced-bash-background", { jobs: "not-an-array" });
  harness.appendCustomMessage("some-prose-callback", undefined, "bg_stale finished successfully");
  harness.append({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "untrusted-completion-shaped-result",
      isError: false,
      content: [{ type: "text", text: "bg_stale completed" }],
      details: { jobs: [{ id: "bg_stale", kind: "bash", status: "exited", exitCode: 0 }] },
    },
  });
  harness.appendAssistant("No trusted matching terminal metadata was present.");
  await harness.emit("agent_settled");

  assert.equal(harness.latestPersisted().lifecycle, "waiting_external");
  assert.deepEqual(harness.latestPersisted().waitFor, { kind: "background_task", id: "bg_stale" });
  assert.equal(harness.controls().length, controlsBefore);
});

test("failed typed completion enters diagnosis without satisfying criteria", async () => {
  const harness = new ExtensionHarness();
  const waiting = await enterWaitingExternal(
    harness,
    "background task bg_failure",
    { kind: "background_task", id: "bg_failure" },
  );
  const criteriaBefore = structuredClone(waiting.acceptanceCriteria);
  const controlsBefore = harness.controls().length;

  harness.appendCustomMessage("enhanced-bash-background", {
    jobs: [{ id: "bg_failure", kind: "bash", status: "failed", exitCode: 17 }],
  });
  harness.appendAssistant("The callback turn cannot self-verify goal criteria.");
  await harness.emit("agent_settled");

  const woke = harness.latestPersisted();
  assert.equal(harness.controls().length, controlsBefore + 1);
  assert.equal(woke.lifecycle, "recovering");
  assert.equal(woke.scheduler.state, "run_in_flight");
  assert.match(woke.ledger.nextAction ?? "", /failed \(exit code 17\); diagnose the failure/);
  assert.match(woke.ledger.nextAction ?? "", /Do not mark criteria satisfied/);
  assert.deepEqual(woke.acceptanceCriteria, criteriaBefore);
});

test("monitor timeout and workflow failure terminal statuses map to diagnosis", async () => {
  const monitor = new ExtensionHarness();
  await enterWaitingExternal(monitor, "finite monitor mon_001", {
    kind: "background_task",
    id: "mon_001",
  });
  monitor.appendCustomMessage("enhanced-bash-background", {
    jobs: [{ id: "mon_001", kind: "monitor", status: "timed_out" }],
  });
  monitor.appendAssistant("Finite monitor terminated.");
  await monitor.emit("agent_settled");
  assert.match(monitor.latestPersisted().ledger.nextAction ?? "", /failed \(timed out\)/);

  const workflow = new ExtensionHarness();
  await enterWaitingExternal(workflow, "workflow workflow-error", {
    kind: "workflow",
    id: "workflow-error",
  });
  workflow.appendCustomMessage("workflow-notification", {
    runId: "workflow-error",
    status: "failed",
    error: "untrusted producer detail",
  });
  workflow.appendAssistant("Workflow failure callback settled.");
  await workflow.emit("agent_settled");
  assert.match(workflow.latestPersisted().ledger.nextAction ?? "", /failed \(workflow failed\)/);
  assert.doesNotMatch(workflow.latestPersisted().ledger.nextAction ?? "", /untrusted producer detail/);
});

test("a typed completion steered into an unrelated turn wakes when that turn settles", async () => {
  const harness = new ExtensionHarness();
  await enterWaitingExternal(harness, "task bg_steered", {
    kind: "background_task",
    id: "bg_steered",
  });
  const controlsBefore = harness.controls().length;
  await harness.beginUserPrompt("Can you restate what this task is for?");
  harness.appendCustomMessage("enhanced-bash-background", {
    jobs: [{ id: "bg_steered", kind: "bash", status: "exited", exitCode: 0 }],
  });
  harness.appendAssistant("The unrelated clarification turn has now settled.");
  await harness.emit("agent_settled");

  assert.equal(harness.controls().length, controlsBefore + 1);
  assert.equal(harness.latestPersisted().lifecycle, "recovering");
  assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
});

test("workflow completion wakes from restore and maps terminal failure statuses", async () => {
  const restored = new ExtensionHarness();
  const waiting = await enterWaitingExternal(
    restored,
    "workflow run workflow-restore",
    { kind: "workflow", id: "workflow-restore" },
  );
  const controlsBefore = restored.controls().length;
  restored.appendCustomMessage("workflow-notification", {
    runId: "workflow-restore",
    status: "completed",
    agents: 2,
    failures: 0,
  });

  await restored.emit("session_start", { reason: "reload" });
  assert.equal(restored.controls().length, controlsBefore + 1);
  assert.equal(restored.latestPersisted().lifecycle, "recovering");
  assert.equal(restored.latestPersisted().epoch, waiting.epoch);
  assert.equal(restored.latestPersisted().waitFor, undefined);
  assert.match(restored.latestPersisted().ledger.nextAction ?? "", /workflow workflow-restore completed/);

  const failed = new ExtensionHarness();
  await enterWaitingExternal(failed, "workflow run workflow-failed", {
    kind: "workflow",
    id: "workflow-failed",
  });
  failed.appendCustomMessage("workflow-notification", {
    runId: "workflow-failed",
    status: "cancelled",
  });
  failed.appendAssistant("Cancelled workflow callback settled.");
  await failed.emit("agent_settled");
  assert.match(failed.latestPersisted().ledger.nextAction ?? "", /failed \(workflow cancelled\)/);
});

test("a persisted machine wake retries dispatch later and ignores duplicate completion entries", async () => {
  const harness = new ExtensionHarness();
  await enterWaitingExternal(harness, "task bg_delayed", {
    kind: "background_task",
    id: "bg_delayed",
  });
  const controlsBefore = harness.controls().length;
  harness.pending = true;
  harness.appendCustomMessage("enhanced-bash-background", {
    jobs: [{ id: "bg_delayed", kind: "bash", status: "exited", exitCode: 0 }],
  });
  harness.appendAssistant("Completion observed while another message is pending.");
  await harness.emit("agent_settled");

  const recoveredRevision = harness.latestPersisted().revision;
  assert.equal(harness.latestPersisted().lifecycle, "recovering");
  assert.equal(harness.latestPersisted().scheduler.state, "idle");
  assert.equal(harness.controls().length, controlsBefore);

  harness.appendCustomMessage("enhanced-bash-background", {
    jobs: [{ id: "bg_delayed", kind: "bash", status: "exited", exitCode: 0 }],
  });
  harness.appendAssistant("Duplicate callback.");
  await harness.emit("agent_settled");
  assert.equal(harness.latestPersisted().revision, recoveredRevision);
  assert.equal(harness.controls().length, controlsBefore);

  harness.pending = false;
  await harness.emit("agent_settled");
  assert.equal(harness.controls().length, controlsBefore + 1);
  assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
});

test("a persisted typed machine wake survives reload before its dispatch", async () => {
  const harness = new ExtensionHarness();
  await enterWaitingExternal(harness, "task bg_reload_delayed", {
    kind: "background_task",
    id: "bg_reload_delayed",
  });
  const controlsBefore = harness.controls().length;
  harness.pending = true;
  harness.appendCustomMessage("enhanced-bash-background", {
    jobs: [{ id: "bg_reload_delayed", kind: "bash", status: "exited", exitCode: 0 }],
  });
  harness.appendAssistant("Typed completion persisted before dispatch became eligible.");
  await harness.emit("agent_settled");
  assert.equal(harness.latestPersisted().lifecycle, "recovering");
  assert.equal(harness.latestPersisted().scheduler.state, "idle");
  assert.equal(harness.controls().length, controlsBefore);

  harness.pending = false;
  await harness.emit("session_start", { reason: "reload" });
  assert.equal(harness.controls().length, controlsBefore + 1);
  assert.equal(harness.latestPersisted().lifecycle, "recovering");
  assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
});

test("waiting and blocked goals gate mutating tools but preserve read-only and protocol access", async () => {
  const waitingHarness = new ExtensionHarness();
  await enterWaitingExternal(waitingHarness);
  waitingHarness.idle = false;

  for (const toolName of ["read", "grep", "find", "ls", GOAL_RESUME_TOOL, GOAL_CHECKPOINT_TOOL]) {
    assert.equal(await waitingHarness.preflightTool(toolName), undefined, `${toolName} remains available`);
  }
  for (const toolName of ["bash", "edit", "write", "custom_mutator"]) {
    const blocked = await waitingHarness.preflightTool(toolName);
    assert.equal(blocked?.block, true, `${toolName} is blocked`);
    assert.match(blocked?.reason ?? "", /Should the release target staging or production/);
    assert.match(blocked?.reason ?? "", /goal_resume/);
    assert.match(blocked?.reason ?? "", /\/goal pause/);
  }

  await waitingHarness.command("pause");
  assert.equal(await waitingHarness.preflightTool("bash"), undefined, "explicit pause releases the wait gate");

  const runningHarness = new ExtensionHarness();
  assert.equal(await runningHarness.preflightTool("bash"), undefined, "an absent goal does not gate tools");
  await createAndObserve(runningHarness);
  assert.equal(await runningHarness.preflightTool("write"), undefined, "a goal-owned run is not gated");
  await runningHarness.command("stop");
  assert.equal(await runningHarness.preflightTool("write"), undefined, "a terminal goal does not gate tools");

  const blockedHarness = new ExtensionHarness();
  await createAndObserve(blockedHarness);
  blockedHarness.appendAssistant("[[GOAL_BLOCKED: choose the migration strategy]]");
  await blockedHarness.emit("agent_settled");
  assert.equal((await blockedHarness.preflightTool("edit"))?.block, true);
  assert.equal(await blockedHarness.preflightTool("read"), undefined);
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
  const afterCheckpointMutation = await harness.preflightTool("bash");
  assert.equal(afterCheckpointMutation?.block, true);
  assert.match(afterCheckpointMutation?.reason ?? "", /goal_checkpoint must be the final tool call/);
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

test("finishing the bounded horizon returns to planning instead of claiming the whole goal", async () => {
  const harness = new ExtensionHarness();
  await createAndObserve(harness, "finish the whole roadmap");
  await settleWithProgress(harness); // one-phase rolling plan

  const callId = "call-final-phase-test";
  harness.append({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "npm test" } }],
      stopReason: "toolUse",
    },
  });
  harness.append({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "bash",
      content: [{ type: "text", text: "tests passed" }],
      isError: false,
    },
  });
  const active = harness.latestPersisted();
  const result = await harness.callCheckpoint({
    action: "phase_candidate_complete",
    expectedRevision: active.revision,
    phaseId: "phase-1",
    summary: "The current bounded roadmap slice is complete.",
    nextAction: "Re-inventory the roadmap and plan the next slice.",
    evidence: [{
      id: "phase-proof",
      criterionId: "phase-criterion-1",
      kind: "test",
      description: "The bounded slice tests passed.",
      locator: `tool:${callId}`,
    }],
  });
  harness.appendCheckpointResult(result);
  harness.appendAssistant("The bounded phase is ready for acceptance.");
  await harness.emit("agent_settled");

  const planning = harness.latestPersisted();
  assert.equal(planning.phases[0]?.status, "completed");
  assert.equal(planning.lifecycle, "planning");
  assert.equal(planning.activePhaseId, undefined);
  assert.equal(planning.acceptanceCriteria[0]?.status, "pending");
  assert.match(planning.ledger.nextAction ?? "", /Re-inventory the full objective/);
  assert.equal(planning.scheduler.state, "run_in_flight", "the next run must extend the rolling plan");
  assert.doesNotMatch(harness.notifications.map((item) => item.message).join("\n"), /Goal completion is claimed/);
});

test("a structurally complete but unproved whole-goal claim returns to planning", async () => {
  const harness = new ExtensionHarness();
  const active = await createAndObserve(harness, "finish the whole roadmap");
  let result = await harness.callCheckpoint({
    action: "set_plan",
    expectedRevision: active.revision,
    summary: "Model-authored closure has a deliberately missing proof source.",
    acceptanceCriteria: [{
      id: "accept-1",
      description: "The whole roadmap is complete.",
      status: "satisfied",
      evidenceIds: ["missing-goal-proof"],
    }],
    phases: [{
      id: "phase-1",
      title: "Roadmap",
      intent: "Finish the roadmap.",
      status: "completed",
      criteria: [{ id: "phase-criterion-1", description: "Phase complete.", status: "satisfied" }],
    }],
    evidence: [{
      id: "missing-goal-proof",
      criterionId: "accept-1",
      kind: "test",
      description: "Purported final proof.",
      locator: "tool:missing-final-proof",
    }],
  });
  harness.appendCheckpointResult(result);
  harness.appendAssistant("Closure plan recorded.");
  await harness.emit("agent_settled");

  const ready = harness.latestPersisted();
  result = await harness.callCheckpoint({
    action: "goal_candidate_complete",
    expectedRevision: ready.revision,
    summary: "Claim the whole goal with the unresolved source.",
  });
  harness.appendCheckpointResult(result);
  harness.appendAssistant("Goal claim recorded.");
  await harness.emit("agent_settled");

  const rejected = harness.latestPersisted();
  assert.equal(rejected.lifecycle, "planning");
  assert.equal(rejected.scheduler.state, "run_in_flight");
  assert.match(rejected.ledger.nextAction ?? "", /Whole-goal verification rejected/);
  assert.match(rejected.ledger.nextAction ?? "", /accept-1 \/ missing-goal-proof/);
  assert.doesNotMatch(harness.notifications.map((item) => item.message).join("\n"), /Goal completion is claimed/);
});

test("rejected phase evidence returns to work with criterion-specific diagnostics", async () => {
  const harness = new ExtensionHarness();
  await createAndObserve(harness);
  await settleWithProgress(harness); // establish the initial plan and dispatch phase work

  const active = harness.latestPersisted();
  const result = await harness.callCheckpoint({
    action: "phase_candidate_complete",
    expectedRevision: active.revision,
    phaseId: "phase-1",
    summary: "Claim phase completion with a deliberately missing observation.",
    evidence: [{
      id: "evidence-missing",
      criterionId: "phase-criterion-1",
      kind: "test",
      description: "A test result that is not on the branch.",
      locator: "tool:call-that-does-not-exist",
    }],
  });
  harness.appendCheckpointResult(result);
  harness.appendAssistant("Completion claim recorded.");
  await harness.emit("agent_settled");

  const recovered = harness.latestPersisted();
  assert.equal(recovered.lifecycle, "running");
  assert.equal(recovered.phases[0]?.status, "running");
  assert.match(recovered.ledger.nextAction ?? "", /phase-criterion-1 \/ evidence-missing/);
  assert.match(recovered.ledger.nextAction ?? "", /no matching tool result/i);
  assert.equal(recovered.scheduler.state, "run_in_flight", "one corrective work run is dispatched with diagnostics");
});

test("session reload and tree navigation pause runnable state and never auto-dispatch", async () => {
  const harness = new ExtensionHarness();
  const reloadState = createInitialCheckpoint("restore after reload", { now: 10 });
  harness.replaceBranch([{ type: "custom", customType: GOAL_CHECKPOINT_ENTRY, data: reloadState }]);

  await harness.emit("session_start", { reason: "reload" });
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

test("reload retries only restorations proven safe by branch evidence", async (t) => {
  await t.test("undelivered dispatch retries once without refunding budget", async () => {
    const harness = new ExtensionHarness();
    const pending = createInitialCheckpoint("retry an undelivered dispatch", {
      now: 10,
      goalId: "goal-undelivered",
      eventId: "event-undelivered",
      maxEpochRuns: 5,
    });
    pending.scheduler = {
      state: "dispatch_pending",
      dispatch: {
        dispatchId: "dispatch-undelivered",
        goalId: pending.goalId,
        epoch: pending.epoch,
        revision: pending.revision,
        runId: "run-undelivered",
        createdAt: 10,
      },
    };
    pending.budgets.epochRuns = 1;
    pending.budgets.totalRuns = 1;
    harness.replaceBranch([{ type: "custom", customType: GOAL_CHECKPOINT_ENTRY, data: pending }]);

    await harness.emit("session_start", { reason: "reload" });
    assert.equal(harness.controls().length, 1);
    assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
    assert.equal(harness.latestPersisted().epoch, pending.epoch);
    assert.equal(harness.latestPersisted().budgets.epochRuns, 2, "the first spent run is not refunded");

    const entries = harness.branch.length;
    await harness.emit("agent_settled");
    assert.equal(harness.branch.length, entries, "no duplicate retry is emitted");
  });

  await t.test("completed but unsettled checkpoint settles and continues once", async () => {
    const harness = new ExtensionHarness();
    const active = await createAndObserve(harness, "settle after reload");
    const result = await harness.callCheckpoint(initialPlan(active.revision));
    harness.appendCheckpointResult(result);
    harness.appendAssistant("The checkpointed run ended normally.");
    const controlsBefore = harness.controls().length;

    await harness.emit("session_start", { reason: "reload" });
    assert.equal(harness.controls().length, controlsBefore + 1);
    assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
    assert.equal(harness.latestPersisted().scheduler.lastSettledRunId, active.scheduler.activeRun?.runId);
  });

  await t.test("orphan checkpoint results after the terminating assistant fail closed", async () => {
    const harness = new ExtensionHarness();
    const active = await createAndObserve(harness, "reject orphan restore evidence");
    const result = await harness.callCheckpoint(initialPlan(active.revision));
    harness.appendAssistant("The run already ended before this orphan result.");
    harness.appendCheckpointResult(result);

    await harness.emit("session_start", { reason: "reload" });
    assert.equal(harness.controls().length, 1);
    assert.equal(harness.latestPersisted().lifecycle, "paused");
    assert.equal(harness.latestPersisted().pauseReason, "interrupted");
  });

  await t.test("typed completion wakes after an unsettled waiting run is restored", async () => {
    const harness = new ExtensionHarness();
    await createAndObserve(harness, "restore a completed typed wait");
    await settleWithProgress(harness);
    const active = harness.latestPersisted();
    const result = await harness.callCheckpoint({
      action: "waiting_external",
      expectedRevision: active.revision,
      phaseId: active.activePhaseId,
      summary: "Started a typed background task.",
      waitFor: { kind: "background_task", id: "bg-restore-settle" },
    });
    harness.appendCheckpointResult(result);
    harness.appendCustomMessage("enhanced-bash-background", {
      jobs: [{ id: "bg-restore-settle", kind: "bash", status: "exited", exitCode: 0 }],
    });
    harness.appendAssistant("The waiting run ended normally.");
    const controlsBefore = harness.controls().length;

    await harness.emit("session_start", { reason: "reload" });
    assert.equal(harness.controls().length, controlsBefore + 1);
    assert.equal(harness.latestPersisted().lifecycle, "recovering");
    assert.equal(harness.latestPersisted().waitFor, undefined);
    assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
  });

  await t.test("a durably applied ordinary answer continues in the same epoch", async () => {
    const harness = new ExtensionHarness();
    const waiting = await enterWaitingExternal(harness);
    const controlsBefore = harness.controls().length;
    await harness.beginUserPrompt("Use production.");
    await harness.callResume();
    assert.equal(harness.latestPersisted().lifecycle, "recovering");
    assert.equal(harness.latestPersisted().epoch, waiting.epoch);

    await harness.emit("session_start", { reason: "reload" });
    assert.equal(harness.controls().length, controlsBefore + 1);
    assert.equal(harness.latestPersisted().epoch, waiting.epoch);
    assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
  });
});

test("fork, tree, and unknown restore reasons never consume typed completion", async () => {
  for (const mode of ["tree", "fork", "unknown"] as const) {
    const harness = new ExtensionHarness();
    const waiting = await enterWaitingExternal(harness, `task-${mode}`, {
      kind: "background_task",
      id: `bg-${mode}`,
    });
    const controlsBefore = harness.controls().length;
    harness.appendCustomMessage("enhanced-bash-background", {
      jobs: [{ id: `bg-${mode}`, kind: "bash", status: "exited", exitCode: 0 }],
    });
    if (mode === "tree") await harness.emit("session_tree");
    else await harness.emit("session_start", mode === "fork" ? { reason: "fork" } : { reason: "future-mode" });
    assert.equal(harness.controls().length, controlsBefore, mode);
    assert.equal(harness.latestPersisted().eventId, waiting.eventId, mode);
    assert.equal(harness.latestPersisted().lifecycle, "waiting_external", mode);
    assert.deepEqual(harness.latestPersisted().waitFor, waiting.waitFor, mode);
  }
});

test("corrupt state without a valid predecessor still renders explicit ownership", async () => {
  const harness = new ExtensionHarness();
  harness.replaceBranch([{
    type: "custom",
    customType: GOAL_CHECKPOINT_ENTRY,
    data: { schemaVersion: 2, eventId: "malformed" },
  }]);
  await harness.emit("session_start", { reason: "reload" });
  assert.match(JSON.stringify(harness.widgets.at(-1)?.value), /PAUSED — CORRUPT STATE/);
  assert.match(JSON.stringify(harness.widgets.at(-1)?.value), /\/goal stop/);
  await harness.command("");
  assert.match(harness.notifications.at(-1)?.message ?? "", /PAUSED — CORRUPT STATE/);
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
  assert.equal(achieved.latestPersisted().lifecycle, "planning");
  assert.notEqual(achieved.latestPersisted().lifecycle, "succeeded");
  assert.match(achieved.latestPersisted().ledger.nextAction ?? "", /Legacy completion claim rejected/);
  assert.equal(achieved.controls().length, 2, "an unproved legacy claim returns to one planning run");

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

  const proofCallId = "call-final-acceptance-test";
  harness.append({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: proofCallId, name: "bash", arguments: { command: "npm test" } }],
      stopReason: "toolUse",
    },
  });
  harness.append({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: proofCallId,
      toolName: "bash",
      content: [{ type: "text", text: "tests passed" }],
      isError: false,
    },
  });
  let active = harness.latestPersisted();
  let result = await harness.callCheckpoint({
    action: "set_plan",
    expectedRevision: active.revision,
    summary: "Reconciled the entire objective and its acceptance evidence.",
    acceptanceCriteria: [{
      id: "accept-1",
      description: "The objective is observably satisfied.",
      status: "satisfied",
      evidenceIds: ["final-proof"],
    }],
    phases: [{
      id: "phase-1",
      title: "Execute objective",
      intent: "Perform and verify the bounded work.",
      status: "completed",
      criteria: [{
        id: "phase-criterion-1",
        description: "The phase has observed evidence.",
        status: "satisfied",
        evidenceIds: ["final-proof"],
      }],
    }],
    evidence: [{
      id: "final-proof",
      criterionId: "accept-1",
      kind: "test",
      description: "The final acceptance test passed.",
      locator: `tool:${proofCallId}`,
    }],
  });
  harness.appendCheckpointResult(result);
  harness.appendAssistant("The complete objective is now structurally ready for a goal claim.");
  await harness.emit("agent_settled");

  active = harness.latestPersisted();
  result = await harness.callCheckpoint({
    action: "goal_candidate_complete",
    expectedRevision: active.revision,
    summary: "The entire evidenced objective is complete and ready for review.",
  });
  harness.appendCheckpointResult(result);
  harness.appendAssistant("Goal completion claim recorded.");
  await harness.emit("agent_settled");

  assert.equal(harness.latestPersisted().lifecycle, "verifying_goal");
  assert.equal(harness.latestPersisted().scheduler.state, "idle");
  assert.notEqual(harness.latestPersisted().lifecycle, "succeeded");

  await harness.command("verify");
  assert.equal(harness.latestPersisted().scheduler.state, "run_in_flight");
  assert.equal(harness.controls().length, 4);
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

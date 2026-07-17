import { isDeepStrictEqual } from "node:util";
import { assertCanonicalJson } from "./canonical-json.js";
import type {
  WorkflowAgentRecord,
  WorkflowBudget,
  WorkflowEvent,
  WorkflowFailure,
  WorkflowInput,
  WorkflowRunRecord,
  WorkflowStatus,
  WorkflowTerminalIntent,
  WorkflowTerminalStatus,
  WorkflowTransition,
  WorkflowUsage,
} from "./contracts.js";
import { emptyWorkflowUsage, WORKFLOW_AGENT_STATUS_VALUES, WORKFLOW_STATUS_VALUES, WORKFLOW_TERMINAL_STATUS_VALUES } from "./contracts.js";
import {
  MAX_OUTPUT_BYTES,
  MAX_WORKFLOW_AGENTS,
  MAX_WORKFLOW_CONCURRENCY,
  MAX_WORKFLOW_TIMEOUT_MS,
  WORKFLOW_RUN_SCHEMA_VERSION,
} from "./limits.js";

const STATUSES = new Set<WorkflowStatus>(WORKFLOW_STATUS_VALUES);
const TERMINAL_STATUSES = new Set<WorkflowTerminalStatus>(WORKFLOW_TERMINAL_STATUS_VALUES);
const AGENT_STATUSES = new Set(WORKFLOW_AGENT_STATUS_VALUES);
const UNSETTLED_AGENT_STATUSES = new Set(["queued", "running", "retrying"]);
const CONCURRENT_AGENT_STATUSES = new Set(["running", "retrying"]);

export class WorkflowInvariantError extends Error {
  override name = "WorkflowInvariantError";
}

export interface CreateWorkflowRunOptions {
  id: string;
  input: WorkflowInput;
  createdAt?: number;
  budget?: Partial<WorkflowBudget>;
}

export interface ReduceWorkflowOptions { now?: number }

export function createWorkflowRunRecord(options: CreateWorkflowRunOptions): WorkflowRunRecord {
  const createdAt = options.createdAt ?? Date.now();
  const budget: WorkflowBudget = {
    maxAgents: options.budget?.maxAgents ?? MAX_WORKFLOW_AGENTS,
    maxConcurrency: options.budget?.maxConcurrency ?? MAX_WORKFLOW_CONCURRENCY,
    timeoutMs: options.budget?.timeoutMs ?? options.input.timeoutMs ?? MAX_WORKFLOW_TIMEOUT_MS,
    maxOutputBytes: options.budget?.maxOutputBytes ?? MAX_OUTPUT_BYTES,
  };
  const record: WorkflowRunRecord = {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    id: options.id,
    input: structuredClone(options.input),
    budget,
    status: "created",
    createdAt,
    updatedAt: createdAt,
    nextEventSequence: 1,
    agents: [],
    usage: emptyWorkflowUsage(),
    failures: [],
    references: [],
  };
  assertWorkflowRunInvariants(record);
  return record;
}

/** Pure, exhaustive lifecycle reducer. Input records and events are never mutated. */
export function reduceWorkflowEvent(record: WorkflowRunRecord, event: WorkflowEvent, options: ReduceWorkflowOptions = {}): WorkflowTransition {
  assertWorkflowRunInvariants(record);
  const now = options.now ?? Date.now();
  finiteNonNegative(now, "now");
  const previous = structuredClone(record);
  const next = structuredClone(record);

  if (!isWorkflowTerminalStatus(next.status)) {
    switch (event.type) {
      case "RunStarted":
        if (next.status === "created") {
          next.status = "running";
          next.startedAt = now;
        }
        break;
      case "AgentQueued":
        if (next.status === "running") queueAgent(next, event.agent);
        break;
      case "AgentStarted":
        if (next.status === "running") startAgent(next, event.index, event.attempt, now);
        break;
      case "AgentRetrying":
        if (next.status === "running") retryAgent(next, event.index, event.attempt, event.failure);
        break;
      case "AgentCompleted":
        settleAgent(next, event.index, "completed", now, undefined, event.result);
        break;
      case "AgentFailed":
        settleAgent(next, event.index, "failed", now, event.failure);
        break;
      case "AgentCancelled":
        cancelAgent(next, event.index, now, event.reason);
        break;
      case "CompletionRequested":
        requestTerminal(next, event.output
          ? { kind: "success", requestedAt: now, output: event.output }
          : { kind: "success", requestedAt: now });
        break;
      case "FailureRequested":
        requestTerminal(next, { kind: "failure", requestedAt: now, reason: event.failure.message, failure: event.failure });
        break;
      case "CancellationRequested":
        requestTerminal(next, { kind: "cancel", requestedAt: now, reason: event.reason });
        break;
      case "TimeoutElapsed":
        requestTerminal(next, { kind: "timeout", requestedAt: now, reason: event.reason ?? "workflow timeout elapsed" });
        break;
      case "RunFinalized":
        finalize(next, now);
        break;
      default:
        assertNever(event);
    }
  }

  const changed = !isDeepStrictEqual(previous, next);
  if (changed) {
    next.updatedAt = Math.max(previous.updatedAt, now);
    next.nextEventSequence = previous.nextEventSequence + 1;
  }
  assertWorkflowRunInvariants(next);
  if (previous.terminalIntent && next.terminalIntent && !isDeepStrictEqual(previous.terminalIntent, next.terminalIntent)) {
    throw new WorkflowInvariantError("first terminal intent must win");
  }
  return { previous, next, event: structuredClone(event), changed };
}

export function isWorkflowTerminalStatus(status: WorkflowStatus): status is WorkflowTerminalStatus {
  return TERMINAL_STATUSES.has(status as WorkflowTerminalStatus);
}

export function assertWorkflowRunInvariants(value: unknown): asserts value is WorkflowRunRecord {
  if (!plainRecord(value)) throw invariant("run record must be a plain object");
  if (value.schemaVersion !== WORKFLOW_RUN_SCHEMA_VERSION) throw invariant("unsupported run schemaVersion");
  nonEmptyString(value.id, "id");
  if (!STATUSES.has(value.status as WorkflowStatus)) throw invariant(`invalid status ${String(value.status)}`);
  finiteNonNegative(value.createdAt, "createdAt");
  finiteNonNegative(value.updatedAt, "updatedAt");
  if (value.updatedAt < value.createdAt) throw invariant("updatedAt cannot precede createdAt");
  positiveInteger(value.nextEventSequence, "nextEventSequence");
  assertInput(value.input);
  assertBudget(value.budget);
  assertUsage(value.usage);
  if (!Array.isArray(value.agents)) throw invariant("agents must be an array");
  if (!Array.isArray(value.failures)) throw invariant("failures must be an array");
  if (!Array.isArray(value.references)) throw invariant("references must be an array");
  for (const [index, failure] of value.failures.entries()) assertFailure(failure, `failures[${index}]`);
  for (const [index, reference] of value.references.entries()) assertReference(reference, `references[${index}]`);
  if (value.metadata !== undefined) assertJsonAt(value.metadata, "metadata");
  if (value.agents.length > (value.budget as WorkflowBudget).maxAgents) throw invariant("agent budget exceeded");

  const indices = new Set<number>();
  let active = 0;
  let unsettled = 0;
  for (const [position, rawAgent] of value.agents.entries()) {
    assertAgent(rawAgent, position);
    const agent = rawAgent as WorkflowAgentRecord;
    if (indices.has(agent.index)) throw invariant(`duplicate agent index ${agent.index}`);
    indices.add(agent.index);
    if (CONCURRENT_AGENT_STATUSES.has(agent.status)) active += 1;
    if (UNSETTLED_AGENT_STATUSES.has(agent.status)) unsettled += 1;
  }
  if (active > (value.budget as WorkflowBudget).maxConcurrency) throw invariant("agent concurrency budget exceeded");

  const status = value.status as WorkflowStatus;
  if (status === "created") {
    if (value.startedAt !== undefined || value.finishedAt !== undefined || value.terminalIntent !== undefined || value.result !== undefined) {
      throw invariant("created run contains lifecycle fields");
    }
  } else if (status === "running") {
    finiteNonNegative(value.startedAt, "startedAt");
    if (value.finishedAt !== undefined || value.terminalIntent !== undefined || value.result !== undefined) throw invariant("running run contains terminal fields");
  } else if (status === "stopping") {
    if (!plainRecord(value.terminalIntent)) throw invariant("stopping run requires terminalIntent");
    assertTerminalIntent(value.terminalIntent);
    if (value.finishedAt !== undefined || value.result !== undefined) throw invariant("stopping run is already finalized");
  } else {
    if (!plainRecord(value.terminalIntent)) throw invariant("terminal run requires terminalIntent");
    assertTerminalIntent(value.terminalIntent);
    finiteNonNegative(value.finishedAt, "finishedAt");
    if (unsettled !== 0) throw invariant("terminal run cannot contain unsettled agents");
    if (!plainRecord(value.result) || value.result.status !== status || value.result.runId !== value.id) throw invariant("terminal result does not match run");
    if (value.result.finishedAt !== value.finishedAt || value.result.agents !== value.agents.length) throw invariant("terminal result summary does not match run");
    if ((status === "completed") !== (value.terminalIntent.kind === "success")) throw invariant("terminal status contradicts first terminal intent");
    if ((status === "cancelled") !== (value.terminalIntent.kind === "cancel")) throw invariant("terminal status contradicts first terminal intent");
  }
}

function queueAgent(record: WorkflowRunRecord, input: WorkflowAgentRecord): void {
  if (record.agents.length >= record.budget.maxAgents) throw invariant("agent budget exceeded");
  if (record.agents.some((agent) => agent.index === input.index)) throw invariant(`duplicate agent index ${input.index}`);
  const agent = structuredClone(input);
  assertAgent(agent, record.agents.length);
  if (agent.status !== "queued") throw invariant("new agent must be queued");
  record.agents.push(agent);
}

function startAgent(record: WorkflowRunRecord, index: number, attempt: number, now: number): void {
  const agent = findAgent(record, index);
  if (agent.status !== "queued" && agent.status !== "retrying") return;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > agent.maxRetries + 1) throw invariant("invalid agent attempt");
  const running = record.agents.filter((item) => item.index !== index && CONCURRENT_AGENT_STATUSES.has(item.status)).length;
  if (running >= record.budget.maxConcurrency) throw invariant("agent concurrency budget exceeded");
  agent.status = "running";
  agent.attempt = attempt;
  agent.startedAt ??= now;
}

function retryAgent(record: WorkflowRunRecord, index: number, attempt: number, failure: WorkflowFailure): void {
  const agent = findAgent(record, index);
  if (agent.status !== "running") return;
  if (!Number.isSafeInteger(attempt) || attempt <= agent.attempt || attempt > agent.maxRetries + 1) throw invariant("invalid retry attempt");
  agent.status = "retrying";
  agent.attempt = attempt;
  agent.failure = structuredClone(failure);
}

function settleAgent(
  record: WorkflowRunRecord,
  index: number,
  status: "completed" | "failed",
  now: number,
  failure?: WorkflowFailure,
  result?: WorkflowAgentRecord["result"],
): void {
  const agent = findAgent(record, index);
  if (!UNSETTLED_AGENT_STATUSES.has(agent.status)) return;
  agent.status = status;
  agent.finishedAt = now;
  if (failure) {
    agent.failure = structuredClone(failure);
    record.failures.push(structuredClone(failure));
  }
  if (result) {
    if (result.index !== index) throw invariant("agent result index mismatch");
    agent.result = structuredClone(result);
    record.usage = addUsage(record.usage, result.usage);
    if (result.failure) record.failures.push(structuredClone(result.failure));
  }
}

function cancelAgent(record: WorkflowRunRecord, index: number, now: number, reason: string): void {
  const agent = findAgent(record, index);
  if (!UNSETTLED_AGENT_STATUSES.has(agent.status)) return;
  agent.status = "cancelled";
  agent.finishedAt = now;
  agent.failure = { kind: "cancelled", message: reason, agentIndex: index, ...(agent.label ? { label: agent.label } : {}) };
}

function requestTerminal(record: WorkflowRunRecord, intent: WorkflowTerminalIntent): void {
  if (record.terminalIntent) return;
  record.terminalIntent = structuredClone(intent);
  record.status = "stopping";
  if (intent.failure) record.failures.push(structuredClone(intent.failure));
  if (intent.output) record.references.push(structuredClone(intent.output));
}

function finalize(record: WorkflowRunRecord, now: number): void {
  if (record.status !== "stopping" || !record.terminalIntent) return;
  if (record.agents.some((agent) => UNSETTLED_AGENT_STATUSES.has(agent.status))) return;
  const intent = record.terminalIntent;
  const status: WorkflowTerminalStatus = intent.kind === "success" ? "completed" : intent.kind === "cancel" ? "cancelled" : "failed";
  record.status = status;
  record.finishedAt = now;
  record.result = {
    runId: record.id,
    status,
    ...(intent.output ? { output: intent.output } : {}),
    usage: structuredClone(record.usage),
    agents: record.agents.length,
    failures: structuredClone(record.failures),
    references: structuredClone(record.references),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    finishedAt: now,
  };
}

function assertAgent(value: unknown, position: number): asserts value is WorkflowAgentRecord {
  if (!plainRecord(value)) throw invariant(`agents[${position}] must be an object`);
  nonNegativeInteger(value.index, `agents[${position}].index`);
  if (!AGENT_STATUSES.has(value.status as WorkflowAgentRecord["status"])) throw invariant(`invalid agent status at ${position}`);
  nonNegativeInteger(value.attempt, `agents[${position}].attempt`);
  nonNegativeInteger(value.maxRetries, `agents[${position}].maxRetries`);
  if (value.attempt > value.maxRetries + 1) throw invariant(`agent ${position} exceeded retry limit`);
  finiteNonNegative(value.queuedAt, `agents[${position}].queuedAt`);
  if (value.startedAt !== undefined) finiteNonNegative(value.startedAt, `agents[${position}].startedAt`);
  if (value.finishedAt !== undefined) finiteNonNegative(value.finishedAt, `agents[${position}].finishedAt`);
  if ((value.status === "running" || value.status === "retrying") && (value.startedAt === undefined || value.attempt < 1)) {
    throw invariant(`active agent ${position} has no valid start`);
  }
  if ((value.status === "completed" || value.status === "failed" || value.status === "cancelled") && value.finishedAt === undefined) {
    throw invariant(`settled agent ${position} has no finishedAt`);
  }
  if (value.finishedAt !== undefined && value.startedAt !== undefined && value.finishedAt < value.startedAt) throw invariant(`agent ${position} finished before start`);
  if (value.status === "completed" && !plainRecord(value.result)) throw invariant(`completed agent ${position} requires a result`);
  if (value.status === "failed" && !plainRecord(value.failure)) throw invariant(`failed agent ${position} requires a failure`);
  if (value.failure !== undefined) assertFailure(value.failure, `agents[${position}].failure`);
}

function assertTerminalIntent(value: Record<string, unknown>): void {
  if (!new Set(["success", "failure", "cancel", "timeout"]).has(value.kind as string)) throw invariant("invalid terminal intent");
  finiteNonNegative(value.requestedAt, "terminalIntent.requestedAt");
  if (value.reason !== undefined && typeof value.reason !== "string") throw invariant("terminalIntent.reason must be a string");
  if (value.failure !== undefined) assertFailure(value.failure, "terminalIntent.failure");
  if (value.output !== undefined) assertReference(value.output, "terminalIntent.output");
  if (value.kind === "failure" && value.failure === undefined) throw invariant("failure terminal intent requires a failure");
}

function assertInput(value: unknown): void {
  if (!plainRecord(value) || !plainRecord(value.source)) throw invariant("input.source must be an object");
  const source = value.source;
  if (source.kind === "inline") nonEmptyString(source.script, "input.source.script");
  else if (source.kind === "path") nonEmptyString(source.path, "input.source.path");
  else if (source.kind === "saved") nonEmptyString(source.name, "input.source.name");
  else throw invariant("invalid workflow source kind");
  if (value.args !== undefined) assertJsonAt(value.args, "input.args");
  if (value.timeoutMs !== undefined) positiveInteger(value.timeoutMs, "input.timeoutMs");
  if (value.background !== undefined && typeof value.background !== "boolean") throw invariant("input.background must be boolean");
}

function assertBudget(value: unknown): asserts value is WorkflowBudget {
  if (!plainRecord(value)) throw invariant("budget must be an object");
  positiveInteger(value.maxAgents, "budget.maxAgents");
  positiveInteger(value.maxConcurrency, "budget.maxConcurrency");
  positiveInteger(value.timeoutMs, "budget.timeoutMs");
  positiveInteger(value.maxOutputBytes, "budget.maxOutputBytes");
  if (value.maxAgents > MAX_WORKFLOW_AGENTS) throw invariant("maxAgents exceeds fixed limit");
  if (value.maxConcurrency > MAX_WORKFLOW_CONCURRENCY || value.maxConcurrency > value.maxAgents) throw invariant("maxConcurrency exceeds fixed limit");
  if (value.timeoutMs > MAX_WORKFLOW_TIMEOUT_MS) throw invariant("timeoutMs exceeds fixed limit");
  if (value.maxOutputBytes > MAX_OUTPUT_BYTES) throw invariant("maxOutputBytes exceeds fixed limit");
}

function assertFailure(value: unknown, path: string): asserts value is WorkflowFailure {
  if (!plainRecord(value)) throw invariant(`${path} must be an object`);
  if (!new Set(["validation", "agent", "timeout", "cancelled", "runtime", "persistence"]).has(value.kind as string)) throw invariant(`${path}.kind is invalid`);
  nonEmptyString(value.message, `${path}.message`);
  if (value.code !== undefined && typeof value.code !== "string") throw invariant(`${path}.code must be a string`);
  if (value.agentIndex !== undefined) nonNegativeInteger(value.agentIndex, `${path}.agentIndex`);
  if (value.label !== undefined && typeof value.label !== "string") throw invariant(`${path}.label must be a string`);
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") throw invariant(`${path}.retryable must be boolean`);
  if (value.details !== undefined) assertJsonAt(value.details, `${path}.details`);
}

function assertReference(value: unknown, path: string): void {
  if (!plainRecord(value)) throw invariant(`${path} must be an object`);
  if (value.kind === "script") {
    nonEmptyString(value.path, `${path}.path`);
    nonEmptyString(value.sha256, `${path}.sha256`);
  } else if (value.kind === "output") {
    nonEmptyString(value.path, `${path}.path`);
    if (value.encoding !== "tagged-json-v1") throw invariant(`${path}.encoding is invalid`);
    nonNegativeInteger(value.bytes, `${path}.bytes`);
    if (typeof value.truncated !== "boolean") throw invariant(`${path}.truncated must be boolean`);
  } else if (value.kind === "agent") {
    nonNegativeInteger(value.index, `${path}.index`);
    if (value.transcriptPath !== undefined && typeof value.transcriptPath !== "string") throw invariant(`${path}.transcriptPath must be a string`);
  } else throw invariant(`${path}.kind is invalid`);
}

function assertJsonAt(value: unknown, path: string): void {
  try { assertCanonicalJson(value); }
  catch (error) { throw invariant(`${path} must be canonical JSON: ${(error as Error).message}`); }
}

function assertUsage(value: unknown): asserts value is WorkflowUsage {
  if (!plainRecord(value)) throw invariant("usage must be an object");
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"] as const) finiteNonNegative(value[key], `usage.${key}`);
}

function addUsage(a: WorkflowUsage, b: WorkflowUsage): WorkflowUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
    contextTokens: Math.max(a.contextTokens, b.contextTokens),
    turns: a.turns + b.turns,
  };
}

function findAgent(record: WorkflowRunRecord, index: number): WorkflowAgentRecord {
  const agent = record.agents.find((item) => item.index === index);
  if (!agent) throw invariant(`unknown agent ${index}`);
  return agent;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function finiteNonNegative(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invariant(`${path} must be a non-negative finite number`);
}
function nonNegativeInteger(value: unknown, path: string): asserts value is number {
  finiteNonNegative(value, path);
  if (!Number.isSafeInteger(value)) throw invariant(`${path} must be a safe integer`);
}
function positiveInteger(value: unknown, path: string): asserts value is number {
  nonNegativeInteger(value, path);
  if (value <= 0) throw invariant(`${path} must be positive`);
}
function nonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw invariant(`${path} must be a non-empty string`);
}
function invariant(message: string): WorkflowInvariantError { return new WorkflowInvariantError(message); }
function assertNever(value: never): never { throw invariant(`unhandled event ${JSON.stringify(value)}`); }

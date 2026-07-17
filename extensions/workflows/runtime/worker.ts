import { Worker } from "node:worker_threads";

export type WorkerRpcError =
  | { kind: "contract"; code: string; message: string }
  | { kind: "script"; code: string; message: string; stack?: string }
  | { kind: "infrastructure"; code: string; message: string };

export interface WorkerAgentRequest {
  version: 1;
  type: "agent";
  rpcId: number;
  task: string;
  options: Record<string, unknown>;
  phase?: string;
}

export interface WorkerChildRequest {
  version: 1;
  type: "workflow";
  rpcId: number;
  reference: { name: string } | { scriptPath: string };
  args: unknown;
}

export type WorkerRpcRequest = WorkerAgentRequest | WorkerChildRequest;

export interface WorkerRuntimeHooks {
  agent(request: WorkerAgentRequest): Promise<{ value: unknown; failures: readonly unknown[]; budget: WorkerBudgetSnapshot }>;
  workflow(request: WorkerChildRequest): Promise<{ value: unknown; failures: readonly unknown[]; budget: WorkerBudgetSnapshot }>;
  phase?(id: string): void;
  log?(message: string): void;
}

export interface WorkerBudgetSnapshot {
  total: number | null;
  spent: number;
  reserved: number;
  remaining: number | null;
}

export interface CanonicalWorkerInput {
  bodySource: string;
  filename: string;
  args: unknown;
  phaseIds: readonly string[];
  initialBudget: WorkerBudgetSnapshot;
  timeoutMs: number;
  resumable: boolean;
}

interface SerializedError {
  kind: WorkerRpcError["kind"];
  code: string;
  message: string;
  stack?: string;
}

interface RpcSuccess {
  version: 1;
  type: "rpc-result";
  rpcId: number;
  ok: true;
  value: unknown;
  failures: readonly unknown[];
  budget: WorkerBudgetSnapshot;
}

interface RpcFailure {
  version: 1;
  type: "rpc-result";
  rpcId: number;
  ok: false;
  error: SerializedError;
}

type WorkerToParent =
  | WorkerRpcRequest
  | { version: 1; type: "phase"; id: string }
  | { version: 1; type: "log"; message: string }
  | { version: 1; type: "complete"; value: unknown }
  | { version: 1; type: "failed"; error: SerializedError };

const WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { AsyncLocalStorage, createHook } = require("node:async_hooks");

// The worker is a liveness boundary, not a security boundary. Track the entire
// script async tree so detached continuations and unhandled rejections cannot
// race a successful result after the returned promise settles.
const workflowScope = new AsyncLocalStorage();
const WORKFLOW_SCOPE = {};
const scriptResources = new Map();
let activityVersion = 0;
let activityWaiters = [];
let firstUnhandledRejection;
function markActivity() {
  activityVersion++;
  const waiters = activityWaiters;
  activityWaiters = [];
  for (const resolve of waiters) resolve();
}
const asyncHook = createHook({
  init(asyncId, type) {
    if (workflowScope.getStore() !== WORKFLOW_SCOPE) return;
    scriptResources.set(asyncId, type);
    markActivity();
  },
  before(asyncId) { if (scriptResources.has(asyncId)) markActivity(); },
  after(asyncId) { if (scriptResources.has(asyncId)) markActivity(); },
  destroy(asyncId) { if (scriptResources.delete(asyncId)) markActivity(); },
  promiseResolve(asyncId) {
    if (scriptResources.get(asyncId) === "PROMISE") {
      scriptResources.delete(asyncId);
      markActivity();
    }
  },
});
asyncHook.enable();
process.on("unhandledRejection", (reason) => {
  firstUnhandledRejection ??= reason;
  markActivity();
});

const pending = new Map();
let nextRpcId = 1;
let currentPhase;
let failureSnapshot = Object.freeze([]);
let budgetState = { ...workerData.initialBudget };
let openRpc = 0;
let resolveIdle;
let idlePromise = Promise.resolve();

function beginRpc() {
  if (openRpc++ === 0) idlePromise = new Promise((resolve) => { resolveIdle = resolve; });
}
function endRpc() {
  openRpc--;
  if (openRpc === 0) { resolveIdle?.(); resolveIdle = undefined; }
}
function freeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}
function error(kind, code, message, stack) { return { kind, code, message, stack }; }
function contract(code, message) {
  const value = new Error(message);
  value.name = "WorkflowContractError";
  value.code = code;
  throw value;
}
function serializeError(value, fallbackKind = "script") {
  const object = value && (typeof value === "object" || typeof value === "function") ? value : undefined;
  const name = typeof object?.name === "string" ? object.name : "";
  const kind = name === "WorkflowContractError" ? "contract" : fallbackKind;
  return error(
    kind,
    typeof object?.code === "string" ? object.code : kind === "contract" ? "WORKFLOW_CONTRACT" : "WORKFLOW_SCRIPT",
    typeof object?.message === "string" ? object.message : String(value),
    typeof object?.stack === "string" ? object.stack : undefined,
  );
}
function deserializeError(value) {
  const result = new Error(value?.message || "workflow RPC failed");
  result.name = value?.kind === "contract" ? "WorkflowContractError" : "WorkflowRpcError";
  result.code = value?.code;
  result.rpcKind = value?.kind;
  if (value?.stack) result.stack = value.stack;
  return result;
}
function cloneFailureSnapshot(value) {
  const copy = Array.isArray(value) ? value.map((entry) => freeze({ ...entry })) : [];
  return Object.freeze(copy);
}
function rpc(type, payload) {
  const rpcId = nextRpcId++;
  beginRpc();
  const promise = new Promise((resolve, reject) => pending.set(rpcId, { resolve, reject }));
  parentPort.postMessage({ version: 1, type, rpcId, ...payload });
  return promise.finally(endRpc);
}
parentPort.on("message", (message) => {
  if (!message || message.version !== 1 || message.type !== "rpc-result") return;
  const target = pending.get(message.rpcId);
  if (!target) return;
  pending.delete(message.rpcId);
  if (message.ok) {
    failureSnapshot = cloneFailureSnapshot(message.failures);
    budgetState = Object.freeze({ ...message.budget });
    target.resolve(message.value);
  } else target.reject(deserializeError(message.error));
});

function validateAgent(task, options) {
  if (typeof task !== "string" || task.length === 0) contract("AGENT_TASK", "agent() task must be a non-empty string");
  if (!options || typeof options !== "object" || Array.isArray(options)) contract("AGENT_OPTIONS", "agent() options must be an object");
  if (typeof options.id !== "string" || options.id.length === 0) contract("AGENT_ID_REQUIRED", "agent() requires a non-empty options.id");
}
function agent(task, options) {
  validateAgent(task, options);
  const effective = { ...options };
  if (effective.phase === undefined && currentPhase !== undefined) effective.phase = currentPhase;
  return rpc("agent", { task, options: effective, phase: effective.phase });
}
async function parallel(thunks) {
  if (arguments.length !== 1 || !Array.isArray(thunks) || thunks.some((item) => typeof item !== "function")) {
    contract("PARALLEL_SIGNATURE", "parallel() accepts exactly one array of thunk functions");
  }
  if (thunks.length > 10000) contract("HELPER_ITEM_LIMIT", "parallel() exceeds the 10000 item limit");
  return await Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk)));
}
async function pipeline(items, ...stages) {
  if (!Array.isArray(items) || stages.length === 0 || stages.some((stage) => typeof stage !== "function")) {
    contract("PIPELINE_SIGNATURE", "pipeline() requires an item array followed by variadic stage functions");
  }
  if (items.length > 10000 || stages.length > 10000) contract("HELPER_ITEM_LIMIT", "pipeline() exceeds the 10000 item/stage limit");
  return await Promise.all(items.map(async (original, index) => {
    let previous = original;
    for (const stage of stages) {
      if (previous === null) break;
      previous = await stage(previous, original, index);
    }
    return previous;
  }));
}
function workflow(reference, childArgs) {
  const valid = reference && typeof reference === "object" && !Array.isArray(reference)
    && ((Object.keys(reference).length === 1 && typeof reference.name === "string" && reference.name)
      || (Object.keys(reference).length === 1 && typeof reference.scriptPath === "string" && reference.scriptPath));
  if (!valid) contract("WORKFLOW_REFERENCE", "workflow() requires exactly one explicit {name} or {scriptPath} reference");
  return rpc("workflow", { reference: { ...reference }, args: childArgs });
}
function phase(id) {
  if (typeof id !== "string" || !workerData.phaseIds.includes(id)) contract("UNKNOWN_PHASE", "unknown workflow phase: " + String(id));
  currentPhase = id;
  parentPort.postMessage({ version: 1, type: "phase", id });
}
function blockerCount() {
  let count = pending.size;
  for (const type of scriptResources.values()) if (type !== "PROMISE") count++;
  return count;
}
function nextEventLoopTurn() {
  return workflowScope.exit(() => new Promise((resolve) => setImmediate(resolve)));
}
function waitForActivity(version) {
  return workflowScope.exit(() => new Promise((resolve) => {
    if (activityVersion !== version) resolve();
    else activityWaiters.push(resolve);
  }));
}
function throwUnhandledRejection() { if (firstUnhandledRejection !== undefined) throw firstUnhandledRejection; }
async function waitForQuiescence() {
  let observed = activityVersion;
  let stableTurns = 0;
  while (stableTurns < 2) {
    throwUnhandledRejection();
    if (blockerCount() > 0) {
      stableTurns = 0;
      await waitForActivity(observed);
      observed = activityVersion;
      continue;
    }
    await nextEventLoopTurn();
    throwUnhandledRejection();
    const current = activityVersion;
    if (blockerCount() === 0 && current === observed) stableTurns++;
    else stableTurns = 0;
    observed = current;
  }
  throwUnhandledRejection();
}
function safeLog(value) {
  if (typeof value === "string") return value;
  try { const encoded = JSON.stringify(value); return encoded === undefined ? String(value) : encoded; }
  catch { return String(value); }
}
function log(...values) { parentPort.postMessage({ version: 1, type: "log", message: values.map(safeLog).join(" ") }); }
function failures() { return cloneFailureSnapshot(failureSnapshot); }
const budget = Object.freeze({
  get total() { return budgetState.total; },
  spent() { return budgetState.spent; },
  reserved() { return budgetState.reserved; },
  remaining() { return budgetState.remaining; },
});

const args = freeze(structuredClone(workerData.args));
const globals = { agent, parallel, pipeline, workflow, phase, log, failures, args, budget, console: Object.freeze({ log, error: log }) };
if (!workerData.resumable) Object.assign(globals, { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask });
else globals.Date = undefined;
const context = vm.createContext(globals, { codeGeneration: { strings: false, wasm: false } });
if (workerData.resumable) {
  new vm.Script("Math.random = undefined; Promise.race = undefined; Promise.any = undefined; Object.freeze(Math); Object.freeze(Promise);").runInContext(context);
}
const wrapped = "(async () => {\n\"use strict\";\n" + workerData.bodySource + "\n})()";
void (async () => {
  try {
    const script = new vm.Script(wrapped, { filename: workerData.filename });
    const execution = workflowScope.run(WORKFLOW_SCOPE, () => script.runInContext(context));
    const value = await execution;
    while (openRpc > 0) await idlePromise;
    await waitForQuiescence();
    asyncHook.disable();
    parentPort.postMessage({ version: 1, type: "complete", value });
  } catch (cause) {
    asyncHook.disable();
    parentPort.postMessage({ version: 1, type: "failed", error: serializeError(cause) });
  }
})();
`;

export class CanonicalWorkflowWorker {
  constructor(private readonly hooks: WorkerRuntimeHooks) {}

  async run(input: CanonicalWorkerInput, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortError(signal);
    return await new Promise<unknown>((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        name: `workflow-${input.filename.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-48)}`,
        workerData: input,
      });
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        worker.removeAllListeners();
      };
      const finish = (error: unknown, value?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        void worker.terminate().then(() => error === undefined ? resolve(value) : reject(error), reject);
      };
      const onAbort = (): void => finish(abortError(signal));
      worker.on("error", (error) => finish(error));
      worker.on("exit", (code) => {
        if (!settled) finish(new Error(`workflow worker exited before completion (code ${code})`));
      });
      worker.on("message", (message: WorkerToParent) => {
        if (!message || message.version !== 1) return;
        if (message.type === "complete") return finish(undefined, message.value);
        if (message.type === "failed") return finish(deserializeError(message.error));
        if (message.type === "phase") {
          try { this.hooks.phase?.(message.id); } catch (error) { finish(error); }
          return;
        }
        if (message.type === "log") {
          try { this.hooks.log?.(message.message); } catch (error) { finish(error); }
          return;
        }
        if (message.type === "agent" || message.type === "workflow") {
          const request = message;
          let operation: Promise<{ value: unknown; failures: readonly unknown[]; budget: WorkerBudgetSnapshot }>;
          try {
            operation = Promise.resolve(request.type === "agent" ? this.hooks.agent(request) : this.hooks.workflow(request));
          } catch (error) {
            finish(error);
            return;
          }
          void operation.then(
            (result) => {
              const response: RpcSuccess = { version: 1, type: "rpc-result", rpcId: request.rpcId, ok: true, ...result };
              try { worker.postMessage(response); } catch { /* worker already terminal */ }
            },
            (cause) => {
              const response: RpcFailure = {
                version: 1,
                type: "rpc-result",
                rpcId: request.rpcId,
                ok: false,
                error: serializeParentError(cause),
              };
              try { worker.postMessage(response); } catch { /* worker already terminal */ }
            },
          );
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        const error = new Error(`workflow script deadline exceeded after ${input.timeoutMs}ms`);
        (error as NodeJS.ErrnoException).code = "WORKFLOW_DEADLINE";
        finish(error);
      }, Math.max(1, Math.min(2_147_483_647, input.timeoutMs)));
      timer.unref?.();
      if (signal?.aborted) onAbort();
    });
  }
}

function serializeParentError(cause: unknown): SerializedError {
  const value = cause && (typeof cause === "object" || typeof cause === "function")
    ? cause as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; kind?: unknown }
    : undefined;
  const kind = value?.kind === "contract" || value?.kind === "script" || value?.kind === "infrastructure"
    ? value.kind
    : value?.name === "WorkflowContractError" ? "contract" : "infrastructure";
  return {
    kind,
    code: typeof value?.code === "string" ? value.code : kind === "contract" ? "WORKFLOW_CONTRACT" : "WORKFLOW_INFRASTRUCTURE",
    message: typeof value?.message === "string" ? value.message : String(cause),
    stack: typeof value?.stack === "string" ? value.stack : undefined,
  };
}

function deserializeError(value: SerializedError): Error {
  const error = new Error(value.message);
  error.name = value.kind === "contract" ? "WorkflowContractError" : value.kind === "script" ? "WorkflowScriptError" : "WorkflowInfrastructureError";
  error.stack = value.stack ?? error.stack;
  (error as NodeJS.ErrnoException).code = value.code;
  Object.assign(error, { kind: value.kind });
  return error;
}

function abortError(signal?: AbortSignal): Error {
  const error = new Error("workflow aborted", { cause: signal?.reason });
  (error as NodeJS.ErrnoException).code = "WORKFLOW_ABORTED";
  return error;
}

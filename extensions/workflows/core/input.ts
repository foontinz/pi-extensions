import { Buffer } from "node:buffer";
import { cloneCanonicalJson } from "./canonical-json.js";
import type { WorkflowInput } from "./contracts.js";
import { MAX_WORKFLOW_ARGS_BYTES, MAX_WORKFLOW_SCRIPT_BYTES, MAX_WORKFLOW_TIMEOUT_MS } from "./limits.js";

export class WorkflowContractError extends Error {
  readonly kind = "contract" as const;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkflowContractError";
  }
}

export function validateWorkflowInput(input: WorkflowInput): WorkflowInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WorkflowContractError("INPUT_OBJECT", "Workflow input must be an object");
  const sources = [input.script !== undefined, input.scriptPath !== undefined, input.name !== undefined].filter(Boolean).length;
  if (sources !== 1) throw new WorkflowContractError("SOURCE_EXACTLY_ONE", "exactly one of script, scriptPath, or name is required");
  if (input.script !== undefined) {
    if (typeof input.script !== "string" || !input.script.trim()) throw new WorkflowContractError("SCRIPT_EMPTY", "script must be a non-empty string");
    if (Buffer.byteLength(input.script, "utf8") > MAX_WORKFLOW_SCRIPT_BYTES) throw new WorkflowContractError("SCRIPT_LIMIT", `script exceeds ${MAX_WORKFLOW_SCRIPT_BYTES} bytes`);
  }
  for (const [key, value] of [["scriptPath", input.scriptPath], ["name", input.name], ["resumeFromRunId", input.resumeFromRunId]] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new WorkflowContractError("INPUT_STRING", `${key} must be a non-empty string`);
  }
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > MAX_WORKFLOW_TIMEOUT_MS)) {
    throw new WorkflowContractError("TIMEOUT_LIMIT", `timeoutMs must be an integer between 1000 and ${MAX_WORKFLOW_TIMEOUT_MS}`);
  }
  if (input.budgetTokens !== undefined && (!Number.isSafeInteger(input.budgetTokens) || input.budgetTokens < 1)) {
    throw new WorkflowContractError("BUDGET_INVALID", "budgetTokens must be a positive safe integer");
  }
  if (input.background !== undefined && typeof input.background !== "boolean") throw new WorkflowContractError("BACKGROUND_BOOLEAN", "background must be boolean");
  const args = input.args === undefined ? undefined : cloneCanonicalJson(input.args);
  if (args !== undefined && Buffer.byteLength(JSON.stringify(args), "utf8") > MAX_WORKFLOW_ARGS_BYTES) {
    throw new WorkflowContractError("ARGS_LIMIT", `args exceeds ${MAX_WORKFLOW_ARGS_BYTES} encoded JSON bytes`);
  }
  return { ...input, ...(args === undefined ? {} : { args }) };
}

import type { JsonValue } from "./canonical-json.js";
import { WORKFLOW_EVENT_SCHEMA_VERSION, WORKFLOW_RUN_SCHEMA_VERSION } from "./limits.js";

export type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type WorkflowSource =
  | { kind: "inline"; script: string }
  | { kind: "path"; path: string }
  | { kind: "saved"; name: string };

/** Canonical input accepted by the clean-break engine. */
export interface WorkflowInput {
  source: WorkflowSource;
  args?: JsonValue;
  timeoutMs?: number;
  background?: boolean;
}

export interface WorkflowBudget {
  maxAgents: number;
  maxConcurrency: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface WorkflowAgentSchema {
  required?: string[];
  description?: string;
}

export interface WorkflowAgentOptions {
  label?: string;
  tools?: string[];
  systemPrompt?: string;
  thinking?: WorkflowThinkingLevel;
  timeoutMs?: number;
  cwd?: string;
  worktree?: boolean;
  mcp?: boolean;
  schema?: WorkflowAgentSchema;
  retries?: number;
}

/** The optional literal object at the beginning of a workflow script. */
export interface WorkflowMeta {
  name?: string;
  description?: string;
  version?: string;
  tags?: string[];
  budget?: Partial<WorkflowBudget>;
  [key: string]: JsonValue | Partial<WorkflowBudget> | undefined;
}
export type WorkflowMetadata = WorkflowMeta;

export type WorkflowFailureKind = "validation" | "agent" | "timeout" | "cancelled" | "runtime" | "persistence";
export interface WorkflowFailure {
  kind: WorkflowFailureKind;
  message: string;
  code?: string;
  agentIndex?: number;
  label?: string;
  retryable?: boolean;
  details?: JsonValue;
}

export interface WorkflowUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface WorkflowScriptReference {
  kind: "script";
  path: string;
  sha256: string;
}
export interface WorkflowOutputReference {
  kind: "output";
  path: string;
  encoding: "tagged-json-v1";
  bytes: number;
  truncated: boolean;
}
export interface WorkflowAgentReference {
  kind: "agent";
  index: number;
  transcriptPath?: string;
}
export type WorkflowReference = WorkflowScriptReference | WorkflowOutputReference | WorkflowAgentReference;

export interface WorkflowAgentResult {
  index: number;
  label?: string;
  output?: JsonValue;
  usage: WorkflowUsage;
  failure?: WorkflowFailure;
}

export interface WorkflowResult {
  runId: string;
  status: WorkflowTerminalStatus;
  output?: WorkflowOutputReference;
  usage: WorkflowUsage;
  agents: number;
  failures: WorkflowFailure[];
  references: WorkflowReference[];
  startedAt?: number;
  finishedAt: number;
}

export const WORKFLOW_STATUS_VALUES = ["created", "running", "stopping", "completed", "failed", "cancelled"] as const;
export type WorkflowStatus = typeof WORKFLOW_STATUS_VALUES[number];
export const WORKFLOW_TERMINAL_STATUS_VALUES = ["completed", "failed", "cancelled"] as const;
export type WorkflowTerminalStatus = typeof WORKFLOW_TERMINAL_STATUS_VALUES[number];

export const WORKFLOW_AGENT_STATUS_VALUES = ["queued", "running", "retrying", "completed", "failed", "cancelled"] as const;
export type WorkflowAgentStatus = typeof WORKFLOW_AGENT_STATUS_VALUES[number];

export type WorkflowTerminalIntentKind = "success" | "failure" | "cancel" | "timeout";
export interface WorkflowTerminalIntent {
  kind: WorkflowTerminalIntentKind;
  requestedAt: number;
  reason?: string;
  failure?: WorkflowFailure;
  output?: WorkflowOutputReference;
}

export interface WorkflowAgentRecord {
  index: number;
  label?: string;
  status: WorkflowAgentStatus;
  attempt: number;
  maxRetries: number;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: WorkflowAgentResult;
  failure?: WorkflowFailure;
}

/** Fully durable state. It deliberately contains no controllers, promises, or handles. */
export interface WorkflowRunRecord {
  schemaVersion: typeof WORKFLOW_RUN_SCHEMA_VERSION;
  id: string;
  input: WorkflowInput;
  metadata?: WorkflowMeta;
  budget: WorkflowBudget;
  status: WorkflowStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  nextEventSequence: number;
  agents: WorkflowAgentRecord[];
  usage: WorkflowUsage;
  failures: WorkflowFailure[];
  references: WorkflowReference[];
  terminalIntent?: WorkflowTerminalIntent;
  result?: WorkflowResult;
}

export type WorkflowEventPayload =
  | { type: "RunStarted" }
  | { type: "AgentQueued"; agent: WorkflowAgentRecord }
  | { type: "AgentStarted"; index: number; attempt: number }
  | { type: "AgentRetrying"; index: number; attempt: number; failure: WorkflowFailure }
  | { type: "AgentCompleted"; index: number; result: WorkflowAgentResult }
  | { type: "AgentFailed"; index: number; failure: WorkflowFailure }
  | { type: "AgentCancelled"; index: number; reason: string }
  | { type: "CompletionRequested"; output?: WorkflowOutputReference }
  | { type: "FailureRequested"; failure: WorkflowFailure }
  | { type: "CancellationRequested"; reason: string }
  | { type: "TimeoutElapsed"; reason?: string }
  | { type: "RunFinalized" };

export type WorkflowEvent = WorkflowEventPayload;

export interface DurableWorkflowEvent {
  schemaVersion: typeof WORKFLOW_EVENT_SCHEMA_VERSION;
  runId: string;
  sequence: number;
  timestamp: number;
  event: WorkflowEvent;
}

export interface WorkflowTransition {
  previous: WorkflowRunRecord;
  next: WorkflowRunRecord;
  event: WorkflowEvent;
  changed: boolean;
}

/** Concise canonical aliases used by workflow scripts and adapters. */
export type AgentOptions = WorkflowAgentOptions;
export type Failure = WorkflowFailure;
export type Budget = WorkflowBudget;
export type Reference = WorkflowReference;
export type AgentResult = WorkflowAgentResult;
export type RunRecord = WorkflowRunRecord;
export type AgentRecord = WorkflowAgentRecord;

export function emptyWorkflowUsage(): WorkflowUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

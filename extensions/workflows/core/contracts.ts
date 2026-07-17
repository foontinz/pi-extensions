import type { JsonValue } from "./canonical-json.js";
import { WORKFLOW_EVENT_SCHEMA_VERSION, WORKFLOW_RUN_SCHEMA_VERSION } from "./limits.js";

export type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkflowEffects = "none" | "workspace" | "external";
export type WorkflowArtifactPolicy = "capture" | "discard";
export type WorkflowCachePolicy = "off" | "pure" | "workspace-artifact";
export type WorkflowCostState = "reported" | "estimated" | "unavailable";

/** Frozen clean-break public tool input. Exactly one source is validated separately. */
export interface WorkflowInput {
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: JsonValue;
  budgetTokens?: number;
  timeoutMs?: number;
  background?: boolean;
  resumeFromRunId?: string;
}

export interface WorkflowPhaseMeta { id: string; title: string }
export interface WorkflowMeta {
  name: string;
  description: string;
  resumable: boolean;
  maxAgents: number;
  capabilities: string[];
  phases?: WorkflowPhaseMeta[];
  whenToUse?: string;
  estimatedOutputTokens?: number;
}
export type WorkflowMetadata = WorkflowMeta;

export type JsonSchema202012 = Record<string, unknown>;
export interface WorkflowInputManifestEntry { path: string; sha256: string }
export interface WorkflowAgentOptions {
  id: string;
  label?: string;
  phase?: string;
  schema?: JsonSchema202012;
  profile?: string;
  model?: string;
  thinking?: WorkflowThinkingLevel;
  tools?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  timeoutMs?: number;
  effects?: WorkflowEffects;
  workspace?: "isolated";
  artifactPolicy?: WorkflowArtifactPolicy;
  cachePolicy?: WorkflowCachePolicy;
  inputManifest?: WorkflowInputManifestEntry[];
  mcp?: boolean;
}

export type WorkflowReference = { name: string } | { scriptPath: string };
export interface WorkflowLeafFailure {
  nodeId: string;
  agentId: string;
  phase?: string;
  attemptId?: string;
  reason: string;
  code?: string;
  kind: "provider" | "structured-output" | "deadline";
  occurredAt: number;
  details?: JsonValue;
}
export type WorkflowFailure = WorkflowLeafFailure;

export interface WorkflowBudgetSnapshot {
  total: number | null;
  spent: number;
  reserved: number;
  remaining: number | null;
}
export interface WorkflowBudgetApi {
  readonly total: number | null;
  spent(): number;
  reserved(): number;
  remaining(): number | null;
}

export interface WorkflowUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  costState: WorkflowCostState;
  contextTokens: number;
  turns: number;
  providerAttempts: number;
  providerRetries: number;
  structuredSubmissions: number;
  leafAttempts: number;
  cacheHits: number;
}

export const WORKFLOW_RUN_STATUS_VALUES = [
  "created", "running", "pausing", "paused", "stopping", "draining", "completed", "failed", "cancelled", "interrupted", "recovery_required",
] as const;
export type WorkflowRunStatus = typeof WORKFLOW_RUN_STATUS_VALUES[number];
export const WORKFLOW_TERMINAL_STATUS_VALUES = ["completed", "failed", "cancelled", "interrupted", "recovery_required"] as const;
export type WorkflowTerminalStatus = typeof WORKFLOW_TERMINAL_STATUS_VALUES[number];

export const WORKFLOW_LEAF_STATUS_VALUES = ["queued", "running", "backoff", "completed", "failed", "interrupted", "skipped", "cached"] as const;
export type WorkflowLeafStatus = typeof WORKFLOW_LEAF_STATUS_VALUES[number];

export type WorkflowTerminalIntentKind = "complete" | "fail" | "cancel" | "timeout" | "pause" | "interrupt";
export interface WorkflowTerminalIntentV1 {
  kind: WorkflowTerminalIntentKind;
  requestedAt: number;
  reason?: string;
  error?: WorkflowErrorV1;
}
export interface WorkflowErrorV1 {
  kind: "contract" | "script" | "infrastructure" | "cancellation" | "recovery";
  code: string;
  message: string;
  stack?: string;
  details?: JsonValue;
}

export interface WorkflowOwnerV1 {
  sessionId: string;
  sessionFile?: string;
  instanceId: string;
  parentPid: number;
}
export interface WorkflowSourceProvenanceV1 {
  kind: "inline" | "path" | "name";
  copiedPath: string;
  sourcePath?: string;
  qualifiedName?: string;
  sourceDirectory: string;
  sha256: string;
  resolverIdentity: string;
}
export interface WorkflowAttemptRecordV1 {
  attemptId: string;
  runId: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  error?: WorkflowErrorV1;
}
export interface WorkflowProviderAttemptV1 {
  attemptId: string;
  leafId: string;
  startedAt: number;
  settledAt?: number;
  status: "running" | "settled" | "unreconciled";
  usage?: WorkflowUsage;
  costState: WorkflowCostState;
}
export interface WorkflowLeafRecordV1 {
  leafId: string;
  nodeId: string;
  agentId: string;
  label?: string;
  phase?: string;
  status: WorkflowLeafStatus;
  acceptedAt: number;
  startedAt?: number;
  finishedAt?: number;
  deadlineAt: number;
  effects: WorkflowEffects;
  artifactPolicy?: WorkflowArtifactPolicy;
  cachePolicy: WorkflowCachePolicy;
  executionFingerprint: string;
  attempts: WorkflowProviderAttemptV1[];
  result?: JsonValue;
  failure?: WorkflowLeafFailure;
  transcriptPath?: string;
  workspaceLeaseId?: string;
  artifactIds: string[];
}
export interface WorkflowArtifactRecordV1 {
  artifactId: string;
  kind: "workspace" | "output" | "transcript";
  path: string;
  sha256: string;
  bytes: number;
  state: "pending" | "verified" | "applied" | "released" | "recovery_required";
  createdAt: number;
}
export interface WorkflowNotificationRecordV1 {
  state: "pending" | "delivered" | "failed";
  attempts: number;
  updatedAt: number;
  deliveredAt?: number;
  lastError?: string;
}
export interface WorkflowOutputDescriptorV1 {
  encoding: "tagged-json-v1";
  path: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
  preview: string;
}
export interface WorkflowCleanupOutcomeV1 {
  status: "pending" | "running" | "completed" | "failed" | "recovery_required";
  deadlineAt: number;
  finishedAt?: number;
  error?: WorkflowErrorV1;
}

export interface WorkflowRunRecordV1 {
  schemaVersion: typeof WORKFLOW_RUN_SCHEMA_VERSION;
  recordRevision: number;
  runId: string;
  rootRunId: string;
  parentRunId?: string;
  resumeFromRunId?: string;
  owner: WorkflowOwnerV1;
  source: WorkflowSourceProvenanceV1;
  metadata: WorkflowMeta;
  args: JsonValue;
  argsSha256: string;
  executionFingerprint: string;
  activationIdentity: string;
  status: WorkflowRunStatus;
  firstTerminalIntent?: WorkflowTerminalIntentV1;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  deadlineAt: number;
  cleanup: WorkflowCleanupOutcomeV1;
  attempts: WorkflowAttemptRecordV1[];
  leaves: WorkflowLeafRecordV1[];
  failures: WorkflowLeafFailure[];
  artifacts: WorkflowArtifactRecordV1[];
  output?: WorkflowOutputDescriptorV1;
  notification: WorkflowNotificationRecordV1;
  usage: WorkflowUsage;
  budget: WorkflowBudgetSnapshot;
  pinned: boolean;
  expiresAt?: number;
  journalSequence: number;
  error?: WorkflowErrorV1;
}
export type WorkflowRunAggregate = WorkflowRunRecordV1;

export type WorkflowRunEvent =
  | { type: "RunStarted"; attempt: WorkflowAttemptRecordV1 }
  | { type: "TerminalIntentAccepted"; intent: WorkflowTerminalIntentV1 }
  | { type: "RunStatusChanged"; status: WorkflowRunStatus; error?: WorkflowErrorV1 }
  | { type: "LeafAccepted"; leaf: WorkflowLeafRecordV1 }
  | { type: "LeafStatusChanged"; leafId: string; status: WorkflowLeafStatus; at: number; failure?: WorkflowLeafFailure; result?: JsonValue }
  | { type: "LeafReferencesChanged"; leafId: string; transcriptPath?: string; workspaceLeaseId?: string; artifactIds?: string[] }
  | { type: "ProviderAttemptSettled"; leafId: string; attempt: WorkflowProviderAttemptV1 }
  | { type: "UsageAdded"; usage: WorkflowUsage }
  | { type: "ArtifactRecorded"; artifact: WorkflowArtifactRecordV1 }
  | { type: "OutputRecorded"; output: WorkflowOutputDescriptorV1 }
  | { type: "CleanupChanged"; cleanup: WorkflowCleanupOutcomeV1 }
  | { type: "NotificationChanged"; notification: WorkflowNotificationRecordV1 }
  | { type: "BudgetChanged"; budget: WorkflowBudgetSnapshot }
  | { type: "JournalAdvanced"; sequence: number }
  | { type: "RetentionChanged"; pinned: boolean; expiresAt?: number };

export interface DurableWorkflowEvent {
  schemaVersion: typeof WORKFLOW_EVENT_SCHEMA_VERSION;
  runId: string;
  sequence: number;
  timestamp: number;
  event: WorkflowRunEvent;
}
export interface WorkflowTransition {
  previous: WorkflowRunRecordV1;
  next: WorkflowRunRecordV1;
  event: WorkflowRunEvent;
  changed: boolean;
}

export interface WorkflowTerminalResult {
  runId: string;
  status: WorkflowTerminalStatus;
  output?: WorkflowOutputDescriptorV1;
  usage: WorkflowUsage;
  budget: WorkflowBudgetSnapshot;
  failures: WorkflowLeafFailure[];
  artifacts: WorkflowArtifactRecordV1[];
  error?: WorkflowErrorV1;
  cleanup: WorkflowCleanupOutcomeV1;
  finishedAt: number;
}

export type AgentOptions = WorkflowAgentOptions;
export type Failure = WorkflowFailure;
export type Budget = WorkflowBudgetApi;
export type Reference = WorkflowReference;
export type RunRecord = WorkflowRunRecordV1;
export type AgentRecord = WorkflowLeafRecordV1;

export function emptyWorkflowUsage(): WorkflowUsage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, costState: "unavailable", contextTokens: 0, turns: 0,
    providerAttempts: 0, providerRetries: 0, structuredSubmissions: 0, leafAttempts: 0, cacheHits: 0,
  };
}

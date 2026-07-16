import {
  GOAL_BOUNDS,
  GOAL_CHECKPOINT_TOOL,
  GOAL_CONTROL_MESSAGE,
  type GoalArtifactRef,
  type GoalCheckpointV2,
  type GoalCriterion,
  type GoalDispatchIntent,
  type GoalEvidence,
  type GoalLifecycle,
  type GoalRunRef,
} from "./state.ts";

/** Metadata persisted on a goal-owned custom message. */
export interface GoalControlDetails {
  goalId: string;
  epoch: number;
  runId: string;
  revision: number;
  dispatchId: string;
}

/** The deliberately small portion of a Pi custom-message entry used here. */
export interface GoalControlEntry {
  type: "custom_message";
  id: string;
  parentId?: string | null;
  customType: typeof GOAL_CONTROL_MESSAGE;
  details: GoalControlDetails;
  content?: unknown;
  display?: boolean;
}

export interface LocatedBranchEntry<T = Record<string, unknown>> {
  entry: T;
  index: number;
}

export interface LocatedGoalRun {
  control: LocatedBranchEntry<GoalControlEntry>;
  /** Last assistant message in this run's branch interval. */
  assistant?: LocatedBranchEntry<Record<string, unknown>>;
  /** Last entry before another goal control, or the active branch leaf. */
  leaf: LocatedBranchEntry<Record<string, unknown>>;
}

export type GoalControlCorrelation = GoalControlDetails | GoalDispatchIntent | GoalRunRef | GoalCheckpointV2;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= GOAL_BOUNDS.id;
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= GOAL_BOUNDS.counter;
}

function entryRecord(value: unknown): Record<string, unknown> | undefined {
  return record(value) ? value : undefined;
}

function messageOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  return entry.type === "message" && record(entry.message) ? entry.message : undefined;
}

function correlationDetails(value: GoalControlCorrelation): GoalControlDetails | undefined {
  if ("scheduler" in value) {
    const lease = value.scheduler.activeRun ?? value.scheduler.dispatch;
    return lease ? correlationDetails(lease) : undefined;
  }
  return {
    goalId: value.goalId,
    epoch: value.epoch,
    runId: value.runId,
    revision: value.revision,
    dispatchId: value.dispatchId,
  };
}

export function parseGoalControlDetails(value: unknown): GoalControlDetails | undefined {
  if (!record(value)) return undefined;
  const allowed = new Set(["goalId", "epoch", "runId", "revision", "dispatchId"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (!boundedId(value.goalId) || !counter(value.epoch) || value.epoch === 0
    || !boundedId(value.runId) || !counter(value.revision) || !boundedId(value.dispatchId)) return undefined;
  return {
    goalId: value.goalId,
    epoch: value.epoch,
    runId: value.runId,
    revision: value.revision,
    dispatchId: value.dispatchId,
  };
}

/** Recognize only persisted Pi custom-message entries, never ordinary/model text. */
export function parseGoalControlEntry(value: unknown): GoalControlEntry | undefined {
  if (!record(value) || value.type !== "custom_message" || value.customType !== GOAL_CONTROL_MESSAGE
    || !boundedId(value.id)) return undefined;
  const details = parseGoalControlDetails(value.details);
  if (!details) return undefined;
  if (value.display !== undefined && value.display !== false) return undefined;
  if (value.parentId !== undefined && value.parentId !== null && !boundedId(value.parentId)) return undefined;
  return value as unknown as GoalControlEntry;
}

export function goalControlMatches(
  entry: unknown,
  expected: GoalControlCorrelation,
): entry is GoalControlEntry {
  const parsed = parseGoalControlEntry(entry);
  if (!parsed) return false;
  const wanted = correlationDetails(expected);
  if (!wanted) return false;
  return parsed.details.goalId === wanted.goalId
    && parsed.details.epoch === wanted.epoch
    && parsed.details.runId === wanted.runId
    && parsed.details.revision === wanted.revision
    && parsed.details.dispatchId === wanted.dispatchId;
}


/** Find an exact correlated control only on the supplied active branch. */
export function locateGoalControlEntry(
  branch: readonly unknown[],
  expected: GoalControlCorrelation,
): LocatedBranchEntry<GoalControlEntry> | undefined {
  let found: LocatedBranchEntry<GoalControlEntry> | undefined;
  for (let index = 0; index < branch.length; index++) {
    if (!goalControlMatches(branch[index], expected)) continue;
    // Duplicate correlations are ambiguous and therefore fail closed.
    if (found) return undefined;
    found = { entry: parseGoalControlEntry(branch[index])!, index };
  }
  return found;
}

function isAssistantEntry(value: unknown): value is Record<string, unknown> {
  const entry = entryRecord(value);
  const message = entry && messageOf(entry);
  return !!message && message.role === "assistant" && Array.isArray(message.content);
}

function runIntervalEnd(branch: readonly unknown[], controlIndex: number): number {
  for (let index = controlIndex + 1; index < branch.length; index++) {
    if (parseGoalControlEntry(branch[index])) return index - 1;
  }
  return branch.length - 1;
}

type ControlLocator = number | LocatedBranchEntry<GoalControlEntry> | GoalControlCorrelation;

function resolveControlIndex(branch: readonly unknown[], control: ControlLocator): number | undefined {
  if (typeof control === "number") return control;
  if ("entry" in control && typeof control.index === "number") return control.index;
  return locateGoalControlEntry(branch, control as GoalControlCorrelation)?.index;
}

export function locateDescendantAssistantEntry(
  branch: readonly unknown[],
  control: ControlLocator,
): LocatedBranchEntry<Record<string, unknown>> | undefined {
  const controlIndex = resolveControlIndex(branch, control);
  if (controlIndex === undefined || !Number.isSafeInteger(controlIndex) || controlIndex < 0 || controlIndex >= branch.length
    || !parseGoalControlEntry(branch[controlIndex])) return undefined;
  const end = runIntervalEnd(branch, controlIndex);
  for (let index = end; index > controlIndex; index--) {
    if (isAssistantEntry(branch[index])) return { entry: branch[index] as Record<string, unknown>, index };
  }
  return undefined;
}

export function locateDescendantLeafEntry(
  branch: readonly unknown[],
  control: ControlLocator,
): LocatedBranchEntry<Record<string, unknown>> | undefined {
  const controlIndex = resolveControlIndex(branch, control);
  if (controlIndex === undefined || !Number.isSafeInteger(controlIndex) || controlIndex < 0 || controlIndex >= branch.length
    || !parseGoalControlEntry(branch[controlIndex])) return undefined;
  const index = runIntervalEnd(branch, controlIndex);
  const entry = entryRecord(branch[index]);
  return entry ? { entry, index } : undefined;
}

export function locateGoalRunEntries(
  branch: readonly unknown[],
  expected: GoalControlCorrelation,
): LocatedGoalRun | undefined {
  const control = locateGoalControlEntry(branch, expected);
  if (!control) return undefined;
  const leaf = locateDescendantLeafEntry(branch, control);
  if (!leaf) return undefined;
  const assistant = locateDescendantAssistantEntry(branch, control);
  return { control, ...(assistant ? { assistant } : {}), leaf };
}


const EXECUTABLE_LIFECYCLES: ReadonlySet<GoalLifecycle> = new Set([
  "planning", "running", "verifying_phase", "verifying_goal", "recovering",
]);

export type DispatchIneligibilityReason =
  | "lifecycle"
  | "scheduler_lease"
  | "runtime_busy"
  | "pending_messages"
  | "epoch_budget"
  | "elapsed_budget"
  | "time_unknown"
  | "external_wait"
  | "compaction";

export interface DispatchEnvironment {
  /** Runtime idleness must be sampled by the adapter before calling this helper. */
  idle?: boolean;
  isIdle?: boolean;
  pendingMessages?: boolean;
  hasPendingMessages?: boolean;
  externalWait?: boolean;
  hasExternalWait?: boolean;
  outstandingExternalWork?: boolean;
  /** Required only when maxElapsedMs is configured. */
  now?: number;
}

export type DispatchEligibility =
  | { eligible: true }
  | { eligible: false; reason: DispatchIneligibilityReason };

/** Pure, fail-closed autonomous-dispatch gate. */
export function evaluateDispatchEligibility(
  checkpoint: GoalCheckpointV2,
  environment: DispatchEnvironment,
): DispatchEligibility {
  if (checkpoint.lifecycle === "waiting_external" || environment.externalWait === true
    || environment.hasExternalWait === true || environment.outstandingExternalWork === true) {
    return { eligible: false, reason: "external_wait" };
  }
  if (!EXECUTABLE_LIFECYCLES.has(checkpoint.lifecycle)) return { eligible: false, reason: "lifecycle" };
  if (checkpoint.compaction.state !== "idle" || checkpoint.scheduler.state === "compaction_pending") {
    return { eligible: false, reason: "compaction" };
  }
  if (checkpoint.scheduler.state !== "idle" || checkpoint.scheduler.dispatch !== undefined
    || checkpoint.scheduler.activeRun !== undefined) return { eligible: false, reason: "scheduler_lease" };

  const idle = environment.idle ?? environment.isIdle;
  if (idle !== true) return { eligible: false, reason: "runtime_busy" };
  const pending = environment.pendingMessages ?? environment.hasPendingMessages;
  // Unknown queue state is unsafe, just like a non-idle runtime.
  if (pending !== false) return { eligible: false, reason: "pending_messages" };
  if (checkpoint.budgets.epochRuns >= checkpoint.budgets.maxEpochRuns) {
    return { eligible: false, reason: "epoch_budget" };
  }
  if (checkpoint.budgets.maxElapsedMs !== undefined) {
    if (environment.now === undefined || !Number.isSafeInteger(environment.now) || environment.now < 0) {
      return { eligible: false, reason: "time_unknown" };
    }
    if (environment.now - checkpoint.budgets.startedAt >= checkpoint.budgets.maxElapsedMs) {
      return { eligible: false, reason: "elapsed_budget" };
    }
  }
  return { eligible: true };
}

export const DEFAULT_COMPACTION_SOFT_WATERMARK = 0.68;
export const DEFAULT_COMPACTION_MIN_HEADROOM = 16_000;
export const DEFAULT_PHASE_FINISHED_WATERMARK = 0.5;

export interface ContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent?: number | null;
}

export interface ProactiveCompactionOptions {
  /** Values in [0,1] are ratios; values in (1,100] are percentages. */
  softWatermark?: number;
  minHeadroomTokens?: number;
  phaseFinished?: boolean;
  phaseFinishedWatermark?: number;
  /** If supplied, leases and an already pending compaction suppress a trigger. */
  checkpoint?: GoalCheckpointV2;
}

export type ProactiveCompactionReason = "soft_watermark" | "minimum_headroom" | "phase_finished";

export type ProactiveCompactionDecision =
  | { compact: false; ratio?: number; headroom?: number }
  | { compact: true; reason: ProactiveCompactionReason; ratio: number; headroom: number };

function ratioThreshold(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return Number.NaN;
  return value > 1 ? value / 100 : value;
}

/**
 * Decide from a settled usage snapshot. In particular, `tokens: null` is
 * unknown after compaction and can never trigger another compaction.
 */
export function evaluateProactiveCompaction(
  usage: ContextUsageSnapshot | undefined,
  options: ProactiveCompactionOptions = {},
): ProactiveCompactionDecision {
  if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens) || usage.tokens < 0
    || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return { compact: false };
  const checkpoint = options.checkpoint;
  if (checkpoint && (checkpoint.scheduler.state !== "idle" || checkpoint.scheduler.dispatch !== undefined
    || checkpoint.scheduler.activeRun !== undefined || checkpoint.compaction.state !== "idle")) {
    return { compact: false };
  }

  const ratio = usage.tokens / usage.contextWindow;
  const headroom = Math.max(0, usage.contextWindow - usage.tokens);
  const soft = ratioThreshold(options.softWatermark, DEFAULT_COMPACTION_SOFT_WATERMARK);
  const moderate = ratioThreshold(options.phaseFinishedWatermark, DEFAULT_PHASE_FINISHED_WATERMARK);
  const minimum = options.minHeadroomTokens ?? DEFAULT_COMPACTION_MIN_HEADROOM;
  if (Number.isFinite(soft) && soft >= 0 && soft <= 1 && ratio >= soft) {
    return { compact: true, reason: "soft_watermark", ratio, headroom };
  }
  if (Number.isFinite(minimum) && minimum >= 0 && headroom <= minimum) {
    return { compact: true, reason: "minimum_headroom", ratio, headroom };
  }
  if (options.phaseFinished === true && Number.isFinite(moderate) && moderate >= 0 && moderate <= 1
    && ratio >= moderate) return { compact: true, reason: "phase_finished", ratio, headroom };
  return { compact: false, ratio, headroom };
}

export interface ObservedGoalArtifact extends GoalArtifactRef {
  /** Callers that checked the object on disk may make that explicit. */
  verified?: boolean;
}

export interface EvidenceReconciliationOptions {
  /** Observations made outside the model-authored checkpoint. */
  artifacts?: readonly ObservedGoalArtifact[];
  goalId?: string;
  /** Session entries accepted by explicit user action, not by model assertion. */
  explicitUserAcceptanceEntryIds?: readonly string[];
  explicitlyAcceptedCriterionIds?: readonly string[];
  /** Optional domain-specific verifier for stronger semantic checks. */
  validate?: (evidence: GoalEvidence, source: EvidenceSource) => boolean;
}

export interface EvidenceSource {
  kind: "entry" | "tool_result" | "artifact" | "user_acceptance";
  entry?: Record<string, unknown>;
  entryId?: string;
  artifact?: ObservedGoalArtifact;
  toolName?: string;
  invocation?: Record<string, unknown>;
}

export type EvidenceRejectionReason =
  | "duplicate_id"
  | "uncorrelated_run"
  | "source_missing"
  | "tool_failed"
  | "checkpoint_is_not_evidence"
  | "artifact_unverified"
  | "validator_rejected";

export interface VerifiedGoalEvidence {
  evidence: GoalEvidence;
  source: EvidenceSource;
}

export interface RejectedGoalEvidence {
  evidence: GoalEvidence;
  reason: EvidenceRejectionReason;
}

export interface GoalEvidenceReconciliation {
  verified: readonly VerifiedGoalEvidence[];
  rejected: readonly RejectedGoalEvidence[];
  /** Readable aliases for adapters that avoid the shorter property names. */
  verifiedEvidence: readonly VerifiedGoalEvidence[];
  rejectedEvidence: readonly RejectedGoalEvidence[];
  verifiedEvidenceIds: ReadonlySet<string>;
  explicitlyAcceptedCriterionIds: ReadonlySet<string>;
}

interface ToolObservation {
  entry: Record<string, unknown>;
  index: number;
  message: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  invocation?: Record<string, unknown>;
}

function toolResultOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const message = messageOf(entry);
  if (message?.role === "toolResult") return message;
  // Convenient for pure fixtures while retaining the same semantics.
  if (entry.role === "toolResult") return entry;
  return undefined;
}

function exitCodeIn(value: unknown, depth = 0): number | undefined {
  if (!record(value) || depth > 3) return undefined;
  for (const key of ["exitCode", "exit_code", "code"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key];
  }
  for (const key of ["details", "result", "meta", "metadata"] as const) {
    const found = exitCodeIn(value[key], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function successfulToolResult(message: Record<string, unknown>): boolean {
  if (message.isError === true) return false;
  const exitCode = exitCodeIn(message);
  // Pi's stock bash tool throws on a non-zero exit and therefore persists
  // successful results without an exitCode. Custom bash tools may include one,
  // in which case an explicit non-zero value still fails closed.
  return exitCode === undefined || exitCode === 0;
}

function commandFromInvocation(invocation: Record<string, unknown> | undefined): string | undefined {
  return valueStrings(invocation).find((value) => value.trim().length > 0);
}

function observationSupportsEvidence(evidence: GoalEvidence, observation: ToolObservation): boolean {
  if (!successfulToolResult(observation.message)) return false;
  const toolName = observation.toolName;
  if (evidence.kind === "file") return toolName === "read" || toolName === "write" || toolName === "edit";
  if (evidence.kind === "command" || evidence.kind === "test" || evidence.kind === "git") {
    if (toolName !== "bash") return false;
    const command = commandFromInvocation(observation.invocation)?.trim() ?? "";
    if (!command) return false;
    if (evidence.kind === "git") return /^(?:git\s|[^\n]*\bgit\s)/i.test(command);
    // "test" is a semantic label supplied by the verifier. Trying to infer it
    // from executable names rejected valid commands such as `python -m
    // unittest` and project-specific verification scripts. Correlation to the
    // exact successful bash observation is the provenance boundary.
    return true;
  }
  return false;
}

function invocationById(branch: readonly unknown[], before: number, toolCallId: string): Record<string, unknown> | undefined {
  for (let index = before - 1; index >= 0; index--) {
    const entry = entryRecord(branch[index]);
    const message = entry && messageOf(entry);
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!record(part)) continue;
      const id = part.id ?? part.toolCallId ?? part.tool_call_id;
      if (id === toolCallId) return part;
    }
  }
  return undefined;
}

function toolObservation(entry: Record<string, unknown>, index: number, branch: readonly unknown[]): ToolObservation | undefined {
  const message = toolResultOf(entry);
  if (!message) return undefined;
  const rawCallId = message.toolCallId ?? message.tool_call_id;
  const toolCallId = boundedId(rawCallId) ? rawCallId : undefined;
  const rawName = message.toolName ?? message.name;
  const toolName = typeof rawName === "string" ? rawName : undefined;
  return {
    entry,
    index,
    message,
    ...(toolCallId ? { toolCallId, invocation: invocationById(branch, index, toolCallId) } : {}),
    ...(toolName ? { toolName } : {}),
  };
}

function locatorTokens(locator: string): string[] {
  const values = new Set([locator]);
  const match = /^(?:entry|session|tool|tool-result|tool_call|artifact|file|command|test|git):(?:\/\/)?(.+)$/i.exec(locator);
  if (match?.[1]) values.add(match[1]);
  return [...values];
}

function valueStrings(value: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof value === "string") return [value];
  if (!record(value)) return [];
  const result: string[] = [];
  for (const key of ["command", "cmd", "path", "file", "filePath", "cwd"] as const) {
    if (typeof value[key] === "string") result.push(value[key]);
  }
  for (const key of ["arguments", "args", "input", "parameters"] as const) {
    result.push(...valueStrings(value[key], depth + 1));
  }
  return result;
}

function observationMatches(observation: ToolObservation, tokens: readonly string[]): boolean {
  const entryId = typeof observation.entry.id === "string" ? observation.entry.id : undefined;
  const candidates = [entryId, observation.toolCallId, ...valueStrings(observation.invocation)].filter(
    (item): item is string => item !== undefined,
  );
  return tokens.some((token) => candidates.includes(token));
}

function controlForEvidenceRun(
  branch: readonly unknown[],
  runId: string,
  goalId?: string,
): LocatedBranchEntry<GoalControlEntry> | undefined {
  let found: LocatedBranchEntry<GoalControlEntry> | undefined;
  for (let index = 0; index < branch.length; index++) {
    const control = parseGoalControlEntry(branch[index]);
    if (!control || control.details.runId !== runId || (goalId !== undefined && control.details.goalId !== goalId)) continue;
    if (found) return undefined;
    found = { entry: control, index };
  }
  return found;
}

function findEntrySource(
  evidence: GoalEvidence,
  branch: readonly unknown[],
  control: LocatedBranchEntry<GoalControlEntry>,
  acceptedEntryIds: ReadonlySet<string>,
): { source?: EvidenceSource; rejection?: EvidenceRejectionReason } {
  const end = runIntervalEnd(branch, control.index);
  const tokens = locatorTokens(evidence.locator);
  for (let index = control.index + 1; index <= end; index++) {
    const entry = entryRecord(branch[index]);
    if (!entry) continue;
    const observation = toolObservation(entry, index, branch);
    if (observation && observationMatches(observation, tokens)) {
      if (observation.toolName === GOAL_CHECKPOINT_TOOL) return { rejection: "checkpoint_is_not_evidence" };
      if (!observationSupportsEvidence(evidence, observation)) return { rejection: "tool_failed" };
      return {
        source: {
          kind: "tool_result",
          entry,
          ...(typeof entry.id === "string" ? { entryId: entry.id } : {}),
          ...(observation.toolName ? { toolName: observation.toolName } : {}),
          ...(observation.invocation ? { invocation: observation.invocation } : {}),
        },
      };
    }
    if (typeof entry.id === "string" && tokens.includes(entry.id)) {
      const message = messageOf(entry);
      if (acceptedEntryIds.has(entry.id) && message?.role === "user") {
        return { source: { kind: "user_acceptance", entry, entryId: entry.id } };
      }
    }
  }
  return {};
}

function findArtifactSource(
  evidence: GoalEvidence,
  artifacts: readonly ObservedGoalArtifact[],
): EvidenceSource | undefined {
  const tokens = locatorTokens(evidence.locator);
  const artifact = artifacts.find((candidate) =>
    (tokens.includes(candidate.id) || tokens.includes(candidate.path))
    && candidate.runId === evidence.runId
    && candidate.digest.length > 0
    && (evidence.digest === undefined || evidence.digest === candidate.digest)
    && candidate.verified === true);
  return artifact ? { kind: "artifact", artifact } : undefined;
}

/**
 * Reconcile model-proposed evidence with immutable observations. Criterion
 * statuses and prose descriptions are intentionally never consulted.
 */
export function reconcileSuccessfulEvidence(
  checkpointOrEvidence: GoalCheckpointV2 | readonly GoalEvidence[],
  branch: readonly unknown[],
  optionsOrArtifacts: EvidenceReconciliationOptions | readonly ObservedGoalArtifact[] = {},
): GoalEvidenceReconciliation {
  const options: EvidenceReconciliationOptions = Array.isArray(optionsOrArtifacts)
    ? { artifacts: optionsOrArtifacts }
    : optionsOrArtifacts as EvidenceReconciliationOptions;
  const checkpoint = Array.isArray(checkpointOrEvidence) ? undefined : checkpointOrEvidence as GoalCheckpointV2;
  const evidenceItems: readonly GoalEvidence[] = Array.isArray(checkpointOrEvidence)
    ? checkpointOrEvidence as readonly GoalEvidence[]
    : (checkpointOrEvidence as GoalCheckpointV2).evidence;
  // Model-authored artifact references are proposals, not observations. Only
  // adapter-supplied objects explicitly marked verified can support evidence.
  const artifacts = options.artifacts ?? [];
  const goalId = options.goalId ?? checkpoint?.goalId;
  const acceptedEntries = new Set(options.explicitUserAcceptanceEntryIds ?? []);
  const explicitCriteria = new Set(options.explicitlyAcceptedCriterionIds ?? []);
  const counts = new Map<string, number>();
  for (const evidence of evidenceItems) counts.set(evidence.id, (counts.get(evidence.id) ?? 0) + 1);

  const verified: VerifiedGoalEvidence[] = [];
  const rejected: RejectedGoalEvidence[] = [];
  for (const evidence of evidenceItems) {
    if ((counts.get(evidence.id) ?? 0) > 1) {
      rejected.push({ evidence, reason: "duplicate_id" });
      continue;
    }
    const control = controlForEvidenceRun(branch, evidence.runId, goalId);
    if (!control) {
      rejected.push({ evidence, reason: "uncorrelated_run" });
      continue;
    }

    let source: EvidenceSource | undefined;
    let rejection: EvidenceRejectionReason | undefined;
    if (evidence.kind === "artifact") source = findArtifactSource(evidence, artifacts);
    else {
      const entryResult = findEntrySource(evidence, branch, control, acceptedEntries);
      source = entryResult.source;
      rejection = entryResult.rejection;
      if (!source && !rejection && evidence.kind === "file") source = findArtifactSource(evidence, artifacts);
    }
    if (!source) {
      rejected.push({ evidence, reason: rejection ?? (evidence.kind === "artifact" ? "artifact_unverified" : "source_missing") });
      continue;
    }
    if (options.validate && !options.validate(evidence, source)) {
      rejected.push({ evidence, reason: "validator_rejected" });
      continue;
    }
    verified.push({ evidence, source });
  }
  return {
    verified,
    rejected,
    verifiedEvidence: verified,
    rejectedEvidence: rejected,
    verifiedEvidenceIds: new Set(verified.map(({ evidence }) => evidence.id)),
    explicitlyAcceptedCriterionIds: explicitCriteria,
  };
}


export interface CriteriaVerificationOptions {
  allowEmpty?: boolean;
  explicitlyAcceptedCriterionIds?: readonly string[];
}

function criteriaSatisfied(
  criteria: readonly GoalCriterion[],
  reconciliation: GoalEvidenceReconciliation,
  options: CriteriaVerificationOptions,
): boolean {
  if (criteria.length === 0) return options.allowEmpty === true;
  const ids = new Set<string>();
  const explicit = new Set([
    ...reconciliation.explicitlyAcceptedCriterionIds,
    ...(options.explicitlyAcceptedCriterionIds ?? []),
  ]);
  for (const criterion of criteria) {
    if (ids.has(criterion.id)) return false;
    ids.add(criterion.id);
    if (explicit.has(criterion.id)) continue;
    const declared = new Set(criterion.evidenceIds ?? []);
    const supported = reconciliation.verified.some(({ evidence }) =>
      (evidence.criterionId === criterion.id || declared.has(evidence.id))
      && reconciliation.verifiedEvidenceIds.has(evidence.id));
    if (!supported) return false;
  }
  return true;
}

const REJECTION_EXPLANATIONS: Record<EvidenceRejectionReason, string> = {
  duplicate_id: "the evidence ID is duplicated",
  uncorrelated_run: "the evidence run is not correlated to exactly one goal-control run",
  source_missing: "no matching tool result was found in the correlated run; use the exact command, path, tool-call ID, or result-entry ID",
  tool_failed: "the matched tool result failed or its tool type is incompatible with the evidence kind",
  checkpoint_is_not_evidence: "a goal checkpoint cannot prove its own claim",
  artifact_unverified: "no adapter-verified artifact with the matching run and digest exists",
  validator_rejected: "the adapter's semantic validator rejected the observation",
};

/**
 * Produce bounded, criterion-specific feedback for the next goal run. This is
 * deliberately derived from adapter reconciliation rather than model prose.
 */
export function explainCriteriaVerificationFailure(
  criteria: readonly GoalCriterion[],
  reconciliation: GoalEvidenceReconciliation,
  maxLength = GOAL_BOUNDS.text,
): string {
  const lines = ["Phase verification rejected the following evidence:"];
  for (const criterion of criteria) {
    const declared = new Set(criterion.evidenceIds ?? []);
    const supports = ({ evidence }: { evidence: GoalEvidence }) =>
      evidence.criterionId === criterion.id || declared.has(evidence.id);
    if (reconciliation.verified.some(supports)) continue;
    const rejected = reconciliation.rejected.filter(supports);
    if (rejected.length === 0) {
      lines.push(`- ${criterion.id}: no correlated evidence was supplied.`);
      continue;
    }
    for (const { evidence, reason } of rejected.slice(-3)) {
      const locator = evidence.locator.length > 240 ? `${evidence.locator.slice(0, 239)}…` : evidence.locator;
      lines.push(`- ${criterion.id} / ${evidence.id}: ${REJECTION_EXPLANATIONS[reason]}; submitted locator=${JSON.stringify(locator)}.`);
    }
  }
  lines.push("Re-run only the missing observation and submit its exact invocation as the locator; do not repeat evidence that already verified.");
  const text = lines.join("\n");
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Criterion status (`satisfied`/`waived`) is not proof; only reconciled evidence is. */
export function areCriteriaVerifiablySatisfied(
  criteria: readonly GoalCriterion[],
  reconciliation: GoalEvidenceReconciliation,
  options: CriteriaVerificationOptions = {},
): boolean {
  return criteriaSatisfied(criteria, reconciliation, options);
}

/** Verify acceptance criteria and every non-skipped phase criterion. */
export function areAllCriteriaVerifiablySatisfied(
  checkpointOrCriteria: GoalCheckpointV2 | readonly GoalCriterion[],
  reconciliation: GoalEvidenceReconciliation,
  options: CriteriaVerificationOptions = {},
): boolean {
  const criteria: readonly GoalCriterion[] = Array.isArray(checkpointOrCriteria)
    ? checkpointOrCriteria
    : [
        ...(checkpointOrCriteria as GoalCheckpointV2).acceptanceCriteria,
        ...(checkpointOrCriteria as GoalCheckpointV2).phases
          .filter((phase) => phase.status !== "skipped")
          .flatMap((phase) => phase.criteria),
      ];
  return criteriaSatisfied(criteria, reconciliation, options);
}

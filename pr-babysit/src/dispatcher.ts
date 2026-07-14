import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { addEscalation, type EscalationRequest } from "./escalation.ts";
import { notifyEscalation } from "./notify.ts";
import { type AppPaths, appPaths, prPaths } from "./paths.ts";
import {
  requiredReplyTargets,
  type ReplyReceipt,
  type ReplyVerificationClient,
  verifyRequiredReplies,
} from "./replies.ts";
import { executeAgentRun, type AgentRunResult, type RunnerOptions } from "./runner.ts";
import { type Escalation, type EventRecord, type LastRun, type PrState, savePrState } from "./state.ts";

export interface DispatchResult {
  runId: string;
  outcome: Exclude<LastRun["outcome"], null>;
  eventIds: string[];
  artifactDir: string | null;
  escalation: Escalation | null;
  notificationError: string | null;
  error: string | null;
}

export interface DispatchOptions extends RunnerOptions {
  notify?: typeof notifyEscalation;
}

function removeEvents(state: PrState, ids: ReadonlySet<string>): void {
  state.pendingEvents = state.pendingEvents.filter((event) => !ids.has(event.id));
}

function incrementAttempts(state: PrState, ids: ReadonlySet<string>): EventRecord[] {
  const retried: EventRecord[] = [];
  for (const event of state.pendingEvents) {
    if (!ids.has(event.id)) continue;
    event.runAttempts += 1;
    retried.push(event);
  }
  return retried;
}

async function notifyAfterSave(
  state: PrState,
  escalation: Escalation | null,
  notify: typeof notifyEscalation,
): Promise<string | null> {
  if (!escalation) return null;
  try {
    await notify(`PR babysitter: ${state.key}`, escalation.reason);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export async function dispatchPendingEvents(
  state: PrState,
  config: Config,
  options: DispatchOptions = {},
): Promise<DispatchResult | null> {
  if (state.pendingEvents.length === 0) return null;
  const app: AppPaths = options.app ?? appPaths();
  const events = structuredClone(state.pendingEvents);
  const ids = new Set(events.map((event) => event.id));
  const runId = options.runId ?? randomUUID();
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  state.status = "running";
  state.lastError = null;
  state.lastRun = { runId, eventIds: [...ids], startedAt, finishedAt: null, outcome: null };
  await savePrState(state, app);

  let agentResult: AgentRunResult | null = null;
  let outcome: DispatchResult["outcome"] = "error";
  let errorMessage: string | null = null;
  let escalationRequest: EscalationRequest | null = null;
  try {
    agentResult = await executeAgentRun(state, events, config, { ...options, app, runId });
    outcome = agentResult.outcome;
    escalationRequest = agentResult.escalation;
  } catch (error) {
    errorMessage = (error as Error).message;
    outcome = "error";
  }

  let escalation: Escalation | null = null;
  if (outcome === "success") {
    removeEvents(state, ids);
  } else if (outcome === "dry_run") {
    // A dry run only materializes prompt/artifact diagnostics. It performs no
    // remote side effects, so queued work must remain pending for a real run.
  } else if (outcome === "escalated") {
    escalation = addEscalation(
      state,
      escalationRequest ?? { reason: "Agent escalation", details: "The agent escalated without details." },
      runId,
    );
    removeEvents(state, ids);
  } else {
    const retried = incrementAttempts(state, ids);
    const exhaustedIds = new Set(retried.filter((event) => event.runAttempts >= 2).map((event) => event.id));
    if (exhaustedIds.size > 0) {
      const reason = outcome === "timeout" ? "Agent timed out twice" : "Agent run failed twice";
      const details = errorMessage ?? `Run ${runId} ended with ${outcome} for: ${[...exhaustedIds].join(", ")}.`;
      escalation = addEscalation(state, { reason, details }, runId);
      removeEvents(state, exhaustedIds);
      outcome = "escalated";
    }
  }

  const finishedAt = (options.now ?? (() => new Date()))().toISOString();
  state.lastRun = { runId, eventIds: [...ids], startedAt, finishedAt, outcome };
  state.status = "watching";
  state.lastError = errorMessage;
  await savePrState(state, app);
  const notificationError = await notifyAfterSave(state, escalation, options.notify ?? notifyEscalation);

  return {
    runId,
    outcome,
    eventIds: [...ids],
    artifactDir: agentResult?.artifactDir ?? null,
    escalation,
    notificationError,
    error: errorMessage,
  };
}

interface RecoverableMeta {
  outcome: "success" | "dry_run" | "escalated";
  finishedAt: string;
  escalation: EscalationRequest | null;
  replyReceipts: ReplyReceipt[];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((id) => right.includes(id));
}

async function recoverableMeta(state: PrState, app: AppPaths, events: readonly EventRecord[]): Promise<RecoverableMeta | null> {
  const run = state.lastRun;
  if (!run || !/^[a-f\d-]{36}$/i.test(run.runId)) return null;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(prPaths(state.key, app).runsDir, run.runId, "meta.json"), "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 2 || item.runId !== run.runId || item.key !== state.key || !Array.isArray(item.eventIds)) return null;
  const eventIds = item.eventIds.filter((entry): entry is string => typeof entry === "string");
  if (eventIds.length !== item.eventIds.length || !sameIds(eventIds, run.eventIds)) return null;
  const outcome = item.outcome;
  if (item.dryRun === true && outcome === null) {
    return {
      outcome: "dry_run",
      finishedAt: new Date().toISOString(),
      escalation: null,
      replyReceipts: [],
    };
  }
  if (outcome !== "success" && outcome !== "dry_run" && outcome !== "escalated") return null;
  if (typeof item.finishedAt !== "string" || Number.isNaN(Date.parse(item.finishedAt))) return null;

  const receipts = Array.isArray(item.replyReceipts)
    ? item.replyReceipts.filter((entry): entry is ReplyReceipt => {
      if (typeof entry !== "object" || entry === null) return false;
      const receipt = entry as Partial<ReplyReceipt>;
      return typeof receipt.eventId === "string" && Number.isSafeInteger(receipt.replyId) &&
        (receipt.kind === "issue_comment" || receipt.kind === "review_comment" || receipt.kind === "review");
    })
    : [];
  if (outcome === "success") {
    const targets = requiredReplyTargets(state.key, events);
    if (targets.some((target) => !receipts.some((receipt) => receipt.eventId === target.eventId))) return null;
  }

  let escalation: EscalationRequest | null = null;
  if (outcome === "escalated") {
    if (typeof item.escalation !== "object" || item.escalation === null) return null;
    const request = item.escalation as Record<string, unknown>;
    if (typeof request.reason !== "string" || typeof request.details !== "string") return null;
    escalation = { reason: request.reason, details: request.details, source: "file" };
  }
  return { outcome, finishedAt: item.finishedAt, escalation, replyReceipts: receipts };
}

export async function recoverInterruptedRun(
  state: PrState,
  app: AppPaths = appPaths(),
  client?: ReplyVerificationClient,
): Promise<boolean> {
  if (state.status !== "running") return false;
  const run = state.lastRun;
  const events = run ? state.pendingEvents.filter((event) => run.eventIds.includes(event.id)) : [];
  const completeBatch = run !== null && events.length === run.eventIds.length;
  let recovered = completeBatch ? await recoverableMeta(state, app, events) : null;

  // If the process died after replies were posted but before final metadata was
  // committed, the unique run marker is a remote idempotency receipt.
  if (!recovered && completeBatch && client && requiredReplyTargets(state.key, events).length > 0) {
    try {
      const replyReceipts = await verifyRequiredReplies(client, state.key, events, run.runId);
      recovered = {
        outcome: "success",
        finishedAt: new Date().toISOString(),
        escalation: null,
        replyReceipts,
      };
    } catch {
      // No complete remote receipt: retain the batch for its bounded retry.
    }
  }

  state.status = "watching";
  if (recovered && run) {
    if (recovered.outcome !== "dry_run") removeEvents(state, new Set(run.eventIds));
    if (recovered.escalation) addEscalation(state, recovered.escalation, run.runId);
    run.finishedAt = recovered.finishedAt;
    run.outcome = recovered.outcome;
    state.lastError = `Recovered completed ${recovered.outcome} run ${run.runId} without re-executing events`;
  } else {
    state.lastError = "Recovered an interrupted agent run; pending events were retained";
    if (run && run.finishedAt === null) {
      run.finishedAt = new Date().toISOString();
      run.outcome = "error";
    }
  }
  await savePrState(state, app);
  return true;
}

import { randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";

import { type AppPaths, appPaths } from "./paths.ts";
import { escalationFilePath } from "./prompt.ts";
import { type Escalation, type PrState, listPrStates, mutatePrState } from "./state.ts";

export interface EscalationRequest {
  reason: string;
  details: string;
  source: "file" | "sentinel";
}

function clean(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (text === "" || text.length > maximum) throw new Error(`${field} must contain 1 to ${maximum} characters`);
  return text;
}

export function parseEscalationSentinel(text: string): EscalationRequest | null {
  const matches = [...text.matchAll(/\[\[BABYSIT_ESCALATE:\s*([^\]\r\n]{1,500})\]\]/gi)];
  const last = matches.at(-1)?.[1];
  return last === undefined ? null : { reason: clean(last, "escalation reason", 500), details: "Agent requested escalation in its final response.", source: "sentinel" };
}

export async function consumeEscalationFile(controlDirectory: string): Promise<EscalationRequest | null> {
  const directoryInfo = await lstat(controlDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`Invalid escalation control directory: ${controlDirectory}`);
  }
  const path = escalationFilePath(controlDirectory);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
    throw new Error(`Invalid escalation file: ${path}`);
  }
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Escalation file must be an object");
  const request = value as Record<string, unknown>;
  const result: EscalationRequest = {
    reason: clean(request.reason, "escalation.reason", 500),
    details: clean(request.details, "escalation.details", 4_000),
    source: "file",
  };
  await rm(path);
  return result;
}

export function addEscalation(
  state: PrState,
  request: Pick<EscalationRequest, "reason" | "details">,
  runId: string | null,
  now = new Date(),
): Escalation {
  const existing = runId === null ? undefined : state.escalations.find((item) => item.runId === runId);
  if (existing) return existing;
  const escalation: Escalation = {
    id: randomUUID(),
    runId,
    reason: clean(request.reason, "escalation reason", 500),
    details: clean(request.details, "escalation details", 4_000),
    createdAt: now.toISOString(),
    acknowledged: false,
  };
  state.escalations.push(escalation);
  return escalation;
}

export interface AcknowledgedEscalation {
  state: PrState;
  escalation: Escalation;
}

export async function acknowledgeEscalation(
  escalationId: string,
  app: AppPaths = appPaths(),
): Promise<AcknowledgedEscalation> {
  const matches: AcknowledgedEscalation[] = [];
  for (const entry of await listPrStates(app)) {
    if (!entry.state) continue;
    const escalation = entry.state.escalations.find((item) => item.id === escalationId);
    if (escalation) matches.push({ state: entry.state, escalation });
  }
  if (matches.length === 0) throw new Error(`Escalation ${escalationId} was not found`);
  if (matches.length > 1) throw new Error(`Escalation ${escalationId} is not unique`);
  const match = matches[0]!;
  const updated = await mutatePrState(match.state.key, (latest) => {
    const escalation = latest.escalations.find((item) => item.id === escalationId);
    if (!escalation) throw new Error(`Escalation ${escalationId} disappeared during acknowledgement`);
    escalation.acknowledged = true;
    return escalation.id;
  }, app);
  const escalation = updated.state.escalations.find((item) => item.id === updated.result)!;
  return { state: updated.state, escalation };
}

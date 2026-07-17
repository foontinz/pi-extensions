import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkflowPolicyError } from "./policy.js";

export type WorkflowActivation = "ask" | "autonomous" | "explicit-only";

export interface WorkflowSettings {
  activation: WorkflowActivation;
  globalMaxConcurrency: number;
  runMaxConcurrency: number;
  maxAgents: number;
  retentionMs: number;
  cleanupGraceMs: number;
}

export interface ActivationIdentityInput {
  sourceHash: string;
  provider: string;
  model: string;
  tools: readonly string[];
  capabilities: readonly string[];
  maxAgents: number;
  budgetTokens: number | null;
}

const DEFAULTS: WorkflowSettings = {
  activation: "ask",
  globalMaxConcurrency: 16,
  runMaxConcurrency: 8,
  maxAgents: 100,
  retentionMs: 3 * 24 * 60 * 60 * 1_000,
  cleanupGraceMs: 30_000,
};

export function readWorkflowSettings(agentDir = getAgentDir()): WorkflowSettings {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")); } catch { return { ...DEFAULTS }; }
  const workflows = raw && typeof raw === "object" ? (raw as { workflows?: unknown }).workflows : undefined;
  if (!workflows || typeof workflows !== "object" || Array.isArray(workflows)) return { ...DEFAULTS };
  const value = workflows as Record<string, unknown>;
  const activation = value.activation ?? DEFAULTS.activation;
  if (activation !== "ask" && activation !== "autonomous" && activation !== "explicit-only") {
    throw new WorkflowPolicyError("ACTIVATION_UNKNOWN", `unknown workflows.activation setting: ${String(activation)}`);
  }
  const globalMaxConcurrency = integer(value.globalMaxConcurrency, DEFAULTS.globalMaxConcurrency, 1, 64, "globalMaxConcurrency");
  const runMaxConcurrency = integer(value.runMaxConcurrency, DEFAULTS.runMaxConcurrency, 1, globalMaxConcurrency, "runMaxConcurrency");
  return {
    activation,
    globalMaxConcurrency,
    runMaxConcurrency,
    maxAgents: integer(value.maxAgents, DEFAULTS.maxAgents, 1, 500, "maxAgents"),
    retentionMs: integer(value.retentionMs, DEFAULTS.retentionMs, 60_000, 365 * 24 * 60 * 60 * 1_000, "retentionMs"),
    cleanupGraceMs: integer(value.cleanupGraceMs, DEFAULTS.cleanupGraceMs, 1_000, 300_000, "cleanupGraceMs"),
  };
}

export function activationIdentity(input: ActivationIdentityInput): string {
  const normalized = {
    ...input,
    tools: [...input.tools],
    capabilities: [...input.capabilities].sort(),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export async function authorizeWorkflow(
  ctx: ExtensionContext,
  settings: WorkflowSettings,
  input: ActivationIdentityInput,
  explicitlyAuthorized = false,
): Promise<string> {
  const identity = activationIdentity(input);
  if (settings.activation === "autonomous" || explicitlyAuthorized) return identity;
  if (settings.activation === "explicit-only") {
    throw new WorkflowPolicyError("ACTIVATION_EXPLICIT_ONLY", "Workflow activation is explicit-only; use /workflow run <qualified-id>");
  }
  if (!ctx.hasUI) {
    throw new WorkflowPolicyError("ACTIVATION_HEADLESS", "Workflow activation requires approval, but this mode has no approval UI");
  }
  const budget = input.budgetTokens === null ? "unknown (no budget supplied)" : `${input.budgetTokens} output tokens`;
  const accepted = await ctx.ui.confirm(
    "Activate local workflow?",
    [
      `Source: ${input.sourceHash.slice(0, 16)}…`,
      `Model: ${input.provider}/${input.model}`,
      `Tools: ${input.tools.join(", ") || "none"}`,
      `Capabilities: ${input.capabilities.join(", ") || "none"}`,
      `Maximum agents: ${input.maxAgents}`,
      `Budget: ${budget}`,
      `Approval identity: ${identity.slice(0, 16)}…`,
    ].join("\n"),
  );
  if (!accepted) throw new WorkflowPolicyError("ACTIVATION_DECLINED", "Workflow activation was declined");
  return identity;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new WorkflowPolicyError("SETTING_INVALID", `workflows.${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

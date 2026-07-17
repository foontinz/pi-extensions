import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { discoverAgents } from "../../subagents/agents.js";
import type { SubagentThinkingLevel } from "../../subagents/core/in-process-runner.js";
import { WorkflowPolicyError } from "./policy.js";

export type WorkflowEffect = "none" | "workspace" | "external";
export type WorkflowCachePolicy = "off" | "pure" | "workspace-artifact";

export interface AvailableTool {
  name: string;
  description?: string;
  parameters?: unknown;
  sourceInfo?: { source?: string; path?: string };
}

export interface RootExecutionDefaults {
  provider: string;
  model: string;
  thinking: SubagentThinkingLevel;
}

export interface AgentResolutionInput {
  profile?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  effects?: string;
  workspace?: string;
  artifactPolicy?: string;
  cachePolicy?: string;
  mcp?: boolean;
}

export interface ResolvedAgentExecution {
  provider: string;
  model: string;
  thinking: SubagentThinkingLevel;
  profile?: { id: string; sha256: string };
  tools: string[];
  toolIdentities: Array<{ name: string; sha256: string }>;
  systemPrompt?: string;
  appendSystemPrompt: string[];
  promptSha256: string;
  effects: WorkflowEffect;
  workspace?: "isolated";
  artifactPolicy?: "capture" | "discard";
  cachePolicy: WorkflowCachePolicy;
  mcp: boolean;
}

const THINKING = new Set<SubagentThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
const LOCAL_BUILTINS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);
const RETURN_TEXT = "Your final assistant text is returned verbatim to the workflow. Return the result itself, not a completion confirmation. Be concise.";

export function resolveAgentExecution(
  cwd: string,
  input: AgentResolutionInput,
  root: RootExecutionDefaults,
  availableTools: readonly AvailableTool[],
  schemaMode: boolean,
): ResolvedAgentExecution {
  const profile = resolveUserProfile(cwd, input.profile);
  const explicitModel = input.model ?? profile?.model;
  const { provider, model } = explicitModel ? parseConcreteModel(explicitModel) : root;
  const thinkingValue = input.thinking ?? profile?.thinking ?? root.thinking;
  if (!THINKING.has(thinkingValue as SubagentThinkingLevel)) {
    throw new WorkflowPolicyError("THINKING_UNKNOWN", `unknown thinking level: ${String(thinkingValue)}`);
  }

  const effects = input.effects ?? "none";
  if (effects !== "none" && effects !== "workspace" && effects !== "external") {
    throw new WorkflowPolicyError("EFFECTS_UNKNOWN", `unknown effects declaration: ${effects}`);
  }
  const mcp = input.mcp === true;
  if (mcp && effects !== "external") throw new WorkflowPolicyError("EFFECTS_MCP", "MCP requires effects:\"external\"");

  const requested = input.tools ?? profile?.tools ?? [...READ_ONLY].filter((name) => availableTools.some((tool) => tool.name === name));
  if (!Array.isArray(requested) || requested.some((name) => typeof name !== "string" || !name)) {
    throw new WorkflowPolicyError("TOOLS_INVALID", "agent tools must be an array of non-empty names");
  }
  const tools = [...new Set(requested)];
  const byName = new Map(availableTools.map((tool) => [tool.name, tool]));
  for (const name of tools) {
    const definition = byName.get(name);
    if (!definition) throw new WorkflowPolicyError("TOOL_UNKNOWN", `unknown or inactive tool: ${name}`);
    if (effects === "none" && !READ_ONLY.has(name)) {
      throw new WorkflowPolicyError("EFFECTS_READ_ONLY", `effects:\"none\" cannot use tool ${name}`);
    }
    if (effects !== "external" && !LOCAL_BUILTINS.has(name)) {
      throw new WorkflowPolicyError("EFFECTS_CUSTOM_TOOL", `custom/unknown tool ${name} requires effects:\"external\"`);
    }
  }

  let workspace: "isolated" | undefined;
  let artifactPolicy: "capture" | "discard" | undefined;
  if (effects === "workspace") {
    if (input.workspace !== "isolated") throw new WorkflowPolicyError("WORKSPACE_REQUIRED", "effects:\"workspace\" requires workspace:\"isolated\"");
    if (input.artifactPolicy !== undefined && input.artifactPolicy !== "capture" && input.artifactPolicy !== "discard") {
      throw new WorkflowPolicyError("ARTIFACT_POLICY_UNKNOWN", `unknown artifact policy: ${input.artifactPolicy}`);
    }
    workspace = "isolated";
    artifactPolicy = input.artifactPolicy ?? "capture";
  } else if (input.workspace !== undefined || input.artifactPolicy !== undefined) {
    throw new WorkflowPolicyError("WORKSPACE_UNDECLARED", "workspace/artifactPolicy are valid only with effects:\"workspace\"");
  }

  const requestedCache = input.cachePolicy ?? "off";
  if (requestedCache !== "off" && requestedCache !== "pure" && requestedCache !== "workspace-artifact") {
    throw new WorkflowPolicyError("CACHE_POLICY_UNKNOWN", `unknown cache policy: ${requestedCache}`);
  }
  if (effects === "external" && requestedCache !== "off") throw new WorkflowPolicyError("CACHE_EXTERNAL", "external-effect leaves are non-cacheable");
  if (requestedCache === "pure" && effects !== "none") throw new WorkflowPolicyError("CACHE_PURE_EFFECTS", "cachePolicy:\"pure\" requires effects:\"none\"");
  if (requestedCache === "workspace-artifact" && (effects !== "workspace" || artifactPolicy !== "capture")) {
    throw new WorkflowPolicyError("CACHE_WORKSPACE_ARTIFACT", "workspace-artifact cache requires an isolated captured workspace");
  }

  const systemPrompt = input.systemPrompt ?? profile?.systemPrompt;
  // Schema mode's shared leaf runtime appends its schema-bearing mandatory
  // return instruction last. Text mode appends the verbatim-return contract here.
  const appendSystemPrompt = [input.appendSystemPrompt, schemaMode ? undefined : RETURN_TEXT].filter((value): value is string => Boolean(value));
  const toolIdentities = tools.map((name) => ({ name, sha256: hashJson(byName.get(name)) }));
  const profileIdentity = profile ? { id: `user:${profile.name}`, sha256: hash(fs.readFileSync(profile.filePath)) } : undefined;
  return {
    provider,
    model,
    thinking: thinkingValue as SubagentThinkingLevel,
    profile: profileIdentity,
    tools,
    toolIdentities,
    systemPrompt,
    appendSystemPrompt,
    promptSha256: hashJson({ systemPrompt, appendSystemPrompt }),
    effects,
    workspace,
    artifactPolicy,
    cachePolicy: requestedCache,
    mcp,
  };
}

function resolveUserProfile(cwd: string, name: string | undefined) {
  if (!name) return undefined;
  const profiles = discoverAgents(cwd, "user").agents;
  const profile = profiles.find((candidate) => candidate.name === name || `user:${candidate.name}` === name);
  if (!profile) throw new WorkflowPolicyError("PROFILE_UNKNOWN", `unknown user-owned workflow profile: ${name}`);
  return profile;
}

function parseConcreteModel(value: string): { provider: string; model: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new WorkflowPolicyError("MODEL_CONCRETE_REQUIRED", `model must be a concrete provider/model id: ${value}`);
  }
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function hashJson(value: unknown): string { return hash(JSON.stringify(value, objectKeyOrder)); }
function objectKeyOrder(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
}

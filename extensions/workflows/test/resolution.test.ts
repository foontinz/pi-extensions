import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentExecution, type AvailableTool } from "../runtime/resolution.js";

const available: AvailableTool[] = [
  { name: "read", description: "read", sourceInfo: { source: "builtin" } },
  { name: "grep", description: "grep", sourceInfo: { source: "builtin" } },
  { name: "bash", description: "bash", sourceInfo: { source: "builtin" } },
  { name: "write", description: "write", sourceInfo: { source: "builtin" } },
  { name: "network", description: "external", sourceInfo: { source: "extension" } },
];
const root = { provider: "provider", model: "model", thinking: "high" as const };

test("none effects enforce read-only tools and inherit concrete root execution", () => {
  const result = resolveAgentExecution("/tmp", { tools: ["read", "grep"] }, root, available, false);
  assert.deepEqual([result.provider, result.model, result.thinking, result.effects], ["provider", "model", "high", "none"]);
  assert.equal(result.appendSystemPrompt.at(-1)?.startsWith("Your final assistant text"), true);
  assert.throws(() => resolveAgentExecution("/tmp", { tools: ["bash"] }, root, available, false), /cannot use tool bash/);
  assert.throws(() => resolveAgentExecution("/tmp", { tools: ["missing"] }, root, available, false), /unknown or inactive/);
});

test("workspace effects require isolation and default to verified capture", () => {
  assert.throws(() => resolveAgentExecution("/tmp", { effects: "workspace", tools: ["write"] }, root, available, false), /workspace.*isolated/);
  const result = resolveAgentExecution("/tmp", {
    effects: "workspace",
    workspace: "isolated",
    tools: ["bash", "write"],
  }, root, available, false);
  assert.equal(result.artifactPolicy, "capture");
  assert.equal(result.workspace, "isolated");
  assert.throws(() => resolveAgentExecution("/tmp", {
    effects: "workspace", workspace: "isolated", artifactPolicy: "discard", cachePolicy: "workspace-artifact", tools: ["write"],
  }, root, available, false), /requires.*captured workspace/);
});

test("external effects disable caching and schema return contract is mandatory-last", () => {
  assert.throws(() => resolveAgentExecution("/tmp", { mcp: true }, root, available, false), /MCP requires/);
  assert.throws(() => resolveAgentExecution("/tmp", { effects: "external", tools: ["network"], cachePolicy: "pure" }, root, available, false), /non-cacheable/);
  const result = resolveAgentExecution("/tmp", {
    effects: "external",
    tools: ["network"],
    mcp: true,
    appendSystemPrompt: "custom append",
    model: "other/exact-model",
  }, root, available, true);
  assert.deepEqual([result.provider, result.model], ["other", "exact-model"]);
  assert.equal(result.appendSystemPrompt[0], "custom append");
  assert.match(result.appendSystemPrompt.at(-1)!, /^Return only through StructuredOutput/);
});

test("explicit unknown model and thinking values fail closed", () => {
  assert.throws(() => resolveAgentExecution("/tmp", { model: "fuzzy-model" }, root, available, false), /concrete provider\/model/);
  assert.throws(() => resolveAgentExecution("/tmp", { thinking: "turbo" }, root, available, false), /unknown thinking/);
});

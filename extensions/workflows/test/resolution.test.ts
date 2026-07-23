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

test("none effects permit inspection tools including bash and inherit concrete root execution", () => {
  const result = resolveAgentExecution("/tmp", { tools: ["read", "grep"] }, root, available, false);
  assert.deepEqual([result.provider, result.model, result.thinking, result.effects], ["provider", "model", "high", "none"]);
  assert.equal(result.appendSystemPrompt.at(-1)?.startsWith("Your final assistant text"), true);
  const shellInspection = resolveAgentExecution("/tmp", { tools: ["bash"], effects: "none" }, root, available, false);
  assert.deepEqual(shellInspection.tools, ["bash"]);
  assert.equal(shellInspection.effects, "none");
  assert.throws(() => resolveAgentExecution("/tmp", { tools: ["write"] }, root, available, false), /cannot use tool write/);
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
  const cacheable = resolveAgentExecution("/tmp", {
    effects: "workspace", workspace: "isolated", artifactPolicy: "capture", cachePolicy: "workspace-artifact", tools: ["write"],
  }, root, available, false);
  assert.equal(cacheable.cachePolicy, "workspace-artifact");
  assert.throws(() => resolveAgentExecution("/tmp", {
    effects: "workspace", workspace: "isolated", artifactPolicy: "discard", cachePolicy: "workspace-artifact", tools: ["write"],
  }, root, available, false), /requires.*captured workspace/);
});

test("pure replay is tool-free so undeclared reads cannot create stale cache entries", () => {
  assert.throws(
    () => resolveAgentExecution("/tmp", { cachePolicy: "pure", tools: ["read"] }, root, available, false),
    /undeclared reads would make replay unsound/,
  );
  assert.throws(
    () => resolveAgentExecution("/tmp", { cachePolicy: "pure" }, root, available, false),
    /undeclared reads would make replay unsound/,
  );
  assert.equal(resolveAgentExecution("/tmp", { cachePolicy: "pure", tools: [] }, root, available, false).cachePolicy, "pure");
});

test("external effects disable caching and schema mode delegates mandatory-last prompt to shared runtime", () => {
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
  assert.deepEqual(result.appendSystemPrompt, ["custom append"]);
});

test("explicit unknown model and thinking values fail closed", () => {
  assert.throws(() => resolveAgentExecution("/tmp", { model: "fuzzy-model" }, root, available, false), /concrete provider\/model/);
  assert.throws(() => resolveAgentExecution("/tmp", { thinking: "turbo" }, root, available, false), /unknown thinking/);
});

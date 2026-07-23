import * as path from "node:path";
import { emptyUsageStats } from "../../../subagents/core/types.js";
import { WorkflowEngine } from "../../engine.js";

const root = process.argv[2];
const mode = process.argv[3];
if (!root || (mode !== "pure" && mode !== "external")) throw new Error("usage: crash-running-workflow.ts <root> <pure|external>");

let runId: string | undefined;
let announced = false;
const leafExecutor = async () => {
  while (!runId) await new Promise<void>((resolve) => setImmediate(resolve));
  if (!announced) {
    announced = true;
    process.stdout.write(`${runId}\n`);
  }
  await new Promise<never>(() => {});
  return { output: "unreachable", usage: emptyUsageStats() };
};
const pi = {
  getThinkingLevel: () => "high",
  getAllTools: () => mode === "external"
    ? [{ name: "network", description: "network", parameters: {}, sourceInfo: { source: "extension", path: "fixture" } }]
    : [],
} as any;
const ctx = {
  cwd: root,
  model: { provider: "provider", id: "model" },
  modelRegistry: { getAvailable: () => [{ provider: "provider", id: "model" }] },
  hasUI: false,
  isProjectTrusted: () => true,
  sessionManager: { getSessionId: () => "session", getSessionFile: () => path.join(root, "session.jsonl") },
} as any;
const engine = new WorkflowEngine(pi, {
  runRoot: path.join(root, "runs"),
  workspaceRoot: path.join(root, "workspace"),
  leafExecutor,
});
const capabilities = mode === "external" ? '["read","external"]' : '["read"]';
const options = mode === "external"
  ? '{id:"leaf",effects:"external",tools:["network"]}'
  : '{id:"leaf",effects:"none",tools:[]}';
const script = `export const meta={name:"crash",description:"crash fixture",resumable:false,maxAgents:1,capabilities:${capabilities}}\nreturn await agent("wait", ${options})`;
const launch = await engine.launch({ script }, ctx, true);
runId = launch.runId;
await launch.completion;

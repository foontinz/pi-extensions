import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { activationIdentity, authorizeWorkflow, readWorkflowSettings } from "../runtime/activation.js";

const identity = {
  sourceHash: "a".repeat(64), provider: "p", model: "m", tools: ["read"], capabilities: ["read"], maxAgents: 3, budgetTokens: null,
};

test("settings default to ask and enforce safe ceilings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-settings-"));
  try {
    assert.equal(readWorkflowSettings(dir).activation, "ask");
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ workflows: { activation: "autonomous", globalMaxConcurrency: 4, runMaxConcurrency: 3 } }));
    assert.deepEqual(readWorkflowSettings(dir), { activation: "autonomous", globalMaxConcurrency: 4, runMaxConcurrency: 3, maxAgents: 100, retentionMs: 259_200_000, cleanupGraceMs: 30_000 });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ workflows: { globalMaxConcurrency: 2, runMaxConcurrency: 3 } }));
    assert.throws(() => readWorkflowSettings(dir), /runMaxConcurrency/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("approval identity is stable and binds source, model, tools, caps, and budget", () => {
  const first = activationIdentity(identity);
  assert.equal(first, activationIdentity({ ...identity, capabilities: ["read"] }));
  assert.notEqual(first, activationIdentity({ ...identity, model: "other" }));
  assert.notEqual(first, activationIdentity({ ...identity, budgetTokens: 1 }));
});

test("ask fails closed headlessly and explicit-only requires command authorization", async () => {
  const baseSettings = readWorkflowSettings("/missing");
  const headless = { hasUI: false } as any;
  await assert.rejects(authorizeWorkflow(headless, baseSettings, identity), /no approval UI/);
  await assert.rejects(authorizeWorkflow(headless, { ...baseSettings, activation: "explicit-only" }, identity), /explicit-only/);
  assert.match(await authorizeWorkflow(headless, { ...baseSettings, activation: "explicit-only" }, identity, true), /^[a-f0-9]{64}$/);
});

test("ask displays bounded honest approval facts", async () => {
  let body = "";
  const ctx = { hasUI: true, ui: { confirm: async (_title: string, value: string) => { body = value; return true; } } } as any;
  const result = await authorizeWorkflow(ctx, readWorkflowSettings("/missing"), identity);
  assert.match(result, /^[a-f0-9]{64}$/);
  assert.match(body, /Budget: unknown \(no budget supplied\)/);
  assert.match(body, /Maximum agents: 3/);
});

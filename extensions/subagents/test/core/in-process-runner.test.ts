import assert from "node:assert/strict";
import test from "node:test";
import { createBareResourceLoader, resolveModelPattern } from "../../core/in-process-runner.js";

test("resolveModelPattern returns undefined for empty/blank patterns", () => {
  assert.equal(resolveModelPattern(undefined), undefined);
  assert.equal(resolveModelPattern(""), undefined);
  assert.equal(resolveModelPattern("   "), undefined);
});

test("resolveModelPattern returns undefined when nothing matches", () => {
  // A deliberately absurd provider/id that no registry should contain.
  assert.equal(resolveModelPattern("no-such-provider/no-such-model-xyz-123"), undefined);
});

test("bare resource loader keeps pi's default system prompt (undefined) by default", () => {
  const loader = createBareResourceLoader();
  assert.equal(loader.getSystemPrompt(), undefined);
  assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.deepEqual(loader.getExtensions().extensions, []);
  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
});

test("bare resource loader composes an override prompt and append list", () => {
  const loader = createBareResourceLoader("SYSTEM", ["A", "B"]);
  assert.equal(loader.getSystemPrompt(), "SYSTEM");
  assert.deepEqual(loader.getAppendSystemPrompt(), ["A", "B"]);
  // getAppendSystemPrompt returns a fresh array (defensive copy).
  const first = loader.getAppendSystemPrompt();
  first.push("C");
  assert.deepEqual(loader.getAppendSystemPrompt(), ["A", "B"]);
});

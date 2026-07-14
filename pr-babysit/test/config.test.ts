import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, loadConfig, parseConfig, requireAgentModel } from "../src/config.ts";
import { appPaths, ensureAppDirs } from "../src/paths.ts";

test("missing config uses safe operational defaults without an implicit agent model", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-config-"));
  assert.deepEqual(await loadConfig(appPaths(home)), DEFAULT_CONFIG);
  assert.throws(() => requireAgentModel({ ...DEFAULT_CONFIG }), /provider and model/);
});

test("config validates model pairing, ranges, and unknown fields", () => {
  assert.deepEqual(parseConfig({ provider: "openai", model: "gpt-5", pollIntervalSec: 5 }), {
    provider: "openai",
    model: "gpt-5",
    pollIntervalSec: 5,
    runTimeoutMin: 15,
    maxConcurrentRuns: 2,
    baseMergeMessage: null,
  });
  assert.equal(
    parseConfig({ provider: "openai", model: "gpt-5", baseMergeMessage: "chore: merge base GENAI=NO" }).baseMergeMessage,
    "chore: merge base GENAI=NO",
  );
  assert.throws(() => parseConfig({ baseMergeMessage: "line1\nline2" }), /single-line/);
  assert.throws(() => parseConfig({ provider: "openai" }), /both be set/);
  assert.throws(() => parseConfig({ pollIntervalSec: 4 }), /5 to 3600/);
  assert.throws(() => parseConfig({ maxConcurrentRuns: 1.5 }), /integer/);
  assert.throws(() => parseConfig({ typo: true }), /Unknown/);
});

test("malformed config errors include its path", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-babysit-config-bad-"));
  const app = appPaths(home);
  await ensureAppDirs(app);
  await writeFile(app.configFile, "{bad", "utf8");
  await assert.rejects(loadConfig(app), new RegExp(app.configFile.replaceAll("/", "\\/")));
});

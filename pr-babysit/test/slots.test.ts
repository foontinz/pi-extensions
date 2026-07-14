import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appPaths } from "../src/paths.ts";
import { acquireRunSlot } from "../src/slots.ts";

test("global slots serialize runs and release exact ownership", async () => {
  const app = appPaths(await mkdtemp(join(tmpdir(), "pr-babysit-slots-")));
  const first = await acquireRunSlot(1, { app, retryMs: 5 });
  const controller = new AbortController();
  const waiting = acquireRunSlot(1, { app, retryMs: 5, signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(waiting, /aborted/);
  await first.release();
  const second = await acquireRunSlot(1, { app, retryMs: 5 });
  assert.equal(second.index, 0);
  await second.release();
});

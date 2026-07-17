import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsageStats } from "../../subagents/core/types.js";
import { ProviderAttemptLedger } from "../runtime/accounting.js";

const usage = (output: number, cost: number) => ({ ...emptyUsageStats(), output, cost, turns: 1 });

test("attempt ledger attaches to raw promises and commits each attempt at most once", async () => {
  const ledger = new ProviderAttemptLedger();
  ledger.start("a1", "leaf");
  const raw = Promise.resolve({ output: 7 });
  await ledger.observe("a1", raw, (value) => ({ usage: usage(value?.output ?? 0, 0.5), costState: "reported" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ledger.settle("a1", { usage: usage(999, 999), costState: "reported" }), false);
  assert.deepEqual(ledger.usage(), usage(7, 0.5));
  assert.equal(ledger.records()[0].status, "settled");
});

test("rejected and process-lost attempts remain honestly represented", async () => {
  const ledger = new ProviderAttemptLedger();
  ledger.start("429", "leaf");
  const rejected = Promise.reject(new Error("429"));
  await assert.rejects(ledger.observe("429", rejected, () => ({ usage: usage(0, 0), costState: "unavailable" })));
  await new Promise((resolve) => setImmediate(resolve));
  ledger.start("lost", "leaf");
  ledger.markUnreconciled("lost");
  assert.deepEqual(ledger.records().map((record) => [record.attemptId, record.status, record.costState]), [
    ["429", "settled", "unavailable"],
    ["lost", "unreconciled", "unavailable"],
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { BudgetManager, FairSemaphore } from "../runtime/policy.js";

test("fair semaphore is FIFO, cancellation-aware, and release-idempotent", async () => {
  const semaphore = new FairSemaphore(1);
  const releaseFirst = await semaphore.acquire();
  const order: number[] = [];
  const cancelled = new AbortController();
  const second = semaphore.acquire(cancelled.signal).then((release) => { order.push(2); release(); });
  const third = semaphore.acquire().then((release) => { order.push(3); release(); });
  cancelled.abort();
  releaseFirst();
  releaseFirst();
  await assert.rejects(second, /aborted/);
  await third;
  assert.deepEqual(order, [3]);
  assert.equal(semaphore.inUse, 0);
});

test("budget manager reserves atomically, refunds, commits exactly once, and reports overshoot", () => {
  const budget = new BudgetManager(10);
  const first = budget.reserve(7);
  const second = budget.reserve(7);
  assert.deepEqual([first.amount, second.amount], [7, 3]);
  assert.deepEqual(budget.snapshot(), { total: 10, spent: 0, reserved: 10, remaining: 0 });
  budget.commit(first, 5);
  budget.refund(second);
  assert.deepEqual(budget.snapshot(), { total: 10, spent: 5, reserved: 0, remaining: 5 });
  assert.throws(() => budget.commit(first, 5), /unknown or already settled/);
  const third = budget.reserve(5);
  budget.commit(third, 8);
  assert.deepEqual(budget.snapshot(), { total: 10, spent: 13, reserved: 0, remaining: 0 });
  assert.throws(() => budget.reserve(1), /exhausted/);
});

test("unbounded budget still tracks reservations and spend", () => {
  const budget = new BudgetManager(null);
  const reservation = budget.reserve(1_000);
  budget.commit(reservation, 12);
  assert.deepEqual(budget.snapshot(), { total: null, spent: 12, reserved: 0, remaining: null });
});


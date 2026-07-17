import type { WorkerBudgetSnapshot } from "./worker.js";

export class WorkflowPolicyError extends Error {
  readonly kind = "contract" as const;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkflowPolicyError";
  }
}

interface Waiter {
  signal?: AbortSignal;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  onAbort: () => void;
}

/** FIFO semaphore. A release hands its permit directly to the oldest live waiter. */
export class FairSemaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("semaphore capacity must be a positive safe integer");
  }

  get inUse(): number { return this.active; }
  get queued(): number { return this.queue.length; }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError(signal);
    if (this.active < this.capacity && this.queue.length === 0) {
      this.active++;
      return this.releaseFactory();
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(abortError(signal));
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) waiter.onAbort();
    });
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        next.signal?.removeEventListener("abort", next.onAbort);
        if (next.signal?.aborted) {
          next.reject(abortError(next.signal));
          continue;
        }
        next.resolve(this.releaseFactory());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}

export interface BudgetReservation {
  readonly id: string;
  readonly amount: number;
}

/** Root-owned output-token budget with atomic synchronous reservations. */
export class BudgetManager {
  private committed: number;
  private sequence = 0;
  private readonly reservations = new Map<string, number>();

  constructor(readonly total: number | null, initialSpent = 0) {
    if (total !== null && (!Number.isSafeInteger(total) || total < 1)) {
      throw new WorkflowPolicyError("BUDGET_INVALID", "budgetTokens must be a positive safe integer");
    }
    if (!Number.isSafeInteger(initialSpent) || initialSpent < 0) throw new WorkflowPolicyError("BUDGET_SPENT_INVALID", "initial spent budget must be a non-negative safe integer");
    this.committed = initialSpent;
  }

  reserve(requested: number): BudgetReservation {
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new WorkflowPolicyError("BUDGET_RESERVATION_INVALID", "budget reservation must be a positive safe integer");
    }
    const remaining = this.remaining();
    if (remaining !== null && remaining < 1) throw new WorkflowPolicyError("BUDGET_EXHAUSTED", "workflow output-token budget is exhausted");
    const amount = remaining === null ? requested : Math.min(requested, remaining);
    const id = `budget:${++this.sequence}`;
    this.reservations.set(id, amount);
    return Object.freeze({ id, amount });
  }

  commit(reservation: BudgetReservation, actualOutputTokens: number): void {
    const held = this.take(reservation);
    const actual = normalizeUsage(actualOutputTokens);
    // A provider that cannot enforce the reservation can overshoot. Account it
    // honestly; callers surface this as dispatch-budget semantics.
    this.committed += actual;
    if (actual > held && this.total !== null) {
      // Overshoot remains visible in spent/remaining rather than being clamped.
    }
  }

  refund(reservation: BudgetReservation): void { void this.take(reservation); }

  spent(): number { return this.committed; }
  reserved(): number { return [...this.reservations.values()].reduce((sum, value) => sum + value, 0); }
  remaining(): number | null {
    return this.total === null ? null : Math.max(0, this.total - this.committed - this.reserved());
  }
  snapshot(): WorkerBudgetSnapshot {
    return Object.freeze({ total: this.total, spent: this.spent(), reserved: this.reserved(), remaining: this.remaining() });
  }

  private take(reservation: BudgetReservation): number {
    const held = this.reservations.get(reservation.id);
    if (held === undefined || held !== reservation.amount) {
      throw new WorkflowPolicyError("BUDGET_RESERVATION_UNKNOWN", `unknown or already settled budget reservation: ${reservation.id}`);
    }
    this.reservations.delete(reservation.id);
    return held;
  }
}

function normalizeUsage(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function abortError(signal?: AbortSignal): Error {
  const error = new Error("operation aborted", { cause: signal?.reason });
  (error as NodeJS.ErrnoException).code = "WORKFLOW_ABORTED";
  return error;
}

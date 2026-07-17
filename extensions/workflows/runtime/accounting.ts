import { addUsage, emptyUsageStats, type UsageStats } from "../../subagents/core/types.js";

export type CostState = "reported" | "estimated" | "unavailable";

export interface ProviderAttemptAccounting {
  attemptId: string;
  leafId: string;
  startedAt: number;
  settledAt?: number;
  usage?: UsageStats;
  costState: CostState;
  status: "running" | "settled" | "unreconciled";
}

/** Exactly-once ledger for every provider attempt observed by this process. */
export class ProviderAttemptLedger {
  private readonly attempts = new Map<string, ProviderAttemptAccounting>();
  private aggregate = emptyUsageStats();

  start(attemptId: string, leafId: string, startedAt = Date.now()): void {
    if (!attemptId || this.attempts.has(attemptId)) throw new Error(`duplicate provider attempt id: ${attemptId}`);
    this.attempts.set(attemptId, { attemptId, leafId, startedAt, costState: "unavailable", status: "running" });
  }

  /** Attach before an abort race. Settlement accounting cannot be lost to the race winner. */
  observe<T>(
    attemptId: string,
    rawAttempt: Promise<T>,
    usage: (value: T | undefined, error: unknown | undefined) => { usage?: UsageStats; costState: CostState },
  ): Promise<T> {
    if (!this.attempts.has(attemptId)) throw new Error(`unknown provider attempt id: ${attemptId}`);
    void rawAttempt.then(
      (value) => this.settle(attemptId, usage(value, undefined)),
      (error) => this.settle(attemptId, usage(undefined, error)),
    );
    return rawAttempt;
  }

  settle(attemptId: string, result: { usage?: UsageStats; costState: CostState }, settledAt = Date.now()): boolean {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error(`unknown provider attempt id: ${attemptId}`);
    if (attempt.status !== "running") return false;
    attempt.status = "settled";
    attempt.settledAt = settledAt;
    attempt.costState = result.costState;
    if (result.usage) {
      attempt.usage = { ...result.usage };
      this.aggregate = addUsage(this.aggregate, result.usage);
    }
    return true;
  }

  markUnreconciled(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error(`unknown provider attempt id: ${attemptId}`);
    if (attempt.status === "running") attempt.status = "unreconciled";
  }

  usage(): UsageStats { return { ...this.aggregate }; }
  records(): readonly ProviderAttemptAccounting[] {
    return [...this.attempts.values()].map((attempt) => ({ ...attempt, usage: attempt.usage ? { ...attempt.usage } : undefined }));
  }
}

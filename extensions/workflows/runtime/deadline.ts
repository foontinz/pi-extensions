export class AbsoluteDeadline {
  readonly acceptedAt: number;
  readonly deadlineAt: number;

  constructor(timeoutMs: number, now = Date.now()) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("deadline timeout must be a positive safe integer");
    this.acceptedAt = now;
    this.deadlineAt = now + timeoutMs;
  }

  remaining(now = Date.now()): number { return Math.max(0, this.deadlineAt - now); }
  throwIfElapsed(now = Date.now()): void {
    if (now < this.deadlineAt) return;
    const error = new Error(`absolute deadline elapsed after ${this.deadlineAt - this.acceptedAt}ms`);
    (error as NodeJS.ErrnoException).code = "WORKFLOW_LEAF_DEADLINE";
    throw error;
  }

  signal(parent?: AbortSignal): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    const onParent = () => controller.abort(parent?.reason);
    parent?.addEventListener("abort", onParent, { once: true });
    const remaining = this.remaining();
    const timer = setTimeout(() => {
      const error = new Error(`absolute deadline elapsed after ${this.deadlineAt - this.acceptedAt}ms`);
      (error as NodeJS.ErrnoException).code = "WORKFLOW_LEAF_DEADLINE";
      controller.abort(error);
    }, Math.max(1, remaining));
    timer.unref?.();
    if (remaining === 0) queueMicrotask(() => controller.abort(deadlineError(this)));
    if (parent?.aborted) onParent();
    return {
      signal: controller.signal,
      dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", onParent); },
    };
  }
}

export async function deadlineDelay(ms: number, deadline: AbsoluteDeadline, signal?: AbortSignal): Promise<void> {
  deadline.throwIfElapsed();
  const wait = Math.min(Math.max(0, ms), deadline.remaining());
  if (wait === 0) deadline.throwIfElapsed(deadline.deadlineAt);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, wait);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  deadline.throwIfElapsed();
}

function deadlineError(deadline: AbsoluteDeadline): Error {
  const error = new Error(`absolute deadline elapsed after ${deadline.deadlineAt - deadline.acceptedAt}ms`);
  (error as NodeJS.ErrnoException).code = "WORKFLOW_LEAF_DEADLINE";
  return error;
}
function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("operation aborted", { cause: reason });
}

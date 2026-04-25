import {
  assertDurableJobRecord,
  cloneJobRecord,
} from "./invariants.js";
import { reduceJobEvent } from "./state-machine.js";
import {
  createEmptyJobRuntimeState,
  type JobEvent,
  type JobRecord,
  type JobRuntimeState,
  type JobTransition,
  type JobTransitionEffect,
  type ReduceOptions,
  type Waiter,
} from "./types.js";

export type Awaitable<T> = T | Promise<T>;
export type JobActorPersist = (record: JobRecord, transition: JobTransition) => Awaitable<void>;
export type JobActorObserver = (transition: JobTransition) => void;
export type JobActorEffectObserver = (effect: JobTransitionEffect, transition: JobTransition) => void;

export interface JobActorOptions {
  persist?: JobActorPersist;
  runtime?: JobRuntimeState;
}

export interface WaitForJobOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class JobActor {
  readonly id: string;
  readonly runtime: JobRuntimeState;

  private record: JobRecord;
  private tail: Promise<void> = Promise.resolve();
  private readonly persist?: JobActorPersist;
  private readonly observers = new Set<JobActorObserver>();
  private readonly effectObservers = new Set<JobActorEffectObserver>();
  private readonly effectQueue: JobTransitionEffect[] = [];

  constructor(record: JobRecord, options: JobActorOptions = {}) {
    assertDurableJobRecord(record);
    this.record = cloneJobRecord(record);
    this.id = record.id;
    this.persist = options.persist;
    this.runtime = options.runtime ?? createEmptyJobRuntimeState();
  }

  snapshot(): JobRecord {
    return cloneJobRecord(this.record);
  }

  subscribe(observer: JobActorObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  subscribeEffects(observer: JobActorEffectObserver): () => void {
    this.effectObservers.add(observer);
    return () => this.effectObservers.delete(observer);
  }

  waiterCount(): number {
    return this.runtime.waiters.size;
  }

  drainEffects(): JobTransitionEffect[] {
    return this.effectQueue.splice(0, this.effectQueue.length);
  }

  dispatch(event: JobEvent, options: ReduceOptions = {}): Promise<JobRecord> {
    let result!: Promise<JobRecord>;

    const run = this.tail.then(async () => {
      result = this.dispatchNow(event, options);
      await result;
    });

    this.tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run.then(() => result);
  }

  async waitFor(predicate: (record: JobRecord) => boolean, options: WaitForJobOptions = {}): Promise<JobRecord> {
    const snapshot = this.snapshot();
    if (predicate(snapshot)) return snapshot;
    if (options.signal?.aborted) throw abortError();

    return await new Promise<JobRecord>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        predicate,
        resolve: (record) => {
          waiter.cleanup();
          resolve(cloneJobRecord(record));
        },
        reject: (error) => {
          waiter.cleanup();
          reject(error);
        },
        cleanup: () => {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          this.runtime.waiters.delete(waiter);
        },
      };
      const onAbort = () => waiter.reject(abortError());

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => waiter.reject(new Error(`timed out waiting for job ${this.id}`)), options.timeoutMs);
        timer.unref?.();
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.runtime.waiters.add(waiter);
    });
  }

  private async dispatchNow(event: JobEvent, options: ReduceOptions): Promise<JobRecord> {
    const transition = reduceJobEvent(this.record, event, options);
    const durableNext = cloneJobRecord(transition.next);
    assertDurableJobRecord(durableNext);

    if (!transition.changed) return this.snapshot();

    const committedTransition: JobTransition = {
      ...transition,
      previous: cloneJobRecord(this.record),
      next: durableNext,
    };

    await this.persist?.(durableNext, committedTransition);

    this.record = cloneJobRecord(durableNext);
    const committedSnapshot = this.snapshot();
    const notifyTransition: JobTransition = {
      ...committedTransition,
      next: committedSnapshot,
    };

    this.notifyObservers(notifyTransition);
    this.resolveWaiters(committedSnapshot);
    this.enqueueEffects(notifyTransition.effects, notifyTransition);

    return this.snapshot();
  }

  private notifyObservers(transition: JobTransition): void {
    for (const observer of [...this.observers]) {
      try {
        observer(transition);
      } catch {
        // Observer failures must not corrupt an already-committed transition.
      }
    }
  }

  private resolveWaiters(record: JobRecord): void {
    for (const waiter of [...this.runtime.waiters]) {
      let shouldResolve = false;
      try {
        shouldResolve = waiter.predicate(record);
      } catch (error) {
        waiter.reject(error);
        continue;
      }
      if (shouldResolve) waiter.resolve(record);
    }
  }

  private enqueueEffects(effects: JobTransitionEffect[], transition: JobTransition): void {
    if (effects.length === 0) return;
    this.effectQueue.push(...effects.map((effect) => ({ ...effect })));
    for (const effect of effects) {
      for (const observer of [...this.effectObservers]) {
        try {
          observer(effect, transition);
        } catch {
          // Effect observer failures are isolated from committed actor state.
        }
      }
    }
  }
}

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

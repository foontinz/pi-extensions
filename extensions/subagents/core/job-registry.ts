import { assertDurableJobRecord } from "./invariants.js";
import { hydrateJobRecord, hydrateRuntimeState, type HydrateJobRecordOptions } from "./hydration.js";
import { JobActor, type JobActorOptions, type JobActorPersist } from "./job-actor.js";
import type { JobEvent, JobRecord, JobRuntimeState, ReduceOptions } from "./types.js";

export interface JobRegistryOptions {
  persist?: JobActorPersist;
  createRuntime?: (record: JobRecord) => JobRuntimeState;
}

export class JobRegistry {
  private readonly actors = new Map<string, JobActor>();
  private readonly persist?: JobActorPersist;
  private readonly createRuntime: (record: JobRecord) => JobRuntimeState;

  constructor(options: JobRegistryOptions = {}) {
    this.persist = options.persist;
    this.createRuntime = options.createRuntime ?? hydrateRuntimeState;
  }

  get(id: string): JobActor | undefined {
    return this.actors.get(id);
  }

  require(id: string): JobActor {
    const actor = this.get(id);
    if (!actor) throw new Error(`unknown job ${id}`);
    return actor;
  }

  has(id: string): boolean {
    return this.actors.has(id);
  }

  ids(): string[] {
    return [...this.actors.keys()].sort();
  }

  list(): JobActor[] {
    return [...this.actors.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  snapshots(): JobRecord[] {
    return this.list().map((actor) => actor.snapshot());
  }

  upsert(record: JobRecord, options: JobActorOptions = {}): JobActor {
    assertDurableJobRecord(record);
    const existing = this.actors.get(record.id);
    if (existing) return existing;

    const actor = new JobActor(record, {
      persist: options.persist ?? this.persist,
      runtime: options.runtime ?? this.createRuntime(record),
    });
    this.actors.set(record.id, actor);
    return actor;
  }

  hydrate(rawRecords: Iterable<unknown>, options: HydrateJobRecordOptions = {}): JobActor[] {
    const hydrated: JobActor[] = [];
    for (const raw of rawRecords) {
      const record = hydrateJobRecord(raw, options);
      hydrated.push(this.upsert(record));
    }
    return hydrated;
  }

  delete(id: string): boolean {
    return this.actors.delete(id);
  }

  clear(): void {
    this.actors.clear();
  }

  async dispatch(id: string, event: JobEvent, options: ReduceOptions = {}): Promise<JobRecord> {
    return await this.require(id).dispatch(event, options);
  }
}

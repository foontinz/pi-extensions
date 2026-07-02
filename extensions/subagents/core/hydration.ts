import {
  assertDurableJobRecord,
  JobRecordHydrationError,
  RUNTIME_ONLY_KEYS,
} from "./invariants.js";
import {
  JOB_RECORD_SCHEMA_VERSION,
  MIGRATABLE_JOB_RECORD_SCHEMA_VERSIONS,
  createEmptyJobRuntimeState,
  type JobRecord,
  type JobRuntimeState,
} from "./types.js";

// Fields dropped from DurableSupervisorInfo in schema v3 (tmux/subprocess-only).
const REMOVED_SUPERVISOR_INFO_KEYS = ["pid", "tmuxSession", "stdoutPath", "stderrPath", "exitCodePath"] as const;

export { JobRecordHydrationError } from "./invariants.js";

export class UnsupportedJobRecordSchemaError extends JobRecordHydrationError {
  override name = "UnsupportedJobRecordSchemaError";

  constructor(readonly schemaVersion: unknown) {
    super(`unsupported job record schemaVersion ${String(schemaVersion)}`);
  }
}

export function serializeJobRecord(record: JobRecord): string {
  assertDurableJobRecord(record);
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function hydrateJobRecord(raw: unknown): JobRecord {
  const parsed = parseRaw(raw);

  if (!isRecord(parsed)) throw new JobRecordHydrationError("job record must be an object");

  if (parsed.schemaVersion === undefined) {
    throw new JobRecordHydrationError("missing job record schemaVersion");
  }

  const migrated = migrateForward(structuredClone(parsed));

  if (migrated.schemaVersion !== JOB_RECORD_SCHEMA_VERSION) {
    throw new UnsupportedJobRecordSchemaError(parsed.schemaVersion);
  }

  const record = migrated as unknown as JobRecord;
  assertDurableJobRecord(record);
  return record;
}

/**
 * Migrate older durable records forward to the current schema. Currently handles
 * v2 -> v3: the tmux supervisor was removed, so any legacy "tmux" kind becomes
 * "process" (such orphaned jobs are finalized as failed on reload anyway) and the
 * tmux/subprocess-only supervisorInfo fields are stripped.
 */
function migrateForward(parsed: Record<string, unknown>): Record<string, unknown> {
  if (parsed.schemaVersion !== 2 || !MIGRATABLE_JOB_RECORD_SCHEMA_VERSIONS.includes(2)) return parsed;

  if (parsed.supervisor === "tmux") parsed.supervisor = "process";
  if (isRecord(parsed.supervisorInfo)) {
    const info = parsed.supervisorInfo;
    if (info.kind === "tmux") info.kind = "process";
    for (const key of REMOVED_SUPERVISOR_INFO_KEYS) delete info[key];
  }
  parsed.schemaVersion = JOB_RECORD_SCHEMA_VERSION;
  return parsed;
}

export function hydrateRuntimeState(_record: JobRecord): JobRuntimeState {
  return createEmptyJobRuntimeState();
}

export function stripRuntimeFieldsForPersistence(value: unknown): unknown {
  return stripRuntimeFields(value, "$", new WeakSet<object>());
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new JobRecordHydrationError(`failed to parse job record JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stripRuntimeFields(value: unknown, path: string, seen: WeakSet<object>): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "function") throw new JobRecordHydrationError(`${path} contains a function`);
  if (typeof value !== "object") return value;

  if (value instanceof Set || value instanceof Map || value instanceof WeakSet || value instanceof WeakMap) {
    throw new JobRecordHydrationError(`${path} contains non-serializable runtime collection`);
  }
  if (value instanceof Promise) throw new JobRecordHydrationError(`${path} contains a Promise`);

  if (seen.has(value)) throw new JobRecordHydrationError(`${path} contains a circular reference`);
  seen.add(value);

  if (Array.isArray(value)) {
    const array = value.map((item, index) => {
      const stripped = stripRuntimeFields(item, `${path}.${index}`, seen);
      return stripped === undefined ? null : stripped;
    });
    seen.delete(value);
    return array;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RUNTIME_ONLY_KEYS.has(key)) continue;
    const stripped = stripRuntimeFields(child, `${path}.${key}`, seen);
    if (stripped !== undefined) output[key] = stripped;
  }
  seen.delete(value);
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

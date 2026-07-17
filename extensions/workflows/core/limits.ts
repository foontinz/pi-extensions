/** Hard limits shared by parsing, execution records, encoding, and persistence. */
export const MAX_WORKFLOW_SCRIPT_BYTES = 1_000_000;
export const MAX_WORKFLOW_METADATA_BYTES = 64_000;
export const MAX_WORKFLOW_INPUT_BYTES = 1_000_000;
export const MAX_WORKFLOW_AGENTS = 100;
export const MAX_WORKFLOW_CONCURRENCY = 8;
export const MAX_WORKFLOW_TIMEOUT_MS = 30 * 60 * 1_000;
export const MAX_AGENT_TIMEOUT_MS = 30 * 60 * 1_000;
export const MAX_AGENT_RETRIES = 5;
export const MAX_WORKFLOW_EVENTS = 100_000;

export const MAX_CANONICAL_JSON_DEPTH = 100;
export const MAX_CANONICAL_JSON_NODES = 100_000;

export const MAX_OUTPUT_BYTES = 1_000_000;
export const MAX_OUTPUT_DEPTH = 50;
export const MAX_OUTPUT_NODES = 25_000;
export const MAX_OUTPUT_COLLECTION_ITEMS = 10_000;
export const MAX_OUTPUT_STRING_BYTES = 256_000;
export const MAX_OUTPUT_BINARY_BYTES = 256_000;

export const WORKFLOW_RUN_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_EVENT_SCHEMA_VERSION = 1 as const;
export const ENCODED_OUTPUT_SCHEMA_VERSION = 1 as const;

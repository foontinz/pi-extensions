/** Frozen safe ceilings shared by admission, execution, persistence, UI, and recovery. */
export const MAX_WORKFLOW_SCRIPT_BYTES = 1_000_000;
export const MAX_WORKFLOW_METADATA_BYTES = 64_000;
export const MAX_WORKFLOW_METADATA_DEPTH = 32;
export const MAX_WORKFLOW_PARSER_NODES = 100_000;
export const MAX_WORKFLOW_ARGS_BYTES = 1_000_000;
export const MAX_WORKFLOW_ARGS_DEPTH = 100;
export const MAX_WORKFLOW_ARGS_NODES = 100_000;
export const MAX_WORKFLOW_HELPER_ITEMS = 10_000;
export const MAX_WORKFLOW_AGENTS = 100;
export const MAX_WORKFLOW_NESTING_DEPTH = 4;
export const MAX_WORKFLOW_GLOBAL_CONCURRENCY = 64;
export const MAX_WORKFLOW_RUN_CONCURRENCY = 32;
export const MAX_WORKFLOW_TIMEOUT_MS = 30 * 60 * 1_000;
export const MAX_WORKFLOW_CLEANUP_GRACE_MS = 5 * 60 * 1_000;
export const MAX_AGENT_TIMEOUT_MS = 30 * 60 * 1_000;

export const MAX_SCHEMA_BYTES = 256 * 1024;
export const MAX_SCHEMA_NODES = 10_000;
export const MAX_SCHEMA_DEPTH = 64;
export const MAX_SCHEMA_REFERENCES = 256;
export const MAX_STRUCTURED_VALUE_BYTES = 1024 * 1024;
export const MAX_STRUCTURED_VALUE_NODES = 10_000;
export const MAX_STRUCTURED_VALUE_DEPTH = 64;

export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_PREVIEW_BYTES = 8 * 1024;
export const MAX_OUTPUT_DEPTH = 64;
export const MAX_OUTPUT_NODES = 100_000;
export const MAX_OUTPUT_COLLECTION_ITEMS = 10_000;
export const MAX_OUTPUT_STRING_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BINARY_BYTES = 4 * 1024 * 1024;

export const MAX_NOTIFICATION_BYTES = 16 * 1024;
export const MAX_STATUS_RESPONSE_BYTES = 50 * 1024;
export const MAX_EVENT_RECORD_BYTES = 256 * 1024;
export const MAX_EVENT_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_EVENT_RECORDS = 250_000;
export const MAX_JOURNAL_RECORD_BYTES = 1024 * 1024;
export const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;
export const MAX_WORKSPACE_ARTIFACT_BYTES = 1024 * 1024 * 1024;
export const MAX_LOG_BYTES = 16 * 1024 * 1024;
export const MAX_FAILURE_DETAIL_BYTES = 16 * 1024;

// Compatibility names internal to the pre-integration tests; not public DSL compatibility.
export const MAX_CANONICAL_JSON_DEPTH = MAX_WORKFLOW_ARGS_DEPTH;
export const MAX_CANONICAL_JSON_NODES = MAX_WORKFLOW_ARGS_NODES;
export const WORKFLOW_RUN_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_EVENT_SCHEMA_VERSION = 1 as const;
export const ENCODED_OUTPUT_SCHEMA_VERSION = 1 as const;

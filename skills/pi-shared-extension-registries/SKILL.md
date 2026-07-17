---
name: pi-shared-extension-registries
description: "Design and review registries shared by multiple Pi extensions when loader imports, reloads, realms, or processes may create separate module instances. Use when one extension exposes registration hooks consumed by other extensions."
---

# Pi Shared Extension Registries

Use this skill when one Pi extension owns a registry and other extensions register or query entries through hooks or imports.

## Core rule

Do not assume a module-local `Map`, `Set`, or mutable singleton is shared across extension boundaries. Different import paths, loader contexts, reloads, realms, or processes may evaluate the same source as distinct module instances.

## Method

1. Search the entire repository for every registry writer, reader, import path, startup hook, reset, and generated file.
2. Determine the required sharing boundary:
   - duplicate module evaluations in one global object;
   - multiple realms or loader contexts in one process;
   - multiple processes;
   - persistence across restarts.
3. Choose the narrowest shared source of truth that satisfies that boundary, in this order:
   1. a loader- or runtime-owned service explicitly passed to extensions;
   2. `globalThis[Symbol.for("<stable-registry-key>")]` when all instances share the same global object;
   3. a state/cache file when instances cannot share memory;
   4. a dedicated single-owner service for genuinely concurrent or multi-process mutation.
4. Normalize and validate keys at every registration and lookup boundary.
5. Define deterministic repeated-registration semantics: replace, merge, reject, or preserve-first. Do not let import order decide accidentally.
6. Define lifecycle ownership explicitly. The owning extension initializes or clears process-scoped state once, before dependent extensions register.
7. Test through consumers' real import paths and through an actual reload, not only with unit tests or type checking.

## File-backed registries

Use a file only when in-memory runtime-owned state cannot span the required boundary.

- Store it in Pi's writable state/cache location, not beside package or extension source unless repository policy explicitly guarantees that location is writable and canonical.
- Resolve one canonical absolute path for all readers and writers.
- Read the current file inside every mutation and query; do not treat a module-local cache as authoritative.
- Serialize each read-modify-write transaction with a single writer or an inter-process lock. Atomic rename alone does not prevent lost updates.
- While holding the lock, write a uniquely named temporary file in the same directory, flush/close it as required, then rename it over the destination. Clean up abandoned temporary files.
- Treat a missing file as empty. For malformed data, warn and quarantine or fail according to repository policy; do not silently overwrite corruption as an empty registry.
- Validate the complete decoded shape before using it.
- If entries are process-scoped, record a process identity that includes more than a bare PID when practical, such as a startup nonce. Ignore stale identities from prior runs.
- Exclude generated files from version control and never store credentials, tokens, callbacks, executable code, or other secrets in them.

## Review checklist

- Have all writers, readers, resets, and import styles been found repository-wide?
- Would duplicate evaluation of the hook module still observe one source of truth?
- Does the selected mechanism actually span the loader contexts, realms, or processes involved?
- Is startup initialization guaranteed to happen before consumer registration?
- Can stale registrations survive reload or restart incorrectly?
- Are keys and values normalized and validated consistently?
- Are repeated registrations deterministic?
- Can concurrent writers lose an update despite atomic replacement?
- Can a crash leave truncated data, abandoned temporary files, or a held lock?
- Is malformed storage surfaced and recovered safely rather than silently erased?
- Is the storage path writable, canonical, secret-free, and ignored by version control?

## Validation

1. Run the repository's normal formatting, type-check, test, and repository-wide check commands.
2. Start or reload a real Pi session.
3. Have at least two separate consumer extensions register through their normal import paths.
4. Confirm the owning extension lists both registrations.
5. Repeat a registration and verify the documented merge behavior.
6. Reload or restart and verify stale-state behavior.
7. If file-backed mutation can overlap, exercise simultaneous writers and confirm no update is lost.

# Pi Workflows

Production local workflow orchestration with durable ownership, canonical metadata, bounded execution, recoverable artifacts, and one clean-break DSL.

## Public tools

- `Workflow` — launch exactly one inline/path/qualified-name source.
- `workflow_status` — owner-scoped durable detail/list query; `scope:"all"` is explicit.
- `workflow_output` — bounded read of tagged `output.json`.
- `workflow_control` — `stop`, `pause`, `resume`, `skip`, `retry`, `pin`, `unpin`.
- `workflow_apply` — verify/apply a workspace artifact into a fresh integration worktree.
- `workflow_release_workspace` — idempotently release retained source/integration workspaces.

Commands:

- `/workflow run <builtin|user|project:id>` — explicit activation.
- `/workflows` — owner-scoped history summary.

## Source and metadata

Exactly one of `script`, `scriptPath`, or `name` is required. Names are always qualified:

```text
builtin:code-review
user:my-review
project:my-review
```

Every source begins with a pure AST-literal export:

```js
export const meta = {
  name: "review",
  description: "Review changed code",
  resumable: false,
  maxAgents: 12,
  capabilities: ["read"],
  phases: [{ id: "review", title: "Review" }]
}
```

The parser rejects dynamic values, calls, identifiers, spreads, computed keys, methods/accessors, template literals, sparse arrays, duplicate/prototype-sensitive keys, TypeScript, missing required fields, duplicate phase IDs, and unknown metadata keys. The declaration is blanked without changing line/column offsets. The copied, hashed `script.js` in the run directory is executed—not the mutable original path.

## Canonical hooks

```js
agent(prompt, { id, ...options })
parallel([() => agent(...), () => agent(...)])
pipeline(items, stage1, stage2, ...)
workflow({ name: "user:child" }, childArgs)
workflow({ scriptPath: "./child.workflow.js" }, childArgs)
phase(id)
log(message)
failures()
args
budget
```

There are no old helper overloads. `parallel(items, fn)`, array-stage `pipeline`, raw nested workflow source, callable `args()`, and agent calls without IDs fail.

Operational leaf failures return `null` and appear in `failures()`. Script, contract, infrastructure, cancellation, pause, and recovery outcomes remain distinct.

## Effects

- `effects:"none"` — enforced read-only tools only; no bash, MCP, or unknown custom tools.
- `effects:"workspace", workspace:"isolated"` — dedicated Git worktree; verified artifact capture by default or explicit recorded discard.
- `effects:"external"` — MCP/network/custom effects; non-cacheable.

Workspace capture records a baseline, full-index binary patch, Git object bundle, tracked/staged/unstaged/untracked changes, deletes, renames, modes and symlinks. Hash verification completes before cleanup. Dirty submodules and unresolved indexes retain the workspace for recovery. Apply never mutates the caller's working tree.

## Structured output

`agent(..., { schema })` uses strict Ajv Draft 2020-12 validation and the mandatory `StructuredOutput({value})` tool in one child session. It supports local refs and standard formats, rejects remote/custom/async schemas, performs no coercion/defaulting/removal, allows at most five submissions, and ignores assistant text. Without a schema, JSON-looking text remains exact text.

## Durability

Each run uses a full UUID and owns:

```text
run.json
script.js
output.json
events.jsonl
notification.json
agents/*.jsonl
artifacts/*
journal.jsonl       # resumable only
```

Snapshots use flushed temp-file replacement plus parent-directory flush where supported. Event/journal streams are append-only and bounded. Runtime controllers/workers/promises never enter persisted records. Output uses a bounded tagged encoding for cycles, aliases, BigInt, undefined, non-finite numbers, Date, Error, Map/Set, and binary values.

The reducer is the sole lifecycle owner. First terminal intent wins, terminal state is sticky, every accepted leaf settles/interupts, cleanup can upgrade to failure/recovery without erasing intent, and notification delivery never changes execution outcome.

## Resume and controls

`resumable:true` enables checksummed journaling, exact source/args/execution-fingerprint validation, concurrent resume claims, torn-tail repair, pure-node cache replay, stable node controls, pause, skip, and conservative retry invalidation. Changed source, args, model, prompts, tools, schema, or engine fingerprint refuses resume. Effectful uncertain work becomes `recovery_required`; it is never rerun automatically.

## Activation and trust

Default activation is `ask`. Headless ask fails closed. `autonomous` and `explicit-only` are explicit settings. Approval binds source hash, concrete model, available tools, capabilities, maximum agents, and budget. Project workflows require active Pi project trust and canonical containment; symlink/traversal escape is rejected.

## Security boundary

The script runs in a worker with `codeGeneration:{strings:false, wasm:false}`. The worker is a liveness/cancellation boundary only. `node:vm` is **not** a confidentiality or integrity sandbox. Leaves explicitly granted workspace/external effects execute locally with those declared capabilities.

# Subagents + Workflows — Engineering Handoff

Status snapshot for the in-process subagents migration and the new `workflows`
extension. Read alongside:
- `docs/subagents-improvement-path.md` — the phased plan + decision log.
- `docs/claude-dynamic-workflows-spec.md` — the reverse-engineered workflow spec.

Last updated: after the subprocess→in-process migration and dead-code removal.

---

## TL;DR

- `run_agent` runs subagents **in-process** via the SDK `createAgentSession`. The
  subprocess/tmux supervisor has been **deleted** (no fallback flag).
- A new **`workflows`** extension exposes a `Workflow` tool that orchestrates many
  in-process subagents (fan-out / pipeline) with caps, backoff, schema retry, usage
  rollup, and background delivery.
- Both paths share one in-process foundation in `extensions/subagents/core/`.
- All workspaces type-check; subagents 87 pass / 0 fail, workflows 8 pass / 0 fail.
- Validated live end-to-end (real model) for single agent, parallel fan-out, and
  `run_agent`.

---

## Architecture

### Shared in-process foundation (`extensions/subagents`)
- `core/in-process-runner.ts`
  - `runSubagentInProcess(opts)` — await-based one-shot: `createAgentSession` →
    `prompt(task)` → typed `SubagentResult` (output, parsed `structuredOutput`,
    usage, error). Used by **workflows**.
  - `createBareResourceLoader(systemPrompt?, appendSystemPrompt[])` — minimal
    `ResourceLoader` that loads **no** extensions/skills (avoids recursion + MCP
    reconnect). `getSystemPrompt()` undefined → pi builds its default coding prompt;
    `getAppendSystemPrompt()` carries our additions (matches old `--append-system-prompt`).
  - `getSharedHandles()` — process-wide singleton `AuthStorage` + `ModelRegistry`
    reused across concurrent sessions.
  - `resolveModelPattern(pattern)` — best-effort `provider/id` / substring → `Model`.
- `supervisor/in-process-supervisor.ts`
  - `startInProcessAgent(opts)` — event/callback-driven driver for `run_agent` jobs:
    creates a session, forwards the live `AgentSessionEvent` stream to `onEvent`
    (shapes match the old `--mode json` stdout, so the existing `processEvent`
    machinery is reused unchanged), and calls `onDone({aborted,error})` on completion.
    Returns `{ abort(), modelResolved }`.
- `core/types.ts` — `SubagentResult`, `UsageStats`, `addUsage()`, durable `JobRecord`
  schema + state-machine event/phase types.

### `run_agent` job lifecycle (`extensions/subagents/index.ts`)
- `startAgentJob` → worktree prep (cwd) → build `JobRecord`/`AgentJob`
  (`supervisor: "process"`) → `launchInProcessJob`.
- `launchInProcessJob` → `inProcessLauncher(...)` (seam; default `startInProcessAgent`)
  → events into `processEvent`/`addLog`/`updateFromAssistantMessage`; `onDone` →
  `finalizeInProcessJob` → `finalizeJob` (status from stopReason/abort/timeout).
- `stop_agent`/timeout → `terminateJob` → `inProcessHandle.abort()` →
  `onDone(aborted)` → cancelled/timeout via the state machine (first-terminal-intent).
- Hydration: a persisted `running` record with **no** live handle is finalized as
  **failed** on reload (in-process work can't survive a parent restart); live
  in-memory jobs are left alone.
- Preserved: concurrency caps, worktree(cwd), waiters/polling, status widget,
  background callbacks (`pi.sendUserMessage`, idle-aware), persistence for
  observability/callbacks.

### `workflows` extension (`extensions/workflows/index.ts`)
- `Workflow` tool: `{ script | scriptPath | name, args, timeoutMs, background }`.
  Inline `script` is persisted under `<agentDir>/workflows/runs/` and the path is
  returned. Background (default) returns `{runId,status,scriptPath}` and delivers a
  `<workflow-notification>` on completion; aborts on session shutdown.
- `WorkflowRunner` (exported, testable via an injected `AgentExecutor`):
  - hooks `agent / parallel / pipeline / workflow / phase / log / args / failures`
  - concurrency semaphore (8), agent cap (100), provider-429 backoff w/ jitter,
    stall watchdog, schema validate+retry, usage rollup, per-agent `cwd`.
  - VM runner with **no sandboxing** (script is trusted, model-authored on opt-in).

---

## What's done

- Phase 1: P1.1 JSON addendum, P1.2 typed result, P1.3 parallel worktree create
  (pool 4), P1.4 lean default tools.
- In-process primitive + `workflows` engine (above).
- Full `run_agent` subprocess→in-process migration; **all tmux/subprocess dead code
  removed** (~450 lines out of `index.ts`, `tmux-supervisor.ts` deleted,
  `tmuxSessionName` removed, formatter branches pruned).
- Spikes A (concurrency), B (re-entrancy from the tool's `call()`), E (shared
  auth/model) validated live.

## What's left

Priority order:

1. **Per-agent git worktree isolation for in-process agents** (main functional gap).
   Today agents share the workflow/job cwd; only a manual `agent({ cwd })` knob
   exists. Plan: extract the worktree-create logic currently inlined in
   `index.ts` (`prepareWorktreeForSpawn` + `copyConfiguredFiles` + post-copy +
   cleanup) into a standalone, lifecycle-free `createWorktree(sourceCwd) → { cwd,
   dispose() }`, then add `agent({ isolate: true })` to `WorkflowRunner` (create on
   start, dispose on end). Matters mainly for **parallel write-heavy** agents;
   read-mostly fan-out is fine on a shared cwd (pi serializes same-file writes via
   `withFileMutationQueue`).
2. **Shared MCP gateway proxy** (P3.3) — only if workflow/subagents need MCP. Route
   child MCP calls to the parent's already-connected adapter instead of reconnecting.
3. **Resume / journals** (`resumeFromRunId`, longest-unchanged-prefix cache) —
   deferred to **v2**; would require determinism stripping (also deferred).

Polish / hardening:
- Slim the durable `JobRecord` schema: it still carries vestigial `"tmux"`
  `SupervisorKind` + supervisor-info fields for back-compat with old persisted
  records. Remove in a future schema bump with a hydration migration.
- `rawLog*` cap reporting in the poll summary is now moot (always 0) — remove.
- 3 `poll_agent` characterization tests are `test.skip` (the `poll_agent` tool isn't
  registered) — wire up or delete.
- Add tests for `resolveModelPattern` and bare-loader system-prompt composition.

Dropped (won't do): VM sandboxing; subprocess/tmux supervisor.

---

## How to work here

- Build/check: `npm run check` (all workspaces). Tests: `npm run test`.
- Per-workspace: `npm run check -w pi-extension-subagents`, `... -w pi-extension-workflows`.
- Test seam: `__subagentsTest.setInProcessLauncher(fn)` injects a fake in-process
  launcher so subagent jobs can be driven without a live model; `workflows` tests
  inject an `AgentExecutor` into `WorkflowRunner`. Use these to stay hermetic.
- Live smoke (needs configured auth/model): import `runSubagentInProcess` or drive
  `run_agent` via the registered tool and poll `__subagentsTest.getJob(id)`.

### Gotchas
- VM-created values (arrays/objects from a `Workflow` script) are **cross-realm**:
  use `Array.from(...)`/structural compares in tests, and the runner spreads tool
  arrays before passing them on.
- The bare `ResourceLoader` must return `getSystemPrompt() === undefined` to keep
  pi's default coding prompt; put additions in `getAppendSystemPrompt()`.
- In-process subagents are session-bound and **non-recoverable** across restarts by
  design — don't reintroduce reattach logic for them.

## Key files
- `extensions/subagents/index.ts` — tools, job lifecycle, persistence, status.
- `extensions/subagents/core/in-process-runner.ts` — await runner, loader, handles.
- `extensions/subagents/supervisor/in-process-supervisor.ts` — event-driven driver.
- `extensions/subagents/core/{types,state-machine,invariants,hydration,job-store}.ts`.
- `extensions/workflows/index.ts` — `Workflow` tool + `WorkflowRunner`.
- `extensions/workflows/test/runner.test.ts` — runner unit tests.
- `extensions/subagents/test/characterization/tool-contracts.test.ts` — tool contracts.

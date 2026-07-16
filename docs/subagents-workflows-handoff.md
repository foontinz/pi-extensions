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
  - `getSharedModelRuntime()` — process-wide async `ModelRuntime` singleton reused
    across concurrent sessions.
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

1. ~~**Per-agent git worktree isolation for in-process agents**~~ **(DONE).**
   Worktree-create/cleanup logic was extracted out of `index.ts` into a standalone,
   lifecycle-free module `subagents/workspace/create-worktree.ts` exposing
   `prepareWorktree(sourceCwd, opts) → { cwd, worktree?, warning? }`,
   `createWorktree(sourceCwd, opts) → { …, dispose(status?) }`, plus the shared
   creation-slot semaphore and git-root/cleanup helpers (`cleanupWorktreeAsync`,
   `shouldRetainWorktree`, `getGitRoot*`). `run_agent` now calls `prepareWorktree`
   (keeping its job-aware cleanup wrappers); `WorkflowRunner` gained
   `agent({ isolate: true })` which provisions a dedicated worktree from the resolved
   cwd and disposes it (completed→remove, failed→retain per `keepWorktree`) when the
   agent finishes. Matters mainly for **parallel write-heavy** agents; read-mostly
   fan-out is fine on a shared cwd (pi serializes same-file writes via
   `withFileMutationQueue`).
2. ~~**Shared MCP gateway proxy** (P3.3)~~ **(DONE).** Child sessions load no
   extensions, so they get an opt-in `mcp` gateway tool (`run_agent({ mcp: true })`,
   `agent({ mcp: true })`) backed by a **process-wide** MCP connection pool
   (`subagents/mcp/{config,gateway,proxy-tool}.ts`): each configured server (from
   `mcp.json` / `.pi/mcp.json` / `.mcp.json`) is connected once per process and reused
   across all agents, disposed on session shutdown. Supports stdio + HTTP(bearer);
   OAuth/elicitation UI out of scope. Built on `@modelcontextprotocol/sdk`.
3. **Resume / journals** (`resumeFromRunId`, longest-unchanged-prefix cache) —
   deferred to **v2**; would require determinism stripping (also deferred).

Polish / hardening — **all DONE**:
- Durable `JobRecord` schema slimmed: bumped to **v3**; `SupervisorKind` is now
  `["process"]` only and `DurableSupervisorInfo` dropped the tmux/subprocess fields
  (`pid`, `tmuxSession`, `stdoutPath`, `stderrPath`, `exitCodePath`). `hydrateJobRecord`
  migrates v2 records forward (tmux→process, vestigial fields stripped).
- `rawLog*` cap reporting removed from the poll formatter + `PollFormatOptions`
  (`MAX_RAW_LOG_BYTES`/`MAX_LOG_READ_BYTES` constants deleted).
- The 6 `test.skip` `poll_agent` characterizations were deleted (the callback-based
  design has no `poll_agent` tool; the formatters are covered elsewhere).
- Added tests for `resolveModelPattern`, bare-loader system-prompt composition, the
  v2→v3 hydration migration, and the MCP gateway/proxy (real stdio MCP server).

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
- `extensions/subagents/workspace/create-worktree.ts` — standalone worktree
  provisioning (`prepareWorktree`/`createWorktree`/cleanup) shared by `run_agent`
  + `workflows`.
- `extensions/subagents/mcp/{config,gateway,proxy-tool}.ts` — process-wide shared
  MCP connection pool + injectable `mcp` proxy tool for child sessions.
- `extensions/subagents/core/in-process-runner.ts` — await runner, loader, handles.
- `extensions/subagents/supervisor/in-process-supervisor.ts` — event-driven driver.
- `extensions/subagents/core/{types,state-machine,invariants,hydration,job-store}.ts`.
- `extensions/workflows/index.ts` — `Workflow` tool + `WorkflowRunner`.
- `extensions/workflows/test/runner.test.ts` — runner unit tests.
- `extensions/subagents/test/characterization/tool-contracts.test.ts` — tool contracts.

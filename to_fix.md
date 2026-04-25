# Subagents extension: remaining findings to fix

This is the remaining issue list after the following fixes were committed:

- `2763497 Harden subagent log and tool defaults`
- `efcc473 Persist subagent result observability`
- `5d7c3a4 Limit subagent concurrency and improve supervision`

## P1 — high priority

### 1. Abort-aware startup

`run_agent` still does not fully respect tool-call cancellation during startup/preparation.

Remaining work:

- Thread the `AbortSignal` through worktree prep, copy/glob work, postCopy scripts, prompt creation, and tmux launch.
- Abort/kill postCopy scripts where possible.
- Clean up partial prompt dirs and temp worktrees when startup is cancelled.
- Add tests for abort during worktree prep and postCopy.

### 2. tmux degraded-state handling

If tmux disappears or becomes unavailable mid-job, jobs can still remain in a weak/running-looking state and recovery guidance is limited.

Remaining work:

- Track repeated tmux-unavailable observations per job.
- Surface degraded status/details in `poll_agent` and the status widget.
- After a threshold, mark the job failed/unknown or provide explicit recovery instructions.
- Improve stop/timeout behavior when tmux is unavailable.
- Add tests for tmux disappearing mid-job and session-gone-without-exit-file cases.

### 3. Persistence/hydration error visibility

Persistence failures and corrupt/unreadable job records are still mostly silent.

Remaining work:

- Add diagnostics logging for persistence and hydration failures.
- Quarantine corrupt job records, e.g. `*.corrupt.<timestamp>`.
- Surface persistence/hydration warnings in status/poll output.
- Avoid silent divergence between live tmux state and durable records.
- Add tests for corrupt records, unreadable records, and write failures.

### 4. Diagnostics / doctor tool

There is still no first-class diagnostics tool for incident response.

Possible tool: `diagnose_agent({ id })` or `subagents_doctor`.

Should report:

- tmux availability/version
- tmux session existence
- raw stdout/stderr paths and sizes
- stdout/stderr offsets vs file sizes
- latest log/output/event age
- timeout deadline
- cleanup phase/error
- worktree path existence and retention mode
- stale lock files
- corrupt/quarantined records
- suggested recovery commands (`tmux attach`, `tail`, `git worktree prune`, etc.)

## P2 — medium priority

### 5. Stable public result schemas

Tool result `details` are still mostly defined by `summarizeJob()` and expose internal/debug fields directly.

Remaining work:

- Define explicit `RunAgentDetails`, `PollAgentDetails`, and `StopAgentDetails` types/schemas.
- Document stable vs debug/internal fields.
- Move paths, tmux session names, raw log paths, worktree internals, and postCopy outputs under a `debug` object or verbosity/debug flag.
- Add README tool-contract examples.

### 7. Worktree per-call controls

Worktree creation is still automatic inside git repos unless repo config disables it.

Remaining work:

- Add a `run_agent` parameter such as `worktree: true | false | "auto"`.
- Support read-only/recon subagents running in-place when explicitly requested.
- Document safety/performance tradeoffs.
- Add tests for per-call worktree override.

### 8. Git error distinction

`getGitRoot()` still treats many git failures as “not in a repo”.

Remaining work:

- Distinguish not-a-repo from git unavailable, invalid cwd, and unexpected git errors.
- Fail closed or warn prominently when worktree isolation was expected but git failed.
- Add tests for git missing/error cases.

### 9. Finish callback hardening

Subagent completion callbacks are still injected into the parent conversation as synthetic user/follow-up/steer messages.

Remaining work:

- Wrap callback output in a clearly untrusted data block.
- Add guidance that callback content is subagent output, not direct user instruction.
- Consider an option to disable auto-callbacks.
- Add tests for callback formatting and injection-resistant wrapping.

### 10. Callback delivery markers

Callback markers are still not fully two-phase.

Remaining work:

- Use `pending` marker before delivery and `delivered` marker after successful `sendUserMessage`.
- Retry pending callbacks on startup/reload.
- Handle shutdown between marker creation and message delivery.
- Add tests for interrupted delivery.

### 11. Stop/timeout semantics

Stopping tmux jobs is still abrupt and descendant cleanup is not guaranteed.

Remaining work:

- Add graceful termination first, then hard kill after a grace period.
- Consider process-tree/process-group tracking where possible.
- Report whether output was drained.
- Add optional `stop_agent.waitMs`.
- Add tests for graceful/hard kill paths.

## P3 — lower priority / polish

### 12. Named-agent discovery

There is still no first-class discovery tool/command for named agents.

Options:

- Add `list_agents` tool.
- Add `run_agent({ agent: "?" })` discovery behavior.
- Include available agents in a relevant list/status output.
- Add tests for user/project/both scopes and precedence.

### 13. Status widget short job IDs

The status widget still needs more actionable identifiers.

Remaining work:

- Include a short job id column/suffix.
- Consider showing failed/completed jobs longer when unpolled.
- Include degraded/cleanup-failed indicators.

### 14. `.pi/worktree.json` alias

The config file is still named `.pi/worktree.env` even though it is strict JSON.

Remaining work:

- Support `.pi/worktree.json` as a clearer alias.
- Keep `.pi/worktree.env` backward-compatible.
- Document precedence when both files exist.

### 15. postCopy shell portability

postCopy still relies on shell behavior that may be less portable than desired.

Remaining work:

- Prefer `/bin/sh -c`, or validate/configure shell explicitly.
- Avoid assuming `/bin/bash` or `$SHELL -lc` works everywhere.
- Add tests/docs for shell selection.

### 16. File permission migration

New files are mostly created safely, but older logs/registry files may be world-readable.

Remaining work:

- Add one-time chmod/migration for existing subagent logs and extension registry files.
- Ensure registry writers use `0600`.
- Prune stale per-PID registry files.

### 17. Child Pi isolation options

Child Pi still loads normal config/extensions, which can cause nested subagents or extension side effects.

Remaining work:

- Document this more prominently.
- Consider options to disable nested subagents.
- Consider minimal-extension child mode or extension denylist.

### 18. Broader fake tmux/fake Pi E2E tests

The test suite still lacks full fake-supervisor integration coverage.

Remaining work:

- Add isolated store-path overrides so tests never touch real `~/.pi/agent/subagents`.
- Add fake tmux/fake Pi end-to-end tests for run/poll/stop.
- Add tests for tmux missing, malformed exit files, session disappearing, reload of running jobs.
- Add raw log limit/retention integration tests.

### 19. Architecture modularization

`extensions/subagents/index.ts` remains large and owns many responsibilities.

Remaining work:

- Extract tool handlers, tmux supervisor, worktree manager, job store, log parser, UI widget, callbacks, and formatting.
- Complete `JobActor`/`JobRegistry` migration.
- Consolidate duplicated types/state between `index.ts` and `core/types.ts`.

## Recently fixed / no longer primary open items

- Raw log byte guard added with `PI_SUBAGENTS_MAX_RAW_LOG_BYTES`.
- Default tool exposure changed to safe read-only tools.
- Durable compact observability added for final output/recent logs.
- Poll cursor-window metadata added (`logWindowStartSeq`, `logWindowEndSeq`, `logsTruncated`, `cursorExpired`) with expired-cursor text and tests.
- Stale log cursor monitor crash mitigated.
- Idle zero-byte output polling no longer persists unchanged records.
- `tmux -V` availability is cached.
- Global refresh uses batched `tmux list-sessions`.
- Global/per-repo concurrency limits added.
- Basic tmux and `/bin/sh` preflight added.
- Cleanup-pending/failed jobs are protected from pruning.

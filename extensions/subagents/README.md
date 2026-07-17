# pi-extension-subagents

Non-blocking Pi subagents exposed as tools.

**Execution model:** `run_agent` runs subagents **in-process**, via the SDK
`createAgentSession` (no `pi` subprocess, no tmux). The job starts asynchronously and returns a
job id immediately; live `AgentSession` events stream into the log/status/callback machinery,
and the final result is delivered back to the parent session on completion. The legacy
tmux/subprocess supervisor has been removed.

In-process subagents are bound to the parent process: they are aborted on session shutdown/
reload and **cannot be recovered after a restart** (a persisted record that was still running is
marked failed on reload).

Subagent execution is session-bound: running child jobs are stopped when the parent Pi session shuts down or reloads. Persistence is used for terminal summaries, callback delivery/retry, log/debug data, and cleanup retry; it is not a durable detached-execution recovery system.

## Tools

- `list_agents` — lists user-owned markdown-backed named agents discoverable by `run_agent` from `~/.pi/agent/agents`.
- `run_agent` — starts a session-bounded **in-process** subagent and returns a job id immediately. Finished subagents report their final output back to the parent Pi session when possible. Omit `model` unless the user explicitly requested a specific model; the subagent otherwise uses your default model configuration. Recursive subagent tools are denied in child allowlists by default. Pass `mcp: true` to give the subagent a shared `mcp` gateway tool that forwards to a process-wide MCP connection pool (servers connected once, reused across agents).
- `stop_agent` — terminates a running background job.

Tool names use underscores for provider/tool-call compatibility; labels render as “List Agents”, “Run Agent”, and “Stop Agent”. Running/recent jobs are also shown in Pi’s subagents status/widget with their label, runtime, status, and compact state.

## Basic flow

```jsonc
// 1. Optionally list named agents
list_agents({})

// 2. Start a job
run_agent({
  "task": "Search the repo for auth middleware and summarize the relevant files"
})

// Omit tools for the portable safe default. Pi will use whichever safe read-only
// tools are active in the parent session.
run_agent({
  "task": "Inspect the repository and summarize likely correctness bugs"
})

// Pass tools explicitly only when more than the safe read-only default is needed.
// In Pi sessions where grep/find/ls are not separate active tools, use bash for
// read-only shell inspection only when shell access is acceptable.
run_agent({
  "task": "Run the test suite and summarize failures",
  "tools": ["read", "bash"]
})

// Without schema, final output retains the legacy assistant-text behavior.
// Pass a Draft 2020-12 object schema for a validated StructuredOutput return.
run_agent({
  "task": "Return the top three suspect files",
  "schema": {
    "type": "object",
    "properties": { "files": { "type": "array", "items": { "type": "string" }, "maxItems": 3 } },
    "required": ["files"],
    "additionalProperties": false
  }
})

// Disable worktree isolation for read-only/recon work that needs live uncommitted files.
run_agent({
  "task": "Inspect my current working tree and summarize unstaged changes",
  "worktree": false
})

// Retain a temp worktree only if the subagent fails or is cancelled/stopped.
run_agent({
  "task": "Try the risky migration in isolation",
  "keepWorktree": "onFailure"
})

// 3. The final result is sent back to the parent Pi session when the job finishes.
// Terminal job details include `result: { output, structuredOutput?,
// structuredOutputOutcome?, usage, error?, truncated? }` alongside the legacy
// `finalOutput` preview fields. In schema mode assistant text is ignored.
// If you need to wait for results, end the turn rather than blocking with sleep/polling;
// Pi will wake you up when subagent callbacks arrive.

// 4. Cancel if no longer needed. stop_agent aborts the in-process session and
// force-cancels after waitMs/default grace if the job has not finished.
stop_agent({ "id": "agent_...", "reason": "not needed", "waitMs": 5000 })
```

## Temporary git worktrees

When `run_agent` starts inside a git repository, it creates a temporary detached git worktree and runs the child agent from the matching path inside that worktree. If the current directory is not inside a git repo, no worktree is created and the child agent runs in the original directory. Per call, `worktree: false` disables isolation and runs in-place; `worktree: true` requires git worktree isolation and fails startup if the cwd is not inside a git repo. Omit `worktree` for the default auto/config behavior. Per call, `keepWorktree` controls retention: omit it or set `"never"` to remove the temp worktree, set `"onFailure"` to retain failed/cancelled/stopped jobs, or set `"always"` to retain every temp worktree.

The worktree config file is discovered at `.pi/worktree.json` in the git repo root (not in `~/.pi/agent`). All `copy`, `exclude`, and `postCopy.cwd` paths are relative to that repo root. The child process starts from the same repo-relative cwd as the parent `run_agent` call, but inside the temp worktree.

By default the worktree is created from `HEAD`, so uncommitted or untracked files are not visible unless copied in explicitly. Add `.pi/worktree.json` to copy selected repo-relative files or directories into the temp worktree at spawn time and optionally run setup commands after copying:

```json
{
  "copy": [
    ".gitignore",
    "README.md",
    "extensions/*",
    { "from": ".env.local", "optional": true },
    { "from": "local-config.json", "to": "config/local.json", "optional": true },
    { "from": "src/**/*.ts", "to": "source-snapshot", "optional": true }
  ],
  "exclude": [
    "extensions/experimental/**",
    "src/**/*.test.ts"
  ],
  "postCopy": [
    "npm install --ignore-scripts --no-audit --no-fund",
    { "command": "./scripts/bootstrap-subagent.sh", "cwd": ".", "timeoutMs": 120000, "optional": true }
  ]
}
```

Supported fields:

- `enabled` — optional boolean. Set `false` to disable temp worktree creation for this repo.
- `base` — optional non-empty git revision for `git worktree add`; defaults to `HEAD`.
- `copy` — optional array of strings or `{ from, to?, optional? }` objects. Paths must be relative to the repo root and may not point at `.git` metadata. Entries may be exact files/directories or glob patterns using `*`, `?`, and `**`. Directory copies are recursive. For glob objects with `to`, matched paths are copied under `to` while preserving their path relative to the glob's non-wildcard base. Symlinks are copied as symlinks only when their target resolves inside the repo root and not into `.git` metadata; outbound or `.git`-targeting symlinks are rejected instead of being copied into the worktree.
- `exclude` / `exclusions` — optional array of repo-relative exclusion patterns using the same glob syntax. These are aliases; use one or the other, not both. Exclusions are only set here; `!pattern` entries inside `copy` are not supported.
- `postCopy` / `postCopyScripts` — optional array of shell commands run after `copy` and before the child Pi process starts. These are aliases; use one or the other, not both. Entries can be strings or `{ command, cwd?, timeoutMs?, optional?, env? }` objects. `cwd` is repo-relative and defaults to the worktree root. `timeoutMs` defaults to 120000 and is capped at 1800000. Config is normalized and validated before the temp worktree is created. Commands run via `/bin/sh -c` rather than a login/user shell. Because these commands are repo-controlled and are not constrained by the subagent tool allowlist, only use `postCopy` in trusted repos.

`keepWorktree` is a `run_agent` input, not a `.pi/worktree.json` field. Any `keepWorktree` value in `.pi/worktree.json` is ignored.

Security note: `postCopy` commands are arbitrary shell commands from the repository. They run without an interactive approval prompt, with a minimal inherited environment rather than the full Pi process environment: only common process keys needed for shell/package-manager operation (for example `PATH`, `HOME`, `SHELL`, temp/locale/user keys when present) are preserved, then per-command `env` entries are added. Do not put secrets in repo-controlled `.pi/worktree.json`; use public/non-secret `env` values only.

Temp worktrees are removed when Pi observes that the job finished, failed, or was stopped unless the `run_agent` `keepWorktree` input retains them. Running jobs are bounded to the parent Pi session: subagents run **in-process**, so on graceful session shutdown or `/reload` Pi aborts running subagents after the stop grace period. In-process subagents cannot survive a parent restart; a persisted job still marked running on the next session load is abandoned (finalized as failed) rather than adopted. Cleanup state is persisted and retried if a previous cleanup attempt was interrupted or failed.

## Named markdown agents

`run_agent` can run named user-owned agents from:

- `~/.pi/agent/agents/*.md`

Project-local `.pi/agents` prompts are intentionally not discoverable by these tools.

Agent files use YAML frontmatter:

```md
---
name: scout
description: Fast read-only repository reconnaissance
# Omit tools for the portable safe read-only default, or specify only tools
# expected to be active in the parent session, for example: read, bash.
model: claude-haiku-4-5
thinking: low
---

You are a fast reconnaissance subagent. Find relevant files and return a concise summary.
```

## Notes

- Subagents run **in-process** (via the SDK `createAgentSession`, no `pi` subprocess / tmux). Job metadata is persisted under `~/.pi/agent/subagents/` for observability and callback delivery, but running jobs are bounded to the parent Pi session. Graceful `/reload`, session switch, and parent Pi shutdown abort running subagents after the stop grace period. Because in-process work cannot survive a parent restart, a persisted job still marked running on the next session load is abandoned (finalized as failed) rather than adopted. Use `stop_agent` to terminate a running job explicitly; it aborts the in-process session and force-cancels after the grace period (`waitMs`, default 5000, max 60000) if needed.
- Child tool access is limited to tools active in the parent Pi session. If `tools` is omitted, the child receives only the active safe read-only default tools: `read`, `grep`, `find`, and `ls` when available. For portability, omit `tools` unless extra access is needed; some Pi sessions expose search/list operations through `bash` instead of separate `grep`/`find`/`ls` tools. Explicitly requested unavailable safe-default tools are ignored, but any other unavailable tool is refused. Recursive subagent tools (`run_agent`, `list_agents`, `stop_agent`) are denied by default. Pass tools explicitly to grant write, execute, network, or other higher-risk capabilities.
- Running job concurrency is capped by default to protect the host: `PI_SUBAGENTS_MAX_RUNNING` defaults to 10 globally and `PI_SUBAGENTS_MAX_RUNNING_PER_REPO` defaults to 10 per repository/path. Set either to `0` to disable that limit. Temporary worktree provisioning is also bounded (`PI_SUBAGENTS_MAX_WORKTREE_CREATIONS`, default 4).
- The nested session does not inherit the parent conversation. Put all needed context in the task, named/ad-hoc system prompt, files, or repo context.
- **Transcript persistence (read/grep, no extra tool):** each job's full session transcript (user turn, assistant text, tool calls, thinking, outputs) is persisted as JSONL under an isolated per-job directory `~/.pi/agent/subagents/owners/<owner>/sessions/<jobId>/` via `SessionManager.create`. The directory is reported as `Transcript:` in both the `run_agent` start result and the finish callback, so the parent agent can `read`/`grep` it on demand to inspect progress or what the subagent actually did (don't poll — the final result arrives via callback). These transcripts are pruned on session start after 3 days (`core/run-archive.ts`, shared with the `workflows` extension).
- Do not pass a `model` override for routine delegation/review. Only set `model` when the user explicitly asks for that exact model/provider; otherwise the child uses its configured default, avoiding provider/API-key mismatches.
- Child sessions use a **bare `ResourceLoader`** that loads no extensions or skills (pi's default coding system prompt is preserved via append-only additions). This avoids reloading the whole extension stack (and MCP reconnection / self-recursion) per subagent. MCP is opt-in via `mcp: true`, which injects a shared `mcp` gateway tool backed by a process-wide connection pool (see "Shared MCP gateway" below). The `tools` allowlist still constrains tool exposure per run, and recursive subagent tools are denied by default.

## Shared MCP gateway

Because child sessions load no extensions, they do not inherit the parent's `mcp`
tool. Passing `mcp: true` to `run_agent` (or `agent({ mcp: true })` in a workflow)
injects a thin `mcp` gateway tool that forwards to a **process-wide** MCP connection
pool (`mcp/`). Each configured MCP server is connected **once per process** and reused
across every subagent / workflow agent, so a fan-out never reconnects an MCP adapter
per child. Server definitions are read from `<agentDir>/mcp.json`, then project-local
`.mcp.json` and `.pi/mcp.json` (project overrides global by server name).

The gateway tool modes: no args → list servers; `{ server }` → list its tools;
`{ search }` → find tools; `{ describe }` → show a tool's parameters; `{ tool, args }`
→ call a tool (`args` is a JSON string). Only stdio (`command`) and HTTP (`url`, with
optional `auth: "bearer"` + `bearerToken`) servers are supported; interactive-only
concerns (OAuth login flows, elicitation UI) are out of scope. Connections are torn
down on session shutdown.

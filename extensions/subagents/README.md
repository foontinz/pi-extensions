# pi-extension-subagents

Non-blocking Pi subagents exposed as tools.

## Tools

- `run_agent` — starts a detached tmux-supervised `pi --mode json -p --no-session` process and returns a job id immediately. Startup/prep failures return a failed job record when possible so they can be inspected with `poll_agent`. Omit `model` unless the user explicitly requested a specific model; the child Pi will otherwise use its normal/default model configuration.
- `poll_agent` — polls compact status for a job id. Omit `id` to list jobs. Set `verbosity: "logs"` for recent summarized logs or `verbosity: "full"` to retrieve the final assistant output up to tool output limits.
- `stop_agent` — terminates a running background job.

Tool names use underscores for provider/tool-call compatibility; labels render as “Run Agent”, “Poll Agent”, and “Stop Agent”. Running/recent jobs are also shown in Pi’s subagents status/widget with their label, runtime, status, and compact state.

## Basic flow

```jsonc
// 1. Start a job
run_agent({
  "task": "Search the repo for auth middleware and summarize the relevant files",
  "tools": ["read", "grep", "find", "ls"]
})

// 2. Poll sparingly; default verbosity is a few-line status.
// Reuse nextSeq from the previous poll and prefer 10-30s waits for running jobs.
poll_agent({ "id": "agent_...", "sinceSeq": 0, "waitMs": 15000 })

// 2b. Only when needed, ask for summarized logs or the full final assistant output.
poll_agent({ "id": "agent_...", "sinceSeq": 12, "verbosity": "logs" })
poll_agent({ "id": "agent_...", "verbosity": "full" })

// 3. Cancel if no longer needed
stop_agent({ "id": "agent_...", "reason": "not needed" })
```

## Temporary git worktrees

When `run_agent` starts inside a git repository, it creates a temporary detached git worktree and runs the child agent from the matching path inside that worktree. If the current directory is not inside a git repo, no worktree is created and the child agent runs in the original directory.

The worktree config file is discovered at `.pi/worktree.env` in the git repo root (not in `~/.pi/agent`). All `copy`, `exclude`, and `postCopy.cwd` paths are relative to that repo root. The child process starts from the same repo-relative cwd as the parent `run_agent` call, but inside the temp worktree.

By default the worktree is created from `HEAD`, so uncommitted or untracked files are not visible unless copied in explicitly. Add `.pi/worktree.env` to copy selected repo-relative files or directories into the temp worktree at spawn time and optionally run setup commands after copying:

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
  ],
  "keepWorktree": "onFailure"
}
```

Supported fields:

- `enabled` — optional boolean. Set `false` to disable temp worktree creation for this repo.
- `base` — optional non-empty git revision for `git worktree add`; defaults to `HEAD`.
- `copy` — optional array of strings or `{ from, to?, optional? }` objects. Paths must be relative to the repo root and may not point at `.git` metadata. Entries may be exact files/directories or glob patterns using `*`, `?`, and `**`. Directory copies are recursive. For glob objects with `to`, matched paths are copied under `to` while preserving their path relative to the glob's non-wildcard base. Symlinks are copied as symlinks only when their target resolves inside the repo root and not into `.git` metadata; outbound or `.git`-targeting symlinks are rejected instead of being copied into the worktree.
- `exclude` / `exclusions` — optional array of repo-relative exclusion patterns using the same glob syntax. These are aliases; use one or the other, not both. Exclusions are only set here; `!pattern` entries inside `copy` are not supported.
- `postCopy` / `postCopyScripts` — optional array of shell commands run after `copy` and before the child Pi process starts. These are aliases; use one or the other, not both. Entries can be strings or `{ command, cwd?, timeoutMs?, optional?, env? }` objects. `cwd` is repo-relative and defaults to the worktree root. `timeoutMs` defaults to 120000 and is capped at 1800000. Config is normalized and validated before the temp worktree is created; confirmation shows the normalized command, cwd, timeoutMs, optional flag, and env keys (values hidden). Because these commands are repo-controlled and are not constrained by the subagent tool allowlist, Pi asks for interactive confirmation before running them and refuses them in non-interactive sessions.
- `keepWorktree` — optional `false`, `true`, `"never"`, `"always"`, or `"onFailure"`. Retained worktrees are useful when a subagent fails before you can inspect artifacts. `"onFailure"` retains failed and cancelled/stopped jobs.

Security note: `postCopy` commands are arbitrary shell commands from the repository. Only approve them in trusted repos/configs. They run with a minimal inherited environment rather than the full Pi process environment: only common process keys needed for shell/package-manager operation (for example `PATH`, `HOME`, `SHELL`, temp/locale/user keys when present) are preserved, then per-command `env` entries are added. The confirmation dialog lists inherited keys and per-command env keys but never prints env values. Do not put secrets in repo-controlled `.pi/worktree.env`; use public/non-secret `env` values only.

Temp worktrees are removed when Pi observes that the job finished, failed, or was stopped unless `keepWorktree` retains them. Running jobs survive Pi `/reload`, session switches, and parent Pi exit because tmux supervises the child process; if Pi is not running when a job exits, cleanup happens on the next reload/poll that observes completion. Cleanup state is persisted and retried if a previous cleanup attempt was interrupted or failed.

## Named markdown agents

`run_agent` can run named agents from:

- `~/.pi/agent/agents/*.md` (default `agentScope: "user"`)
- nearest project `.pi/agents/*.md` when `agentScope` is `"project"` or `"both"`

Project agents are repo-controlled prompts and require interactive confirmation by default.

Agent files use YAML frontmatter:

```md
---
name: scout
description: Fast read-only repository reconnaissance
tools: read, grep, find, ls
model: claude-haiku-4-5
thinking: low
---

You are a fast reconnaissance subagent. Find relevant files and return a concise summary.
```

Project agents with the same name override user agents when `agentScope: "both"`.

## Notes

- Jobs are supervised by tmux and persisted under `~/.pi/agent/subagents/`, so running jobs survive `/reload`, session switch, and parent Pi exit. Use `stop_agent` to terminate a running job.
- Attach to a live job with `tmux attach -t <session>`; `run_agent` prints the exact session name.
- `poll_agent` returns summarized/capped in-memory logs. Full raw child process streams are persisted under `~/.pi/agent/subagents/logs/*.stdout.jsonl` and `*.stderr.log` for manual inspection.
- `poll_agent` defaults to compact summary output to avoid flooding the main model context.
- Child tool access is limited to tools active in the parent Pi session. Requested agent/tool allowlists must be a subset of parent active tools.
- The child process uses `--no-session`: it does not inherit the parent conversation and does not write a normal Pi session file. Put all needed context in the task, named/ad-hoc system prompt, files, or repo context.
- Do not pass a `model` override for routine delegation/review. Only set `model` when the user explicitly asks for that exact model/provider; otherwise the child Pi uses its configured default, avoiding provider/API-key mismatches.
- The child process loads normal Pi configuration/extensions, skills, and context files; these are not model-disableable from `run_agent`.

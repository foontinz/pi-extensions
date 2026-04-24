# pi-extension-subagents

Non-blocking Pi subagents exposed as tools.

## Tools

- `run_agent` — starts a separate `pi --mode json -p --no-session` process and returns a job id immediately.
- `poll_agent` — polls compact status for a job id. Omit `id` to list jobs. Set `verbosity: "logs"` for recent raw logs or `verbosity: "full"` to retrieve final output.
- `stop_agent` — terminates a running background job.

Tool names use underscores for provider/tool-call compatibility; labels render as “Run Agent”, “Poll Agent”, and “Stop Agent”.

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

// 2b. Only when needed, ask for raw logs or the full final output.
poll_agent({ "id": "agent_...", "sinceSeq": 12, "verbosity": "logs" })
poll_agent({ "id": "agent_...", "verbosity": "full" })

// 3. Cancel if no longer needed
stop_agent({ "id": "agent_...", "reason": "not needed" })
```

## Temporary git worktrees

When `run_agent` starts inside a git repository, it creates a temporary detached git worktree and runs the child agent from the matching path inside that worktree. If the current directory is not inside a git repo, no worktree is created and the child agent runs in the original directory.

By default the worktree is created from `HEAD`, so uncommitted or untracked files are not visible unless copied in explicitly. Add a JSON file at `.pi/worktree.env` to copy selected repo-relative files or directories into the temp worktree at spawn time:

```json
{
  "copy": [
    ".gitignore",
    "README.md",
    { "from": ".env.local", "optional": true },
    { "from": "local-config.json", "to": "config/local.json", "optional": true }
  ]
}
```

Supported fields:

- `enabled` — optional boolean. Set `false` to disable temp worktree creation for this repo.
- `base` — optional git revision for `git worktree add`; defaults to `HEAD`.
- `copy` — optional array of strings or `{ from, to?, optional? }` objects. Paths must be relative to the repo root and may not point at `.git` metadata.

Temp worktrees are removed when the job finishes, fails, is stopped, or the Pi session shuts down.

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

- Jobs are in-memory for the current Pi extension runtime. `/reload`, session switch, or shutdown terminates running jobs.
- Logs are capped in memory and tool output is truncated before being sent back to the LLM.
- `poll_agent` defaults to compact summary output to avoid flooding the main model context.
- Child tool access is limited to tools active in the parent Pi session. Requested agent/tool allowlists must be a subset of parent active tools.
- The child process loads normal Pi configuration/extensions, skills, and context files; these are not model-disableable from `run_agent`.

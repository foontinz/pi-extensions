# workflows

Always-available `Workflow` tool that orchestrates multiple **in-process**
subagents (via the SDK `createAgentSession`, no `pi` subprocess / tmux). Depends on
the `subagents` extension's in-process runner.

## Tool: `Workflow`

Parameters (provide exactly one script source):
- `script` — inline JavaScript orchestration script (top-level `await` supported). Persisted
  to `<agentDir>/workflows/runs/` and the path is returned for edit + re-invoke.
- `scriptPath` — path to a workflow script file (resolved against the session cwd).
- `name` — a saved workflow under `<cwd>/.pi/workflows/<name>.js` or `<agentDir>/workflows/<name>.js`.
- `args` — arbitrary JSON value exposed to the script via `args()`.
- `timeoutMs` — overall workflow stall watchdog (default 30 min).
- `background` — run in background and notify on completion (default `true`).

With `background:true` (default) the tool returns immediately with
`{ runId, status: "running", scriptPath }` and delivers a `<workflow-notification>`
user message when the run finishes. With `background:false` it waits and returns the
envelope:

```jsonc
{
  "runId": <string>,
  "scriptPath": <string>,
  "output": <script return value>,
  "usage": { "input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns" },
  "agents": <number launched>,
  "failures": [{ "index", "label?", "reason" }]
}
```

## Script hooks

| hook | sync? | description |
|------|-------|-------------|
| `agent(task, opts?)` | async | Run one in-process subagent; returns its JSON output (or text). Returns `null` on failure (recorded in `failures()`). |
| `parallel(items, fn)` | async | `Promise.all` fan-out over `items`. |
| `pipeline(items, fns)` | async | Per item, thread the value through `fns` in order. |
| `workflow(script)` | async | Run a nested workflow script in the same runner. |
| `phase(name)` | sync | Emit a progress phase marker. |
| `log(...values)` | sync | Emit a progress log line. |
| `args()` | sync | The `args` input value. |
| `failures()` | sync | Snapshot of recorded agent failures. |

### `agent` options

```ts
{
  label?: string;
  tools?: string[];          // default: ["read","bash"]
  systemPrompt?: string;
  timeoutMs?: number;        // per-agent
  cwd?: string;              // run the agent in this dir (resolved against workflow cwd)
  isolate?: boolean;         // run in a dedicated git worktree (created from cwd, torn down after)
  mcp?: boolean;             // inject a shared `mcp` gateway tool (process-wide MCP connection pool)
  schema?: { required?: string[]; description?: string };  // JSON validate + retry
  retries?: number;          // schema-validation retries, default 2
}
```

## Non-functional behavior

- **Concurrency:** capped at 8 simultaneous in-process agents (FIFO queue).
- **Agent cap:** 100 agents per workflow run.
- **Rate limits:** provider 429 / rate-limit errors are retried with exponential
  backoff + jitter (up to 5 attempts).
- **Usage rollup:** token usage is aggregated across all agents into `usage`.
- **Abort:** the tool's abort signal, the stall watchdog, and session shutdown all
  abort in-flight agents.
- **Shared handles:** all agents reuse one process-wide `AuthStorage` / `ModelRegistry`
  (validated under concurrency) instead of rebuilding them per agent.
- **Background delivery:** background runs notify the parent session on completion via
  an idle-aware `sendUserMessage` (`followUp` when idle, else `steer`).

## Worktree isolation

`agent(task, { isolate: true })` provisions a dedicated detached git worktree from
the resolved cwd (honoring `.pi/worktree.json` copy/postCopy config), runs the agent
there, and tears it down when the agent finishes. Use it for **parallel write-heavy**
agents that must not share a working tree; read-mostly fan-out is fine on the shared
cwd (pi serializes same-file writes via `withFileMutationQueue`). Worktree creation
across the whole process is bounded by a shared slot semaphore
(`PI_SUBAGENTS_MAX_WORKTREE_CREATIONS`, default 4). The provisioning logic is shared
with `run_agent` via `subagents/workspace/create-worktree.ts`.

## Shared MCP gateway

`agent(task, { mcp: true })` gives the agent an `mcp` tool that forwards to a
**process-wide** MCP connection pool (`subagents/mcp/`). Each configured MCP server
(from `mcp.json` / `.pi/mcp.json` / `.mcp.json`) is connected **once per process** and
reused across every subagent / workflow agent, so a fan-out does not reconnect an MCP
adapter per child. The tool supports: no args → list servers; `{ server }` → list its
tools; `{ search }` → find tools; `{ describe }` → show a tool's parameters;
`{ tool, args }` → call a tool (`args` is a JSON string). Connections are torn down on
session shutdown. Only stdio (`command`) and HTTP (`url`, optional `bearer`) servers are
supported; interactive-only concerns (OAuth login, elicitation UI) are out of scope.

## Out of scope (v1)

- VM **sandboxing** (the script is trusted, model-authored on explicit opt-in).
- Resume / journals / `resumeFromRunId` and the longest-unchanged-prefix cache.

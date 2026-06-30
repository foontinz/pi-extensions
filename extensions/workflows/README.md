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

## Out of scope (v1)

- VM **sandboxing** (the script is trusted, model-authored on explicit opt-in).
- Resume / journals / `resumeFromRunId` and the longest-unchanged-prefix cache.
- Shared MCP gateway for workflow agents.
- Per-agent git **worktree** isolation (agents share the workflow cwd; use `agent` `cwd`
  for lightweight directory separation).

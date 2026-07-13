# workflows

Always-available `Workflow` tool that orchestrates multiple **in-process**
subagents (via the SDK `createAgentSession`, no `pi` subprocess / tmux). Depends on
the `subagents` extension's in-process runner.

## When to use it (reach for this first)

Prefer a `Workflow` **proactively** — don't wait to be explicitly asked — whenever
a task splits into independent parts. If you're about to repeat the same kind of
step across many files/modules/services/items, fan it out instead. Strong fits:

- Parallel code review or repo-wide search + summarize
- Batch refactors / migrations / codemods across many files
- Generating tests or docs for many modules at once
- Comparing multiple approaches in parallel
- Multi-step pipelines (a planning `phase()` then `parallel()` agents)

Parallel subagents finish far faster than sequential hand-work, and each gets its
own context window so this session stays lean. It does spawn multiple agents and
use tokens — so size the agent count to the job (a handful for small tasks, more
for big fan-outs) rather than avoiding it; the parallelism and isolated context
are the point.

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
`{ runId, status: "running", scriptPath }` and delivers a `workflow-notification`
custom message when the run finishes (see [Completion notifications](#completion-notifications)).
Stop a running background run with the `stop_workflow` tool (see
[Stopping a run](#stopping-a-run)).
With `background:false` it waits and returns the envelope:

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
| `agent(task, opts?)` | async | Run one in-process subagent; resolves to its parsed JSON output when the child returned JSON, otherwise the child's **final assistant text** (the last assistant message that carries text, even if the run ends on a tool call). Returns `null` on failure (recorded in `failures()`); a model-side terminal error (`stopReason` error/aborted) is treated as a failure, not a silent empty success. |
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
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
                              // default: inherit the root session's selected level
  timeoutMs?: number;        // per-agent
  cwd?: string;              // run the agent in this dir (resolved against workflow cwd)
  worktree?: boolean;        // run in a dedicated git worktree (default false; requires a git repo)
  mcp?: boolean;             // inject a shared `mcp` gateway tool (process-wide MCP connection pool)
  schema?: { required?: string[]; description?: string };  // JSON validate + retry
  retries?: number;          // schema-validation retries, default 2
}
```

Reviews and verification are often time-consuming. Give them generous per-agent
`timeoutMs` and overall workflow `timeoutMs` values rather than short deadlines.

## Live view (TUI)

While a run is active — including background runs — a boxed dashboard is shown
`belowEditor`, keyed per `runId` (no footer status line):

```
╭─ Workflow a1b2c3d4 ──────────────────────────────────────────╮
│ ⠸ research › synthesize                  ▰▱▱▱▱▱▱▱ 2/11         │
│ 8 active · 3 queued · ↑12k ↓4.1k · $0.083 · 1 failed     0:42 │
├──────────────────────────────────────────────────────────────┤
│ ✓ crawl-docs      research                              0:12 │
│ ✗ fetch-legacy    research                   timeout after…  │
│ ⠸ summarize       synthesize                            0:03 │
│ ↻ verify          synthesize                       retry 1/2 │
│ · draft-report    synthesize                          queued │
│ … 3 more                                                     │
╰──────────────────────────────────────────────────────────────╯
```

- The header shows a spinner + a **phase breadcrumb** (`research › synthesize`,
  current one highlighted) — or `completed`/`failed` when done — plus a progress
  bar of completed/launched agents and the count.
- The metrics row shows live concurrency (`active`/`queued`) while running (or the
  total agent count when finished), rolled-up token usage, cost, failures, a
  rate-limit flag, and elapsed time (frozen at finish).
- Agent rows use glyphs: `✓` done · `✗` failed · `↻` retrying · `⠸` running ·
  `·` queued. Running/retrying/failed agents are prioritized; the rest collapse
  into a `… N more` line.
- The view is responsive to terminal width and disappears a few seconds after the
  run finishes. Rendering is driven by `WorkflowRunner.snapshot()` /
  `WorkflowSnapshot`; see `ui/dashboard.ts`. In RPC mode the component factory is
  ignored (no widget is shown).

## Stopping a run

A background run can be cancelled while in flight with the **`stop_workflow`** tool:
`stop_workflow({ runId })` stops one run; omit `runId` (or pass `"all"`) to stop every
running workflow. Optional `reason` is recorded on the run.

Stopping aborts the shared `AbortSignal`, which cancels in-flight subagents. The run
ends as **cancelled** (not failed): a distinct `⊘ cancelled` glyph in the dashboard and
completion notice, and the reason is surfaced inline. A turn abort (Esc) on a
foreground run is treated the same way; the overall `timeoutMs` still ends the run as
`failed`.

## Completion notifications

Background runs announce completion by injecting a `workflow-notification`
**custom message** (via `pi.sendMessage`, not `sendUserMessage`). The full result
(`formatSummary`) is always kept in LLM context; a registered message renderer
controls only how the entry looks in the transcript, collapsing it like the
`tool-view` extension:

```
✓ Workflow 97e85be8 completed · 5 agents · ↑3.5k ↓376
```

- **It reuses `tool-view`'s persisted flag** (`~/.pi/agent/tool-view.json` `mode`):
  `minimized` / `medium` → the one-line summary above; `verbose` → the full body.
  Toggle it with `/toolview` (no separate setting). When the flag file is absent
  it defaults to collapsed.
- Expanding the entry in the TUI always reveals the full body regardless of mode.
- Failures render with a red `✗` and the error message.

The **`Workflow` tool call/result** itself is collapsed by the same flag too
(the tool is custom, so `tool-view` cannot manage it directly — the extension
registers its own `renderCall`/`renderResult`). Collapsed, a background start
shows `▸ Workflow <id> started · background` and a foreground finish shows
`✓ Workflow <id> done · N agents · ↑in ↓out`; `verbose`/expanded shows the full
ack or summary. Errors are always shown.

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

`agent(task, { worktree: true })` provisions a dedicated detached git worktree from
the resolved cwd (honoring `.pi/worktree.json` copy/postCopy config), runs the agent
there, and tears it down when the agent finishes. Use it for **parallel write-heavy**
agents that must not share a working tree; read-mostly fan-out is fine on the shared
cwd (pi serializes same-file writes via `withFileMutationQueue`). Worktree creation
across the whole process is bounded by a shared slot semaphore
(`PI_SUBAGENTS_MAX_WORKTREE_CREATIONS`, default 4). The provisioning logic is shared
with `run_agent` via `subagents/workspace/create-worktree.ts`.

The flag mirrors `run_agent`'s `worktree`, with two intentional differences: here it
defaults to **`false`** (fan-out shares one working tree) and there is **no `auto`
mode** — pass `worktree: true` explicitly to opt in. **It requires the workflow cwd
to be inside a git repository**; in a non-git working dir use the default shared cwd.
If `worktree: true` is used outside a git repo the agent throws a clear, actionable
error (surfaced to the user, including on the collapsed failure notice) rather than
failing obscurely.

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

## Run artifacts (read/grep, no extra tool)

Every run gets an **isolated directory** at `<agentDir>/workflows/runs/<runId>/`, returned
in the background ack and the completion notification (`runDir`). Instead of a dedicated
status tool, the agent inspects a run on demand with the existing `read` / `grep` tools:

- `events.log` — a timestamped **timeline** of the run: `phase:` markers, `agent X
  started/completed/failed`, retries, rate-limit backoff, and an `agent … transcript:
  agents/<file>` mapping line tying each agent to its transcript.
- `agents/*.jsonl` — each agent's **full native session transcript** (user turn,
  assistant text, tool calls, thinking, outputs), persisted incrementally via
  `SessionManager.create` (filenames are `<timestamp>_<runId>-a<index>.jsonl`).

This is on-demand only — don't poll; completion still arrives via the notification.
Artifacts are **pruned on session start** after 3 days
(`DEFAULT_RUN_RETENTION_MS`, shared with `subagents/core/run-archive.ts`).

## Out of scope (v1)

- VM **sandboxing** (the script is trusted, model-authored on explicit opt-in).
- Resume / journals / `resumeFromRunId` and the longest-unchanged-prefix cache.

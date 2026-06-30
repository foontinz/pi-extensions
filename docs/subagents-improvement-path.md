# Subagents Improvement Path

> **Handoff:** current architecture, status, and how to continue are in
> `docs/subagents-workflows-handoff.md`. Start there.

Improvements to the `extensions/subagents` runtime so it can serve the **dynamic
workflows** use case (many subagents fanned out / pipelined; see
`docs/claude-dynamic-workflows-spec.md`). Today each `agent()` would be a full
`pi --mode json -p --no-session` process under a tmux session, with hot-path disk
writes, optional **serialized** worktree creation, and no shared MCP wiring — the
opposite of Claude's cheap in-process subagents.

This doc is **phased**. Phase 1 = cheap, extension-only, low-risk wins that improve
usability and trim overhead. Later phases hold the higher-impact-but-costlier
changes.

> **Re-sequencing note (post-decision):** in-process execution (former Phase 3 P3.1)
> is **confirmed feasible via the SDK** and is now the **v1 foundation**, not a later
> phase. Resume is **deferred to v2**. The subprocess-lightening items (P2.1 no-tmux,
> P2.2 reduced persistence) are therefore **not needed for workflows** (they remain
> relevant only to the existing `run_agent` subprocess path).

---

## Decision log — v1 (RESOLVED)

| # | Decision | Resolution |
|---|---|---|
| 1 | Agent execution model | **In-process** via SDK `createAgentSession` (+ `cwd` for worktree isolation); subprocess kept only as a fallback flag |
| 2 | Resume in v1? | **Deferred to v2** — no journal / chained-prefix cache / args-seed / `resumeFromRunId` in v1 |
| 3 | VM placement | **Main thread** for v1 (revisit worker-thread only if sync-hangs bite) |
| 4 | MCP for workflow agents | **Skip for now** — built-ins + injected `StructuredOutput` only |
| 5 | Engine location / ownership | **New `workflows` extension** that depends on `subagents` |
| 6 | Activation model | **Always-available tool** — drop `ultracode` keyword / session-mode / system-reminders gating |
| a | Determinism stripping | **Drop for v1** (only needed to protect resume; document that v2 resume will require it) |
| b | In-process concurrency | **8–12 concurrent + provider-429 backoff** |
| c | Agent project context | **Bare** by default (minimal `ResourceLoader`); opt-in via `agentType` |
| d | `agentType` → named agents | **Keep** (reuses `list_agents` / `~/.pi/agent/agents`) |
| e | In-process `agent()` primitive lives in | **`subagents`** (shared capability); `workflows` only orchestrates |
| f | Launch guard | **Autonomous** — agent-count + concurrency caps are the only guard |
| 8 | v1 §16 polish | **Keep:** `failures()` accessor, >4096 auto-window, lean tools. **Defer:** fair-share nested pool, sha256 allow-rules, load-time determinism scan, worktree GC |

Out of scope (decided earlier): token **budget** accounting.
Non-blockers / spikes tracked in "What's left" below.

### Subprocess → in-process migration (DONE; subprocess path removed)
`run_agent` runs **in-process** only. The subprocess+tmux supervisor and all its dead
code have been deleted (no `PI_SUBAGENTS_SUPERVISOR` flag): removed the tmux module
(`supervisor/tmux-supervisor.ts`), `tmuxSessionName`, the tmux launch/monitor/kill paths,
stdout/stderr JSONL parsing + raw-log limiting, temp-prompt files + `getPiInvocation`,
child-process signaling, and the now-dead `AgentJob` fields/constants/formatter branches
(~450 lines net out of `index.ts`). tmux characterization tests were replaced with
in-process equivalents using an injectable launcher seam.
- New `supervisor/in-process-supervisor.ts` drives a nested `AgentSession` and forwards
  its live `AgentSessionEvent` stream into the existing `processEvent` → log/status/
  usage/callback machinery (the event shapes match the old `--mode json` stdout).
- `startAgentJob` branches on supervisor kind: in-process skips CLI args/temp prompt
  file/tmux script; the combined prompt is passed as **appendSystemPrompt** to a bare
  `ResourceLoader` (so pi's default coding prompt is preserved, no extensions/skills
  reloaded). `supervisor: "process"` records carry no tmux/exit-code paths.
- `stop_agent`/`terminateJob` abort the in-process session (`session.abort()`); timeouts
  map through the state machine to `failed`/`timeout`; shutdown aborts in-flight jobs.
- Hydration: a persisted in-process job that was still "running" is marked **failed** on
  reload (in-process work cannot survive a parent restart; tmux jobs are still re-monitored).
- Caps, worktree (cwd) isolation, waiters/polling, status widget, background callbacks,
  and the typed result envelope are all preserved and shared across both paths.
- Tests: tmux characterization tests pinned via `PI_SUBAGENTS_SUPERVISOR=tmux`; added
  in-process start/completion, stop→cancel, and timeout→failed characterizations (96
  pass). Validated live end-to-end through the real `run_agent` tool.

### v1 implementation status (in this repo)
- **Done:** P1.1 JSON addendum; P1.2 typed `SubagentResult`; P1.3 parallel worktree
  creation (pool 4); P1.4 lean default tools. In-process primitive
  (`subagents/core/in-process-runner.ts`, `createAgentSession` + bare `ResourceLoader`
  + `SessionManager.inMemory` + per-agent abort/timeout + usage capture + shared
  process-wide `AuthStorage`/`ModelRegistry`). New `workflows` ext with `Workflow` tool
  + `agent/parallel/pipeline/workflow/phase/log/args/failures` hooks, concurrency cap
  (8) + agent cap (100), 429 backoff, stall watchdog, schema validate+retry, usage
  rollup envelope, `script`/`scriptPath`/`name` sources + inline-script persistence,
  per-agent `cwd`, **background-task delivery** (idle-aware completion notification +
  session-shutdown abort), injectable executor + unit tests. Spikes A/B/E validated
  live (concurrent in-process sessions, re-entrancy from the tool's `call()`, shared
  auth/model under concurrency).
- **Not yet (intentionally deferred):** per-agent git **worktree** isolation (agents
  share the workflow cwd; lightweight `agent` `cwd` knob provided); shared **MCP**
  gateway proxy (P3.3); **resume**/journal (v2); VM **sandboxing** (dropped per
  decision).

### v1 build scope (derived from the decisions)
- **`subagents` ext:** in-process spawn-and-await primitive (`createAgentSession`
  with `tools`, `cwd`, `SessionManager.inMemory()`, minimal `ResourceLoader`) →
  `await prompt(task)` → capture `state.messages` + `getLastAssistantUsage` +
  abort/stall; JSON final-output addendum (P1.1); typed result envelope (P1.2);
  worktree-creation parallelism (P1.3); lean default tools (P1.4).
- **`workflows` ext:** `Workflow` tool `{script | name | scriptPath, args}` (no
  `resumeFromRunId`); VM runner (main thread, codegen-disabled, **no** determinism
  stripping) + hooks `agent / parallel / pipeline / workflow / phase / log / args`;
  parent-side schema validate+retry; concurrency semaphore (8–12) + agent-count cap
  + stall watchdog; progress events + background-task delivery.
- **Spikes:** 16 concurrent in-process sessions (A), re-entrancy from the tool's
  `call()` (B), shared `AuthStorage`/`ModelRegistry` under concurrency (E).

---

## Phase 1 — cheap wins (extension-only, low risk)

> None of these reduce the dominant cost (booting a `pi` process + MCP per agent —
> that's Phase 3 / pi core). They make subagents **more usable** and shave edges.
> Do them in order; #10 and #8 are the highest value-per-line.

### P1.1 — JSON final-output addendum (was #10)
**Effort:** trivial. **Value:** high (reliable parsing).

The spawn already assembles `promptParts = [agent?.systemPrompt, params.systemPrompt]`
and passes them via `--append-system-prompt`. Add a constant addendum for every
subagent spawn:

> Your final output IS the return value to the calling agent, not a conversational
> message. Return only valid JSON: no Markdown, no code fences, no prose, no
> confirmations like "Done.". If the task does not specify a JSON shape, use this
> default shape: {"output": string}.

- Implementation: a `DEFAULT_JSON_OUTPUT_ADDENDUM` constant appended to `promptParts`
  for all `run_agent` spawns.
- The transport remains `--mode json`; this addendum controls the child assistant's
  final text. The typed result envelope parses that text into `structuredOutput`
  when valid JSON.

### P1.2 — Typed terminal result envelope (was #8)
**Effort:** cheap-ish. **Value:** high (usage aggregation + clean error/`null` handling).

`--mode json` already emits the final assistant message and usage, so the data exists
— this is parsing it into a typed shape instead of a bare `finalOutput: string`.

- New terminal result type (capture point + `core/types.ts`):
  ```ts
  interface SubagentResult {
    output: string;                 // final assistant text (already captured)
    structuredOutput?: unknown;     // populated by the schema path (engine-side, §18.2)
    usage: UsageStats;              // input/output/cacheRead/cacheWrite/cost/turns
    error?: { reason: TerminalReason; message: string };
    truncated?: boolean;            // output was capped
  }
  ```
- Keep `finalOutput` as a derived/back-compat field; add the envelope alongside.
- Unblocks: workflow usage rollups (`totalTokens`/`totalToolCalls`), and the
  `parallel`/`pipeline` "`null` on failure" contract keyed off `error`.

### P1.3 — Parallelize worktree creation (cheap half of #7)
**Effort:** small. **Value:** medium (kills serial fan-out setup latency).

Worktree provisioning is effectively serial today; a fan-out of N isolated agents
pays ~200–500 ms × N of pure serial setup before any real work.

- Raise worktree-creation concurrency from 1 → a small pool (2–4), bounded.
- Scope: **creation only**. Defer cross-agent worktree *reuse/pooling* (harder
  lifecycle/cleanup) to a later phase.
- Keep `keepWorktree` semantics unchanged.

### P1.4 — Lean default tools for workflow agents (was #6)
**Effort:** ~free. **Value:** low–medium (faster boot, smaller prompt, less cost).

The `--tools csv` / `--no-tools` knob already exists. This remains an **engine
default**, not a `run_agent` default: the workflow engine should pass a minimal
toolset per `agent()` (e.g. `read,bash`) unless the call's `opts`/`agentType` ask for
more. Normal `run_agent` omitted-tools behavior stays the portable read-only default.

- Action item: document the recommended minimal default; ensure `--no-tools` and tiny
  allowlists boot cleanly and fast.

### Phase 1 acceptance
- A workflow-internal spawn returns a **typed result** with usage + error.
- Subagents are instructed to emit **valid JSON final output** by default.
- N isolated agents provision worktrees **concurrently** (pool of 2–4).
- Workflow agents run with a **minimal toolset** unless overridden.

---

## What's left (later phases)

### Phase 2 — higher-value perf, still extension-only (real work)

- **P2.1 Headless supervisor (drop tmux for ephemeral agents) (#3).** Add a
  "direct/pipe" supervisor (`child_process` + stdout capture) alongside the tmux one;
  keep tmux opt-in for human debugging. The `supervisor` field already implies
  pluggability. Biggest extension-only perf win, but a new supervisor lifecycle
  (spawn, output capture, abort, cleanup) is meaningful code.
- **P2.2 Reduce hot-path persistence for workflow-internal agents (#4).** Skip per-job
  `.log` / `callback.json` / record writes when the result lives in the workflow
  journal anyway; keep debug retention behind a flag. Care needed: persistence backs
  callback delivery/retry and cleanup, so gate it precisely.
- **P2.3 Worktree reuse/pooling (rest of #7).** Reuse worktrees across sequential
  agents in a phase; reclaim changed worktrees (GC/TTL). Lifecycle-heavy.
- **P2.4 Fast clean abort + guaranteed cleanup (#11).** Ensure stall/abort frees slots
  promptly with no zombie tmux/worktree. Incremental hardening on existing cleanup.

### Phase 3 — the real "lightness" lever (**unblocked — pi SDK already supports it**)

> Research result: pi exposes an in-process `AgentSession` via the SDK
> (`createAgentSession`), and the RPC doc explicitly recommends it over spawning a
> subprocess. Extensions run in-process and can import `@earendil-works/pi-coding-agent`
> (the subagents extension already does). So P3.1 is **not** blocked on pi core — it's
> the highest-value lightness win and should be tackled right after Phase 1.

- **P3.1 In-process execution path (#1) — UNBLOCKED.** Run agents as a nested
  `createAgentSession({ tools, model, cwd, sessionManager: SessionManager.inMemory(),
  resourceLoader })` in the parent process; `await session.prompt(task)`, read the
  final result from `agent_end.messages` / `session.state.messages`, then `dispose()`.
  No `pi` spawn / tmux. **Worktree isolation is preserved via the `cwd` option** — point
  the session at the worktree path, no separate process needed. The single biggest cost
  reducer; matches Claude.
  - **Must use a custom/minimal `ResourceLoader`** (not `DefaultResourceLoader`), or the
    nested session re-discovers and loads every global extension — including subagents
    itself (recursion) and the MCP adapter (reconnect). Pass explicit `tools` and a loader
    that loads no extensions/skills for workflow subagents.
  - Open detail for implementation: exact **usage** field on messages/events (for token
    rollups) — confirm when wiring P1.2's envelope.
- **P3.2 Warm worker / RPC serve mode (#2) — available but mostly redundant.**
  `pi --mode rpc` is a persistent JSONL serve over stdin/stdout (a warm worker you feed
  prompts). In-process (P3.1) is cheaper, so reserve RPC for when you specifically need
  **OS-process isolation at scale** rather than `cwd`/worktree isolation.
- **P3.3 Shared MCP gateway (#5) — conditional, mechanism known.** pi core has **no
  first-class MCP**; MCP comes from the pi-mcp-adapter extension + `mcp.json`, surfaced
  as the `mcp` gateway tool. So nested in-process sessions do **not** inherit MCP for
  free — loading the adapter per child reintroduces the per-child cost. If workflow
  agents need MCP, route their MCP calls to the **parent's already-connected adapter**
  (expose a thin proxy tool to the child session) instead of reconnecting. If agents
  only need read/bash/edit, skip MCP for them entirely. Product decision on whether it's
  worth building.

### Explicitly dropped
- **Schema option on `run_agent` (#9).** Redundant with the engine-side
  validate-and-retry wrapper (workflows spec §18.2) — let the wrapper own it.
- **Batch spawn (#12).** Marginal; the engine can call spawn N times. Revisit only if
  per-spawn overhead proves significant.

---

## Resolved: pi capability findings (researched against pi 0.80.2 SDK/docs)
1. **Nested in-process agent API?** → **YES.** `createAgentSession()` (SDK) gives an
   in-process `AgentSession` (`prompt()`/`subscribe()`/`state.messages`/`dispose()`) with
   `tools`/`model`/`cwd`/`SessionManager.inMemory()`/`resourceLoader`. RPC doc recommends
   it over subprocess. Extensions can import the package. **P3.1 unblocked.** Caveat: use
   a minimal `ResourceLoader` to avoid reloading the whole extension stack / self-recursion.
2. **Persistent worker / serve mode?** → **YES** (`pi --mode rpc`), but in-process P3.1 is
   cheaper and subsumes it for our use case; keep RPC only for OS-process isolation at scale.
3. **MCP?** → pi core has **no first-class MCP** (it's the pi-mcp-adapter extension +
   `mcp.json` + the `mcp` gateway tool). Nested sessions don't inherit MCP for free, so
   P3.3 (shared-gateway proxy) is only worth building **if** workflow agents need MCP.

### Resolved as non-blockers (pi design already handles these)
- **Permissions/approval:** `CreateAgentSessionOptions` has **no permission gate** —
  the core `AgentSession` runs whatever tools are enabled (approval UX is interactive-
  layer only). Headless nested sessions **auto-run tools, never hang**; bound blast
  radius via the `tools` allowlist + `cwd`.
- **Parallel-worktree correctness:** tools are **cwd-bound at construction**
  (`createTool(name, cwd, …)`), not via `process.cwd()` — concurrent sessions in
  different worktrees are correct.
- **Same-file FS races:** pi exports `withFileMutationQueue(filePath, fn)` and already
  serializes concurrent same-file mutations (mitigates parallel-edit races).
- **Deferred background delivery:** `pi.sendUserMessage` + idle-deferred notifications
  (the subagents ext already uses this) → Workflow-as-background-task delivery works.
- **Usage capture:** `getLastAssistantUsage` is exported and `SessionStats` exists →
  per-agent token usage is accessible for P1.2's envelope. (Earlier open detail closed.)

### Spike-level unknowns (validate in a prototype; not hard blockers)
- **A. Concurrency safety of ~16 simultaneous `AgentSession`s** in one process (shared
  model client, auth-token refresh, provider 429s). No global lock visible in types.
- **B. Re-entrancy** — creating sessions from inside the Workflow tool's `call()`
  (runs within the parent session's tool execution). Confirm no shared-state assumption.
- **C. VM-in-worker-thread** (§16.5) — a worker importing the SDK creates sessions with
  separate auth/model/network instances; heavier. Else keep VM on main thread + accept
  sync-hang risk. Design choice.
- **D. MCP** — not free for nested sessions; only blocks if workflows need MCP (P3.3).
- **E. Auth/model sharing** — reuse the parent's `AuthStorage`/`ModelRegistry` across
  children (both accepted options); verify token refresh under concurrency.

## Cross-references
- Workflow engine + `agent()`→`run_agent` wrapper + schema validate/retry:
  `docs/claude-dynamic-workflows-spec.md` §17–§18.
- Out-of-process cost/concurrency caps: spec §18.3.
- Worktree-creation-serial bottleneck: spec §16.4.

# Dynamic Workflows — Reverse-Engineered Spec

Reverse-engineered from the Claude Code binary `2.1.195`
(`~/.local/share/claude/versions/2.1.195`, Mach-O arm64, embedded JS bundle).
This documents the **dynamic workflows / "ultracode"** feature: a tool that runs a
user-authored JavaScript orchestration script in a sandbox, where the script
deterministically fans out / pipelines / verifies work across many subagents.

All prompts and constants below are quoted verbatim from the bundle (escapes
normalized). Internal minified identifiers are given in `(parens)` for traceability.

---

## 1. Concept

A **dynamic workflow** is a small JavaScript program the model writes on the fly.
The program is not run by the model token-by-token; it runs in a real JS VM and
*calls back into* the agent runtime via a handful of host functions
(`agent()`, `parallel()`, `pipeline()`, `workflow()`, `phase()`, `log()`).

This gives **deterministic control flow** (loops, conditionals, fan-out, dedup,
budget math in plain JS) around **non-deterministic leaf steps** (each `agent()`
call spawns a subagent). It is the orchestration substrate behind "ultracode".

Key properties:
- Runs **in the background**: the tool returns immediately with a task ID; a
  `<task-notification>` arrives on completion. Live progress shown via `/workflows`.
- **Resumable**: every run keeps a journal; re-running with the same script +
  args replays cached `agent()` results (100% cache hit on unchanged prefix).
- **Deterministic by construction**: `Date.now()`, `Math.random()`, argless
  `new Date()` are removed from the sandbox (they would break resume).
- **Bounded**: concurrency cap, lifetime agent-count cap, per-call item cap,
  optional token budget, per-agent stall timeout.

Tool name: `Workflow` (alias `RunWorkflow`). Constant `WORKFLOW_TOOL_NAME = "Workflow"`.

---

## 2. Activation / opt-in policy

Workflows can spawn dozens of agents and burn many tokens, so the model is told
to call `Workflow` **only on explicit user opt-in**. The tool prompt enumerates
the allowed triggers:

1. The user included the keyword **`ultracode`** in their prompt (a
   system-reminder confirms it).
2. **Ultracode session mode** is on (a system-reminder confirms it).
3. The user asked for orchestration in their own words ("use a workflow",
   "run a workflow", "fan out agents", "orchestrate this with subagents").
   *A task that would merely benefit from a workflow does not count.*
4. The user invoked a skill / slash command whose instructions tell it to call `Workflow`.
5. The user asked to run a specific named/saved workflow.

For anything else, the model must **not** call the tool — it should use the
`Agent` tool for a single subagent, or describe what a workflow could do + rough
cost and ask the user. (It is told to mention the user can say "use a workflow".)

### 2.1 Keyword triggers

Three `ultra*` keywords are recognized in user prompts (alongside `ultrathink`):
`ultracode`, `ultraplan`, `ultrareview`. The `ultracode` keyword opts that single
turn into orchestration.

### 2.2 System-reminders (injected as meta user messages)

These are injected as `isMeta` reminders (identifiers in parens are the reminder keys):

- **`ultrathink_effort`**:
  > The user included the keyword "ultrathink", requesting deeper reasoning on this turn. Reason as thoroughly as the task warrants.

- **`workflow_keyword_request`** (fires on `ultracode` keyword; gauge `tengu_workflow_keyword`):
  > The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request.

- **`ultra_effort_enter`**, `reminderType: "full"` (entering ultracode session mode):
  > Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool's **Ultracode** section and quality patterns. Solo only on conversational/trivial turns.

- **`ultra_effort_enter`**, non-full (still on, sparse re-reminder):
  > Ultracode is still on — use the Workflow tool; see its Ultracode section.

- **`ultra_effort_exit`**:
  > Ultracode is off — the Workflow tool's standard opt-in rule applies again.

### 2.3 Ultracode session mode

A persisted/session setting `ultracode`:
> Enable ultracode for the session: xhigh effort plus standing dynamic-workflow
> orchestration. Interactive toggles never persist it. Requires workflows to be
> enabled and an xhigh-capable model.

When on, the standing instruction is: author and run a workflow for **every
substantive task** by default; multi-phase work (understand → design → implement
→ review) means several workflows in sequence, one per phase, so the main loop
stays in the loop between them. Solo only on conversational/trivial turns.

---

## 3. The `Workflow` tool

`isEnabled` gates on `XS()` (workflows feature enabled). Defined via `ti({...})`.

### 3.1 Input schema (`Npm`)

| Field | Type | Notes |
|---|---|---|
| `script` | string (≤ 524288 bytes) | Self-contained script. Must begin with `export const meta = { name, description, phases }` (pure literal) followed by body using `agent()/parallel()/pipeline()/phase()`. Rejected if it contains control chars. |
| `name` | string | Name of a predefined workflow (built-in or `.claude/workflows/`). Resolves to a script. |
| `description` | string | **Ignored** — set it in the script's `meta`. |
| `title` | string | **Ignored** — set it in the script's `meta`. |
| `args` | unknown | Value exposed to the script as the global `args`, verbatim. Pass arrays/objects as real JSON, NOT a JSON-encoded string (a stringified list breaks `args.filter`/`args.map`). |
| `scriptPath` | string | Path to a script file on disk. Every invocation persists its script under the session dir and returns the path; edit + re-invoke with same `scriptPath` to iterate. **Takes precedence over `script` and `name`.** |
| `resumeFromRunId` | string `^wf_[a-z0-9-]{6,}$` | Resume a prior run. Unchanged `(prompt, opts)` agent calls return cached results; only edited/new calls re-run. Same-session only. Must stop the prior run first (`TaskStop`). |

Refinement: must provide one of `script` / `name` / `scriptPath`.

Resolution order (`Ahl`): `scriptPath` → `name` (look up registry) → `script`.

### 3.2 Output schema (`Fpm`)

`status` ∈ {`async_launched`, `remote_launched`}, plus `taskId`, `taskType`
(`local_workflow` | `remote_agent`), `workflowName` (= `meta.name`), `runId`
(local resume handle), `summary`, `transcriptDir` (where subagent transcripts go),
`scriptPath` (persisted, editable), `sessionUrl` (when remote), `warning`, `error`.

### 3.3 Validation (`validateInput`)

1. Server-fallback retraction guard.
2. `disableWorkflows` managed setting → error 5.
3. `XS()` false → error 6 ("org policy, launch gate, or the 'Dynamic workflows' setting in /config").
4. Resolve script; resolution error → error 1.
5. Parse meta (`tk`); parse error → error 2.
6. If inline `script` and body uses `Date.now()/Math.random()/new Date()` (`Tfl`
   walks the AST for `Date.now`, `Math.random`, `new Date()`) → error 4
   ("Workflow scripts must be deterministic…").
7. If `resumeFromRunId` matches a still-running task → error 3 (stop it first with `TaskStop`).

### 3.4 Permissions (`checkPermissions`)

Permission keyed by **workflow name** (not for ad-hoc `scriptPath`). Deny/ask/allow
rules from `Koe(ctx, "Workflow", name)`. Default behavior: **ask** — "Review dynamic
workflow before running" — with a suggestion to add an `allow` rule
(`{toolName:"Workflow", ruleContent:name}` → `localSettings`). In auto/acceptEdits
mode there is also a usage-consent gate (`workflowNeedsUsageConsentPrompt`,
`recordWorkflowUsageConsent`, setting `hasSkipWorkflowUsageWarning`).

### 3.5 `maxResultSizeChars` = 100000.

---

## 4. The tool prompt (verbatim, `XHo`)

> Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a `<task-notification>` arrives when the workflow completes. Use /workflows to watch live progress.
>
> A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.
>
> ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
> - The user included the keyword "ultracode" in their prompt (you'll see a system-reminder confirming it).
> - Ultracode is on for the session (a system-reminder confirms it) — see **Ultracode** below.
> - The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
> - The user invoked a skill or slash command whose instructions tell you to call Workflow.
> - The user asked you to run a specific named or saved workflow.
>
> For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the Agent tool for individual subagents, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can ask for one with "use a workflow" in a future message to skip the ask.
>
> When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the channels, scope the diff) to discover the work-list, then call Workflow to pipeline over it. You don't need to know the shape before the *task* — only before the *orchestration step*.
>
> Common single-phase workflows you can chain across turns:
> - **Understand** — parallel readers over relevant subsystems → structured map
> - **Design** — judge panel of N independent approaches → scored synthesis
> - **Review** — dimensions → find → adversarially verify (example below)
> - **Research** — multi-modal sweep → deep-read → synthesize
> - **Migrate** — discover sites → transform each (worktree isolation) → verify
>
> For larger work, run several in sequence — read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.
>
> **Ultracode.** When a system-reminder confirms ultracode is on, that opt-in is standing: author and run a workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce — token cost is not a constraint. For multi-phase work (understand → design → implement → review), that often means several workflows in sequence — one per phase — so you stay in the loop between them. The quality patterns below (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits the task. Lean toward orchestrating with workflows and adversarially verifying your findings — unless the work is trivial or already verified. Solo only on conversational turns or trivial mechanical edits. When a reminder says ultracode is off, revert to the opt-in rule above.
>
> Pass the script inline via `script` — do not Write it to a file first. Every invocation automatically persists its script to a file under the session directory and returns the path in the tool result. To iterate on a workflow, edit that file with Write/Edit and re-invoke Workflow with `{scriptPath: "<path>"}` instead of resending the full script.
>
> Every script must begin with `export const meta = {...}`:
> ```js
>   export const meta = {
>     name: 'find-flaky-tests',
>     description: 'Find flaky tests and propose fixes',   // one-line, shown in permission dialog
>     phases: [                                            // one entry per phase() call
>       { title: 'Scan', detail: 'grep test logs for retries' },
>       { title: 'Fix', detail: 'one agent per flaky test' },
>     ],
>   // script body starts here — use agent()/parallel()/pipeline()/phase()/log()
>   phase('Scan')
>   const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})
> ```
> The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: `name`, `description`. Optional: `whenToUse` (shown in the workflow list), `phases`. Use the SAME phase titles in meta.phases as in phase() calls — titles are matched exactly; a phase() call with no matching meta entry just gets its own progress group. Add `model` to a phase entry when that phase uses a specific model override.
>
> Script body hooks:
> - **agent**(prompt: string, opts?: {label?, phase?, schema?, model?, effort?, isolation?: 'worktree', agentType?}): Promise\<any\> — spawn a subagent. Without schema, returns its final text as a string. With schema (a JSON Schema), the subagent is forced to call a StructuredOutput tool and agent() returns the validated object — no parsing needed. Returns null if the user skips the agent mid-run or the subagent dies on a terminal API error after retries (filter with .filter(Boolean)). opts.label overrides display label. opts.phase explicitly assigns the agent to a progress group (use inside pipeline()/parallel() stages to avoid races on the global phase() state). opts.model overrides the model for this agent call — default to omitting it (inherit the resolved session model). opts.effort overrides reasoning effort ('low'|'medium'|'high'|'xhigh'|'max'). opts.isolation: 'worktree' runs the agent in a fresh git worktree — EXPENSIVE (~200-500ms setup + disk per agent), use ONLY when agents mutate files in parallel and would otherwise conflict; auto-removed if unchanged. opts.agentType uses a custom subagent type (e.g. 'Explore', 'code-reviewer') resolved from the same registry as the Agent tool; composes with schema.
> - **pipeline**(items, stage1, stage2, ...): Promise\<any[]\> — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Each stage callback receives (prevResult, originalItem, index). A stage that throws drops that item to `null` and skips its remaining stages.
> - **parallel**(thunks: Array<() => Promise\<any\>>): Promise\<any[]\> — run tasks concurrently. This is a BARRIER: awaits all thunks. A thunk that throws resolves to `null` (the call never rejects), so `.filter(Boolean)`. Use ONLY when you genuinely need all results together.
> - **log**(message: string): void — emit a progress message (narrator line above the progress tree).
> - **phase**(title: string): void — start a new phase; subsequent agent() calls group under this title.
> - **args**: any — the value passed as Workflow's `args` input, verbatim (undefined if not provided). Pass arrays/objects as actual JSON values, NOT a JSON-encoded string.
> - **budget**: {total: number|null, spent(): number, remaining(): number} — the turn's token target from the user's "+500k"-style directive. `total` is null if no target. `spent()` returns output tokens spent this turn across the main loop and all workflows (shared pool, not per-workflow). `remaining()` = max(0, total - spent()) or Infinity. The target is a HARD ceiling: once spent() reaches total, further agent() calls throw. Use for dynamic loops `while (budget.total && budget.remaining() > 50_000) {...}` or static scaling `const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5`.
> - **workflow**(nameOrRef: string | {scriptPath}, args?: any): Promise\<any\> — run another workflow inline as a sub-step. Child shares this run's concurrency cap, agent counter, abort signal, and token budget; its agents appear under a "▸ name" group and its tokens count toward budget.spent(). The args param becomes the child's `args`. **Nesting is one level only**: workflow() inside a child throws.
>
> Subagents are told their final text IS the return value (not a human-facing message), so they return raw data. For structured output, use the schema option — validation happens at the tool-call layer so the model retries on mismatch.
>
> Workflow agents can reach all session-connected MCP tools via ToolSearch — schemas load on demand per agent. Caveat: interactively-authenticated MCP servers (e.g. claude.ai) may be absent in headless/cron runs.
>
> Scripts are plain JavaScript, NOT TypeScript — type annotations (`: string[]`), interfaces, generics fail to parse. The body runs in an async context — use await directly. Standard JS built-ins are available — EXCEPT `Date.now()`/`Math.random()`/argless `new Date()` (they throw — they would break resume). No filesystem or Node.js API access.
>
> DEFAULT TO pipeline(). Only reach for a barrier when stage N genuinely needs ALL prior-stage results together (dedup/merge across the full set, early-exit on zero count, "compare against the other findings"). A barrier is NOT justified by "I need to flatten/map/filter first" (do it inside a pipeline stage), "the stages are conceptually separate", or "it's cleaner code".
>
> Concurrent agent() calls are capped at **min(16, cpu cores - 2)** per workflow — excess queue. Total agent count across a workflow's lifetime is capped at **1000**. A single parallel()/pipeline() call accepts at most **4096** items.
>
> [Canonical examples follow: pipeline review→verify; barrier dedup-before-verify; loop-until-count; loop-until-budget; composing exhaustive review (find→dedup-vs-seen→diverse-lens panel→loop-until-dry).]
>
> Quality patterns — Adversarial verify; Perspective-diverse verify; Judge panel; Loop-until-dry; Multi-modal sweep; Completeness critic; No silent caps (log() what was dropped).
>
> Scale to what the user asked for. "find any bugs" → a few finders, single-vote verify. "thoroughly audit this" / "be comprehensive" → larger finder pool, 3–5 vote adversarial pass, synthesis stage.
>
> ## Resume
> The tool result includes a runId. To resume after a pause, kill, or script edit, relaunch with Workflow({scriptPath, resumeFromRunId}) — the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after it runs live. Same script + same args → 100% cache hit. Fallback when no journal is available: Read agent-\<id\>.jsonl files in the transcript directory and hand-author a continuation script.

(The `description()` and `prompt()` of the tool both return this same `XHo` string.)

### 4.1 Canonical example (verbatim from the prompt)

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA}),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, {label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA})
      .then(v => ({...f, verdict: v}))
  ))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
return { confirmed }
```

---

## 5. Script format & meta parsing (`tk`)

- Max script size: **524288 bytes** (`U9`). Larger → error.
- Parsed with acorn (`ecmaVersion: latest`, `sourceType: module`,
  `allowAwaitOutsideFunction`, `allowReturnOutsideFunction`).
- The **first statement** must be `export const meta = {...}` (an
  `ExportNamedDeclaration` of a single `const meta` `ObjectExpression`), else error:
  > `export const meta = { name, description, phases }` must be the FIRST statement in the script
- `meta` must be a **pure literal** (`Cfl`/`Afl`): only `Literal`, `ArrayExpression`,
  `ObjectExpression`, `TemplateLiteral` (no interpolation), negative-number
  `UnaryExpression`. No spreads, computed keys, methods/accessors, sparse arrays.
  Reserved keys `__proto__`/`constructor`/`prototype` are rejected.
- Validated meta fields (`Xdm`/`Qdm`):
  - `name`: non-empty string (required)
  - `description`: non-empty string (required)
  - `title`: optional string
  - `whenToUse`: optional string (shown in workflow list)
  - `phases`: optional array of `{title, detail?, model?}` (only entries with a string `title` kept)
- `scriptBody` = everything after the meta statement (leading `;`/newline trimmed).

---

## 6. Execution model (sandbox)

### 6.1 Compilation (`Vyt` + AST transform)

The script body is compiled in two passes:

1. A **deterministic-await AST rewrite** wraps every `await`/`for-await`/async
   return/yield argument in a host settle call (`$p((...))` / `$p a((...))`),
   so the VM hands awaited values back across the boundary in a controlled way.
   It also:
   - forbids identifiers starting with the reserved prefix (`$p`),
   - forbids `with` statements,
   - forbids `await using` declarations.
2. `Function("async function _check(){'use strict'; ... })` is used to surface
   syntax errors early (compile check), then the body is wrapped and compiled to
   a `vm.Script`.

### 6.2 VM context (`Jfl`)

Uses Node `node:vm`. `vm.createContext(..., {codeGeneration:{strings:false, wasm:false}})`
(so `eval`/`new Function`/wasm are disabled). The context exposes only:

- `log`, `phase`, `budget`, `console` (sandboxed; logs forwarded as progress),
- `setTimeout`/`clearTimeout` (abort-aware wrappers),
- host functions `agent`, `parallel`, `pipeline`, `workflow`,
- `args` (deep-cloned from JSON into the VM).

Cross-boundary values are cloned/sanitized via dedicated helpers
(`DVt` deep clone, `Vzn` array materialize). Array length across the VM boundary
is capped at **4096** (`mMe`); exceeding throws.

Standard JS built-ins are available **except** the determinism-breakers
(`Date.now`, `Math.random`, argless `new Date`) which throw at runtime in addition
to the static check.

### 6.3 Sync timeout

The initial synchronous run of the compiled script is bounded by
`Zzn = 30000` ms (`runInContext({timeout: 30000})`).

### 6.4 Result handling (`Qfl`)

- Script return value is sanitized + JSON-roundtripped; functions are stripped.
- A function return value is rejected ("workflow result cannot be a function").
- On error, the JS stack is trimmed to ≤5 frames for the failure message.
- Returns `{result, agentCount, logs, failures, durationMs, error?}`.
- Up to `fpm = 1000` `log()` messages are retained.

---

## 7. The host hooks (`Ufl`)

### 7.1 `agent(prompt, opts)` (`G` → `W` → `ct`)

For each call:
1. Enforce **agent-count cap** (`Nfl = 1000`, error `WorkflowAgentCapError`) and
   **budget cap** (`WorkflowBudgetExceededError` once `spent() >= total`).
2. Resolve label (default = first 60 chars of prompt), phase group, stall ms
   (`opts.stallMs`, default `dpm = 180000`).
3. **Resume cache lookup** (if journal present): compute cache key (§9) and, if a
   cached result exists and we haven't yet diverged, emit a `cached` progress event
   and return the cached value immediately (`p(we.result)`); mark divergence after first miss.
4. Resolve the **agent definition**:
   - `opts.agentType` → look up in the active agent registry (same as the `Agent`
     tool), honoring deny rules (`Agent(<type>)`); error if not found.
     Disallowed tools merged with the workflow defaults.
   - else default workflow subagent (`WHo`), or its structured variant (`upm`) when
     a schema is present.
5. If `opts.schema`: convert JSON Schema → a `StructuredOutput` tool (`Hct`), append
   the StructuredOutput instruction to the system prompt, add the tool to the toolset.
6. Resolve model: `_oe(...)` from agent def / main-loop model / `opts.model` /
   permission mode. Resolve effort from `opts.effort`.
7. Build the toolset via `kQ(...)` in `acceptEdits` mode (skipping REPL filter),
   including MCP tools; subagents can reach MCP tools through ToolSearch.
8. If `opts.isolation === 'worktree'`: create a fresh git worktree
   (`wf-<index>` or `<runId>-<index>`); prepend a worktree notice to the prompt.
   (`isolation:'remote'` throws — "not available in this build".)
9. Run the subagent query loop (`a4(...)`): a full nested agent with
   `agentType:"subagent"`, `depth = parentDepth+1`, transcripts written under
   `subagents/workflows/<runId>/`. A **stall watchdog** aborts the agent if no
   progress for `stallMs`. `requiresStructuredOutput` is set when a schema is present;
   up to `MAX_STRUCTURED_OUTPUT_RETRIES` (`ppm = 5`) retries on schema mismatch.
10. Result:
    - schema present → the validated `structured_output` object;
    - else → the agent's final assistant text;
    - `null` if user skipped the agent or it died on a terminal API error.
11. Append `{type:"result"}` to the journal.

### 7.2 `parallel(thunks)` (`K`)

- Validates each element is a function ("not promises. Wrap each call: `() => agent(...)`").
- Enforces caps, then `Promise.allSettled` over all thunks.
- A rejected thunk → `null` in the result array (the call never rejects).
- Budget-exceeded rejections counted separately and logged
  ("parallel: N slots dropped — token budget exceeded"). **Barrier**: awaits all.

### 7.3 `pipeline(items, ...stages)` (`z`)

- Validates first arg is an array, each stage is a function.
- For each item, runs stages sequentially; stage callback signature
  `(prevResult, originalItem, index)`. If `prevResult === null`, remaining stages
  skip. **No barrier between stages** — items advance independently.
- Item-level failures → `null`. Same budget-drop accounting as `parallel`.

### 7.4 `workflow(nameOrRef, args)` (`Rfl` / `T`)

- Resolves a saved workflow by name or a `{scriptPath}` script file.
- Parses + compiles it, runs it in a fresh nested VM context that **shares** the
  parent's concurrency cap, agent counter, abort signal, and token budget.
- Child agents appear under a `▸ <name>` progress group (`X2e = "▸"`).
- **One level of nesting only**: calling `workflow()` inside a child throws.

### 7.5 `phase(title)` / `log(message)`

- `phase` opens/locates a progress group (`workflow_phase` progress event).
  Seeded from `meta.phases[].title` at startup. Matched by exact title string.
- `log` emits a `workflow_log` progress event (narrator line).

### 7.6 `budget`

Frozen object: `{ total: number|null, spent(): number, remaining(): number }`,
derived from the turn's token target ("+500k"-style directive). Shared across the
main loop and all (nested) workflows.

### 7.7 Concurrency

- Per-workflow concurrent `agent()` slots: `npm(cpus) = min(16, max(2, cpus-2))`
  (`rpm`). Excess calls queue.
- A separate small pool (`opm = 50`) governs pipeline scheduling.

---

## 8. Subagent system prompts

### 8.1 Default workflow subagent (`WHo` → `ipm`)

`agentType: "workflow-subagent"`, `tools: ["*"]`,
`disallowedTools: [SendUserMessage, Agent, Workflow]`, `source/baseDir: "built-in"`.

System prompt (`ipm`):
> You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.
> CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
> - Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
> - If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
> - Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.
> - Be concise. The script will parse your output.

### 8.2 Structured-output variant (`upm` → `cpm`)

Used when `opts.schema` is set (with the default subagent):
> You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.
> CRITICAL: You MUST call the StructuredOutput tool exactly once to return your final answer. The tool's input schema defines the required shape.
> - Do your work (Read files, run commands, etc.), then call StructuredOutput with your answer.
> - Do NOT put your answer in a text response. The script reads ONLY the StructuredOutput tool call.
> - If the schema validation fails, read the error and call StructuredOutput again with a corrected shape.
> - After calling StructuredOutput successfully, end your turn. No acknowledgment needed.

### 8.3 Addenda appended to **custom** `agentType` system prompts

When `opts.agentType` is a custom agent, one of these is appended to its own system prompt:

- Without schema (`apm`):
  > NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.

- With schema (`lpm`):
  > NOTE: You are running inside a workflow script. You MUST return your final answer by calling the StructuredOutput tool exactly once — the tool's input schema defines the required shape. Do your work, then call StructuredOutput; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call StructuredOutput again with a corrected shape.

### 8.4 Worktree-isolation prompt prefix

When `isolation:'worktree'`, the agent prompt is prefixed with:
> You are running in an isolated git worktree at \<path\> (a separate working copy of the repo). Changes you make here do NOT affect the main working directory (\<cwd\>) or other agents. Work normally — the worktree will be cleaned up automatically if you made no changes, or preserved for review if you did.

---

## 9. StructuredOutput tool (`xp = "StructuredOutput"`, def `Joo`, `Hct`)

- `Hct(jsonSchema)` compiles the schema with **Ajv** (`allErrors:true`,
  `validateSchema` first), memoized in a `WeakMap`. Returns `{tool}` or `{error}`.
- The produced tool's `call(input)` runs the compiled validator; on failure throws
  `Output does not match required schema: <instancePath>: <message>, ...`
  (the subagent sees this and retries, up to `ppm = 5`).
- On success returns `{ data: "Structured output provided successfully",
  structured_output: input, endsTurn: true }` — and `agent()` returns
  `structured_output`.
- Tool metadata: `isReadOnly:true`, `isOpenWorld:false`, `isConcurrencySafe:true`,
  `maxResultSizeChars:1e5`.
- Generic prompt (no schema):
  > Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response to provide the structured output.

---

## 10. Resume / journal (`$Ho`, `Dfl`, `Hfl`)

- Each run has a `journal.jsonl` at
  `<projectStateDir>/<sessionId>/subagents/workflows/<runId>/journal.jsonl`.
- Two record types, appended live:
  - `{type:"started", key, agentId}` — agent dispatched
  - `{type:"result", key, agentId, result}` — agent completed
- **Cache key** is a *chained prefix hash* (`Dfl(prompt, opts, priorKey)`):
  `"<epm=v2>:" + sha256(priorKey ‖ "\0" ‖ prompt ‖ "\0" ‖ stableStringify(opts))`,
  where `priorKey` is the previous call's key (running variable `g`, initialized to `""`),
  and the stable opts JSON (`tpm`) includes only `schema/model/effort/isolation/agentType`
  with sorted object keys (drops `__proto__`, functions, etc.).
  **Note:** `runId` is *not* part of the key — run isolation comes from *which*
  `journal.jsonl` is loaded, not the key. The chain makes each call's key depend on
  the exact sequence of all preceding `(prompt, opts)` pairs, so two identical
  `agent()` calls in a loop still get distinct keys (by position).
  **Also not in the key:** `args` — the chain seeds at `g = ""`. This is a latent
  stale-reuse bug on different-args resume; the recommended fix seeds the chain with
  a canonical hash of `args` (+ scriptBody) so args becomes correct-by-construction. See §16.11.
- On resume, the longest unchanged **prefix** of `agent()` calls returns cached results
  instantly; the first miss flips a "diverged" flag (`_`) and everything after runs live.
  Because the hash is chained, any change to an early call (or its result feeding a
  later prompt) invalidates every downstream key — resume is strictly prefix-based.
- A separate **run snapshot** JSON is written to
  `<state>/<session>/workflows/<runId>.json` on completion (`xfl`) — used by
  `/workflows` to list past runs (`kfl`). Snapshot includes script, scriptPath,
  args, result, agentCount, logs, durationMs, status, phases, workflowProgress,
  totalTokens/totalToolCalls.
- Resume is **same-session only** and requires stopping the running task first.
- Background-adopted resume (`thl`) pins the script by **sha256**; a content change
  means it must be re-approved via the Workflow tool.
- Determinism (`Date.now`/`Math.random`/`new Date` removed) is precisely *because*
  resume replays — non-deterministic values would diverge cached vs. live.

---

## 11. Task / progress / lifecycle model

Workflow runs register as a background task (`type: "local_workflow"`) in the task
registry (`OHo` `registerWorkflowTask`). Status ∈ running / completed / failed /
paused / killed. Progress is a stream of events:

- `workflow_phase` `{index, title, kind}` — phase group
- `workflow_agent` `{index, label, phaseIndex, phaseTitle, agentId, model, state,
  startedAt, queuedAt, attempt, tokens, toolCalls, cached?, resultPreview, promptPreview, ...}`
  — states: `queued`/`start`/`done`/`error`
- `workflow_log` `{message}`

The registry tracks `agentCount`, `totalTokens`, `totalToolCalls`. Progress is
batched (`MHo` `updateWorkflowProgressBatch`, ~16ms flush) and the log ring is
trimmed (`Sfl = 500` × 2). UI summary lines (`iyt`): e.g.
"N dynamic workflows", "Waiting for … to finish".

Lifecycle operations (module `BHo`): `pauseWorkflowTask`, `killWorkflowTask`
(`TaskStop`), `retryWorkflowAgent`, `skipWorkflowAgent`, `completeWorkflowTask`,
`failWorkflowTask`, `enqueueWorkflowNotification`, `buildResumePrompt`.

### 11.1 Completion / notification (`nYn`)

On completion a `<task-notification>` is enqueued with the summary:
- success: `Dynamic workflow "<name>" completed`
- failure: `Dynamic workflow "<name>" failed: <error>`
- stopped: `Dynamic workflow "<name>" was stopped`

On failure/kill the notification includes a **resume hint**:
`To resume after editing the script, call: Workflow({scriptPath, resumeFromRunId})`
plus the agent transcript directory. The result block carries `<result>`,
`<failures>`, `<usage>` (`<agent_count>/<subagent_tokens>/<tool_uses>/<duration_ms>`),
and a `<recovery>` section.

### 11.2 Pause / resume prompt (`FHo` `buildResumePrompt`)

> Resume the paused workflow by calling: Workflow({scriptPath: '<path>', resumeFromRunId: '<runId>'[, args: <json>]}) — completed agents return cached results.

Output file for a completed run holds `{summary, agentCount, logs, result,
workflowProgress (sans logs), totalTokens, totalToolCalls}`.

---

## 12. Error classes & caps

| Constant | Value | Meaning |
|---|---|---|
| `U9` | 524288 | Max script bytes |
| `Zzn` | 30000 | Sync run timeout (ms) |
| `Nfl` | 1000 | Lifetime agent-count cap (`WorkflowAgentCapError`) |
| `rpm` | min(16, max(2, cpus-2)) | Concurrent agent slots per workflow |
| `opm` | 50 | Pipeline scheduling pool |
| `mMe` | 4096 | Max array length / items across the VM boundary |
| `dpm` | 180000 | Default per-agent stall timeout (ms) |
| `ppm` | 5 | Max StructuredOutput retries (`MAX_STRUCTURED_OUTPUT_RETRIES`) |
| `Pfl` | 400 | Result/preview truncation length |
| `fpm` | 1000 | Max retained `log()` messages |
| `epm` | "v2" | Journal cache-key version prefix |

- `WorkflowAgentCapError`: cap reached — usually a `budget.remaining()` loop that
  never terminates because no budget was set (remaining() is Infinity).
- `WorkflowBudgetExceededError`: `spent() >= total` — in-flight agents finish, results preserved.

---

## 13. Workflow sources & registry (`TMe`)

Resolution order (later overrides earlier by name): built-in (`KHo`/`Vfl`),
plugin (`iYn` from each plugin's `workflowsPath`/`workflowsPaths`), project
(`.claude/workflows/*.js`, `projectSettings`), user (`~/.claude/workflows/*.js`,
`userSettings`). All `.js` files; each must parse to valid `meta`; size-capped at `U9`.

- `/workflows` slash command + `WorkflowDetailDialog` for browsing/saving runs.
- `getWorkflowCommands` / `createWorkflowCommand` register saved workflows as commands.

### 13.1 Built-in: `code-review` (`Ict`, hidden)

> Workflow-backed code review — one finder agent per review angle, an independent
> verifier for every distinct (file, line) location across the pooled candidates,
> then a ranked, capped findings report.

Launched by the `/code-review` skill at high/xhigh/max effort.
`args` = `"<level> [target]"` (level ∈ high|xhigh|max; target = PR#/branch/ref-range/path/instructions).
Phases: **Scope** → **Find** (correctness + cleanup + conventions angles, pooled)
→ **Verify** (one verifier per distinct (file,line): CONFIRMED/PLAUSIBLE/REFUTED)
→ **Sweep** (fresh gap-hunting finder, xhigh/max only) → **Synthesize** (merge dupes,
rank, cap report). Review angles: reuse, simplification, efficiency, altitude, conventions.

### 13.2 Built-in: `deep-research`

> Deep research harness — fan-out web searches, fetch sources, adversarially
> verify claims, synthesize a cited report.

`whenToUse`: when the user wants a deep, multi-source, fact-checked research
report; if the question is underspecified, ask 2-3 clarifying questions first,
then pass the refined question as `args`.
Phases: Scope (decompose into 5 angles) → Search (5 parallel WebSearch agents) →
Fetch (URL-dedup, top 15 sources, extract falsifiable claims) → Verify
(3-vote adversarial, need 2/3 refutes to kill) → Synthesize (merge dupes, rank by
confidence, cite). Constants: `VOTES_PER_CLAIM=3`, `REFUTATIONS_REQUIRED=2`,
`MAX_FETCH=15`, `MAX_VERIFY_CLAIMS=25`. Uses `pipeline()` Search→URL-dedup→Fetch+Extract
with running cross-searcher URL dedup state. It is a full, idiomatic API example
(schemas as plain JSON-Schema literals, `agent({schema})`, `log()`, accumulating dedup map).

---

## 14. Feature flags & settings

| Setting / env | Effect |
|---|---|
| `disableWorkflows` / `CLAUDE_CODE_DISABLE_WORKFLOWS` | Hard-disable the feature (managed). |
| `enableWorkflows` / `tengu_workflows_enabled` / `allow_workflows` / `CLAUDE_CODE_WORKFLOWS` | Enable/gate by plan/policy. |
| `workflowKeywordTriggerEnabled` | Enable the `ultracode` keyword trigger (default true). |
| `ultracode` | Persisted session ultracode mode (xhigh + standing orchestration). |
| `skipWorkflowUsageWarning` / `hasSkipWorkflowUsageWarning` | Suppress the multi-agent usage-consent prompt. |
| `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` | Also removes bundled skills+workflows. |

Telemetry events: `tengu_workflow_completed`, `tengu_workflow_phase_completed`
(built-in only), `tengu_workflow_agent_cap_exceeded`, `tengu_workflow_budget_cap_exceeded`,
`tengu_workflow_journal_started_hit_respawn`, `tengu_workflow_keyword`, `tengu_ultra_effort`,
`task_local_workflow*`.

---

## 15. Remote / cloud variant (brief)

A workflow can also dispatch to a **cloud session** (CCR), surfacing as
`remote_agent` task type with `remoteTaskType: "remote-workflow"`, status string
"Remote dynamic workflow completed", and a `sessionUrl` as the resume handle
(no local `runId`). `agent({isolation:'remote'})` is parsed but throws in this build.
Cloud eligibility requires login, a git repo, a GitHub remote, and the Claude
GitHub app installed.

---

## 16. Problems, bottlenecks & polish

Critique of the design as built, with **small, behavior-preserving** refinements
(no change to the opt-in model, the script API surface, or the resume contract).
Severity: 🔴 correctness/cost · 🟠 scalability · 🟡 ergonomics.

### 16.1 🟠 Subagent concurrency is tied to CPU count

`rpm = min(16, max(2, cpus-2))` (`npm`). Subagent work is **API/latency-bound**,
not CPU-bound — the model just streams from the provider. Pinning the parallelism
ceiling to core count under-utilizes wide fan-outs on small machines (a 4-core box
caps at 2 concurrent agents) and is unrelated to the real limiter (provider rate
limits + token budget).

**Polish:** decouple the limit from cores. Default to a fixed value (e.g. 12–16),
make it a setting (`workflowMaxConcurrency`), and additionally clamp by an adaptive
signal — back off on provider 429s rather than on CPUs. Keep the hard `min(16, …)`
ceiling. No script-visible change.

### 16.2 ⚪ `budget` semantics — out of scope

(`budget` meters output tokens only; we're intentionally not addressing budget
accounting here. Left as-is.)

### 16.3 🟠 Resume is a strictly chained prefix — no independent-branch caching

The chained hash (§10) means a single re-run early `agent()` invalidates **all**
downstream cache, even for parallel branches that have no data dependency on it.
For a wide `parallel([...])` where you edit one thunk, every sibling re-runs too,
because each sibling's key folds in the running chain `g`.

**Polish:** for the *direct children of a single `parallel()`/`pipeline()` call*,
derive keys from a **stable branch index off the call's entry key** instead of the
mutating global chain (`key = H(entryChain, callSiteId, branchIndex, prompt, opts)`).
Sequential calls still chain. This makes "edit one of N parallel agents" re-run only
that one. Resume stays prefix-based at the call granularity; the cross-run contract
("same script+args ⇒ 100% hit") is preserved.

### 16.4 🟡 `parallel`/`pipeline` collapse all failures to `null`

User-skip, terminal API error, and a thunk throwing are indistinguishable — all
become `null`. Scripts that forget `.filter(Boolean)` silently fold `null` into
synthesis. The runtime already records reasons (`getFailures()`), but the script
can't see them.

**Polish:** keep `null` as the array value (unchanged), but expose a read-only
`failures` accessor in the sandbox (`failures()` → `[{index, label, reason}]`) so a
script can branch on *why* a slot dropped (e.g. retry skips, abort on auth errors).
Purely additive.

### 16.5 🔴 The 30 s "VM" timeout only bounds the *first* synchronous segment

First, scope the word **"VM"**: this is Node's `node:vm` module
(`vm.createContext`/`vm.runInContext`/`vm.Script`), **not** a virtual machine,
container, or OS sandbox. The script runs in a fresh V8 *context* but in the **same
Claude Code process, thread, event loop, and heap**. `node:vm` is explicitly *not*
a security boundary — the hardening (`codeGeneration:{strings:false,wasm:false}`,
global whitelist, reserved-prefix/`with`/`await using` bans, `Date.now`/`Math.random`
removal) is for determinism + API surface, not isolation. (The only other "isolation"
primitive in the feature, `agent({isolation:'worktree'})`, is just a git worktree —
also not a VM.)

`runInContext({ timeout: 30000 })` bounds **synchronous execution of the initial run
only**. The body is async, so the engine runs it synchronously until the first
`await` suspends — that initial slice is all the 30 s actually guards. When an
awaited promise later resolves, the continuation resumes as a fresh microtask that is
**not** wrapped in any timed `runInContext` call. So CPU-heavy synchronous work *after*
an await (e.g. an O(n²) dedup over thousands of findings) runs **unbounded**, and the
per-agent stall watchdog doesn't fire (no agent is running) and the abort signal is
cooperative (a tight sync loop never yields to check it).

**Important nuance for the fix:** because everything is single-threaded, the special
power of `node:vm`'s `timeout` is that it uses V8's execution-*interrupt* to break a
synchronous loop. A plain `setTimeout` wall-clock watchdog **cannot** do this — while
a sync loop holds the thread, the timer callback never runs. So:

**Polish (two parts):**
1. A coarse, abortable wall-clock watchdog on the overall run (generous default,
   configurable) — but understand it only catches *stuck-but-still-awaiting* control
   flow and runs that keep yielding; it **cannot** preempt a true synchronous
   infinite loop in a post-await continuation.
2. To actually bound synchronous hangs, either re-enter each resumed segment through
   `runInContext({timeout})`, or (cleaner for a port) run the whole workflow in a
   **worker thread** the parent can terminate — which also prevents a runaway from
   freezing the rest of the agent. Both are orthogonal to the per-agent stall (180 s).

### 16.6 🟠 The 4096-item cap is also the hard per-call limit

`mMe = 4096` is the VM-boundary array cap and the max items for one
`parallel()`/`pipeline()`. Legit large-scale jobs (e.g. migrate 10k files) must hand-roll
batching, and exceeding it is a hard error, not graceful chunking.

**Polish:** ship a sandbox helper `chunk(items, size)` and document the
"batch-then-pipeline" idiom, or have `pipeline()` auto-window inputs >4096 with a
`log()` notice (no silent truncation — consistent with the "no silent caps" rule).
Keep the 4096 ceiling per *window*.

### 16.7 🟡 Nested `workflow()` shares one FIFO semaphore → head-of-line stalls

`tmt(rpm, …)` is a single FIFO queue shared by parent + child workflows. A parent
that has already saturated the pool starves a `workflow()` child until parent slots
drain — a `pipeline(items, item => workflow(...))` effectively serializes.

**Polish:** give nested workflows a fair-share sub-allocation (e.g. reserve ⌈rpm/(depth+1)⌉
slots per level) instead of pure FIFO, while keeping the shared global ceiling so the
total never exceeds `rpm`. Bounded and starvation-free; no API change.

### 16.8 🟡 Permissions can't allow-list ad-hoc (`scriptPath`/inline) workflows

Permission rules key on **workflow name** only; inline and `scriptPath` runs always
"ask". Automation (cron, repeated `scriptPath` iteration) re-prompts every time even
when the content is unchanged — yet the adopt path already pins by sha256.

**Polish:** support an allow rule keyed by **script sha256** (`Workflow(sha256:…)`),
reusing the existing content pin. Lets users approve a specific reviewed script once.
Default behavior (ask) is unchanged.

### 16.9 🟡 Determinism static check skips `name`/`scriptPath`

`Tfl` (the `Date.now`/`Math.random`/`new Date` AST scan) runs **only** for inline
`script`. Named/file workflows rely on the runtime sandbox throwing — so the author
gets a mid-run failure instead of an upfront validation error.

**Polish:** run the same cheap AST scan during workflow *load/registration*
(`Kfl`/`Wfl`/`qfl`) and at `validateInput` for `scriptPath`, surfacing the friendly
"scripts must be deterministic" message before launch. Pure error-quality fix.

### 16.10 🟡 Crash/cross-session recovery is weak

`resumeFromRunId` only matches tasks in the **live** registry, and the cache key has
no session scope; the `journal.jsonl` survives on disk but resume across a CLI
restart falls back to "hand-author a continuation script." The adopt path (`thl`)
handles background hand-off but not user-driven resume after a crash.

**Polish:** on `resumeFromRunId`, if no live task matches, load the on-disk
`journal.jsonl` + run snapshot for that runId (same-project) and replay from it.
sha256-pin the script (as adopt already does) to refuse stale resumes. Recovers the
common "it crashed, let me continue" case without changing the same-script contract.

### 16.11 🔴 Resume doesn't bind `args` into the cache — silent stale reuse

Agents only see `args` *through* their `(prompt, opts)`, both of which are in the
key, so args-dependence is usually captured transitively. The hole is the **seed**:
the chain starts at `g = ""`, so `args` is never an input to the key chain itself.
A resume launched with **different args but the same script** silently reuses the
prefix for every agent whose prompt/opts don't textually encode the args dependence
(e.g. args routing pure-JS control flow, or args threaded into a `workflow(name,
childArgs)` child). The documented contract is "same script + same args ⇒ 100% hit";
nothing guards the different-args case.

**Selected fix — seed the chain with `args` (correct-by-construction):**

```
seed  = sha256( stableStringify(args ?? NULL_TOKEN) ‖ "\0" ‖ scriptBody )
g     = seed                                    // was: g = ""
key_i = "v2:" + sha256( g ‖ "\0" ‖ prompt ‖ "\0" ‖ tpm(opts) );  g = key_i
```

- Identical args → identical seed → identical keys → **100% hit** (contract preserved).
- Any args change → seed differs → **every** key misses → clean cold start. That is
  the correct conservative behavior (no static taint analysis can prove which agents
  truly depend on args).
- Reuse the existing `tpm` canonicalizer (sorted keys, drops `__proto__`/functions);
  define a fixed `NULL_TOKEN` for `args === undefined` so "no args in both runs" is stable.
- For `workflow(name, childArgs)`, seed the child chain with
  `H(parentChainAtCall, stableStringify(childArgs))` so nested caching is also args-correct.

**Companion guard (UX, cheap):** write the first journal line as a provenance header
`{type:"meta", argsHash, scriptSha256}`. On `resumeFromRunId`, compare to the incoming
run; on mismatch either refuse with a precise message ("args changed since run
`wf_…`; start a fresh run or pass the original args" — mirrors the `thl` sha256 pin)
or proceed and `log()` "args changed → full re-run, prior cache ignored." Without it,
a different-args resume just looks like a mysterious 0% cache hit.

**Out-of-scope caveat to state anyway:** even fixed, resume replays cached agents
*without* re-running their FS side effects, so a resumed run's filesystem can differ
from a fresh run — a general resume limitation (relates to §16.2-style FS races /
worktree isolation), not the args bug.

### 16.12 🟢 Things that are already right (leave alone)

- Stall watchdog **pauses while a tool is in-flight** (`un.size>0` clears the timer),
  so long builds/tests don't trip the 180 s stall — only silent model gaps do.
- `parallel` enforces "thunks, not promises" with a clear error.
- VM hardening: `codeGeneration:{strings:false,wasm:false}`, reserved-prefix +
  `with`/`await using` bans, deep clone across the boundary.
- Determinism-by-removal is the correct mechanism for replayable resume.
- Schema path forces a `StructuredOutput` tool with Ajv validation + bounded retries
  (`ppm=5`) — no brittle text parsing.

---

## 17. Implementation notes for a port (pi)

To replicate dynamic workflows in another agent harness:

1. **Tool surface**: one `Workflow` tool that accepts `{script|name|scriptPath, args,
   resumeFromRunId}`, returns immediately with a background task id + runId + scriptPath.
2. **Meta parse + determinism check** on the AST before running (acorn).
3. **Sandbox**: `node:vm` — an **in-process V8 context, not a real VM/container**
   (the only file isolation is optional per-agent git worktrees) — with codeGeneration disabled, only the host
   hooks + `args`/`budget`/`log`/`phase` + safe timers exposed; strip
   `Date.now`/`Math.random`/`new Date`; cross-boundary clone with a 4096 cap.
4. **Host hooks**: `agent` (spawn nested subagent, optional JSON-Schema → forced
   structured-output tool with Ajv validation + retries), `parallel` (barrier,
   null-on-throw + additive `failures()` accessor §16.4), `pipeline` (no-barrier
   per-item staging, auto-window >4096 with a `log()` notice §16.6), `workflow`
   (1-level nesting, shared budget/counters, fair-share sub-pool §16.7), `phase`, `log`.
5. **Subagent prompts**: tell the subagent its final text/StructuredOutput call IS
   the return value; concise; no human-facing confirmations.
6. **Caps**: concurrency **decoupled from CPU** — fixed default 12–16 + adaptive 429
   backoff (§16.1), 1000 lifetime agents, 4096 items/window, 180s per-agent stall.
   Bound synchronous hangs by running the workflow in a **worker thread** the parent
   can terminate (a `setTimeout` watchdog can't preempt sync code) — §16.5. Token
   budget is out of scope (§16.2).
7. **Resume journal**: append `started`/`result` lines keyed by a chained prefix
   hash `v2:sha256(priorKey, prompt, stableOpts)` (not runId — run isolation is the
   journal file); replay unchanged prefix. **Seed the chain with `hash(args, scriptBody)`
   instead of `""`** so args is correct-by-construction (§16.11), and write a
   `{type:"meta", argsHash, scriptSha256}` journal header to detect mismatched resumes.
   Prefer **branch-indexed keys within a single `parallel()`/`pipeline()`** so editing
   one sibling re-runs only it (§16.3). On `resumeFromRunId` with no live task, load the
   on-disk journal + sha256-pin (§16.10).
8. **Activation gating**: only run on explicit opt-in (keyword / session mode /
   explicit ask / named workflow / skill), and inject the matching system-reminder.
9. **Validation**: run the determinism AST scan at *load* for named/scriptPath
   workflows too, not just inline (§16.9). Support sha256-keyed allow rules for
   ad-hoc scripts (§16.8).
10. **Progress + notification**: phase/agent/log progress events; completion
    notification with usage block and resume hint.

---

## 18. Pi port: subagent adapter (`extensions/subagents`)

In Claude Code, `agent()` is an **in-process** async query, so it returns the
subagent's result directly. In pi, subagents run **out-of-process**
(`pi --mode json -p --no-session`, tmux-supervised, optional git worktree) via the
`subagents` extension. That extension is already most of the transport — what the
workflow engine needs is a thin **spawn-and-await + validate** wrapper on top of it.

### 18.1 What the child already provides (no change needed)
- `--mode json` output (already used) and a captured terminal `finalOutput`.
- Terminal phases (`completed`/`failed`/`cancelled`) in the job state machine.
- Worktree isolation (`.pi/worktree.json`) → maps to `agent({isolation:'worktree'})`.
- Named agents (`~/.pi/agent/agents`, `list_agents`) → `agent({agentType})`.
- `stop_agent` (Ctrl-C then hard-kill) → stall-watchdog / abort.
- Per-call tool allowlists → `agent({tools})`.

At most, prepend the §8.1/§8.2 addendum to the task at spawn ("your final output IS
the return value — return raw data/JSON, no confirmations"). That's passed text, not
a child code change.

### 18.2 The wrapper the engine must add — `agent()` → `run_agent`

`agent()` cannot use the existing fire-and-callback path (that resolves the result to
the *parent session*). It needs a **programmatic spawn-and-await** that resolves to
the *awaiting caller inside the workflow VM*:

```
async function agent(prompt, opts) {
  const job = startJob({                       // reuse run_agent's spawn path
    task: addReturnContractAddendum(prompt, opts.schema),
    agent:   opts.agentType,
    tools:   opts.tools,
    worktree: opts.isolation === 'worktree',
    model:   opts.model,                        // omit by default
  })
  registerForStallAndAbort(job, opts.stallMs)   // stop_agent on stall/abort
  const phase = await awaitTerminal(job)         // resolve on terminal state-machine phase
  if (phase !== 'completed') return null         // matches parallel/pipeline null contract
  return opts.schema
    ? validateOrRetry(job.finalOutput, opts.schema, job, MAX_RETRIES)
    : job.finalOutput                            // raw final text
}
```

**JSON / schema validation is part of this wrapper, not the child.** `--mode json`
gives you the bytes; the wrapper must:

1. parse `finalOutput` as JSON,
2. validate against `opts.schema` (Ajv) — the pi equivalent of Claude's
   server-side StructuredOutput tool,
3. on parse/validation failure, **re-spawn the same agent with the validation error
   appended** to the prompt, up to a bounded retry count (Claude uses `ppm = 5`),
4. return the validated object, or `null` after exhausting retries.

So the StructuredOutput contract is enforced **parent-side** (validate-and-retry in
the wrapper) instead of by injecting a tool into the child. Either works; parent-side
is simpler for the out-of-process model and keeps the child unchanged.

### 18.3 Cost / concurrency deltas vs. in-process

Each `agent()` is a real OS process + tmux session (+ worktree), not a cheap
in-process query. Adjust the §16 caps accordingly:

| Cap | Claude (in-process) | Pi out-of-process recommendation |
|---|---|---|
| Concurrency | `min(16, cpu-2)` | lower default (e.g. 4–8), process-aware, with 429/backpressure backoff (§16.1) |
| Lifetime agents | 1000 | much lower (process-spawn churn is heavy) + `log()` what was capped (§16.6) |
| Worktree creation | serialized to 1 (§16.4) | small pool (2–4); reclaim changed worktrees (§16.7-style GC) |
| Sync-hang bound | worker thread / `runInContext` timeout (§16.5) | VM glue runs in the parent pi process → still wrap in a worker thread |

### 18.4 Explicitly *not* needed
- **No inter-subagent messaging.** Workflow agents are pure `prompt → result`
  functions; all coordination lives in the script (see §16.12 / the pure-function
  contract). Peer messaging would break determinism, resume, and caching. (pi's
  general background-subagent callback model is for the parent turn, not for
  agent-to-agent comms.)
- **No new child output format** — `--mode json` already exists; the gap is
  validation/retry in the wrapper, not a new mode.

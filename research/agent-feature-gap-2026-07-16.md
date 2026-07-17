# Coding-agent feature gap research: Pi + local extensions

**Research window:** 2026-04-16 through 2026-07-16, inclusive
**Prepared:** 2026-07-16
**Local baseline:** Pi `0.80.10` plus the extensions under `~/.pi/agent/extensions` and `pi-mcp-adapter@2.11.0`

## Executive conclusion

Your setup is already unusually strong at **extensibility, parallel workflows, subagents, MCP, browser/search, durable goals, background shell work, model/provider choice, and compact tool rendering**. Copying competitors' generic “subagents / MCP / skills / hooks / worktrees” announcements would add little.

The most valuable genuine gaps are:

1. **Searchable, evidence-aware session memory and durable side threads**
2. **Message-linked filesystem checkpoints and rollback**
3. **A real permission/sandbox policy engine with diff previews**
4. **Reviewable memory-to-skill learning (“Skill Forge”)**
5. **A unified agent/session supervisor with user-mediated agent-to-agent messaging**
6. **Context attribution, aggregate diff review, and LSP diagnostics**
7. **Eventually: an authenticated headless Pi daemon with remote clients**

The best near-term product is not another agent runner. It is a **session intelligence layer**: local full-text/semantic search, chronology-aware answers, side conversations, checkpoints, and rollback. It builds on Pi's session tree and your existing subagent/workflow runtime rather than duplicating them.

---

## 1. What changed across popular agents in the last three months

Only materially new or substantially expanded capabilities are included. Routine provider/model additions and bug fixes are omitted.

### OpenCode

OpenCode's period centered on turning the agent into a multi-workspace platform:

- Workspace session replay, “warp,” and transfer with dirty/untracked files (`v1.4.7`, `v1.14.37`, `v1.14.41`).
- Background subagents and push updates (`v1.14.51`, `v1.15.11`).
- TUI diff viewer and on-demand subagent picker (`v1.15.6`).
- Managed workspace cloning and session movement (`v1.16.0`).
- MCP resources/templates and then confined MCP **code mode** (`v1.17.10`, `v1.17.14`).
- **Session snapshots and message-level rollback including file changes** (`v1.17.11`, 2026-06-25).
- Composer/file browser and session search (`v1.17.16`, `v1.18.3`).

Sources: [OpenCode releases](https://github.com/anomalyco/opencode/releases), [v1.17.11](https://github.com/anomalyco/opencode/releases/tag/v1.17.11), [v1.17.14](https://github.com/anomalyco/opencode/releases/tag/v1.17.14).

### Kilo Code

Kilo shipped the broadest IDE-agent feature set:

- Searchable/resumable sessions, folder and git-change mentions, permission prompts containing exact patches (`v7.2.14`, `v7.2.24`, `v7.2.31`).
- Worktree sessions and per-agent permissions/model policy (`v7.2.34`, `v7.3.11`).
- Imported sessions restoring synchronized filesystem diffs (`v7.3.41`).
- Stable session-local macOS/Linux **sandboxing**, network/filesystem restrictions, notebook-native Jupyter tools, branch naming, cost alerts, and explicit **Implement / Keep refining** plan handoff (`v7.4.0`, 2026-07-03).
- Project memory controls and visible recalled snippets (`v7.4.3`, `v7.4.11`).
- Local transcript search, same-repo tabs, destination-level network allowlists (`v7.4.7`).
- A native manager that can inspect another session and send it a targeted prompt—with separate user approval—and lifecycle/policy inheritance (`v7.4.8`, 2026-07-15).

Sources: [Kilo releases](https://github.com/Kilo-Org/kilocode/releases), [v7.4.0](https://github.com/Kilo-Org/kilocode/releases/tag/v7.4.0), [v7.4.8](https://github.com/Kilo-Org/kilocode/releases/tag/v7.4.8).

### Claude Code

Claude Code emphasized long-running orchestration and extension lifecycle:

- Agent dashboard and JSON roster, persistent goals, parent/child tracing (`v2.1.139`, `v2.1.145`).
- Skills can deny tools; hooks can transform/hide assistant display output (`v2.1.152`).
- Dynamic workflows coordinating many background agents and attachable background shells (`v2.1.154`).
- Project-local plugin loading/scaffolding and constructive stop hooks (`v2.1.157`, `v2.1.163`).
- `--safe-mode` to disable customizations (`v2.1.169`).
- Nested subagents up to bounded depth, parameter-aware permissions, directory-local extension precedence (`v2.1.172`, `v2.1.178`).
- Credential hiding separate from filesystem sandboxing and explainable classifier denials (`v2.1.187`, `v2.1.193`).
- Screen-reader mode and forwarded subagent text/thinking for external observers (`v2.1.208`, `v2.1.211`).

Sources: [Claude Code releases](https://github.com/anthropics/claude-code/releases), [v2.1.139](https://github.com/anthropics/claude-code/releases/tag/v2.1.139), [v2.1.154](https://github.com/anthropics/claude-code/releases/tag/v2.1.154).

### OpenAI Codex CLI

Codex evolved into the strongest hostable/runtime architecture:

- Durable `/side` conversations and fresh-context implementation from plans (`rust-v0.122.0`).
- Stable lifecycle hooks, per-turn environments, Unix-socket/stdio app server, remote thread stores (`v0.124.0–v0.125.0`).
- Persistent goal workflows; explicit multi-agent concurrency/depth/wait controls (`v0.128.0`).
- Headless remote-control daemon and Python SDK (`v0.130.0–v0.132.0`).
- Full-text conversation search, extension lifecycle events, named permission profiles (`v0.133.0–v0.135.0`).
- Cross-agent/Claude session import (`v0.140.0`).
- Encrypted remote executors with per-thread local MCP services (`v0.141.0`).
- Rollout token budgets and per-thread delegation policy: disabled / explicit / proactive (`v0.142.0`).
- Descendant-thread inspection, turn-selective forking, and read-allowed/write-prompt approval mode (`v0.143.0–v0.144.0`).

Sources: [Codex releases](https://github.com/openai/codex/releases), [v0.142.0](https://github.com/openai/codex/releases/tag/rust-v0.142.0), [v0.144.0](https://github.com/openai/codex/releases/tag/rust-v0.144.0).

### Gemini CLI

Gemini's strongest ideas were auditable memory and portable agent protocols:

- A reviewable `/memory inbox` that turns extracted knowledge into patchable skills, plus plan/skill confirmation (`v0.39.0`).
- Skill creation integrated with memory extraction, MCP resources, multi-tier memory (`v0.40.0`).
- Real-time voice and stricter headless trust (`v0.41.0`).
- Canonical memory patches, queued messages during compression (`v0.42.0`).
- Session file export/import and a common protocol for local and remote agents (`v0.43.0`).
- Usage metadata for delegated A2A work (`v0.45.0`).

Sources: [Gemini CLI changelog](https://github.com/google-gemini/gemini-cli/blob/main/docs/changelogs/index.md), [v0.39.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.39.0), [v0.43.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.43.0).

### Cursor

Cursor supplied three of the most transferable ideas:

- **Auto-review Run Mode**: allowlisted calls run directly, sandboxable calls run sandboxed, and ambiguous Shell/MCP/Fetch calls go to a policy-classifier agent that may allow, redirect, or ask (3.6, 2026-05-29). [Source](https://cursor.com/changelog/auto-review)
- An interactive **Context Usage Report** attributing tokens to system prompt, tools, rules, skills, and other sources (3.7, 2026-06-04). [Source](https://cursor.com/changelog/canvas-improvements)
- Durable read-oriented side chats carrying main-thread context, local transcript indexing across thousands of conversations, and in-thread search (3.11, 2026-07-10). [Source](https://cursor.com/changelog/side-chat)

### GitHub Copilot CLI

Copilot pushed extension-owned UI and self-improving skills:

- Chronicle search, independent “rubber duck” critique, and memory controls (`v1.0.49`).
- Session-scoped extensions/canvases and aggregate diff review with inline comments (`v1.0.62`).
- Review/accept/reject/defer for draft skill changes and embedding-based skill retrieval (`v1.0.66`).
- LLM-judged auto-approval (`v1.0.69`).
- **Forge** detects repeated workflows and drafts skills; `/refine` improves rough prompts (`v1.0.70`).
- CLI canvases, plugin marketplace, sidebar sessions, explicit worktree/move operations, hard read-only Plan Mode, bounded subagent nesting (`v1.0.71`).

Sources: [Copilot CLI releases](https://github.com/github/copilot-cli/releases), [v1.0.70](https://github.com/github/copilot-cli/releases/tag/v1.0.70), [v1.0.71](https://github.com/github/copilot-cli/releases/tag/v1.0.71).

### Amp

Amp's notable ideas were thread-centric:

- Rebuilt remote-controllable, compaction-first, plugin-powered CLI with queue/steer controls (2026-05-06). [Source](https://ampcode.com/news/neo)
- Custom agents exposed by plugins and isolated remote agents that sync changes locally (2026-06-19/30).
- `read_thread` became a search subagent for huge histories. It explicitly checks later messages for revisions/reverts, verifies tool outcomes, uses summaries only for orientation, and returns to original messages for exact facts (2026-07-02). [Source](https://ampcode.com/news/read-bigger-threads)
- Headless local runners controllable from the web (2026-07-08).

### Cline, Windsurf/Devin, Roo Code, Aider

- **Cline:** shared SDK-backed CLI/TUI, resumable worktree isolation, Hub remote control, plugins bundling skills and OAuth MCP servers, and user-defined agents exposed as tools. Its attempted VS Code SDK migration in `v4.0.0` was rolled back in `v4.0.1`, a warning against big-bang shared-core migrations. [Releases](https://github.com/cline/cline/releases)
- **Windsurf/Devin:** local/cloud handoff, session-wide MCP approvals, plan mode inside sandbox, subagent MCP access, policy scopes, and reviewable autonomous diffs. [Changelog](https://docs.devin.ai/desktop/changelog)
- **Roo Code:** only checkpoint-navigation UX was added; the final release removed cloud, telemetry, organization enforcement, and marketplace infrastructure. [v3.54.0](https://github.com/RooCodeInc/Roo-Code/releases/tag/v3.54.0)
- **Aider:** no release shipped in this window; latest PyPI package found was `0.86.2` on 2026-02-12. [PyPI](https://pypi.org/project/aider-chat/0.86.2/)

---

## 2. What your Pi already has—do not rebuild it

### Strong existing capabilities

| Area | Current implementation | Local evidence |
|---|---|---|
| Parallel orchestration | `Workflow`, `parallel`, `pipeline`, phases, retries, dashboards, artifacts, up to 8 concurrent agents | `extensions/workflows/index.ts`, `extensions/workflows/README.md` |
| Background subagents | In-process jobs, callbacks, transcripts, explicit tool/model policy, worktree isolation, shared MCP option | `extensions/subagents/index.ts`, `extensions/subagents/README.md` |
| Durable autonomous goals | Evidence-backed phases/checkpoints, typed waits, bounded epochs, compaction, resume | `extensions/goal/index.ts`, `extensions/goal/state.ts` |
| Background processes | Background bash, event-driven monitors, completion wakeups, stop controls | `extensions/enhanced-bash/index.ts` |
| MCP | Proxy, OAuth, resources, elicitation/sampling/UI, Sunsama and Google configurations | `npm/node_modules/pi-mcp-adapter`, `mcp.json` |
| Dynamic external APIs | `search_spec` + `exec_code`; Exa and Playwright handles | `extensions/code-runner`, `extensions/exa-search`, `extensions/playwright-browser` |
| Skills/packages | Pi packages plus GitHub skill loader and enable/disable UI | `extensions/skill-loader/index.ts`; Pi README “Pi Packages” |
| Session tree | Persistent JSONL, branch/tree/fork/clone/import/export, labels, compaction | Pi README “Sessions”; `docs/sdk.md` |
| Extension platform | Tool/request/result middleware, custom TUI, runtime tools, provider hooks, session replacement, SDK/RPC | `docs/extensions.md`, `docs/tui.md`, `docs/sdk.md` |
| Usage/UI | Cross-session usage heatmap, compact footer, tool-view modes, fast-model mode | `extensions/usage`, `extensions/footer`, `extensions/tool-view`, `extensions/fast-mode` |

### Present but only partial

- **Worktrees:** subagents/workflows already isolate work, but there is no user-facing workspace/session manager, session transfer, or repository-state restoration.
- **Agent dashboards:** workflows have a live run dashboard, but there is no unified cross-session roster, inbox, steering UI, or durable detached job recovery.
- **Goals/planning:** durable goals are stronger than typical todos, but there is no lightweight read-only plan mode with a visible approval handoff. Pi ships a reference example at `examples/extensions/plan-mode/`; it is not active.
- **Tool middleware:** Pi can block/mutate calls and results, but you have no active runtime permission policy or sandbox.
- **Session export:** Pi exports its own JSONL/HTML, but has no cross-agent import mapping or local full-text index.
- **Diffs:** individual edits render diffs, but there is no aggregate repository diff tree, inline review comments, or approval queue.
- **MCP:** parent support is strong. Child-agent MCP is a separate reduced client without the parent adapter's OAuth, elicitation, cache, and output guards.
- **Compaction:** Pi supports it, but global automatic compaction is currently disabled in `settings.json`.

---

## 3. Ranked feature gaps

Scores are relative to this setup, not stock Pi. **Effort** assumes one experienced TypeScript developer working as a Pi extension/package.

| Rank | Feature | Value | Novelty | Effort | Confidence |
|---:|---|---:|---:|---|---|
| 1 | Session search + chronology-aware `read_session` + durable side threads | 10/10 | 9/10 | M | High |
| 2 | Message-linked code checkpoints and rollback | 10/10 | 7/10 | M | High |
| 3 | Layered permission/sandbox policy with exact mutation preview | 10/10 | 8/10 | L | High |
| 4 | Reviewable memory inbox / Skill Forge | 9/10 | 10/10 | M | Medium-high |
| 5 | Unified agent/session supervisor and mediated agent messaging | 9/10 | 8/10 | M–L | High |
| 6 | Context usage inspector and reduction advisor | 8/10 | 7/10 | S | High |
| 7 | Aggregate diff-review canvas with inline comments | 8/10 | 7/10 | M | High |
| 8 | LSP diagnostics service and changed-diagnostics context | 8/10 | 6/10 | M | High |
| 9 | Session-owned dev processes, ports, logs, and cleanup | 7/10 | 7/10 | M | High |
| 10 | Authenticated headless Pi daemon / remote steering | 9/10 | 9/10 | XL | Medium |

### 1. Session intelligence: search, evidence-aware retrieval, side threads

**Gap:** `/tree` and `/resume` navigate known sessions but do not search full content. Subagents do not inherit context, and their jobs are not durable side conversations.

**Validated by:** Cursor side chats/search, Codex `/side`, Amp `read_thread`, OpenCode session search.

**Proposed package:** `pi-session-intelligence`

MVP:

- Incrementally index session JSONL into SQLite FTS5; optional embeddings later.
- `/sessions-search` overlay and `search_sessions` tool with project/date/model/branch filters.
- `read_session(question, sessionId)` uses a read-only subagent over selected original entries.
- Retrieval prompt must enforce Amp's rules: do not stop at first hit; inspect later revisions/reverts; treat tool calls as attempts and tool results/tests as outcomes; summaries orient but do not prove exact facts.
- Results cite session ID, entry IDs, timestamps, and source snippets.
- `/side` forks a durable read-oriented session with a compact context packet and lets the parent `@mention` the result back.

Why first: it improves every long-running goal, research task, and multi-agent workflow without changing execution safety.

### 2. Session checkpoints and code rollback

**Gap:** Pi conversation branches do not restore filesystem state. The shipped `git-checkpoint.ts` is only an inactive example and is turn/stash-oriented, not a polished message snapshot system.

**Validated by:** OpenCode `v1.17.11`; Kilo imported-session diff restoration; Cline/Roo checkpoint UX.

**Proposed extension:** `pi-checkpoints`

MVP:

- Capture repository tree state at each completed assistant tool batch that mutated files.
- Store checkpoint ID against Pi entry ID via `appendEntry`.
- `/checkpoints` overlay: inspect changed files, diff, restore selected files, or rollback all.
- On `/tree` navigation, offer “conversation only” vs “conversation + workspace.”
- Use hidden Git refs/objects or a dedicated checkpoint index rather than user-visible commits/stashes.
- Detect dirty state and conflicts; never silently discard untracked files.

Alpha question: checkpoint every turn, every mutation batch, or only before mutations? Measure storage and latency first.

### 3. Layered policy and sandbox

**Gap:** project trust controls extension loading; it is not command permissioning. No active extension currently gates bash, edits, network, MCP, credentials, or child-agent actions.

**Validated by:** Cursor Auto-review, Kilo sandbox, Codex named profiles/`writes` mode, Claude parameter-aware policies and explainable denials.

**Proposed package:** `pi-policy`

Decision pipeline:

1. Deterministic deny rules: secrets, protected paths, destructive Git, privilege escalation.
2. Deterministic allow rules: declared read-only calls and known-safe commands.
3. Sandbox eligible actions using `@anthropic-ai/sandbox-runtime`, Gondolin, Daytona, or a pluggable backend.
4. Classify genuinely ambiguous calls using a small model with natural-language policy.
5. Ask the user with exact command, affected paths, network destinations, patch/diff, classifier rationale, and grant scope.

Profiles:

- `read-only`
- `writes` (reads allowed, writes ask)
- `sandboxed`
- `reviewed-auto`
- `unrestricted`

Rules should match tool name **and arguments**, inherit into subagents/workflows, and support one-call/session/project grants. Classifier output must never override a deterministic deny.

### 4. Reviewable memory inbox / Skill Forge

**Gap:** you can install skills but Pi does not learn reusable knowledge or propose skill updates.

**Validated by:** Gemini memory inbox/canonical patches; Copilot Chronicle skill review and Forge; Kilo visible memory provenance.

**Proposed extension:** `pi-forge`

MVP:

- At `agent_settled`, identify candidate durable knowledge: repeated workflow, corrected command, repository convention, debugging recipe.
- Save a draft with source session/entry provenance; never mutate `AGENTS.md` or skills automatically.
- `/forge inbox`: accept, reject, defer, edit, or merge duplicates.
- Accepted candidates become a new skill or a patch to an existing skill, with a diff preview.
- Retrieval is relevance-based rather than injecting every learned item.
- Conversation markers show which memory/skill snippets were recalled.

Alpha risk: low-quality or secret-bearing memories. Start with explicit `/forge propose` and deterministic secret scanning before enabling automatic proposals.

### 5. Unified agent supervisor

**Gap:** workflow dashboards are per-run; subagents are per-parent-session and only return final callbacks. There is no single roster or safe way for one session to prompt another.

**Validated by:** Claude `claude agents`, Kilo Agent Manager, Codex descendant-thread APIs, Amp custom agents.

**Proposed extension:** `pi-supervisor`

MVP:

- `/agents` overlay across `subagents`, `workflows`, background bash, monitors, and optionally saved sessions.
- Show state, parent, depth, model, tokens/cost, elapsed time, cwd/worktree, latest activity, blocked reason, changed files.
- Actions: inspect transcript, stop, focus worktree, diff, copy result, retry, or send a follow-up.
- Agent-to-agent prompt requires explicit user confirmation and targets only idle sessions initially.
- Closing/removing a managed session must define child/process/worktree cleanup.

Do not add recursive delegation until there are global depth, concurrency, token, and dollar budgets.

### 6. Context inspector

**Gap:** footer/usage show aggregate consumption, not what occupies the current prompt.

**Validated by:** Cursor Context Usage Report.

**Proposed command:** `/context inspect`

Break down estimated tokens for:

- base system prompt
- AGENTS/context files
- active skill text
- active tool schemas and prompt guidance
- session messages and tool results
- compaction summary and recent verbatim tail
- extension-injected messages

Add actions to disable bulky tools/skills, compact, exclude selected context files, or open the exact source. Pi already exposes most inputs through `before_agent_start.systemPromptOptions`, `getAllTools`, `getContextUsage`, and `SessionManager`.

### 7. Aggregate diff-review canvas

**Gap:** no repository-wide review surface or inline comments that become structured prompts.

**Validated by:** OpenCode TUI diff viewer; Copilot `/diff` canvas; Kilo interactive review cards/image diffs.

**Proposed extension:** `pi-review`

- File-tree sidebar, staged/unstaged/base-branch modes.
- Unified/split diff display with syntax highlighting.
- Comment on a file/hunk/line; submit comments as one structured user message.
- Optional checkpoint restore per hunk/file.
- Policy engine can reuse it as the approval surface for proposed writes.

### 8. LSP diagnostics

**Gap:** no active LSP subsystem or persistent diagnostics channel.

**Validated by:** OpenCode's LSP diagnostics expansion.

**Proposed extension:** `pi-diagnostics`

- Discover existing language servers; never auto-install without permission.
- Track diagnostics only for opened/changed files initially.
- Tool: `get_diagnostics({files?, severity?, since?})`.
- After edits, inject concise newly introduced errors only; keep full diagnostics out of context unless requested.
- Surface status counts in footer and a `/diagnostics` overlay.

### 9. Session-owned background services

**Gap:** enhanced-bash owns background jobs, but it does not identify ports/dev servers, group resources by task, or expose attachable interactive shells.

**Validated by:** Kilo's tracked background process preview and Claude attachable background shells.

Enhance `enhanced-bash` with:

- stable process IDs and ownership metadata
- detected listening ports/URLs
- health/readiness conditions
- attach/tail/open actions
- cleanup policy on session switch, goal completion, and shutdown
- optional “keep alive across session” mode only after a durable supervisor exists

### 10. Authenticated headless runtime

**Gap:** Pi has excellent SDK/RPC foundations, but no ready authenticated persistent daemon, pairing/revocation, browser/mobile client, or detached agent recovery.

**Validated by:** Codex app server/remote control, Amp remote control/headless runner, Cline Hub, OpenCode server architecture.

This should be a separate Pi package/application—not merely an extension:

- SDK-based daemon with Unix socket/stdio first; network binding opt-in.
- Short-lived pairing token, explicit directory grants, revocation, TLS/noise tunnel.
- Same session runtime for TUI, web, editor, and automation clients.
- Event stream includes subagent text, tools, approvals, usage, and checkpoints.
- Do not expose arbitrary project selection or shell execution before the policy engine exists.

---

## 4. Recommended build order

### Phase 1 — high value, low risk

1. **`pi-context-inspector`** — one small extension; validates token attribution APIs.
2. **`pi-session-search`** — SQLite FTS5, session citations, `/search` overlay.
3. **`pi-checkpoints`** — hidden Git-object snapshots and selective restore.

These can ship independently and then combine into session intelligence.

### Phase 2 — differentiated alpha

4. Add Amp-style chronology-aware `read_session` subagent.
5. Add durable `/side` threads and context import back into parent.
6. Build aggregate diff review and connect it to checkpoints.
7. Build explicit-only `/forge propose` + review inbox.

### Phase 3 — execution safety and control plane

8. Deterministic `pi-policy` profiles and exact diff/command previews.
9. Add sandbox backend; only then experiment with classifier auto-review.
10. Build unified supervisor and mediated messages to idle sessions.
11. Add global budgets and bounded recursive delegation.

### Phase 4 — bigger platform bet

12. SDK-based daemon, pairing/revocation, remote clients, remote/sandbox adapters.

---

## 5. Features not worth prioritizing

- **Another MCP adapter:** current parent MCP support is already broad. Improve child-agent parity/output guards instead.
- **Another workflow DSL:** your `Workflow` extension already matches the strongest Claude/Codex announcements.
- **Basic subagents or worktrees:** already implemented with isolation, transcripts, callbacks, and concurrency controls.
- **Generic plan mode clone:** add a lightweight review/approval handoff to durable goals or enable/adapt Pi's reference plan-mode example instead.
- **More provider wrappers:** low leverage compared with session safety/intelligence.
- **Opaque automatic memory:** only pursue the reviewable inbox/patch model.
- **Unbounded recursive agents:** introduce budgets, depth, permissions, and supervisor UX first.
- **A web UI before a daemon/security model:** avoid coupling UI work to an unsafe execution server.

---

## 6. Immediate configuration and maintenance notes

These are not competitor-feature gaps, but surfaced during the audit:

1. **Automatic compaction is disabled** in `settings.json`; your durable goal extension can compact explicitly, but ordinary long sessions will not use threshold compaction. Reconsider enabling it before building more long-running UI.
2. `mcp.json` contains a bearer credential and is mode `0644`; change to `0600` and preferably move the secret into Keychain/env indirection.
3. Child-agent MCP lacks the parent adapter's OAuth, elicitation, caching, output guard, and truncation. Large child MCP results can consume excessive context.
4. `workflows` defaults children to `read,bash`, broader than `run_agent`'s read-only default. Consider making workflow defaults read-only and requiring explicit write/bash grants.
5. The subagent root documentation still mentions a nonexistent `poll_agent`; callbacks/artifact reads are the real interface.
6. `usage` excludes zero-cost turns, so it is a cost dashboard rather than a complete token dashboard for local/free models.

---

## 7. Research coverage and methodology

Products reviewed:

- OpenCode
- Kilo Code
- Claude Code
- OpenAI Codex CLI
- Google Gemini CLI
- Cursor Agent/CLI
- GitHub Copilot CLI
- Amp
- Cline
- Windsurf / Devin Desktop and Local
- Roo Code
- Aider

Method:

- Inclusive release window based on the environment date: `2026-04-16..2026-07-16`.
- Preferred official GitHub release bodies, official changelogs, and product news pages.
- Distinguished genuinely new capabilities from fixes, provider catalog maintenance, preview-only features, and older features merely promoted to default.
- Audited local extension entrypoints/READMEs, Pi `0.80.10` README/changelog, and the full Pi extension/SDK/TUI documentation.
- Local validation performed by the audit worker: all extension workspaces typechecked; 402 tests passed across extensions with test scripts. External MCP package tests and live service mutations were not run.

Detailed workflow evidence and subagent transcripts are stored temporarily under:

`~/.pi/agent/workflows/runs/23fae0ab/`

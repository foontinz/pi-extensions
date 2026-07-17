# Skill Forge

Skill Forge is a global Pi extension that continuously inventories **every persisted Pi session for the current project**, analyzes all historical and future session entries in bounded chunks, and prepares reviewable Agent Skill proposals. It never starts an agent session, never injects a message, never registers a model-facing tool, and never installs anything automatically.

## Behavior

- Inventory runs after `session_start`, `agent_settled`, compaction/tree changes, explicit sync, and about every 60 seconds.
- Inventory uses `SessionManager.list(cwd, sessionDir)`, stable JSONL snapshots, full-tree entry scanning, malformed-line isolation, rewrite/shrink replay, and durable per-session watermarks. If supporting history is rewritten or removed, unsupported ready proposals are invalidated before replay.
- A durable single-concurrency queue uses retry/backoff, stale-lease recovery, idempotent range IDs, and an atomic cross-process directory lock.
- The analyzer uses the active session model through a direct isolated `complete()` call and a strict one-off structured-output tool schema. It does not trigger Pi's main agent loop or create analyzer sessions.
- Analysis is precision-first and deny-by-default: empty output is preferred over a speculative proposal. A candidate needs proven recurrence, material generalization, substantial non-obvious value, and evidence-only instructions. A large successful task, repeated implementation steps, generic engineering hygiene, or a completion report does not qualify.
- Before every evaluation, Skill Forge inventories existing user/project skills and prompt templates from `<agent-dir>/{skills,prompts}` and `<cwd>/<CONFIG_DIR_NAME>/{skills,prompts}`, augmented by Pi's loaded skill metadata. Bounded, secret-redacted descriptions/content are sent to the analyzer, which must suppress capabilities already covered under any name, kind, wording, or scope. Active proposals from every project session are reconciled the same way.
- Exact-content duplicates, same-name creates, and updates without one unambiguous existing target are also suppressed deterministically after analysis; resources are rescanned after the model call to catch concurrent installs. Valid updates inherit the target's kind and scope, so updating a prompt cannot accidentally create a parallel skill.
- Images, thinking, extension-owned entries, oversized logs, and likely secrets are excluded or bounded. Tool outcomes, branch parentage, and bounded preceding/following context make corrections and reverts part of analysis; overlap changes during a model request invalidate its stale result.
- Validated proposals are merged by semantic capability and retain durable evidence provenance (session IDs and paths, entry IDs, timestamps, redacted excerpts, evidence digests, analyzer model, and prompt version). Each later chunk receives active proposal summaries and can invalidate a proposal by citing correction/revert evidence.

A session may correctly produce no proposal. `SKILL.md` is the only generated file in v1.

## Scope policy

Every proposal includes a canonical **PROPOSED SCOPE**:

- `user`: broadly reusable capability appropriate for the user's global skill directory.
- `project`: repository-specific commands, conventions, architecture, or policy.

The proposal includes scope rationale, confidence, and signals. Reviewers can override scope with `/forge scope <id> user|project`, in the review UI, or on acceptance. The selected target is:

- user: `<agent-dir>/skills/<name>/SKILL.md`
- project: `<cwd>/<CONFIG_DIR_NAME>/skills/<name>/SKILL.md`

Project installs require Pi project trust. Names/frontmatter are sanitized, paths are confined, symlinks are refused, writes are staged and atomic, and a differing destination requires an explicit collision diff confirmation. Applying state is persisted before the filesystem side effect and recovered on startup.

## Commands

- `/forge` — rich TUI inbox (sorted by confidence, scrolling list, type-to-filter, `ctrl+r` rejects the highlighted proposal, truncated to terminal width), or a plain-text inbox outside TUI
- `/forge status`
- `/forge sync`
- `/forge analyze`
- `/forge pause` / `/forge resume`
- `/forge inspect <id>`
- `/forge edit <id>`
- `/forge accept <id> [user|project] [skill|prompt]`
- `/forge reject <id> [reason]`
- `/forge defer <id>`
- `/forge reopen <id>`
- `/forge scope <id> <user|project>`
- `/forge kind <id> <skill|prompt>`
- `/forge retry [id|all]`
- `/forge doctor`

The TUI review flow displays proposed scope metadata and provenance separately, opens an editor containing only `SKILL.md`, and requires confirmation of the exact scope, kind, target, digest, and content before installation. Accepted resources offer a safe Pi resource reload.

Each proposal installs either as a **skill** (`<scope>/skills/<name>/SKILL.md`, auto-loaded by the agent) or as a **prompt template** (`<scope>/prompts/<name>.md`, invoked manually as the `/<name>` slash command). The review menu's `accept as…` picks kind and scope interactively; `set kind` / `set scope` persist overrides on the proposal.

## Storage

State is outside session JSONL under:

```text
<agent-dir>/skill-forge/projects/<sha256(realpath(cwd))>/state.json
```

The mode-0600 atomic JSON state contains canonical project metadata, config, queue/jobs, leases, session watermarks, proposals, applying/install records, provenance, and bounded diagnostics. Directories are mode 0700. `.state.lock/` is a short-lived atomic `mkdir` process lock.

Defaults: background enabled, 60-second inventory, four attempts, conservative ~36k-character requests, and the active session model.

## Security notes

Session transcripts are untrusted analyzer input. Secret-like values are recursively redacted before model submission and proposal persistence; evidence excerpts are bounded. Evidence digests do not contain transcript plaintext. **When the active model is remote, these redacted excerpts are sent to that model provider automatically**; use `/forge pause` whenever that is not desired. Generated skills can influence an agent and must be carefully reviewed. No proposal is auto-installed, collisions are never silently overwritten, and project content cannot be installed without trust.

The v1 analyzer uses Pi AI's provider-neutral compatibility `complete()` path. Built-in Anthropic, OpenAI, Codex, Google, Bedrock, Mistral, and Pi-message APIs are supported. A custom provider that depends on an extension-only `streamSimple` implementation or provider request hooks may not be analyzable through this path; the job remains visible as retry/dead with diagnostics instead of being silently skipped.

# Pi Skill Loader Extension

Installs Agent Skills-compatible GitHub repositories into Pi and controls model visibility for both downloaded skills and normal user skills under `~/.pi/agent/skills`.

## Install from CLI

```bash
pi --install-skill https://github.com/daytona/skills
```

This installs the skills as **user-only** and exits; it does not open an interactive Pi session. User-only skills remain available through `/skill:name` but are not advertised in the model's system prompt.

Explicitly enable newly downloaded skills in the model prompt:

```bash
pi --install-skill https://github.com/daytona/skills --install-skill-enabled
```

`--install-skill-disabled` remains accepted for compatibility and forces the user-only behavior.

## Command

```text
/skills-ui
```

`/skills-ui` opens a searchable TUI settings view like the extension manager. It reports an unsupported-mode warning in RPC and other non-TUI modes. It includes:

- skills downloaded through `--install-skill`;
- skills discovered normally under `<Pi agent dir>/skills` (default `~/.pi/agent/skills`).

Every newly discovered skill defaults to **user-only**. The two states are:

- `enabled`: advertised in the system prompt so the model may load it automatically;
- `user-only`: omitted from the system prompt but still available explicitly with either syntax:

```text
/skill:<name> optional arguments
Use @<name> anywhere in a prompt.
```

Examples:

```text
@code-review review the current diff
Review the current diff with @code-review.
Use @research and @code-review for this task.
```

In the TUI, typing `@` offers skill completions alongside Pi's existing `@file` completions. A tag must exactly match a discovered skill name. Email addresses, URLs, path-like tokens, and tags inside Markdown code spans, fenced blocks, or indented code are left unchanged. A bare exact name prefers the skill; when a file has the same `@name`, its file completion automatically inserts the escape form. Escape a known tag as `\@name` to send it literally.

The first inline skill is routed through Pi's native `/skill:name` expansion, preserving native argument placement, invocation rendering, provenance, and relative-path behavior. Additional unique tags use the same native skill block format because Pi expands only one leading skill command per prompt; only the first therefore receives Pi's collapsed invocation row. The original prompt remains after the loaded instructions, and duplicate tags load a skill only once. Invocation is cancelled before the agent starts if any requested skill cannot be read. Native `/skill:name` behavior is unchanged.

Inline tags are processed for interactive prompts and RPC `prompt` requests. Pi's dedicated RPC `steer` and `follow_up` queue operations bypass extension input hooks; use `/skill:name` with those operations or send the tag through `prompt` with streaming behavior.

The extension keeps every skill in Pi's normal discovery pipeline so both explicit syntaxes work for user-only skills too. It filters only the generated system-prompt skill catalog. User-owned `SKILL.md` files are never rewritten.

## Storage

- Registry and visibility preferences: `<Pi agent dir>/skill-loader/registry.json` (default: `~/.pi/agent/skill-loader/registry.json`)
- Immutable cloned-repo generations: `<Pi agent dir>/skill-loader/sources/`

The registry is atomically written and locked across concurrent Pi processes. Local preferences are keyed by discovered skill file path; moved or new skills therefore return to the safe user-only default. Reinstalling a URL publishes a fully validated immutable checkout generation, atomically switches the registry to it, and leaves paths held by existing Pi sessions unchanged. Live Pi runtimes pin their generations with process leases; unreferenced generations and stale staging trees are reclaimed during later refreshes. Refresh also reconciles skills removed from that source. A conflicting skill name from another downloaded source is rejected rather than inheriting its visibility. Missing or corrupt checkouts are skipped independently so valid downloaded skills remain available.

## Supported URLs

- `https://github.com/org/repo`
- `https://github.com/org/repo.git`
- `https://github.com/org/repo/tree/ref/path` (including branch names containing `/` when the ref can be resolved from the remote)
- `git@github.com:org/repo.git`

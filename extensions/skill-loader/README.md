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

`/skills-ui` opens a searchable CLI/TUI settings view like the extension manager. It includes:

- skills downloaded through `--install-skill`;
- skills discovered normally under `<Pi agent dir>/skills` (default `~/.pi/agent/skills`).

Every newly discovered skill defaults to **user-only**. The two states are:

- `enabled`: advertised in the system prompt so the model may load it automatically;
- `user-only`: omitted from the system prompt but still available explicitly with:

```text
/skill:<name> optional arguments
```

The extension keeps every skill in Pi's normal discovery pipeline so Pi owns command expansion and relative-path behavior. It filters only the generated system-prompt skill catalog. User-owned `SKILL.md` files are never rewritten.

## Storage

- Registry and visibility preferences: `<Pi agent dir>/skill-loader/registry.json` (default: `~/.pi/agent/skill-loader/registry.json`)
- Cloned repos: `<Pi agent dir>/skill-loader/sources/`

The registry is atomically written and locked across concurrent Pi processes. Local preferences are keyed by discovered skill file path; moved or new skills therefore return to the safe user-only default. Reinstalling a URL refreshes its fetched ref and reconciles skills that were removed from that source.

## Supported URLs

- `https://github.com/org/repo`
- `https://github.com/org/repo.git`
- `https://github.com/org/repo/tree/ref/path` (including branch names containing `/` when the ref can be resolved from the remote)
- `git@github.com:org/repo.git`

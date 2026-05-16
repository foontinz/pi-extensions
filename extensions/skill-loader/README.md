# Pi Skill Loader Extension

Installs Agent Skills-compatible GitHub repositories into Pi and controls whether those skills are visible in the system prompt.

## Install from CLI

```bash
pi --install-skill https://github.com/daytona/skills
```

This installs the skills and exits; it does not open an interactive Pi session.

Install but keep hidden from the system prompt:

```bash
pi --install-skill https://github.com/daytona/skills --install-skill-disabled
```

## Command

```text
/skills-ui
```

`/skills-ui` opens a CLI/TUI settings view like the extension manager and prompts to reload after changes.

Enabled skills are added to Pi's normal skill discovery via `resources_discover` and appear in the system prompt like any other skill.

Disabled skills are not added to discovery. They can still be loaded explicitly for one turn with:

```text
/skill:<name> optional arguments
```

## Storage

- Registry: `~/.pi/agent/skill-loader/registry.json`
- Cloned repos: `~/.pi/agent/skill-loader/sources/`

## Supported URLs

- `https://github.com/org/repo`
- `https://github.com/org/repo.git`
- `https://github.com/org/repo/tree/ref/path`
- `git@github.com:org/repo.git`

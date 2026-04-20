# pi-extensions

A Pi extensions workspace rooted at `~/.pi/agent`, so extensions live in the native `extensions/` directory and are auto-discovered by pi without extra path configuration.

Included extensions:

- `extensions/envvars`
- `extensions/openrouter-provider`
- `extensions/warp-grep`
- `extensions/fast-mode`
- `extensions/extension-manager`

## Workspace usage

This repo uses npm workspaces rooted at `extensions/*`, directly under `~/.pi/agent`.

```bash
npm ci
npm run check
```

## CI

GitHub Actions runs workspace typechecking on every push to `main` and on pull requests.

## Extension manager extension

`extensions/extension-manager` adds an `/extensions-ui` command that opens an interactive toggle UI for local extensions.

Current scope:
- auto-discovered extensions in `~/.pi/agent/extensions` and `.pi/extensions`
- explicit local extension paths from `settings.json`

Behavior:
- writes exact-path disable entries to the appropriate `settings.json`
- prompts for `/reload` after changes

## Fast mode extension

`extensions/fast-mode` adds a `/fast` command that toggles per-model request acceleration for a small allowlist of models:

- `anthropic/claude-opus-4-6`
- `anthropic/claude-opus-4-7`
- `openai-codex/gpt-5.4`

The toggle is persisted per model in `~/.pi/agent/fast-mode.json`.

## Notes

- Environment files such as `.env`, `.env.*`, and `.envrc` are ignored and intentionally not committed.

# pi-extensions

A small monorepo containing Pi extensions:

- `extensions/envvars`
- `extensions/openrouter-provider`
- `extensions/warp-grep`
- `extensions/fast-mode`

## Workspace usage

This repo uses npm workspaces rooted at `extensions/*`.

```bash
npm ci
npm run check
```

## CI

GitHub Actions runs workspace typechecking on every push to `main` and on pull requests.

## Fast mode extension

`extensions/fast-mode` adds a `/fast` command that toggles per-model request acceleration for a small allowlist of models:

- `anthropic/claude-opus-4-6`
- `anthropic/claude-opus-4-7`
- `openai-codex/gpt-5.4`

The toggle is persisted per model in `~/.pi/agent/fast-mode.json`.

## Notes

- Environment files such as `.env`, `.env.*`, and `.envrc` are ignored and intentionally not committed.

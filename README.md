# pi-extensions

A small monorepo containing three Pi extensions:

- `extensions/envvars`
- `extensions/openrouter-provider`
- `extensions/warp-grep`

## Workspace usage

This repo uses npm workspaces rooted at `extensions/*`.

```bash
npm ci
npm run check
```

## CI

GitHub Actions runs workspace typechecking on every push to `main` and on pull requests.

## Notes

- Environment files such as `.env`, `.env.*`, and `.envrc` are ignored and intentionally not committed.

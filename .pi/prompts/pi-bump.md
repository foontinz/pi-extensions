---
description: Bump this Pi extension workspace to the installed/latest Pi version and apply changelog migrations
argument-hint: "[target-version|latest]"
---
Update this Pi extension workspace for a new Pi release. Target requested by user: `$@`.

Goal: bump all local extension/package dependencies that track Pi, read the upstream changelog/docs for the target release, apply any required code/config migrations in extensions, validate, and leave a clean commit-ready worktree.

Workflow:

1. Establish the target release.
   - Run `pi --version` to see the installed Pi CLI version.
   - Run `npm view @mariozechner/pi-coding-agent version` to see the latest published version.
   - If `$@` is empty, use the installed Pi version when it is newer than local dependencies; otherwise use the latest published version.
   - If `$@` names a version, use that exact version.

2. Inspect current workspace state before editing.
   - `git status --short`
   - `git diff --stat`
   - `npm outdated --depth=0 || true`
   - Identify all `package.json` files under the root and `extensions/*/package.json`.
   - Check for nested stale lockfiles under extensions; do not update them unless they are intentionally used. Mention stale nested locks if found.

3. Read release notes and migration docs before changing code.
   - Read the upstream changelog for the target release and any versions since the current local Pi dependency version:
     `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md`
   - Also inspect installed docs when relevant:
     `/Users/barbos/.nvm/versions/node/v25.8.2/lib/node_modules/@mariozechner/pi-coding-agent/README.md`
     `/Users/barbos/.nvm/versions/node/v25.8.2/lib/node_modules/@mariozechner/pi-coding-agent/docs`
   - For breaking changes, follow referenced docs completely enough to understand the required migration.

4. Bump dependency versions.
   - Update every local workspace dependency on these Pi packages to the target version:
     - `@mariozechner/pi-coding-agent`
     - `@mariozechner/pi-ai`
     - `@mariozechner/pi-agent-core` if present
     - `@mariozechner/pi-tui`
   - Update closely-related non-major dependencies shown by `npm outdated --depth=0` when safe, especially `typebox`, while avoiding risky major upgrades such as TypeScript unless the changelog requires it.
   - Preserve intentional exact pins such as Playwright unless they are outdated and were already being kept in sync or the changelog requires an update.
   - Run `npm install` at the workspace root to refresh `package-lock.json`.

5. Apply changelog migrations to this repo.
   - Search the repo for symbols/configuration mentioned in breaking changes and fixes, for example renamed provider fields, model metadata fields, API signatures, tool/rendering APIs, auth provider names/env vars, or TUI API changes.
   - Update extension source code, docs, prompts, and config where needed.
   - Specifically check custom providers under `extensions/*provider*` and `models.json` for provider/model metadata migrations.
   - Do not modify user secrets or rotate API keys. If an env var rename is required, update docs/templates and report the manual secret migration needed.

6. Validate.
   - Run `npm run check --workspaces --if-present`.
   - If code paths changed, run the smallest relevant build/test command available.
   - Run `npm outdated --depth=0 || true` again and explain any intentionally remaining outdated packages.
   - Run `npm ls @mariozechner/pi-coding-agent @mariozechner/pi-ai @mariozechner/pi-tui typebox --depth=0` or an equivalent command to show resolved versions.

7. Report clearly.
   - Summarize version bumps.
   - Summarize changelog items checked and migrations applied or deemed unnecessary.
   - List validation commands and results.
   - Show remaining uncommitted files and ask whether to commit/push unless the user explicitly requested commit/push.

Guardrails:
- Do not commit unless explicitly asked.
- Do not run `pi update` unless the user explicitly asks to update the globally installed Pi CLI.
- Do not upgrade TypeScript to a new major version just because it is latest; keep it pinned unless required.
- Do not overwrite unrelated user changes. If unrelated changes exist, leave them alone and mention them.
- Prefer precise edits over broad rewrites.

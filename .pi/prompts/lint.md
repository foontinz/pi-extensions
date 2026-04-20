---
description: Reconcile uncommitted changes, untracked files, and stale or dead code in this repo
argument-hint: "[extra focus]"
---
Audit the current repository worktree and reconcile unfinished local changes.

Extra focus from the user: $@

Workflow:
1. Inspect the worktree before editing:
   - `git status --short`
   - `git diff --stat`
   - `git diff --cached --stat`
   - inspect the actual diffs for tracked files
   - inspect untracked files/directories individually before deciding what to do
2. Build a short inventory with these buckets:
   - keep as intentional work
   - fix/refactor
   - delete/move
   - local-only/generated/should-be-ignored
3. Reconcile whatever is clearly safe to clean up now:
   - remove dead, stale, duplicated, commented-out, or unused code introduced or exposed by the current changes
   - remove accidental scratch files, generated artifacts, temp files, obsolete scripts/docs/tests, and empty directories when confidence is high
   - update imports/exports/references after removals
   - if something should remain local-only, add or update `.gitignore` instead of leaving it ambiguous
4. Validate with the smallest relevant checks for the touched areas.
   - In this repo, prefer targeted workspace/package checks when possible
   - fall back to `npm run check` if changes span multiple areas
5. Report back with:
   - what you removed
   - what you kept intentionally
   - anything suspicious or ambiguous that still needs human review

Guardrails:
- Do not revert or overwrite intentional user changes just because they are incomplete
- Do not delete ambiguous files without inspecting them first; ask when intent is unclear
- Prefer minimal, safe cleanups with clear rationale
- If you find probable dead code outside the changed area, mention it and clean it only when confidence is high

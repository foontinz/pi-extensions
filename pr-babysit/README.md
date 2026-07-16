# pr-babysit

Standalone TypeScript CLI that watches GitHub pull requests in tmux and dispatches isolated headless pi runs for new comments, reviews, CI results, and merge conflicts.

## Installation

```sh
cd path/to/pr-babysit
npm install
npm run check
npm link
```

`npm link` installs `pr-babysit` for the active Node installation. Verify it with `pr-babysit --version`. To uninstall it later, run `npm unlink -g pr-babysit`.

## Requirements

- Node.js 25.2 or newer
- `tmux`
- authenticated `gh` (`gh auth status`)
- `pi`

Create `~/.pr-babysitter/config.json` before an event can invoke pi:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.4-mini",
  "pollIntervalSec": 60,
  "runTimeoutMin": 15,
  "maxConcurrentRuns": 2
}
```

The provider and model are always passed explicitly. Runs disable extension, skill, context-file, and project-local approval discovery.

Optional `baseMergeMessage` (a single-line string) sets the commit message used when the base branch is auto-merged into the head branch (see *Branch synchronization*). Set it when the repository enforces a commit-message ruleset that git's default merge message would violate, e.g. `"chore: merge base branch GENAI=NO"`. When omitted, git's default merge message is used.

## Usage

```sh
node src/cli.ts watch https://github.com/OWNER/REPO/pull/123
node src/cli.ts status
node src/cli.ts status --all
node src/cli.ts ack ESCALATION-UUID
node src/cli.ts unwatch owner/repo#123
```

`watch` is idempotent. It provisions one managed worktree and one foreground pane in the tmux `babysitting` window per PR. The pane border is labelled `repo #N · cropped PR title · status`, keeping the repository and PR number visible even for long titles. `status` shows active PRs; use `status --all` to include retained merged and closed PRs. State, event history, prompts, JSONL output, sessions, and escalation history remain under `~/.pr-babysitter`; only explicit `unwatch` removes the worktree, and state is archived rather than discarded.

A bare PR number resolves against the current Git repository. `run --pr [host/]owner/repo#N` is an internal pane command; `--once` is useful for controlled diagnostics.

## Branch synchronization

Before every run, a clean managed worktree is fast-forwarded to the latest pushed head commit and the PR base branch (`origin/<baseRefName>`, e.g. `main`) is automatically merged into the head branch. When the merge introduces new commits they are pushed straight to the PR head ref, so the pull request stays continuously up to date with its base. The merge commit message is git's default unless `baseMergeMessage` is configured (needed when a repository enforces commit-message rules). A merge that stays local because a push failed is retried on the next sync. Fast-forwards, real merges, and "already merged" states are all handled; a merge that conflicts is aborted and left for the dispatched agent to resolve rather than blocking the run. If the worktree has uncommitted local changes, synchronization (and the base merge) is skipped for that run. The chosen action is recorded in the run prompt and `runs/<run-id>/meta.json`.

## GitHub Enterprise Server

Authenticate the host with `gh`, then pass its PR URL:

```sh
gh auth login --hostname github.example.com
pr-babysit watch https://github.example.com/OWNER/REPO/pull/123
```

Enterprise state keys include the hostname (`github.example.com/owner/repo#123`) so they cannot collide with GitHub.com. Every `gh api` call uses `--hostname`, every repository operation uses `[HOST/]OWNER/REPO`, and the agent process receives the watched host as `GH_HOST`; push-remote validation, rate-limit checks, and generated reply links use the same explicit host. This also prevents an ambient `GH_HOST` from redirecting an explicit GitHub.com URL. For shorthand `owner/repo#N` outside a repository, set `GH_HOST=github.example.com`; full URLs and host-qualified keys do not require it. TLS certificates and Enterprise authentication remain managed by `gh`.

## Security model

PR-authored text is escaped JSON inside one `<untrusted_pr_content>` block. The appended system rules prohibit credential discovery, arbitrary network requests, hook bypass, unrelated branches/repositories, and unmarked replies. Coalesced code changes still produce one separately attributed response per source comment; inline review comments use GitHub's review-thread reply endpoint, while issue comments receive separate permalink-attributed timeline responses because GitHub does not thread them. The runner verifies distinct, self-authored, run-marked API replies for every source target before removing any queued event. A per-worktree external `pre-push` hook pins the resolved GitHub head-repository URL and rejects alternate remotes, branch deletion, non-fast-forward updates, and every destination except the exact PR head ref.

The hook is defense in depth, not a general-purpose host sandbox: pi's built-in bash tool executes with the invoking user's OS permissions. Run the CLI only for repositories and providers you trust enough to execute normal project tooling. Escalation is preferred whenever a request is unsafe, ambiguous, contradictory, unverifiable, or outside the PR.

## Recovery

- **stale pane:** rerun `watch` for the same PR. Pending events and run history are durable; completed run metadata or remote reply markers are reconciled before any event is re-executed.
- **error status:** inspect the pane, `state.json`, and `runs/<run-id>/`; repair `gh` authentication/configuration and rerun `watch`.
- **dirty worktree on unwatch:** commit or stash wanted work, or explicitly discard it with `unwatch owner/repo#N --force`.
- **escalation:** inspect its run artifacts, then run `ack <id>`.
- **corrupt state:** `status` names the exact invalid state file and exits nonzero; restore or remove only that file.
- **merged/closed PR:** the pane exits and the PR is hidden from default `status`; use `status --all` to inspect it. The worktree and history remain until `unwatch`.

Use `PR_BABYSIT_HOME` for an isolated state root and `PR_BABYSIT_TMUX_SOCKET` for an isolated tmux server.

## Verification

```sh
npm run check
npm test
npm run test:live
```

The opt-in E2E creates or reuses the authenticated account's private `pr-babysit-e2e` repository, opens and merges a scratch PR, and retains a scrubbed summary under `test/artifacts/`:

```sh
npm run test:e2e
```

It verifies GitHub Actions bot comments flowing through deduplicated fix/push/reply, separate responses for coalesced source comments, malicious payload fencing and blocked prohibited pushes, escalation/acknowledgement, crash retention across pane restart, terminal merge handling, preserved worktree history, and explicit unwatch.

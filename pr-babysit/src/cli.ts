#!/usr/bin/env node

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.ts";
import { dispatchPendingEvents, recoverInterruptedRun } from "./dispatcher.ts";
import { acknowledgeEscalation } from "./escalation.ts";
import { GhClient, GhCommandError } from "./gh.ts";
import { notifyEscalation } from "./notify.ts";
import { HOME_ENV, TMUX_SOCKET_ENV, appPaths, ensureAppDirs, ensurePrDirs, parsePrKey, prPaths } from "./paths.ts";
import { backoffMilliseconds, pollOnce, recordPollError } from "./poller.ts";
import {
  archivePrState,
  createPrState,
  listPrStates,
  loadPrState,
  savePrState,
  type PrState,
} from "./state.ts";
import { ensurePrPane, ensureTmuxAvailable, isPaneLive, killPrPane, setPaneLabel } from "./tmux.ts";
import { provisionWorktree, removeManagedWorktree, worktreeDirty } from "./worktree.ts";

const VERSION = "0.1.0";
const CLI_PATH = fileURLToPath(import.meta.url);

const HELP = `pr-babysit ${VERSION}

Usage:
  pr-babysit watch <pr-url|number|[host/]owner/repo#N>
  pr-babysit status
  pr-babysit unwatch <[host/]owner/repo#N> [--force]
  pr-babysit ack <escalation-id>
  pr-babysit run --pr <[host/]owner/repo#N> [--once]

Requirements:
  tmux, an authenticated gh CLI, Node >=25.2, and ~/.pr-babysitter/config.json
  with explicit "provider" and "model" fields before an agent run.

Operation:
  watch is idempotent and accepts a GitHub.com or Enterprise PR URL, canonical
  [host/]owner/repo#N key, or a bare number in a Git repository. Worktrees,
  event history, sessions, and run artifacts stay under ~/.pr-babysitter until
  explicit unwatch. run is an internal pane command.

Recovery:
  stale pane       rerun watch for the same PR; durable pending work is retained
  error status     inspect the pane and runs/<run-id>, fix gh/config, rerun watch
  dirty unwatch    commit or stash wanted work, or retry unwatch with --force
  escalation       inspect status/artifacts, then ack <escalation-id>
  corrupt state    restore/remove only the reported state file; status exits 1

Set GH_HOST for Enterprise shorthand keys, PR_BABYSIT_HOME to isolate all state,
and PR_BABYSIT_TMUX_SOCKET to select an isolated tmux server. A merged PR or
closed PR stops its pane but keeps its worktree.
`;

export type Invocation =
  | { command: "help" }
  | { command: "version" }
  | { command: "watch"; input: string }
  | { command: "status" }
  | { command: "unwatch"; key: string; force: boolean }
  | { command: "ack"; escalationId: string }
  | { command: "run"; key: string; once: boolean };

export interface CliIo {
  out(message: string): void;
  error(message: string): void;
}

class UsageError extends Error {}

type ParseOptions = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>["options"]>;

function parseCommandArgs(
  args: string[],
  options: ParseOptions,
): ReturnType<typeof parseArgs> {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function oneArgument(positionals: string[], command: string, expected: string): string {
  if (positionals.length !== 1 || positionals[0] === undefined) {
    throw new UsageError(`${command} requires exactly one ${expected} argument`);
  }
  return positionals[0];
}

function oneKey(positionals: string[], command: string): string {
  const input = oneArgument(positionals, command, "[host/]owner/repo#N");
  try {
    return parsePrKey(input).key;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export function parseInvocation(argv: string[]): Invocation {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { command: "help" };
  if (argv[0] === "--version" || argv[0] === "-v") return { command: "version" };

  const [command, ...args] = argv;
  switch (command) {
    case "watch": {
      const parsed = parseCommandArgs(args, { help: { type: "boolean", short: "h" } });
      if (parsed.values.help) return { command: "help" };
      return { command: "watch", input: oneArgument(parsed.positionals, "watch", "PR URL, number, or owner/repo#N") };
    }
    case "status": {
      const parsed = parseCommandArgs(args, { help: { type: "boolean", short: "h" } });
      if (parsed.values.help) return { command: "help" };
      if (parsed.positionals.length !== 0) throw new UsageError("status accepts no positional arguments");
      return { command: "status" };
    }
    case "unwatch": {
      const parsed = parseCommandArgs(args, {
        force: { type: "boolean", short: "f", default: false },
        help: { type: "boolean", short: "h" },
      });
      if (parsed.values.help) return { command: "help" };
      return {
        command: "unwatch",
        key: oneKey(parsed.positionals, "unwatch"),
        force: parsed.values.force === true,
      };
    }
    case "ack": {
      const parsed = parseCommandArgs(args, { help: { type: "boolean", short: "h" } });
      if (parsed.values.help) return { command: "help" };
      const escalationId = oneArgument(parsed.positionals, "ack", "escalation ID");
      if (!/^[a-f\d-]{36}$/i.test(escalationId)) throw new UsageError("ack requires a UUID escalation ID");
      return { command: "ack", escalationId };
    }
    case "run": {
      const parsed = parseCommandArgs(args, {
        pr: { type: "string" },
        once: { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      });
      if (parsed.values.help) return { command: "help" };
      if (parsed.positionals.length !== 0) throw new UsageError("run accepts --pr, not a positional PR key");
      const pr = parsed.values.pr;
      if (typeof pr !== "string" || pr === "") throw new UsageError("run requires --pr [host/]owner/repo#N");
      try {
        return { command: "run", key: parsePrKey(pr).key, once: parsed.values.once === true };
      } catch (error) {
        throw new UsageError((error as Error).message);
      }
    }
    default:
      throw new UsageError(`Unknown command: ${command ?? ""}`);
  }
}

async function watch(input: string, io: CliIo): Promise<void> {
  const app = appPaths();
  await ensureAppDirs(app);
  await loadConfig(app);
  const resolveOptions: { cwd: string; host?: string } = { cwd: process.cwd() };
  if (process.env.GH_HOST) resolveOptions.host = process.env.GH_HOST;
  const resolved = await new GhClient().resolvePr(input, resolveOptions);
  const key = resolved.key;
  if (resolved.state !== "OPEN") throw new Error(`${key} is ${resolved.state.toLowerCase()} and cannot be watched`);
  await ensureTmuxAvailable();
  const paths = prPaths(key, app);
  await ensurePrDirs(paths);

  let state = await loadPrState(key, app);
  if (!state) {
    state = createPrState({ key, url: resolved.url, headRefName: resolved.headRefName });
  } else {
    state.url = resolved.url;
    state.headRefName = resolved.headRefName;
  }
  await savePrState(state, app);

  try {
    const worktree = await provisionWorktree(resolved, app);
    state.repoRoot = worktree.repoRoot;
    state.worktreePath = worktree.worktreePath;
    await savePrState(state, app);
  } catch (error) {
    state.status = "error";
    state.lastError = (error as Error).message;
    await savePrState(state, app);
    throw error;
  }

  const childEnv: Record<string, string> = { [HOME_ENV]: app.home };
  const socketName = process.env[TMUX_SOCKET_ENV];
  if (socketName !== undefined) childEnv[TMUX_SOCKET_ENV] = socketName;
  if (process.env.GH_HOST !== undefined) childEnv.GH_HOST = process.env.GH_HOST;

  try {
    const pane = await ensurePrPane(
      key,
      {
        executable: process.execPath,
        args: [CLI_PATH, "run", "--pr", key],
        cwd: process.cwd(),
        env: childEnv,
      },
      state.tmux,
      app,
    );
    state.tmux = pane.ref;
    state.status = "watching";
    state.lastError = null;
    await savePrState(state, app);
    await setPaneLabel(pane.ref, key, `${key} · watching`);
    io.out(`${pane.disposition === "created" ? "Watching" : "Already watching"} ${key} in pane ${pane.ref.paneId}`);
  } catch (error) {
    state.status = "error";
    state.lastError = (error as Error).message;
    await savePrState(state, app);
    throw error;
  }
}

function formatRows(rows: Array<{ key: string; status: string; pane: string; escalations: string; updated: string }>): string {
  const all = [{ key: "KEY", status: "STATUS", pane: "PANE", escalations: "UNACK", updated: "UPDATED" }, ...rows];
  const widths = {
    key: Math.max(...all.map((row) => row.key.length)),
    status: Math.max(...all.map((row) => row.status.length)),
    pane: Math.max(...all.map((row) => row.pane.length)),
    escalations: Math.max(...all.map((row) => row.escalations.length)),
  };
  return all
    .map(
      (row) =>
        `${row.key.padEnd(widths.key)}  ${row.status.padEnd(widths.status)}  ${row.pane.padEnd(widths.pane)}  ${row.escalations.padStart(widths.escalations)}  ${row.updated}`,
    )
    .join("\n");
}

export function displayStatus(state: Pick<PrState, "status" | "cursors">): string {
  return state.cursors.prState !== null && state.cursors.prState !== "OPEN"
    ? state.cursors.prState.toLowerCase()
    : state.status;
}

async function status(io: CliIo): Promise<number> {
  const entries = await listPrStates();
  const valid = entries.filter((entry): entry is typeof entry & { state: PrState } => entry.state !== undefined);
  const rows = await Promise.all(
    valid
      .map((entry) => entry.state)
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(async (state) => ({
        key: state.key,
        status: displayStatus(state),
        pane: (await isPaneLive(state.tmux, state.key)) ? "up" : "stale",
        escalations: String(state.escalations.filter((item) => !item.acknowledged).length),
        updated: state.updatedAt,
      })),
  );

  if (rows.length === 0) io.out("No PRs watched.");
  else io.out(formatRows(rows));

  const corrupt = entries.filter((entry) => entry.error !== undefined);
  for (const entry of corrupt) io.error(`Invalid state ${entry.path}: ${entry.error?.message ?? "unknown error"}`);
  return corrupt.length === 0 ? 0 : 1;
}

async function unwatch(key: string, force: boolean, io: CliIo): Promise<void> {
  const app = appPaths();
  const state = await loadPrState(key, app);
  if (!state) throw new Error(`${key} is not watched`);

  if ((state.repoRoot === null) !== (state.worktreePath === null)) {
    throw new Error(`Refusing inconsistent worktree state for ${key}`);
  }
  if (state.repoRoot && state.worktreePath && !force && await worktreeDirty(state, app)) {
    throw new Error(`Worktree for ${key} has uncommitted changes; retry unwatch with --force`);
  }

  const result = await killPrPane(state.tmux, key, process.env, app);
  if (result === "ownership-mismatch") {
    throw new Error(`Refused to kill stale or unowned pane recorded for ${key}; state was retained`);
  }
  if (state.repoRoot && state.worktreePath) {
    await removeManagedWorktree(state, force, app);
    state.repoRoot = null;
    state.worktreePath = null;
    state.tmux = null;
    await savePrState(state, app);
  }
  const archive = await archivePrState(key, app);
  io.out(`Unwatched ${key}; worktree removed and history retained${archive ? ` in ${archive}` : ""}`);
}

async function waitForState(key: string, requireTmux: boolean): Promise<PrState> {
  const app = appPaths();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await loadPrState(key, app);
    if (!state) throw new Error(`No watched state exists for ${key}`);
    if (!requireTmux || state.tmux) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const state = await loadPrState(key, app);
  if (!state) throw new Error(`No watched state exists for ${key}`);
  return state;
}

async function waitWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function runPoller(key: string, once: boolean, io: CliIo): Promise<void> {
  let state = await waitForState(key, !once);
  const app = appPaths();
  const config = await loadConfig(app);
  const client = new GhClient();
  const controller = new AbortController();
  let stoppedBy: NodeJS.Signals | null = null;
  const stop = (signal: NodeJS.Signals): void => {
    stoppedBy = signal;
    controller.abort();
  };
  const onSigint = (): void => stop("SIGINT");
  const onSigterm = (): void => stop("SIGTERM");
  const onSighup = (): void => stop("SIGHUP");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("SIGHUP", onSighup);

  try {
    await recoverInterruptedRun(state, app, client);
    const host = parsePrKey(key).host;
    let ownLogin: string | null = null;
    if (state.tmux) await setPaneLabel(state.tmux, key, `${key} · watching`);
    io.out(`[${new Date().toISOString()}] ${key} · poller started${once ? " (--once)" : ""}`);

    while (!controller.signal.aborted) {
      state = (await loadPrState(key, app)) ?? state;
      try {
        ownLogin ??= await client.currentLogin({ signal: controller.signal, host });
        const result = await pollOnce(client, state, ownLogin, app, { signal: controller.signal });
        if (result.initialized) io.out(`[${new Date().toISOString()}] ${key} · baseline established`);
        for (const event of result.events) io.out(`[${new Date().toISOString()}] ${key} · queued ${event.type}: ${event.summary}`);
        if (!result.initialized && result.events.length === 0) {
          io.out(`[${new Date().toISOString()}] ${key} · no new events`);
        }
        if (state.tmux) {
          const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          await setPaneLabel(state.tmux, key, `${key} · watching · ${time}`);
        }
        if (result.terminalState !== null) {
          io.out(`[${new Date().toISOString()}] ${key} · PR ${result.terminalState.toLowerCase()}; watcher stopped`);
          return;
        }

        if (state.pendingEvents.length > 0) {
          io.out(`\a[${new Date().toISOString()}] ${key} · dispatching ${state.pendingEvents.length} queued event${state.pendingEvents.length === 1 ? "" : "s"}`);
          if (state.tmux) await setPaneLabel(state.tmux, key, `${key} · agent running`);
          const dispatched = await dispatchPendingEvents(state, config, { app, signal: controller.signal });
          if (dispatched) {
            if (dispatched.escalation) {
              io.error(`\u001b[31m\a${key} · ESCALATED ${dispatched.escalation.id}: ${dispatched.escalation.reason}\u001b[0m`);
            } else {
              io.out(`[${new Date().toISOString()}] ${key} · agent ${dispatched.outcome} (${dispatched.runId})`);
            }
            if (dispatched.error) io.error(`${key} · agent error: ${dispatched.error}`);
            if (dispatched.notificationError) io.error(`${key} · notification failed: ${dispatched.notificationError}`);
          }
          if (state.tmux) await setPaneLabel(state.tmux, key, `${key} · watching`);
        }
        if (once) return;
        await waitWithAbort(config.pollIntervalSec * 1_000, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) break;
        const failure = error as Error;
        const previousErrors = state.consecutiveErrors;
        await recordPollError(state, failure, app);
        io.error(`[${new Date().toISOString()}] ${key} · poll error ${state.consecutiveErrors}: ${failure.message}`);
        if (previousErrors < 5 && state.consecutiveErrors >= 5) {
          io.error(`\u001b[31m\a${key} · polling entered error state after 5 failures\u001b[0m`);
          await notifyEscalation(`PR babysitter: ${key}`, "Polling entered error state after five failures").catch(() => false);
        }
        if (state.tmux) await setPaneLabel(state.tmux, key, `${key} · error ${state.consecutiveErrors}`);
        if (once) throw failure;

        let delay = backoffMilliseconds(config.pollIntervalSec, state.consecutiveErrors);
        if (failure instanceof GhCommandError && (failure.rateLimited || failure.forbidden)) {
          const reset = await client.rateLimitResetAt({ host }).catch(() => null);
          if (reset !== null) delay = Math.max(delay, reset.getTime() - Date.now() + 1_000);
        }
        io.error(`[${new Date().toISOString()}] ${key} · retrying in ${Math.ceil(delay / 1_000)}s`);
        await waitWithAbort(delay, controller.signal);
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    if (stoppedBy !== null) io.out(`[${new Date().toISOString()}] ${key} · stopped (${stoppedBy})`);
  }
}

export function recoveryHint(message: string): string {
  if (/config\.json|provider|model/i.test(message)) {
    return "Set valid provider/model fields in ~/.pr-babysitter/config.json, then rerun watch.";
  }
  if (/must be|must return|Unknown .*state|returned (a|an) (mismatched|unexpected)/i.test(message)) {
    return "gh returned unexpected data (often an older GitHub Enterprise schema); update `gh`, confirm the PR URL/host, and file an issue with the failing field.";
  }
  if (/rate.?limit|403|401|authentication|not logged in|auth/i.test(message)) {
    return "Run `gh auth status`, repair authentication or wait for rate-limit reset, then rerun watch.";
  }
  if (/\bgh\b|GitHub/i.test(message)) {
    return "Verify `gh` is installed and the PR URL/host is reachable, then rerun watch.";
  }
  if (/tmux/i.test(message)) {
    return "Install/start tmux, verify the configured socket, then rerun watch; durable state is retained.";
  }
  if (/uncommitted|dirty worktree/i.test(message)) {
    return "Commit or stash wanted work, or use `unwatch <key> --force` to discard it explicitly.";
  }
  if (/ownership|unowned pane/i.test(message)) {
    return "Use the original PR_BABYSIT_HOME/tmux socket and inspect `status`; state was retained for safe manual recovery.";
  }
  return "Run `pr-babysit status`, inspect the PR pane and ~/.pr-babysitter/prs run artifacts, then retry the command.";
}

export async function main(argv = process.argv.slice(2), io: CliIo = {
  out: (message) => console.log(message),
  error: (message) => console.error(message),
}): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(argv);
  } catch (error) {
    io.error(`Error: ${(error as Error).message}`);
    io.error("Run pr-babysit --help for usage.");
    return error instanceof UsageError ? 2 : 1;
  }

  try {
    switch (invocation.command) {
      case "help":
        io.out(HELP.trimEnd());
        return 0;
      case "version":
        io.out(VERSION);
        return 0;
      case "watch":
        await watch(invocation.input, io);
        return 0;
      case "status":
        return status(io);
      case "unwatch":
        await unwatch(invocation.key, invocation.force, io);
        return 0;
      case "ack": {
        const acknowledged = await acknowledgeEscalation(invocation.escalationId);
        io.out(`Acknowledged ${acknowledged.escalation.id} for ${acknowledged.state.key}`);
        return 0;
      }
      case "run":
        await runPoller(invocation.key, invocation.once, io);
        return 0;
    }
  } catch (error) {
    const message = (error as Error).message;
    io.error(`Error: ${message}`);
    io.error(`Recovery: ${recoveryHint(message)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}

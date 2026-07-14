import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { finished } from "node:stream/promises";

import { type Config, requireAgentModel } from "./config.ts";
import { consumeEscalationFile, parseEscalationSentinel, type EscalationRequest } from "./escalation.ts";
import { GhClient } from "./gh.ts";
import { type AppPaths, appPaths, ensurePrDirs, parsePrKey, prPaths } from "./paths.ts";
import { buildRunnerRules, buildRunPrompt, escalationFilePath } from "./prompt.ts";
import { type ReplyReceipt, verifyRequiredReplies } from "./replies.ts";
import { acquireRunSlot } from "./slots.ts";
import type { EventRecord, LastRun, PrState } from "./state.ts";
import { writeJsonAtomic } from "./state.ts";
import { syncWorktreeBeforeRun, type SyncResult } from "./worktree.ts";

export interface AgentRunResult {
  runId: string;
  outcome: Exclude<LastRun["outcome"], null>;
  artifactDir: string;
  finalText: string;
  escalation: EscalationRequest | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sync: SyncResult;
  replyReceipts: ReplyReceipt[];
}

export interface RunnerOptions {
  app?: AppPaths;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  piExecutable?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  now?: () => Date;
  runId?: string;
  replyVerifier?: (
    state: Pick<PrState, "key">,
    events: readonly EventRecord[],
    runId: string,
    signal?: AbortSignal,
  ) => Promise<ReplyReceipt[]>;
}

interface ParsedAgentEnd {
  finalText: string;
  usage: unknown;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
        return typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function parseAgentEndJsonl(text: string): ParsedAgentEnd {
  let found: Record<string, unknown> | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Invalid pi JSONL line ${index + 1}: ${(error as Error).message}`);
    }
    if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === "agent_end") {
      found = value as Record<string, unknown>;
    }
  }
  if (!found) throw new Error("pi JSONL did not contain an agent_end event");
  const messages = Array.isArray(found.messages) ? found.messages : [];
  const last = [...messages].reverse().find((message) =>
    typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant"
  ) as Record<string, unknown> | undefined;
  const finalText = contentText(last?.content ?? found.message ?? found.text);
  return { finalText, usage: found.usage ?? last?.usage ?? null };
}

function piArguments(
  provider: string,
  model: string,
  sessionsDir: string,
  rulesPath: string,
  prompt: string,
): string[] {
  return [
    "--print",
    "--mode",
    "json",
    "--provider",
    provider,
    "--model",
    model,
    "--session-dir",
    sessionsDir,
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-approve",
    "--tools",
    "read,bash,edit,write",
    "--append-system-prompt",
    rulesPath,
    prompt,
  ];
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

async function spawnPi(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdoutPath: string,
  stderrPath: string,
  timeoutMs: number,
  killGraceMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  const stdout = createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 });
  const stderr = createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
  const child = spawn(executable, [...args], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let forceKill: NodeJS.Timeout | undefined;
  const terminate = (): void => {
    timedOut = true;
    killTree(child.pid, "SIGTERM");
    forceKill = setTimeout(() => killTree(child.pid, "SIGKILL"), killGraceMs);
  };
  timeout = setTimeout(terminate, timeoutMs);
  if (signal?.aborted) terminate();
  else signal?.addEventListener("abort", terminate, { once: true });

  try {
    const result = await Promise.race([
      once(child, "exit").then(([code, exitSignal]) => ({ code: code as number | null, signal: exitSignal as NodeJS.Signals | null })),
      once(child, "error").then(([error]) => Promise.reject(error)),
    ]);
    return { exitCode: result.code, signal: result.signal, timedOut };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    signal?.removeEventListener("abort", terminate);
    // The pi process may have spawned descendants that inherited its pipes.
    // Terminate the detached process group and bound stream draining so a
    // descendant cannot retain the global slot forever after pi exits.
    killTree(child.pid, "SIGTERM");
    const drain = Promise.all([finished(stdout), finished(stderr)]).then(() => true, () => true);
    let drainTimer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      drain,
      new Promise<false>((resolveDrain) => { drainTimer = setTimeout(() => resolveDrain(false), killGraceMs); }),
    ]);
    if (drainTimer) clearTimeout(drainTimer);
    if (!drained) {
      killTree(child.pid, "SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      stdout.end();
      stderr.end();
      await Promise.race([
        drain,
        new Promise<void>((resolveDrain) => setTimeout(resolveDrain, 1_000)),
      ]);
    }
  }
}

export async function executeAgentRun(
  state: Pick<PrState, "key" | "url" | "headRefName" | "baseRefName" | "worktreePath" | "repoRoot">,
  events: readonly EventRecord[],
  config: Config,
  options: RunnerOptions = {},
): Promise<AgentRunResult> {
  if (events.length === 0) throw new Error("Cannot run an agent without pending events");
  if (!state.worktreePath || !state.repoRoot || !state.headRefName) throw new Error("PR worktree is not provisioned");
  const app = options.app ?? appPaths();
  const paths = prPaths(state.key, app);
  await ensurePrDirs(paths);
  const { provider, model } = requireAgentModel(config);
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? randomUUID();
  if (!/^[a-f\d-]{36}$/i.test(runId)) throw new Error("runId must be a UUID");
  const sync = await syncWorktreeBeforeRun(state, app, undefined, { mergeMessage: config.baseMergeMessage });
  const artifactDir = join(paths.runsDir, runId);
  await mkdir(artifactDir, { mode: 0o700 });
  const promptPath = join(artifactDir, "prompt.md");
  const rulesPath = join(artifactDir, "rules.md");
  const stdoutPath = join(artifactDir, "stdout.jsonl");
  const stderrPath = join(artifactDir, "stderr.log");
  const metaPath = join(artifactDir, "meta.json");
  const prompt = buildRunPrompt(state, events, runId, sync.detail);
  const rules = buildRunnerRules(state, runId, paths.controlDir);
  await Promise.all([
    writeFile(promptPath, prompt, { flag: "wx", mode: 0o600 }),
    writeFile(rulesPath, rules, { flag: "wx", mode: 0o600 }),
    rm(escalationFilePath(paths.controlDir), { force: true }),
  ]);

  const slotOptions: Parameters<typeof acquireRunSlot>[1] = {
    app,
    staleAfterMs: Math.max(30 * 60_000, config.runTimeoutMin * 60_000 + 10 * 60_000),
  };
  if (options.signal !== undefined) slotOptions.signal = options.signal;
  const slot = await acquireRunSlot(config.maxConcurrentRuns, slotOptions);
  const startedAt = now().toISOString();
  try {
    const args = piArguments(provider, model, paths.sessionsDir, rulesPath, prompt);
    const dryRun = (options.env ?? process.env).PR_BABYSIT_DRY_RUN === "1";
    await writeJsonAtomic(metaPath, {
      version: 2,
      runId,
      key: state.key,
      eventIds: events.map((event) => event.id),
      provider,
      model,
      startedAt,
      finishedAt: null,
      outcome: null,
      dryRun,
      slot: slot.index,
      sync,
      pi: { executable: options.piExecutable ?? "pi", args: args.slice(0, -1) },
    });

    if (dryRun) {
      await Promise.all([
        writeFile(stdoutPath, "", { flag: "wx", mode: 0o600 }),
        writeFile(stderrPath, "", { flag: "wx", mode: 0o600 }),
      ]);
      await writeJsonAtomic(metaPath, {
        version: 2,
        runId,
        key: state.key,
        eventIds: events.map((event) => event.id),
        provider,
        model,
        startedAt,
        finishedAt: now().toISOString(),
        outcome: "dry_run",
        dryRun: true,
        slot: slot.index,
        sync,
        replyReceipts: [],
      });
      return {
        runId,
        outcome: "dry_run",
        artifactDir,
        finalText: "",
        escalation: null,
        exitCode: 0,
        signal: null,
        sync,
        replyReceipts: [],
      };
    }

    const agentEnv: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      GH_HOST: parsePrKey(state.key).host,
    };
    const execution = await spawnPi(
      options.piExecutable ?? "pi",
      args,
      state.worktreePath,
      agentEnv,
      stdoutPath,
      stderrPath,
      options.timeoutMs ?? config.runTimeoutMin * 60_000,
      options.killGraceMs ?? 5_000,
      options.signal,
    );
    let outcome: AgentRunResult["outcome"];
    let finalText = "";
    let escalation: EscalationRequest | null = null;
    let usage: unknown = null;
    let replyReceipts: ReplyReceipt[] = [];
    if (execution.timedOut) {
      outcome = "timeout";
    } else if (execution.exitCode !== 0) {
      outcome = "error";
    } else {
      const outputInfo = await stat(stdoutPath);
      if (outputInfo.size > 50 * 1024 * 1024) throw new Error("pi JSONL exceeds 50 MiB");
      const parsed = parseAgentEndJsonl(await readFile(stdoutPath, "utf8"));
      finalText = parsed.finalText;
      usage = parsed.usage;
      escalation = await consumeEscalationFile(paths.controlDir) ?? parseEscalationSentinel(finalText);
      if (escalation) {
        outcome = "escalated";
      } else {
        const verifier = options.replyVerifier ?? (async (runState, runEvents, id, abortSignal) => {
          const ghOptions = abortSignal === undefined ? {} : { signal: abortSignal };
          return verifyRequiredReplies(new GhClient(), runState.key, runEvents, id, ghOptions);
        });
        replyReceipts = await verifier(state, events, runId, options.signal);
        outcome = "success";
      }
    }
    await writeJsonAtomic(metaPath, {
      version: 2,
      runId,
      key: state.key,
      eventIds: events.map((event) => event.id),
      provider,
      model,
      startedAt,
      finishedAt: now().toISOString(),
      outcome,
      dryRun: false,
      slot: slot.index,
      sync,
      exitCode: execution.exitCode,
      signal: execution.signal,
      usage,
      finalText,
      escalation,
      replyReceipts,
    });
    return {
      runId,
      outcome,
      artifactDir,
      finalText,
      escalation,
      exitCode: execution.exitCode,
      signal: execution.signal,
      sync,
      replyReceipts,
    };
  } catch (error) {
    await writeJsonAtomic(metaPath, {
      version: 2,
      runId,
      key: state.key,
      eventIds: events.map((event) => event.id),
      provider,
      model,
      startedAt,
      finishedAt: now().toISOString(),
      outcome: "error",
      error: (error as Error).message,
      sync,
    }).catch(() => undefined);
    throw error;
  } finally {
    await slot.release();
  }
}

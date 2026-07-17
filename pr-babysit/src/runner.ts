import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
import { syncWorktreeWhileLocked, type SyncResult, withWorktreeOperationLock } from "./worktree.ts";

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

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RESPONSE_TRUNCATION_MARKER = "\n\n[final response truncated by pr-babysit]\n\n";

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
    "text",
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

interface CapturedResponse {
  text: string;
  truncated: boolean;
  droppedBytes: number;
  error: string | null;
}

function decodeUtf8Boundary(buffer: Buffer, edge: "start" | "end"): string {
  for (let trim = 0; trim <= 3 && trim <= buffer.length; trim += 1) {
    const candidate = edge === "end" ? buffer.subarray(0, buffer.length - trim) : buffer.subarray(trim);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(candidate);
    } catch {
      // A UTF-8 code point can span at most four bytes; trim only the split boundary.
    }
  }
  return buffer.toString("utf8");
}

class BoundedResponseCapture {
  private readonly marker = Buffer.from(RESPONSE_TRUNCATION_MARKER);
  private readonly contentLimit = MAX_RESPONSE_BYTES - this.marker.length;
  private readonly headLimit = Math.floor(this.contentLimit / 2);
  private readonly tailLimit = this.contentLimit - this.headLimit;
  private readonly head = Buffer.alloc(this.headLimit);
  private readonly tail = Buffer.alloc(this.tailLimit);
  private headLength = 0;
  private tailLength = 0;
  private tailPosition = 0;
  private totalBytes = 0;
  private streamError: string | null = null;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.totalBytes += chunk.length;
    let offset = 0;
    if (this.headLength < this.headLimit) {
      const retained = Math.min(chunk.length, this.headLimit - this.headLength);
      chunk.copy(this.head, this.headLength, 0, retained);
      this.headLength += retained;
      offset = retained;
    }
    if (offset < chunk.length) this.appendTail(chunk.subarray(offset));
  }

  recordError(error: unknown): void {
    this.streamError ??= error instanceof Error ? error.message : String(error);
  }

  async finalize(): Promise<CapturedResponse> {
    const truncated = this.totalBytes > this.contentLimit;
    const head = this.head.subarray(0, this.headLength);
    const tail = this.orderedTail();
    const text = truncated
      ? `${decodeUtf8Boundary(head, "end")}${RESPONSE_TRUNCATION_MARKER}${decodeUtf8Boundary(tail, "start")}`
      : Buffer.concat([head, tail]).toString("utf8");
    try {
      await writeFile(this.path, text, { flag: "wx", mode: 0o600 });
    } catch (error) {
      this.recordError(error);
    }
    return {
      text: text.trimEnd(),
      truncated,
      droppedBytes: Math.max(0, this.totalBytes - this.headLength - this.tailLength),
      error: this.streamError,
    };
  }

  private appendTail(chunk: Buffer): void {
    if (this.tailLimit === 0) return;
    let offset = 0;
    while (offset < chunk.length) {
      const length = Math.min(chunk.length - offset, this.tailLimit - this.tailPosition);
      chunk.copy(this.tail, this.tailPosition, offset, offset + length);
      this.tailPosition = (this.tailPosition + length) % this.tailLimit;
      this.tailLength = Math.min(this.tailLimit, this.tailLength + length);
      offset += length;
    }
  }

  private orderedTail(): Buffer {
    if (this.tailLength === 0) return Buffer.alloc(0);
    const start = (this.tailPosition - this.tailLength + this.tailLimit) % this.tailLimit;
    if (start + this.tailLength <= this.tailLimit) return this.tail.subarray(start, start + this.tailLength);
    const first = this.tail.subarray(start);
    return Buffer.concat([first, this.tail.subarray(0, this.tailLength - first.length)]);
  }
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
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; response: CapturedResponse }> {
  const responseCapture = new BoundedResponseCapture(stdoutPath);
  const stderr = createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
  const child = spawn(executable, [...args], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk: Buffer) => responseCapture.append(chunk));
  child.stdout.on("error", (error) => responseCapture.recordError(error));
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

  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await Promise.race([
      once(child, "exit").then(([code, exitSignal]) => ({ code: code as number | null, signal: exitSignal as NodeJS.Signals | null })),
      once(child, "error").then(([error]) => Promise.reject(error)),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    signal?.removeEventListener("abort", terminate);
    // The pi process may have spawned descendants that inherited its pipes.
    // Terminate the detached process group and bound stream draining so a
    // descendant cannot retain the global slot forever after pi exits.
    killTree(child.pid, "SIGTERM");
    const drain = Promise.all([finished(child.stdout), finished(stderr)]).then(() => true, () => true);
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
      stderr.end();
      await Promise.race([
        drain,
        new Promise<void>((resolveDrain) => setTimeout(resolveDrain, 1_000)),
      ]);
    }
  }
  const response = await responseCapture.finalize();
  return { exitCode: result.code, signal: result.signal, timedOut, response };
}

export async function executeAgentRun(
  state: Pick<PrState, "key" | "url" | "headRefName" | "baseRefName" | "worktreePath" | "repoRoot">,
  events: readonly EventRecord[],
  config: Config,
  options: RunnerOptions = {},
): Promise<AgentRunResult> {
  const app = options.app ?? appPaths();
  const lockOptions: { signal?: AbortSignal } = {};
  if (options.signal !== undefined) lockOptions.signal = options.signal;
  return withWorktreeOperationLock(
    state,
    app,
    () => executeAgentRunLocked(state, events, config, { ...options, app }),
    lockOptions,
  );
}

async function executeAgentRunLocked(
  state: Pick<PrState, "key" | "url" | "headRefName" | "baseRefName" | "worktreePath" | "repoRoot">,
  events: readonly EventRecord[],
  config: Config,
  options: RunnerOptions,
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
  const sync = await syncWorktreeWhileLocked(state, app, undefined, { mergeMessage: config.baseMergeMessage });
  const artifactDir = join(paths.runsDir, runId);
  await mkdir(artifactDir, { mode: 0o700 });
  const promptPath = join(artifactDir, "prompt.md");
  const rulesPath = join(artifactDir, "rules.md");
  const stdoutPath = join(artifactDir, "response.txt");
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
    const finalText = execution.response.text;
    const responseCaptureError = execution.response.error;
    const responseTruncated = execution.response.truncated;
    const responseDroppedBytes = execution.response.droppedBytes;
    let escalation: EscalationRequest | null = null;
    let replyReceipts: ReplyReceipt[] = [];
    if (execution.timedOut) {
      outcome = "timeout";
    } else if (execution.exitCode !== 0) {
      outcome = "error";
    } else {
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
      responseCaptureError,
      responseTruncated,
      responseDroppedBytes,
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

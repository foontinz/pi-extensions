import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

import { type AppPaths, TMUX_SOCKET_ENV, appPaths, ensureAppDirs, parsePrKey } from "./paths.ts";
import type { TmuxPaneRef } from "./state.ts";

const APP_SESSION = "babysit";
const APP_WINDOW = "babysitting";
const OWNER_OPTION = "@pr_babysit_owner";
const KEY_OPTION = "@pr_babysit_key";
const TOKEN_OPTION = "@pr_babysit_token";
const LABEL_OPTION = "@pr_babysit_label";

export interface LaunchSpec {
  executable: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
}

export interface EnsurePaneResult {
  ref: TmuxPaneRef;
  disposition: "created" | "reused" | "adopted";
}

export type KillPaneResult = "killed" | "gone" | "ownership-mismatch";

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface TmuxContext {
  socketName: string | null;
  prefix: string[];
}

interface PaneRecord {
  sessionId: string;
  windowId: string;
  paneId: string;
  ownerToken: string;
  key: string;
  paneToken: string;
}

function socketContext(env: NodeJS.ProcessEnv = process.env): TmuxContext {
  const socketName = env[TMUX_SOCKET_ENV] ?? null;
  if (socketName !== null && !/^[A-Za-z\d_.-]{1,80}$/.test(socketName)) {
    throw new Error(`${TMUX_SOCKET_ENV} must contain only letters, digits, dot, underscore, or hyphen`);
  }
  return { socketName, prefix: socketName === null ? [] : ["-L", socketName] };
}

async function execute(context: TmuxContext, args: readonly string[], allowFailure = false): Promise<CommandResult> {
  try {
    return await new Promise<CommandResult>((resolve, reject) => {
      execFile("tmux", [...context.prefix, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  } catch (error) {
    if (allowFailure) {
      return {
        stdout: String((error as { stdout?: string }).stdout ?? ""),
        stderr: String((error as { stderr?: string }).stderr ?? (error as Error).message),
      };
    }
    const detail = String((error as { stderr?: string }).stderr ?? "").trim() || (error as Error).message;
    throw new Error(`tmux ${args[0] ?? "command"} failed: ${detail}`);
  }
}

async function withTmuxLock<T>(app: AppPaths, task: () => Promise<T>): Promise<T> {
  await ensureAppDirs(app);
  const lockPath = `${app.home}/tmux-operation.lock`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        return await task();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let ageMs: number;
      try {
        ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (ageMs > 60_000) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Timed out waiting for another pr-babysit tmux operation");
}

async function ownerToken(app: AppPaths): Promise<string> {
  await ensureAppDirs(app);
  try {
    const existing = (await readFile(app.ownerTokenFile, "utf8")).trim();
    if (!/^[a-f\d-]{36}$/i.test(existing)) throw new Error("invalid token");
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Invalid tmux owner token ${app.ownerTokenFile}`);
    }
  }

  const token = randomUUID();
  try {
    await writeFile(app.ownerTokenFile, `${token}\n`, { flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return ownerToken(app);
    }
    throw error;
  }
}

function splitLines(text: string): string[] {
  return text.split("\n").map((line) => line.trimEnd()).filter(Boolean);
}

function parsePaneRecord(line: string): PaneRecord | undefined {
  const [sessionId, windowId, paneId, owner, key, paneToken] = line.split("\t");
  if (!sessionId || !windowId || !paneId || owner === undefined || key === undefined || paneToken === undefined) {
    return undefined;
  }
  return { sessionId, windowId, paneId, ownerToken: owner, key, paneToken };
}

async function listPanes(context: TmuxContext): Promise<PaneRecord[]> {
  const result = await execute(
    context,
    [
      "list-panes",
      "-a",
      "-F",
      `#{session_id}\t#{window_id}\t#{pane_id}\t#{${OWNER_OPTION}}\t#{${KEY_OPTION}}\t#{${TOKEN_OPTION}}`,
    ],
    true,
  );
  return splitLines(result.stdout).map(parsePaneRecord).filter((item): item is PaneRecord => item !== undefined);
}

function toRef(record: PaneRecord, socketName: string | null): TmuxPaneRef {
  return {
    socketName,
    sessionId: record.sessionId,
    windowId: record.windowId,
    paneId: record.paneId,
    ownerToken: record.ownerToken,
    paneToken: record.paneToken,
  };
}

async function verifyPane(
  context: TmuxContext,
  ref: TmuxPaneRef,
  key: string,
): Promise<"live" | "gone" | "ownership-mismatch"> {
  if (ref.socketName !== context.socketName) return "ownership-mismatch";
  const result = await execute(
    context,
    [
      "display-message",
      "-p",
      "-t",
      ref.paneId,
      `#{session_id}\t#{window_id}\t#{pane_id}\t#{${OWNER_OPTION}}\t#{${KEY_OPTION}}\t#{${TOKEN_OPTION}}`,
    ],
    true,
  );
  const record = parsePaneRecord(result.stdout.trimEnd());
  if (!record) return "gone";
  if (
    record.sessionId !== ref.sessionId ||
    record.windowId !== ref.windowId ||
    record.paneId !== ref.paneId ||
    record.ownerToken !== ref.ownerToken ||
    record.key !== key ||
    record.paneToken !== ref.paneToken
  ) {
    return "ownership-mismatch";
  }
  return "live";
}

async function sessionId(context: TmuxContext, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (context.socketName === null && env.TMUX) {
    const current = await execute(context, ["display-message", "-p", "#{session_id}"], true);
    const id = current.stdout.trim();
    if (/^\$\d+$/.test(id)) return id;
  }

  const named = await execute(
    context,
    ["display-message", "-p", "-t", APP_SESSION, "#{session_name}\t#{session_id}"],
    true,
  );
  const [name, id] = named.stdout.trim().split("\t");
  return name === APP_SESSION && id !== undefined && /^\$\d+$/.test(id) ? id : undefined;
}

interface WindowRecord {
  id: string;
  name: string;
  ownerToken: string;
}

async function findWindow(context: TmuxContext, targetSession: string, token: string): Promise<string | undefined> {
  const result = await execute(
    context,
    ["list-windows", "-t", targetSession, "-F", `#{window_id}\t#{window_name}\t#{${OWNER_OPTION}}`],
  );
  const matching = splitLines(result.stdout)
    .map((line): WindowRecord | undefined => {
      const [id, name, windowOwner] = line.split("\t");
      return id && name !== undefined && windowOwner !== undefined
        ? { id, name, ownerToken: windowOwner }
        : undefined;
    })
    .filter((item): item is WindowRecord => item?.name === APP_WINDOW);

  const owned = matching.filter((item) => item.ownerToken === token);
  if (owned.length > 1) throw new Error(`Multiple owned tmux windows are named ${APP_WINDOW}`);
  if (owned[0]) return owned[0].id;
  if (matching.length > 0) {
    throw new Error(`tmux window ${APP_WINDOW} already exists but is not owned by pr-babysit`);
  }
  return undefined;
}

function launchArguments(spec: LaunchSpec): string[] {
  if (!spec.executable.startsWith("/")) throw new Error("Pane executable must be an absolute path");
  const environment = Object.entries(spec.env ?? {}).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z\d_]*$/.test(name) || value.includes("\0")) {
      throw new Error(`Invalid pane environment variable: ${name}`);
    }
    return `${name}=${value}`;
  });
  // tmux treats a single command argument as shell text. Always provide at
  // least env + executable so tmux uses its direct argv execution path.
  return ["/usr/bin/env", ...environment, spec.executable, ...spec.args];
}

function parseCreatedPane(line: string, owner: string, key: string, paneToken: string): PaneRecord {
  const [createdSession, windowId, paneId] = line.trim().split("\t");
  if (!createdSession || !windowId || !paneId) throw new Error("tmux did not return created pane identity");
  return { sessionId: createdSession, windowId, paneId, ownerToken: owner, key, paneToken };
}

async function configureWindow(context: TmuxContext, windowId: string, token: string): Promise<void> {
  const settings: ReadonlyArray<readonly [string, string]> = [
    [OWNER_OPTION, token],
    ["automatic-rename", "off"],
    ["allow-rename", "off"],
    ["monitor-bell", "on"],
    ["pane-border-status", "top"],
    ["pane-border-format", ` #{${LABEL_OPTION}} `],
    ["pane-border-lines", "heavy"],
  ];
  for (const [option, value] of settings) {
    await execute(context, ["set-option", "-w", "-t", windowId, option, value]);
  }
}

async function configurePane(context: TmuxContext, record: PaneRecord): Promise<void> {
  const settings: ReadonlyArray<readonly [string, string]> = [
    [OWNER_OPTION, record.ownerToken],
    [KEY_OPTION, record.key],
    [TOKEN_OPTION, record.paneToken],
    [LABEL_OPTION, `${record.key} · starting`],
  ];
  for (const [option, value] of settings) {
    await execute(context, ["set-option", "-p", "-t", record.paneId, option, value]);
  }
}

async function ensurePrPaneUnlocked(
  input: string,
  launch: LaunchSpec,
  savedRef: TmuxPaneRef | null,
  app: AppPaths,
  env: NodeJS.ProcessEnv,
): Promise<EnsurePaneResult> {
  const key = parsePrKey(input).key;
  const context = socketContext(env);
  const token = await ownerToken(app);

  if (savedRef && (await verifyPane(context, savedRef, key)) === "live") {
    return { ref: savedRef, disposition: "reused" };
  }

  const matches = (await listPanes(context)).filter((pane) => pane.ownerToken === token && pane.key === key);
  if (matches.length > 1) throw new Error(`Multiple tmux panes claim ${key}`);
  if (matches[0]) {
    return { ref: toRef(matches[0], context.socketName), disposition: "adopted" };
  }

  const paneToken = randomUUID();
  const command = launchArguments(launch);
  let targetSession = await sessionId(context, env);
  let record: PaneRecord;

  if (!targetSession) {
    const created = await execute(context, [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{session_id}\t#{window_id}\t#{pane_id}",
      "-s",
      APP_SESSION,
      "-n",
      APP_WINDOW,
      "-c",
      launch.cwd,
      ...command,
    ]);
    record = parseCreatedPane(created.stdout, token, key, paneToken);
    targetSession = record.sessionId;
    await configureWindow(context, record.windowId, token);
  } else {
    let windowId = await findWindow(context, targetSession, token);
    if (!windowId) {
      const created = await execute(context, [
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{session_id}\t#{window_id}\t#{pane_id}",
        "-t",
        `${targetSession}:`,
        "-n",
        APP_WINDOW,
        "-c",
        launch.cwd,
        ...command,
      ]);
      record = parseCreatedPane(created.stdout, token, key, paneToken);
      windowId = record.windowId;
      await configureWindow(context, windowId, token);
    } else {
      const created = await execute(context, [
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{session_id}\t#{window_id}\t#{pane_id}",
        "-t",
        windowId,
        "-c",
        launch.cwd,
        ...command,
      ]);
      record = parseCreatedPane(created.stdout, token, key, paneToken);
    }
  }

  try {
    await configurePane(context, record);
    await execute(context, ["select-layout", "-t", record.windowId, "tiled"]);
  } catch (error) {
    await execute(context, ["kill-pane", "-t", record.paneId], true);
    throw error;
  }

  return { ref: toRef(record, context.socketName), disposition: "created" };
}

export async function ensurePrPane(
  input: string,
  launch: LaunchSpec,
  savedRef: TmuxPaneRef | null = null,
  app: AppPaths = appPaths(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnsurePaneResult> {
  return withTmuxLock(app, () => ensurePrPaneUnlocked(input, launch, savedRef, app, env));
}

export function sanitizePaneLabel(label: string): string {
  return label
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("#{", "# {")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

export async function setPaneLabel(
  ref: TmuxPaneRef,
  key: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const context = socketContext(env);
  if ((await verifyPane(context, ref, parsePrKey(key).key)) !== "live") return false;
  await execute(context, ["set-option", "-p", "-t", ref.paneId, LABEL_OPTION, sanitizePaneLabel(label)]);
  return true;
}

export async function isPaneLive(
  ref: TmuxPaneRef | null,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!ref) return false;
  return (await verifyPane(socketContext(env), ref, parsePrKey(key).key)) === "live";
}

// Resolve the pane the current process is running inside (tmux exports TMUX_PANE),
// verifying it is an owned pane for this PR. The poller uses this to authoritatively
// record its own pane, avoiding a startup race with the `watch` caller that spawned
// it (whose post-spawn save could otherwise be overwritten by the first poll).
export async function resolveOwnPaneRef(
  key: string,
  app: AppPaths = appPaths(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<TmuxPaneRef | null> {
  const paneId = env.TMUX_PANE;
  if (!paneId || !/^%\d+$/.test(paneId)) return null;
  const context = socketContext(env);
  const token = await ownerToken(app);
  const result = await execute(
    context,
    [
      "display-message",
      "-p",
      "-t",
      paneId,
      `#{session_id}\t#{window_id}\t#{pane_id}\t#{${OWNER_OPTION}}\t#{${KEY_OPTION}}\t#{${TOKEN_OPTION}}`,
    ],
    true,
  );
  const record = parsePaneRecord(result.stdout.trimEnd());
  if (!record || record.ownerToken !== token || record.key !== parsePrKey(key).key) return null;
  return toRef(record, context.socketName);
}

export async function killPrPane(
  ref: TmuxPaneRef | null,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  app: AppPaths = appPaths(),
): Promise<KillPaneResult> {
  return withTmuxLock(app, async () => {
    if (!ref) return "gone";
    const context = socketContext(env);
    const verification = await verifyPane(context, ref, parsePrKey(key).key);
    if (verification !== "live") return verification;
    await execute(context, ["kill-pane", "-t", ref.paneId]);
    await execute(context, ["select-layout", "-t", ref.windowId, "tiled"], true);
    return "killed";
  });
}

export async function ensureTmuxAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("tmux", ["-V"], (error) => (error ? reject(new Error("tmux is required but was not found")) : resolve()));
  });
}

export async function prepareAppHome(app: AppPaths = appPaths()): Promise<void> {
  await mkdir(app.home, { recursive: true, mode: 0o700 });
}

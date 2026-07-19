import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";

export interface RmGuard {
  dir: string;
  executable: string;
  accountHome: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function guardProgram(accountHome: string, systemRm: string): string {
  return `"use strict";
const { existsSync, realpathSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { dirname, isAbsolute, resolve } = require("node:path");

const accountHome = realpathSync(${JSON.stringify(accountHome)});
const systemRm = ${JSON.stringify(systemRm)};
const args = process.argv.slice(2);
let recursive = false;
let endOptions = false;
const operands = [];

for (const arg of args) {
  if (endOptions) {
    operands.push(arg);
    continue;
  }
  if (arg === "--") {
    endOptions = true;
    continue;
  }
  if (arg === "--recursive") {
    recursive = true;
    continue;
  }
  if (arg.startsWith("--")) continue;
  if (arg.startsWith("-") && arg !== "-") {
    const flags = arg.slice(1);
    if (flags.includes("r") || flags.includes("R")) recursive = true;
    continue;
  }
  operands.push(arg);
}

function canonical(path) {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  try { return realpathSync.native(absolute); }
  catch { return resolve(absolute); }
}

const protectedPaths = new Set([
  "/",
  "/Applications",
  "/Library",
  "/System",
  "/Users",
  "/Volumes",
  "/bin",
  "/etc",
  "/opt",
  "/private",
  "/sbin",
  "/tmp",
  "/usr",
  "/var",
  accountHome,
  dirname(accountHome),
]);
const resolved = operands.map(canonical);

for (const path of resolved) {
  if (protectedPaths.has(path)) {
    console.error(\`enhanced-bash: REFUSED rm of protected path: \${path}\`);
    process.exit(64);
  }
}

if (recursive) {
  const directHomeChildren = new Set(resolved.filter((path) => dirname(path) === accountHome));
  if (directHomeChildren.size >= 1) {
    console.error("enhanced-bash: REFUSED recursive rm of a top-level home entry");
    process.exit(64);
  }
}

const result = spawnSync(systemRm, args, { stdio: "inherit" });
if (result.error) {
  console.error(\`enhanced-bash: could not execute system rm: \${result.error.message}\`);
  process.exit(70);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
`;
}

/**
 * Create a private PATH shim that validates rm's final, shell-expanded argv.
 * The protected home comes from the OS account database, never process.env.HOME.
 */
export function createRmGuard(accountHome = userInfo().homedir): RmGuard {
  if (process.platform === "win32") {
    throw new Error("rm home guard is not supported on Windows");
  }
  const systemRm = existsSync("/bin/rm") ? "/bin/rm" : "/usr/bin/rm";
  if (!existsSync(systemRm)) throw new Error("system rm executable was not found");

  const dir = mkdtempSync(join(tmpdir(), "pi-rm-guard-"));
  const program = join(dir, "rm-guard.cjs");
  const executable = join(dir, "rm");
  try {
    writeFileSync(program, guardProgram(accountHome, systemRm), { mode: 0o600 });
    writeFileSync(
      executable,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(program)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(dir, 0o700);
    return { dir, executable, accountHome };
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export function disposeRmGuard(guard: RmGuard | undefined): void {
  if (!guard) return;
  try { rmSync(guard.dir, { recursive: true, force: true }); } catch {}
}

export function withRmGuardPath(env: NodeJS.ProcessEnv, guard: RmGuard): NodeJS.ProcessEnv {
  const current = env.PATH ?? process.env.PATH ?? "";
  return { ...env, PATH: `${guard.dir}${delimiter}${current}` };
}

export function rmGuardCommandPrefix(guard: RmGuard): string {
  return [
    "unalias rm 2>/dev/null || true",
    "unset -f rm 2>/dev/null || true",
    `export PATH=${shellQuote(guard.dir)}:\"\${PATH:-}\"`,
    "hash -r 2>/dev/null || true",
  ].join("\n");
}

/** Block the two common explicit paths that intentionally bypass the PATH shim. */
export function explicitRmBypassReason(command: string): string | undefined {
  const explicitSystemRm = /(^|[^A-Za-z0-9_])\/(?:usr\/)?bin\/rm(?=$|[\s;&|(){}])/;
  if (explicitSystemRm.test(command)) {
    return "explicit /bin/rm or /usr/bin/rm bypasses the enhanced-bash home guard; use plain rm";
  }
  const rmCommand = /(^|[\s;&|(){}])rm(?=$|[\s;&|(){}])/;
  if (/\bPATH\s*=/.test(command) && rmCommand.test(command)) {
    return "overriding PATH for an rm command bypasses the enhanced-bash home guard";
  }
  if (/\bcommand\s+-p\s+rm\b/.test(command)) {
    return "command -p rm bypasses the enhanced-bash PATH guard";
  }
  if (/\benv\b[^\n;&|]*(?:-i|--ignore-environment)[^\n;&|]*\brm\b/.test(command)) {
    return "env with an empty environment bypasses the enhanced-bash PATH guard for rm";
  }
  if (/\bsudo\b[^\n;&|]*\brm\b/.test(command)) {
    return "sudo may replace PATH and bypass the enhanced-bash rm guard";
  }
  return undefined;
}

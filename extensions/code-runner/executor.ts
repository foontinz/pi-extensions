import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeHandle } from "./hooks";
import { BoundedOutputPreview, RecoverableOutput } from "./output";
import { getEnvVar } from "pi-extension-envvars/store";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxBin = join(workspaceRoot, "node_modules", ".bin", "tsx");
// Prefer tsgo (the native, ~4x faster TypeScript compiler from
// @typescript/native-preview); fall back to plain tsc if it's unavailable.
const tsgoBin = join(workspaceRoot, "node_modules", ".bin", "tsgo");
const tscBin = join(workspaceRoot, "node_modules", ".bin", "tsc");
const typeCheckBin = existsSync(tsgoBin) ? tsgoBin : tscBin;
const TERMINATE_GRACE_MS = 1_000;

export interface ExecuteResult {
  output: string;
  exitCode: number;
  stderr?: string;
  /** Complete, interleaved stdout/stderr when the visible result was truncated. */
  fullOutputPath?: string;
}

interface ProcessResult {
  output: string;
  stderr: string;
  exitCode: number;
  fullOutputPath?: string;
  reason?: "aborted" | "timedOut" | "outputLimit";
  startError?: Error;
}

interface TypeCheckResult {
  errors: string[];
  fullOutputPath?: string;
}

/** Kill the detached process group on Unix and the complete tree on Windows. */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  if (process.platform === "win32") {
    try {
      // taskkill has no graceful equivalent of SIGTERM; /F is required to
      // ensure children do not survive cancellation or session shutdown.
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      }).unref();
    } catch {}
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch {}
  }
}

export async function executeCode(
  code: string,
  handles: CodeHandle[],
  options: { timeout?: number; signal?: AbortSignal; typecheck?: boolean } = {},
): Promise<ExecuteResult> {
  if (options.signal?.aborted) {
    return { output: "", exitCode: 1, stderr: "Cancelled before execution" };
  }

  // Resolve env vars from envvars store (keychain / process.env)
  const envVars: Record<string, string> = {};
  for (const handle of handles) {
    if (handle.envVars) {
      for (const name of handle.envVars) {
        try {
          const value = await getEnvVar(name);
          if (value != null) envVars[name] = value;
        } catch {
          // Stored credentials are optional and the Keychain backend is not
          // available on every platform. An unavailable secret for one handle
          // must not prevent unrelated exec_code programs from running; the
          // handle's setup code can surface its own missing-key diagnostic.
        }
      }
    }
  }

  // Build script: handle preambles + user code.
  // Track how many lines the preamble adds so we can map error line numbers
  // in stack traces back to the user's own code.
  const preamble = handles
    .map((h) => h.setupCode.trim())
    .filter(Boolean)
    .join("\n\n");
  const prefix = preamble ? `${preamble}\n\n` : "";
  const scriptContent = prefix + code;
  // Number of newlines the prefix contributes == line offset of user code.
  const lineOffset = prefix ? prefix.split("\n").length - 1 : 0;

  // Temp dir inside workspace root so ESM resolution finds node_modules.
  // exec_code intentionally uses this throwaway cwd for relative paths.
  const tempDir = await mkdtemp(join(workspaceRoot, ".run-"));
  const tempFile = join(tempDir, "script.mts");

  try {
    await writeFile(tempFile, scriptContent, "utf8");

    // Re-check after async env resolution + file write
    if (options.signal?.aborted) {
      return { output: "", exitCode: 1, stderr: "Cancelled before execution" };
    }

    // Type-check before running (unless opted out). Catches real type errors
    // (e.g. assigning a string to a number, calling missing methods) so the
    // model gets fast, precise feedback instead of a runtime surprise.
    if (options.typecheck !== false) {
      const typeCheckResult = await typeCheck(
        tempDir,
        lineOffset,
        options.timeout,
        options.signal,
      );
      if (options.signal?.aborted) {
        return { output: "", exitCode: 1, stderr: "Cancelled before execution" };
      }
      if (typeCheckResult && typeCheckResult.errors.length > 0) {
        const count = `${typeCheckResult.errors.length} error${typeCheckResult.errors.length > 1 ? "s" : ""}`;
        const recoveryHint = typeCheckResult.fullOutputPath
          ? `\n\nFull type-check output saved to: ${typeCheckResult.fullOutputPath}`
          : "";
        return {
          output: "",
          exitCode: 2,
          stderr:
            `Type check failed (${count}):\n${typeCheckResult.errors.join("\n")}${recoveryHint}\n\n` +
            "Fix the type error(s) above, or pass typecheck:false to run anyway.",
          fullOutputPath: typeCheckResult.fullOutputPath,
        };
      }
    }

    const result = await runCapturedProcess(tsxBin, [tempFile], {
      cwd: tempDir,
      env: { ...process.env, ...envVars },
      timeout: options.timeout ?? 30_000,
      signal: options.signal,
      outputPrefix: "pi-exec-code-output",
    });

    let stderr = cleanStderr(result.stderr, tempDir, lineOffset);
    if (result.startError) {
      const isMissing = (result.startError as NodeJS.ErrnoException).code === "ENOENT";
      const hint = isMissing
        ? `\n\ntsx not found at: ${tsxBin}\nRun: cd ${workspaceRoot} && npm install`
        : "";
      stderr = `Failed to start executor: ${result.startError.message}${hint}`;
    } else if (result.reason === "aborted") {
      stderr = appendStatus(stderr, "Execution cancelled");
    } else if (result.reason === "timedOut") {
      stderr = appendStatus(stderr, `Execution timed out after ${options.timeout ?? 30_000}ms`);
    } else if (result.reason === "outputLimit") {
      stderr = appendStatus(stderr, "Execution stopped after exceeding the recoverable output safety limit");
    }

    return {
      output: result.output,
      exitCode: result.exitCode,
      stderr: stderr || undefined,
      fullOutputPath: result.fullOutputPath,
    };
  } finally {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function appendStatus(text: string, status: string): string {
  return text ? `${text}\n\n${status}` : status;
}

/**
 * Start a detached child so its process group can be terminated as a unit.
 * Output previews are bounded while RecoverableOutput keeps a full temp file
 * whenever Pi's normal result budget is exceeded.
 */
function runCapturedProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    signal?: AbortSignal;
    outputPrefix: string;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const stdout = new BoundedOutputPreview();
    const stderr = new BoundedOutputPreview();
    const fullOutput = new RecoverableOutput(options.outputPrefix);
    let proc: ChildProcess | undefined;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let forceKillHandle: ReturnType<typeof setTimeout> | undefined;
    let reason: ProcessResult["reason"];

    const finish = (exitCode: number, startError?: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      options.signal?.removeEventListener("abort", onAbort);
      stdout.finish();
      stderr.finish();
      const fullOutputPath = fullOutput.finish();
      resolve({
        output: stdout.toString(),
        stderr: stderr.toString(),
        exitCode,
        fullOutputPath,
        reason,
        startError,
      });
    };

    const terminate = (terminationReason: NonNullable<ProcessResult["reason"]>) => {
      if (settled || !proc?.pid) return;
      reason ??= terminationReason;
      killProcessTree(proc.pid, "SIGTERM");
      forceKillHandle ??= setTimeout(() => {
        if (!settled && proc?.pid) killProcessTree(proc.pid, "SIGKILL");
      }, TERMINATE_GRACE_MS);
      forceKillHandle.unref?.();
    };

    const onAbort = () => terminate("aborted");

    try {
      proc = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      finish(1, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      if (!fullOutput.append("stdout", chunk)) terminate("outputLimit");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      if (!fullOutput.append("stderr", chunk)) terminate("outputLimit");
    });
    proc.once("error", (err) => finish(1, err));
    proc.once("close", (code) => finish(code ?? 1));

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (Number.isFinite(options.timeout) && options.timeout > 0) {
      timeoutHandle = setTimeout(() => terminate("timedOut"), options.timeout);
      timeoutHandle.unref?.();
    }
  });
}

/**
 * Rewrite stderr so error locations point at the user's code:
 *  - Replace the generated temp file path with a friendly `exec_code.ts`.
 *  - Subtract the preamble line offset from any reported line numbers so they
 *    match the code the caller actually wrote.
 */
function cleanStderr(stderr: string, tempDir: string, lineOffset: number): string {
  if (!stderr) return stderr;
  const escDir = tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = stderr.replace(
    new RegExp(`${escDir}[/\\\\]script\\.m?ts`, "g"),
    "exec_code.ts",
  );
  if (lineOffset > 0) {
    out = out.replace(/exec_code\.ts:(\d+)/g, (match, line) => {
      const adjusted = Number(line) - lineOffset;
      return adjusted >= 1 ? `exec_code.ts:${adjusted}` : match;
    });
  }
  return out;
}

/**
 * Type-check the generated script with tsc. Returns user-facing type errors,
 * or null if the compiler could not be started. The compiler uses the same
 * process-tree termination and bounded output path as execution.
 */
async function typeCheck(
  tempDir: string,
  lineOffset: number,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
): Promise<TypeCheckResult | null> {
  const tsconfigPath = join(tempDir, "tsconfig.json");
  await writeFile(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        types: ["node"],
        strict: false,
        skipLibCheck: true,
        noEmit: true,
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        pretty: false,
      },
      include: ["script.mts"],
    }),
    "utf8",
  );

  const result = await runCapturedProcess(typeCheckBin, ["--noEmit", "-p", tsconfigPath], {
    cwd: tempDir,
    env: process.env,
    timeout: timeout ?? 30_000,
    signal,
    outputPrefix: "pi-exec-code-typecheck",
  });

  // tsc missing or failed to start: skip type checking rather than block.
  if (result.startError) return null;
  const raw = [result.output, result.stderr].filter(Boolean).join("\n");
  if (!raw) return null;
  return {
    errors: filterUserTypeErrors(raw, lineOffset),
    fullOutputPath: result.fullOutputPath,
  };
}

/**
 * Parse tsc diagnostics, keep only those in the user's code (file line beyond
 * the preamble offset), and remap their locations to `exec_code.ts`.
 */
function filterUserTypeErrors(raw: string, lineOffset: number): string[] {
  const locRe = /^(?:.*?[/\\])?script\.m?ts\((\d+),(\d+)\)(:.*)$/;
  const kept: string[] = [];
  let keepingCurrent = false;
  for (const line of raw.split("\n")) {
    const m = line.match(locRe);
    if (m) {
      const fileLine = Number(m[1]);
      if (fileLine > lineOffset) {
        const userLine = fileLine - lineOffset;
        kept.push(`exec_code.ts(${userLine},${m[2]})${m[3]}`);
        keepingCurrent = true;
      } else {
        keepingCurrent = false;
      }
    } else if (/^\s/.test(line)) {
      // Indented elaboration line: keep it with the current diagnostic.
      if (keepingCurrent) kept.push(line);
    } else {
      // Blank line or summary ("Found N errors"): not part of a diagnostic.
      keepingCurrent = false;
    }
  }
  return kept;
}

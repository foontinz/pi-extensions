import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeHandle } from "./hooks";
import { BoundedOutputPreview, RecoverableOutput } from "./output";
import { getEnvVar } from "pi-extension-envvars/store";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

function resolvePackageBin(packageName: string, binName: string): string {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relativeBin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
  if (!relativeBin) throw new Error(`${packageName} does not declare the ${binName} executable`);
  return join(dirname(packageJsonPath), relativeBin);
}

const tsxBin = resolvePackageBin("tsx", "tsx");
// Prefer tsgo (the native, ~4x faster TypeScript compiler from
// @typescript/native-preview); fall back to plain tsc if it's unavailable.
let tsgoBin: string | undefined;
try { tsgoBin = resolvePackageBin("@typescript/native-preview", "tsgo"); } catch {}
const typeCheckBin = tsgoBin && existsSync(tsgoBin)
  ? tsgoBin
  : resolvePackageBin("typescript", "tsc");
const TERMINATE_GRACE_MS = 1_000;

export interface ExecuteResult {
  output: string;
  exitCode: number;
  stderr?: string;
  /** Bounded stdout/stderr preview in observed event order, with channel labels. */
  combinedOutput?: string;
  /** Complete, interleaved stdout/stderr when the visible result was truncated. */
  fullOutputPath?: string;
}

interface ProcessResult {
  output: string;
  stderr: string;
  combinedOutput: string;
  exitCode: number;
  fullOutputPath?: string;
  reason?: "aborted" | "timedOut" | "outputLimit";
  startError?: Error;
}

interface TypeCheckResult {
  errors: string[];
  failure?: string;
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

  const timeoutMs = options.timeout ?? 30_000;
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Date.now() + timeoutMs
    : Number.POSITIVE_INFINITY;
  const remainingTime = () => Math.max(0, deadline - Date.now());

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
        remainingTime(),
        options.signal,
      );
      if (options.signal?.aborted) {
        return { output: "", exitCode: 1, stderr: "Cancelled before execution" };
      }
      const recoveryHint = typeCheckResult.fullOutputPath
        ? `\n\nFull type-check output saved to: ${typeCheckResult.fullOutputPath}`
        : "";
      if (typeCheckResult.failure) {
        return {
          output: "",
          exitCode: 2,
          stderr:
            `Type check could not complete: ${typeCheckResult.failure}${recoveryHint}\n\n` +
            "Fix the checker/setup problem, or pass typecheck:false to run without checking.",
          fullOutputPath: typeCheckResult.fullOutputPath,
        };
      }
      if (typeCheckResult.errors.length > 0) {
        const count = `${typeCheckResult.errors.length} error${typeCheckResult.errors.length > 1 ? "s" : ""}`;
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

    const executionTimeout = remainingTime();
    if (executionTimeout <= 0) {
      return {
        output: "",
        exitCode: 1,
        stderr: `Execution timed out after ${timeoutMs}ms before user code started`,
      };
    }

    const result = await runCapturedProcess(process.execPath, [tsxBin, tempFile], {
      cwd: tempDir,
      env: { ...process.env, ...envVars },
      timeout: executionTimeout,
      signal: options.signal,
      outputPrefix: "pi-exec-code-output",
    });

    let stderr = cleanStderr(result.stderr, tempDir, lineOffset);
    let combinedOutput = cleanStderr(result.combinedOutput, tempDir, lineOffset);
    if (result.startError) {
      const isMissing = (result.startError as NodeJS.ErrnoException).code === "ENOENT";
      const hint = isMissing
        ? `\n\ntsx not found at: ${tsxBin}\nRun: cd ${workspaceRoot} && npm install`
        : "";
      stderr = `Failed to start executor: ${result.startError.message}${hint}`;
      combinedOutput = appendStatus(combinedOutput, stderr);
    } else if (result.reason === "aborted") {
      stderr = appendStatus(stderr, "Execution cancelled");
      combinedOutput = appendStatus(combinedOutput, "Execution cancelled");
    } else if (result.reason === "timedOut") {
      const status = `Execution timed out after ${timeoutMs}ms total`;
      stderr = appendStatus(stderr, status);
      combinedOutput = appendStatus(combinedOutput, status);
    } else if (result.reason === "outputLimit") {
      const status = "Execution stopped after exceeding the recoverable output safety limit";
      stderr = appendStatus(stderr, status);
      combinedOutput = appendStatus(combinedOutput, status);
    }

    // A process may handle SIGTERM and exit zero. Cancellation, deadline, and
    // output-limit termination are still failed executions regardless of the
    // direct child's chosen exit code.
    const exitCode = result.reason === "timedOut"
      ? 124
      : result.reason === "aborted"
        ? 130
        : result.reason === "outputLimit"
          ? 1
          : result.exitCode;

    return {
      output: result.output,
      exitCode,
      stderr: stderr || undefined,
      combinedOutput: combinedOutput || undefined,
      fullOutputPath: result.fullOutputPath,
    };
  } finally {
    try { await rm(tempDir, { recursive: true, force: true }); } catch {}
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
    const combined = new BoundedOutputPreview();
    const fullOutput = new RecoverableOutput(options.outputPrefix);
    let lastCombinedChannel: "stdout" | "stderr" | undefined;
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
      combined.finish();
      if (combined.truncated) fullOutput.ensurePersisted();
      const fullOutputPath = fullOutput.finish();
      resolve({
        output: stdout.toString(),
        stderr: stderr.toString(),
        combinedOutput: combined.toString(),
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

    const appendCombined = (channel: "stdout" | "stderr", chunk: Buffer) => {
      if (lastCombinedChannel !== channel) {
        combined.append(Buffer.from(`${lastCombinedChannel ? "\n" : ""}[${channel}]\n`, "utf8"));
        lastCombinedChannel = channel;
      }
      combined.append(chunk);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      appendCombined("stdout", chunk);
      if (!fullOutput.append("stdout", chunk)) terminate("outputLimit");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      appendCombined("stderr", chunk);
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
 * Type-check the generated script with tsc. Compiler startup failures,
 * cancellation, timeout, output overflow, and non-diagnostic failures are
 * explicit results rather than silently allowing unchecked execution.
 */
async function typeCheck(
  tempDir: string,
  lineOffset: number,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<TypeCheckResult> {
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

  if (timeout <= 0) {
    return { errors: [], failure: "the overall deadline expired before the checker started" };
  }

  const result = await runCapturedProcess(process.execPath, [typeCheckBin, "--noEmit", "-p", tsconfigPath], {
    cwd: tempDir,
    env: process.env,
    timeout,
    signal,
    outputPrefix: "pi-exec-code-typecheck",
  });

  if (result.startError) {
    return {
      errors: [],
      failure: `failed to start ${typeCheckBin}: ${result.startError.message}`,
      fullOutputPath: result.fullOutputPath,
    };
  }
  if (result.reason === "aborted") {
    return { errors: [], failure: "checking was cancelled", fullOutputPath: result.fullOutputPath };
  }
  if (result.reason === "timedOut") {
    return { errors: [], failure: "the overall deadline expired while checking", fullOutputPath: result.fullOutputPath };
  }
  if (result.reason === "outputLimit") {
    return { errors: [], failure: "checker output exceeded the recovery limit", fullOutputPath: result.fullOutputPath };
  }

  const raw = [result.output, result.stderr].filter(Boolean).join("\n");
  if (result.exitCode === 0) {
    return { errors: [], fullOutputPath: result.fullOutputPath };
  }

  const errors = filterUserTypeErrors(raw, lineOffset);
  if (errors.length > 0) return { errors, fullOutputPath: result.fullOutputPath };

  const diagnostic = remapTypeCheckOutput(raw, lineOffset);
  return {
    errors: [],
    failure: diagnostic
      ? `compiler exited with code ${result.exitCode}:\n${diagnostic}`
      : `compiler exited with code ${result.exitCode} without diagnostics`,
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

/** Label checker/setup diagnostics instead of silently discarding them. */
function remapTypeCheckOutput(raw: string, lineOffset: number): string {
  const locRe = /^(?:.*?[/\\])?script\.m?ts\((\d+),(\d+)\)(:.*)$/;
  return raw.split("\n").map((line) => {
    const match = line.match(locRe);
    if (!match) return line;
    const fileLine = Number(match[1]);
    if (fileLine > lineOffset) {
      return `exec_code.ts(${fileLine - lineOffset},${match[2]})${match[3]}`;
    }
    return `handle-setup.ts(${fileLine},${match[2]})${match[3]}`;
  }).join("\n").trim();
}

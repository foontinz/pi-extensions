import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeHandle } from "./hooks";
import { getEnvVar } from "pi-extension-envvars/store";

declare const __dirname: string;
const workspaceRoot = join(__dirname, "..", "..");
const tsxBin = join(workspaceRoot, "node_modules", ".bin", "tsx");
// Prefer tsgo (the native, ~4x faster TypeScript compiler from
// @typescript/native-preview); fall back to plain tsc if it's unavailable.
const tsgoBin = join(workspaceRoot, "node_modules", ".bin", "tsgo");
const tscBin = join(workspaceRoot, "node_modules", ".bin", "tsc");
const typeCheckBin = existsSync(tsgoBin) ? tsgoBin : tscBin;

export interface ExecuteResult {
  output: string;
  exitCode: number;
  stderr?: string;
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
        const value = await getEnvVar(name);
        if (value != null) envVars[name] = value;
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

  // Temp dir inside workspace root so ESM resolution finds node_modules
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
      const typeErrors = await typeCheck(
        tempDir,
        lineOffset,
        options.timeout,
        options.signal,
      );
      if (typeErrors && typeErrors.length > 0) {
        const count = `${typeErrors.length} error${typeErrors.length > 1 ? "s" : ""}`;
        return {
          output: "",
          exitCode: 2,
          stderr:
            `Type check failed (${count}):\n${typeErrors.join("\n")}\n\n` +
            `Fix the type error(s) above, or pass typecheck:false to run anyway.`,
        };
      }
    }

    return await new Promise<ExecuteResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      // Run with cwd set to the throwaway temp dir so that relative file
      // writes from user code land there (and get cleaned up) instead of
      // polluting the workspace root. ESM resolution still finds node_modules
      // by walking up to workspaceRoot.
      const proc = spawn(tsxBin, [tempFile], {
        cwd: tempDir,
        env: { ...process.env, ...envVars },
        timeout: options.timeout ?? 30_000,
      });

      proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      const onAbort = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL");
        }, 1000).unref();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      proc.on("close", (code) => {
        options.signal?.removeEventListener("abort", onAbort);
        const output = Buffer.concat(stdoutChunks).toString("utf8").trimEnd();
        const rawStderr = Buffer.concat(stderrChunks).toString("utf8").trimEnd();
        const stderr = cleanStderr(rawStderr, tempDir, lineOffset);
        resolve({ output, exitCode: code ?? 1, stderr: stderr || undefined });
      });

      proc.on("error", (err) => {
        options.signal?.removeEventListener("abort", onAbort);
        const isMissing = (err as NodeJS.ErrnoException).code === "ENOENT";
        const hint = isMissing
          ? `\n\ntsx not found at: ${tsxBin}\nRun: cd ${workspaceRoot} && npm install`
          : "";
        resolve({
          output: "",
          exitCode: 1,
          stderr: `Failed to start executor: ${err.message}${hint}`,
        });
      });
    });
  } finally {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
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
 * Type-check the generated script with tsc. Returns the user-facing type
 * errors (line numbers remapped to the caller's code), or null if the check
 * passed or could not run (e.g. tsc missing). Errors originating in the
 * handle preamble are filtered out so callers only see issues in their code.
 */
async function typeCheck(
  tempDir: string,
  lineOffset: number,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
): Promise<string[] | null> {
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

  const raw = await new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn(typeCheckBin, ["--noEmit", "-p", tsconfigPath], {
      cwd: tempDir,
      env: process.env,
      timeout: timeout ?? 30_000,
    });
    const onAbort = () => proc.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => chunks.push(c));
    proc.on("close", () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    // tsc missing or failed to start: skip type checking rather than block.
    proc.on("error", () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(null);
    });
  });

  if (!raw) return null;
  return filterUserTypeErrors(raw, lineOffset);
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

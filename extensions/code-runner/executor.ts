import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeHandle } from "./hooks";
import { getEnvVar } from "pi-extension-envvars/store";

declare const __dirname: string;
const workspaceRoot = join(__dirname, "..", "..");
const tsxBin = join(workspaceRoot, "node_modules", ".bin", "tsx");

export interface ExecuteResult {
  output: string;
  exitCode: number;
  stderr?: string;
}

export async function executeCode(
  code: string,
  handles: CodeHandle[],
  options: { timeout?: number; signal?: AbortSignal } = {},
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

  // Build script: handle preambles + user code
  const preamble = handles
    .map((h) => h.setupCode.trim())
    .filter(Boolean)
    .join("\n\n");
  const scriptContent = preamble ? `${preamble}\n\n${code}` : code;

  // Temp dir inside workspace root so ESM resolution finds node_modules
  const tempDir = await mkdtemp(join(workspaceRoot, ".run-"));
  const tempFile = join(tempDir, "script.mts");

  try {
    await writeFile(tempFile, scriptContent, "utf8");

    // Re-check after async env resolution + file write
    if (options.signal?.aborted) {
      return { output: "", exitCode: 1, stderr: "Cancelled before execution" };
    }

    return await new Promise<ExecuteResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const proc = spawn(tsxBin, [tempFile], {
        cwd: workspaceRoot,
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
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trimEnd();
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

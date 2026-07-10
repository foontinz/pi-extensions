/**
 * Code execution hooks — lets other extensions register code handles:
 * pre-initialized API clients and utilities injected into every
 * exec_code execution as top-level variables.
 *
 * Uses a PID-scoped JSON file as shared registry to work around jiti creating
 * separate module instances when the same file is imported from different
 * extensions. A PID scope prevents handles from one pi process leaking into a
 * later one; stale registry files are removed opportunistically.
 *
 * Usage (from another extension, at module top level):
 *
 *   import { registerCodeHandle, unregisterCodeHandle } from "../code-runner/hooks";
 *
 *   registerCodeHandle({
 *     name: "myClient",
 *     setupCode: `import MyClient from "my-package";\nconst myClient = new MyClient(process.env.MY_KEY);`,
 *     envVars: ["MY_KEY"],
 *     docs: "## `myClient` — My API client\n...",
 *   });
 *
 *   // Call from an extension's own shutdown/dispose path if it dynamically
 *   // removes a handle.
 *   unregisterCodeHandle("myClient");
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CodeHandle {
  /** Variable name available in user code (e.g. `exa`, `github`). */
  name: string;

  /** Short one-line summary used by search_spec discovery. */
  summary?: string;

  /** Keywords used by search_spec ranking. */
  keywords?: string[];

  /**
   * TypeScript code prepended to the user's script.
   * Runs in an ESM context with top-level await.
   * Packages must be resolvable from ~/.pi/agent/node_modules/.
   */
  setupCode: string;

  /**
   * Env var names to inject into the child process.
   * Resolved at execution time via the envvars store (keychain / process.env).
   */
  envVars?: string[];

  /**
   * Markdown documentation returned by search_spec.
   * Should include: variable name, methods, and usage examples.
   */
  docs: string;
}

export interface CodeHandleMatch {
  handle: CodeHandle;
  score: number;
  reasons: string[];
}

const registryDir = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PREFIX = ".handle-registry.";
const REGISTRY_FILE = join(registryDir, `${REGISTRY_PREFIX}${process.pid}.json`);

// This is intentionally non-destructive for the current process. Extensions
// register at module evaluation time, so clearing here or at session_start can
// erase handles registered by another extension during a reload.
cleanupStaleCodeHandleRegistries();

export function registerCodeHandle(handle: CodeHandle): void {
  const registry = readRegistry();
  registry.set(handle.name, handle);
  writeRegistryAtomic(registry);
}

/** Remove one handle without disturbing registrations owned by other extensions. */
export function unregisterCodeHandle(name: string): boolean {
  const registry = readRegistry();
  const removed = registry.delete(name);
  if (removed) writeRegistryAtomic(registry);
  return removed;
}

export function getRegisteredHandles(): CodeHandle[] {
  return [...readRegistry().values()];
}

/**
 * @deprecated Prefer unregisterCodeHandle(name). This remains only for
 * compatibility with explicit test/admin callers; code-runner never clears the
 * shared registry during loading or session lifecycle events.
 */
export function clearCodeHandles(): void {
  writeRegistryAtomic(new Map());
}

/** Remove abandoned PID-scoped registries without touching a live process. */
export function cleanupStaleCodeHandleRegistries(): void {
  let entries: string[];
  try {
    entries = readdirSync(registryDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const match = /^\.handle-registry\.(\d+)\.json$/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isProcessAlive(pid)) continue;
    try { unlinkSync(join(registryDir, entry)); } catch {}
  }
}

export function searchCodeHandles(goal: string): CodeHandleMatch[] {
  const goalLower = goal.trim().toLowerCase();
  const goalTokens = tokenize(goalLower);

  const matches = getRegisteredHandles().map((handle) => {
    const reasons: string[] = [];
    let score = 0;

    const name = handle.name.toLowerCase();
    const summary = (handle.summary ?? "").toLowerCase();
    const keywords = new Set((handle.keywords ?? []).map((k) => k.toLowerCase()));
    const summaryTokens = new Set(tokenize(summary));
    const docsTokens = new Set(tokenize(handle.docs));

    if (goalLower === name) {
      score += 100;
      reasons.push(`exact handle name match: ${handle.name}`);
    } else if (goalLower.includes(name)) {
      score += 30;
      reasons.push(`goal mentions handle name: ${handle.name}`);
    }

    for (const token of goalTokens) {
      if (token === name) {
        score += 40;
        reasons.push(`token matches handle name: ${token}`);
      }
      if (keywords.has(token)) {
        score += 18;
        reasons.push(`keyword match: ${token}`);
      }
      if (summaryTokens.has(token)) {
        score += 8;
        reasons.push(`summary match: ${token}`);
      }
      if (docsTokens.has(token)) {
        score += 2;
      }
    }

    if (goalLower.length >= 4 && summary.includes(goalLower)) {
      score += 20;
      reasons.push("goal phrase appears in summary");
    }
    if (goalLower.length >= 4 && handle.docs.toLowerCase().includes(goalLower)) {
      score += 6;
      reasons.push("goal phrase appears in docs");
    }

    return { handle, score, reasons: dedupe(reasons) } satisfies CodeHandleMatch;
  });

  matches.sort((a, b) => b.score - a.score || a.handle.name.localeCompare(b.handle.name));
  return matches;
}

// --- Internals ---

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means another user owns a still-live process, so leave its file.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRegistry(): Map<string, CodeHandle> {
  try {
    const data = readFileSync(REGISTRY_FILE, "utf8");
    const parsed = JSON.parse(data) as unknown;
    if (!Array.isArray(parsed)) return new Map();
    return new Map(
      parsed
        .filter((handle): handle is CodeHandle =>
          typeof handle === "object" && handle !== null &&
          typeof (handle as CodeHandle).name === "string" &&
          typeof (handle as CodeHandle).setupCode === "string" &&
          typeof (handle as CodeHandle).docs === "string",
        )
        .map((handle) => [handle.name, handle]),
    );
  } catch {
    return new Map();
  }
}

function writeRegistryAtomic(registry: Map<string, CodeHandle>): void {
  mkdirSync(registryDir, { recursive: true });
  const tmp = `${REGISTRY_FILE}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify([...registry.values()], null, 2), "utf8");
  renameSync(tmp, REGISTRY_FILE);
}

const STOP_WORDS = new Set([
  "a", "an", "and", "api", "best", "by", "for", "from", "get", "help",
  "how", "i", "in", "into", "is", "it", "me", "of", "on", "or", "the",
  "to", "use", "using", "want", "with",
]);

function tokenize(text: string): string[] {
  return dedupe(
    text.toLowerCase().split(/[^a-z0-9]+/g)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t)),
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

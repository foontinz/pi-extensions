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

  /** Alternate names accepted by exact discovery (for example `pw`). */
  aliases?: string[];

  /** Keywords used by search_spec ranking. */
  keywords?: string[];

  /** Short task-oriented phrases describing what the handle can do. */
  capabilities?: string[];

  /** Representative natural-language tasks that should discover this handle. */
  exampleGoals?: string[];

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
  confidence: "exact" | "strong" | "good" | "weak";
  reasons: string[];
}

/** Minimum useful score; docs-only incidental token matches stay below this. */
export const MIN_CODE_HANDLE_MATCH_SCORE = 6;

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

/** Deterministic compact catalog for browse/list discovery. */
export function listCodeHandles(): CodeHandle[] {
  return getRegisteredHandles().sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a handle by canonical name or alias, case-insensitively. */
export function findCodeHandle(name: string): CodeHandle | undefined {
  const needle = normalizePhrase(name);
  if (!needle) return undefined;
  return getRegisteredHandles().find((handle) =>
    normalizePhrase(handle.name) === needle ||
    (handle.aliases ?? []).some((alias) => normalizePhrase(alias) === needle),
  );
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
  return rankCodeHandles(goal, getRegisteredHandles());
}

/** Pure deterministic ranker, independent of the file-backed registry. */
export function rankCodeHandles(goal: string, handles: readonly CodeHandle[]): CodeHandleMatch[] {
  const goalPhrase = normalizePhrase(goal);
  const goalTokens = tokenize(goalPhrase);

  const matches = handles.map((handle) => {
    const reasons: string[] = [];
    let score = 0;

    const name = normalizePhrase(handle.name);
    const aliases = (handle.aliases ?? []).map(normalizePhrase).filter(Boolean);
    const keywords = (handle.keywords ?? []).flatMap(tokenize);
    const capabilities = (handle.capabilities ?? []).map(normalizePhrase).filter(Boolean);
    const exampleGoals = (handle.exampleGoals ?? []).map(normalizePhrase).filter(Boolean);
    const summary = normalizePhrase(handle.summary ?? "");
    const docSymbols = extractDocumentationTerms(handle.docs);
    const docs = normalizePhrase(handle.docs);

    if (goalPhrase === name) {
      score += 120;
      reasons.push(`exact handle name: ${handle.name}`);
    } else if (aliases.includes(goalPhrase)) {
      score += 100;
      reasons.push(`exact alias: ${goalPhrase}`);
    } else if (containsPhrase(goalPhrase, name)) {
      score += 35;
      reasons.push(`mentions handle name: ${handle.name}`);
    }

    if (goalPhrase.length >= 4) {
      const capability = capabilities.find((value) =>
        value.includes(goalPhrase) || goalPhrase.includes(value),
      );
      if (capability) {
        score += 30;
        reasons.push(`capability phrase: ${capability}`);
      } else if (summary.includes(goalPhrase)) {
        score += 20;
        reasons.push("goal phrase appears in summary");
      } else if (docs.includes(goalPhrase)) {
        score += 4;
        reasons.push("goal phrase appears in docs");
      }
    }

    const fields: Array<{ label: string; values: string[]; weight: number }> = [
      { label: "handle name", values: tokenize(name), weight: 45 },
      { label: "alias", values: aliases.flatMap(tokenize), weight: 36 },
      { label: "keyword", values: keywords, weight: 24 },
      { label: "capability", values: capabilities.flatMap(tokenize), weight: 16 },
      { label: "example goal", values: exampleGoals.flatMap(tokenize), weight: 15 },
      { label: "summary", values: tokenize(summary), weight: 9 },
      { label: "documentation symbol", values: docSymbols, weight: 8 },
      // General documentation prose is intentionally weak: one generic token must not
      // turn an unrelated handle into a supposedly strong result.
      { label: "docs", values: tokenize(docs), weight: 1 },
    ];

    for (const token of goalTokens) {
      let bestScore = 0;
      let bestReason: string | undefined;
      for (const field of fields) {
        for (const candidate of field.values) {
          const similarity = tokenSimilarity(token, candidate);
          if (similarity < 0.72) continue;
          const contribution = similarity === 1
            ? field.weight
            : field.weight * similarity * 0.65;
          if (contribution > bestScore) {
            bestScore = contribution;
            bestReason = similarity === 1
              ? `${field.label} match: ${token}`
              : `${field.label} fuzzy match: ${token} → ${candidate}`;
          }
        }
      }
      score += bestScore;
      if (bestReason && bestScore >= 4) reasons.push(bestReason);
    }

    const roundedScore = Math.round(score * 10) / 10;
    return {
      handle,
      score: roundedScore,
      confidence: confidenceFor(roundedScore),
      reasons: dedupe(reasons),
    } satisfies CodeHandleMatch;
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
          typeof (handle as CodeHandle).docs === "string" &&
          isOptionalString((handle as CodeHandle).summary) &&
          isOptionalStringArray((handle as CodeHandle).aliases) &&
          isOptionalStringArray((handle as CodeHandle).keywords) &&
          isOptionalStringArray((handle as CodeHandle).capabilities) &&
          isOptionalStringArray((handle as CodeHandle).exampleGoals) &&
          isOptionalStringArray((handle as CodeHandle).envVars),
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
  "a", "an", "and", "api", "best", "by", "for", "from", "help",
  "how", "i", "in", "into", "is", "it", "me", "of", "on", "or", "the",
  "to", "use", "using", "want", "with",
]);

// Small, domain-neutral concept groups make ordinary task language discoverable
// without requiring an embedding service. Handle-specific vocabulary still
// belongs in aliases/keywords/capabilities on the registration itself.
const RELATED_TERMS = [
  ["search", "find", "lookup", "query", "discover"],
  ["web", "internet", "online", "website", "site"],
  ["browse", "browser", "navigate", "page", "webpage"],
  ["fetch", "retrieve", "download", "read", "content"],
  ["automate", "automation", "control"],
  ["capture", "screenshot", "snapshot", "image"],
  ["docs", "documentation", "reference", "spec", "specification"],
].map((group) => new Set(group));

function normalizePhrase(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function tokenize(text: string): string[] {
  return dedupe(
    normalizePhrase(text).split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
  );
}

function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function extractDocumentationTerms(markdown: string): string[] {
  const selected: string[] = [];
  for (const line of markdown.split("\n")) {
    if (/^#{1,6}\s+/.test(line)) selected.push(line.replace(/^#{1,6}\s+/, ""));
    for (const match of line.matchAll(/`([^`]+)`/g)) selected.push(match[1]);
  }
  return selected.flatMap(tokenize);
}

function normalizedWord(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function areRelatedTerms(left: string, right: string): boolean {
  return RELATED_TERMS.some((group) => group.has(left) && group.has(right));
}

/** Sørensen–Dice coefficient over character bigrams. */
function fuzzySimilarity(left: string, right: string): number {
  if (left.length < 3 || right.length < 3) return 0;
  const pairs = (value: string): string[] => {
    const result: string[] = [];
    for (let i = 0; i < value.length - 1; i++) result.push(value.slice(i, i + 2));
    return result;
  };
  const remaining = pairs(right);
  let overlap = 0;
  for (const pair of pairs(left)) {
    const index = remaining.indexOf(pair);
    if (index < 0) continue;
    overlap++;
    remaining.splice(index, 1);
  }
  return (2 * overlap) / (left.length - 1 + right.length - 1);
}

function tokenSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizedWord(left);
  const normalizedRight = normalizedWord(right);
  if (normalizedLeft === normalizedRight) return 1;
  if (areRelatedTerms(left, right) || areRelatedTerms(normalizedLeft, normalizedRight)) return 0.9;
  if (
    Math.min(normalizedLeft.length, normalizedRight.length) >= 4 &&
    (normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft))
  ) return 0.82;
  return fuzzySimilarity(normalizedLeft, normalizedRight);
}

function confidenceFor(score: number): CodeHandleMatch["confidence"] {
  if (score >= 90) return "exact";
  if (score >= 40) return "strong";
  if (score >= 16) return "good";
  return "weak";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

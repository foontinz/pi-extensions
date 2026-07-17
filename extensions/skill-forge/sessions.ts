import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { Stats } from "node:fs";
import { resolve } from "node:path";
import type { AnalysisChunk, EvidenceRef, FileStamp, ParsedSession } from "./types.ts";
import { canonicalProject, sha256 } from "./storage.ts";

const MAX_ENTRY_TEXT = 4_000;
const MAX_TOOL_ARGUMENTS = 2_000;
const SECRET_KEY = /(?:^|[_-])(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?key|session[_-]?key)(?:$|[_-])/i;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/gi, "[REDACTED_PEM]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/\b(?:npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gi, "[REDACTED_TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [/(\bhttps?:\/\/[^\s\/@:]+:)[^\s\/@]+(@)/gi, "$1[REDACTED]$2"],
  [/\b((?:proxy-)?authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, "$1[REDACTED]"],
  [/\b((?=[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY))[A-Z_][A-Z0-9_]*)\s*=\s*([^\s'\"]+|'[^']*'|\"[^\"]*\")/gi, "$1=[REDACTED]"],
  [/\b((?:client[_-]?secret|api[_-]?key|access[_-]?key|private[_-]?key|password|passwd|pwd|secret|token)\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\r\n,;]+)/gi, "$1[REDACTED]"],
  [/(\"(?:[^\"]*[_-])?(?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key|access[_-]?key)\"\s*:\s*)\"[^\"]*\"/gi, "$1\"[REDACTED]\""],
];

export function redactSecrets(value: string): string {
  let output = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

/** Recursively removes values under credential-like keys before serialization. */
export function sanitizeSecretValues(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 12 || seen.has(value)) return "[REDACTED_COMPLEX_VALUE]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeSecretValues(item, depth + 1, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeSecretValues(item, depth + 1, seen);
  }
  return result;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\0/g, "").replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{4,}/g, "\n\n\n").trim();
}

function bounded(value: string, maximum = MAX_ENTRY_TEXT): string {
  const clean = redactSecrets(normalizeWhitespace(value));
  if (clean.length <= maximum) return clean;
  const head = clean.slice(0, Math.floor(maximum * 0.65));
  const tail = clean.slice(-(maximum - head.length - 40));
  return `${head}\n…[bounded ${clean.length} chars]…\n${tail}`;
}

function stamp(stats: Stats): FileStamp {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export async function readStableJsonl(path: string, attempts = 3): Promise<{ text: string; stamp: FileStamp }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "r");
      const before = stamp(await handle.stat());
      const text = await handle.readFile({ encoding: "utf8" });
      const after = stamp(await handle.stat());
      if (sameStamp(before, after)) return { text, stamp: after };
      lastError = new Error("session changed during read");
    } catch (error) { lastError = error; }
    finally { await handle?.close().catch(() => undefined); }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10 * (attempt + 1)));
  }
  throw new Error(`Could not obtain stable session snapshot for ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export function parseSessionSnapshot(path: string, text: string, fileStamp: FileStamp): ParsedSession {
  const values: Record<string, unknown>[] = [];
  const malformed: ParsedSession["malformed"] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values.push(parsed as Record<string, unknown>);
      else malformed.push({ line: index + 1, digest: sha256(line), message: "JSONL value is not an object" });
    } catch (error) { malformed.push({ line: index + 1, digest: sha256(line), message: error instanceof Error ? error.message : String(error) }); }
  }
  const header = values.find((value) => value.type === "session");
  if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") throw new Error(`Session header is missing or invalid: ${path}`);
  return { sessionId: header.id, cwd: header.cwd, path, stamp: fileStamp, entries: values.filter((value) => value !== header), malformed };
}

export async function loadSession(path: string): Promise<ParsedSession> {
  const snapshot = await readStableJsonl(path);
  return parseSessionSnapshot(path, snapshot.text, snapshot.stamp);
}

function contentText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text" && typeof (block as Record<string, unknown>).text === "string" ? [(block as Record<string, unknown>).text as string] : []);
}

function safeJson(value: unknown, maximum = MAX_TOOL_ARGUMENTS): string {
  try { return bounded(JSON.stringify(sanitizeSecretValues(value)), maximum); } catch { return "[unserializable]"; }
}

function normalizedEntry(entry: Record<string, unknown>): { kind: string; text: string } | undefined {
  const customType = typeof entry.customType === "string" ? entry.customType : undefined;
  if (customType?.startsWith("skill-forge") || entry.type === "custom") return undefined;
  if (entry.type === "custom_message" && customType?.startsWith("skill-forge")) return undefined;
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "unknown";
    if (role === "custom" && typeof message.customType === "string" && message.customType.startsWith("skill-forge")) return undefined;
    if (role === "user") { const text = bounded(contentText(message.content).join("\n")); return text ? { kind: "user", text } : undefined; }
    if (role === "custom") {
      const text = bounded(contentText(message.content).join("\n"));
      return text ? { kind: "custom-context", text } : undefined;
    }
    if (role === "assistant") {
      const parts = contentText(message.content).map((text) => bounded(text)).filter(Boolean);
      if (Array.isArray(message.content)) for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        const call = block as Record<string, unknown>;
        if (call.type === "toolCall" && typeof call.name === "string") parts.push(`TOOL CALL ${bounded(call.name, 120)} args=${safeJson(call.arguments)}`);
      }
      const text = bounded(parts.join("\n")); return text ? { kind: "assistant", text } : undefined;
    }
    if (role === "toolResult") {
      const name = typeof message.toolName === "string" ? bounded(message.toolName, 120) : "unknown";
      const result = bounded(contentText(message.content).join("\n"));
      return { kind: message.isError === true ? "tool-error" : "tool-success", text: `TOOL OUTCOME ${name} error=${message.isError === true}\n${result}` };
    }
    if (role === "bashExecution") return { kind: message.exitCode === 0 ? "tool-success" : "tool-error", text: bounded(`SHELL command=${String(message.command ?? "")} exit=${String(message.exitCode ?? "unknown")}\n${String(message.output ?? "")}`) };
  }
  if (entry.type === "compaction" && typeof entry.summary === "string") return { kind: "summary", text: bounded(entry.summary) };
  if (entry.type === "branch_summary" && typeof entry.summary === "string") return { kind: "branch-summary", text: bounded(entry.summary) };
  return undefined;
}

function entryDigest(entry: Record<string, unknown>): string { return createHash("sha256").update(JSON.stringify(entry)).digest("hex"); }

export function prefixDigest(entries: Record<string, unknown>[], end: number): string {
  const hash = createHash("sha256");
  for (let index = 0; index < Math.min(end, entries.length); index++) hash.update(entryDigest(entries[index]!)).update("\0");
  return hash.digest("hex");
}

interface TranscriptRecord { ref: string; entryIndex: number; entryId: string; parentId: string | null; branchRelation: EvidenceRef["branchRelation"]; timestamp: string; kind: string; context: "preceding" | "range" | "following"; text: string }

export function buildChunk(session: ParsedSession, start: number, maxChars: number, maxEntries: number): AnalysisChunk | undefined {
  if (start >= session.entries.length) return undefined;
  const limit = Math.max(2, maxChars);
  const primaryBudget = Math.max(2, Math.floor(limit * 0.68));
  const entryIds = new Set(session.entries.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []));
  const records: TranscriptRecord[] = [];
  const evidence: EvidenceRef[] = [];
  const contextEntryIndexes = new Set<number>();
  let serializedLength = 2;

  const append = (index: number, context: TranscriptRecord["context"], budget: number): boolean => {
    const entry = session.entries[index]!;
    const normalized = normalizedEntry(entry);
    if (!normalized) return true;
    const entryId = typeof entry.id === "string" ? bounded(entry.id, 160) : `line-entry-${index}`;
    const rawParent = typeof entry.parentId === "string" ? entry.parentId : null;
    const parentId = rawParent === null ? null : bounded(rawParent, 160);
    const branchRelation: EvidenceRef["branchRelation"] = parentId === null ? "root" : entryIds.has(rawParent!) ? "reply" : "orphan";
    const ref = `r${index}`;
    const base = { ref, entryIndex: index, entryId, parentId, branchRelation, timestamp: typeof entry.timestamp === "string" ? bounded(entry.timestamp, 80) : "unknown", kind: normalized.kind, context };
    let text = normalized.text;
    let record: TranscriptRecord = { ...base, text };
    let encoded = JSON.stringify(record);
    const available = Math.min(budget, limit) - serializedLength - (records.length ? 1 : 0);
    if (encoded.length > available) {
      text = bounded(text, Math.max(0, available - JSON.stringify({ ...base, text: "" }).length));
      record = { ...base, text };
      encoded = JSON.stringify(record);
    }
    if (!text || encoded.length > available) return false;
    records.push(record);
    contextEntryIndexes.add(index);
    serializedLength += encoded.length + (records.length > 1 ? 1 : 0);
    evidence.push({ ref, sessionId: session.sessionId, sessionPath: session.path, entryId, parentId, branchRelation, timestamp: record.timestamp, kind: normalized.kind, excerpt: bounded(text, 600), evidenceDigest: sha256(`${entryId}\0${parentId ?? ""}\0${normalized.kind}\0${normalized.text}`) });
    return true;
  };

  let end = start;
  while (end < session.entries.length && end - start < Math.max(1, maxEntries)) {
    const appended = append(end, "range", primaryBudget);
    if (!appended) {
      if (end === start) throw new Error(`Skill Forge request budget (${maxChars}) is too small to represent session entry ${start}`);
      break;
    }
    end++;
  }
  if (end === start) throw new Error(`Skill Forge could not build a non-empty chunk at session entry ${start}`);
  for (let index = Math.max(0, start - 4); index < start; index++) append(index, "preceding", limit);
  for (let index = end; index < Math.min(session.entries.length, end + 6); index++) {
    if (!append(index, "following", limit)) break;
  }
  // Bind the job to every raw entry that influenced the request, including
  // overlap context. A correction appended or rewritten during analysis must
  // invalidate the stale result rather than being committed as provenance.
  const digestIndexes = new Set<number>(contextEntryIndexes);
  for (let index = start; index < end; index++) digestIndexes.add(index);
  const orderedIndexes = [...digestIndexes].sort((a, b) => a - b);
  const rangeDigest = sha256(orderedIndexes.map((index) => `${index}:${entryDigest(session.entries[index]!)}`).join("\0"));
  records.sort((a, b) => a.entryIndex - b.entryIndex);
  evidence.sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)));
  return { sessionId: session.sessionId, sessionPath: session.path, startEntryIndex: start, endEntryIndex: end, rangeDigest, transcript: JSON.stringify(records), evidence };
}

export async function belongsToProject(session: ParsedSession, projectCwd: string): Promise<boolean> { return await canonicalProject(session.cwd) === projectCwd; }
export function sameFileIdentity(a: FileStamp, b: FileStamp): boolean { return a.dev === b.dev && a.ino === b.ino; }
export function sameSnapshotStamp(a: FileStamp, b: FileStamp): boolean { return sameStamp(a, b); }
export function resolvedPath(path: string): string { return resolve(path); }

export const __testing = { normalizedEntry, bounded, entryDigest, sameStamp, safeJson };

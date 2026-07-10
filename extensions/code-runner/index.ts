import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { executeCode } from "./executor";
import {
  findCodeHandle,
  getRegisteredHandles,
  listCodeHandles,
  MIN_CODE_HANDLE_MATCH_SCORE,
  searchCodeHandles,
  type CodeHandle,
} from "./hooks";
import { sliceUtf8Head, sliceUtf8Tail } from "./output";

interface SearchSpecDetails {
  action: "list" | "search" | "get";
  goal?: string;
  canonicalName?: string;
  handleCount?: number;
  matchCount?: number;
  handles?: Array<string | {
    name: string;
    score: number;
    confidence: "exact" | "strong" | "good" | "weak";
    reasons: string[];
  }>;
}

export default function (pi: ExtensionAPI) {
  // Tool definitions are stateless and can be registered during extension
  // loading. Handle registrations remain dynamic and are read at execution.
  registerTools(pi);
}

/**
 * Truncate large output by keeping BOTH the head and the tail, eliding the
 * middle. This preserves early results (e.g. a value printed before a long
 * loop) as well as final output, instead of dropping the head entirely.
 */
function truncateText(text: string): string {
  const content = text || "(no output)";
  const maxLines = DEFAULT_MAX_LINES;
  const maxBytes = DEFAULT_MAX_BYTES;

  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) return content;

  // Reserve room for the elision marker itself so the final tool result stays
  // within Pi's configured context budget.
  const payloadLines = Math.max(2, maxLines - 4);
  const payloadBytes = Math.max(2, maxBytes - 256);
  const headLines = Math.ceil(payloadLines / 2);
  const tailLines = Math.floor(payloadLines / 2);
  let headStr = lines.slice(0, headLines).join("\n");
  let tailStr = lines.slice(Math.max(headLines, totalLines - tailLines)).join("\n");

  // Split the byte budget between head and tail.
  const halfBytes = Math.floor(payloadBytes / 2);
  headStr = sliceUtf8Head(headStr, halfBytes);
  tailStr = sliceUtf8Tail(tailStr, halfBytes);

  const shownLines =
    headStr.split("\n").length + tailStr.split("\n").length;
  const shownBytes =
    Buffer.byteLength(headStr, "utf8") + Buffer.byteLength(tailStr, "utf8");
  const omittedLines = Math.max(0, totalLines - shownLines);

  const elision =
    `\n\n… [omitted ${omittedLines} of ${totalLines} lines, ` +
    `${formatSize(totalBytes - shownBytes)} of ${formatSize(totalBytes)}] …\n\n`;

  return headStr + elision + tailStr;
}

function formatCapabilities(handle: CodeHandle): string | undefined {
  const capabilities = handle.capabilities?.filter(Boolean) ?? [];
  return capabilities.length > 0 ? `Capabilities: ${capabilities.join("; ")}` : undefined;
}

function formatCatalogEntry(handle: CodeHandle): string {
  const aliases = handle.aliases?.length ? ` (aliases: ${handle.aliases.join(", ")})` : "";
  const summary = handle.summary ?? "No summary provided.";
  const capabilities = formatCapabilities(handle);
  return [`- ${handle.name}${aliases} — ${summary}`, capabilities ? `  ${capabilities}` : undefined]
    .filter(Boolean)
    .join("\n");
}

function formatFullSpec(handle: CodeHandle): string {
  const aliases = handle.aliases?.length ? `Aliases: ${handle.aliases.join(", ")}` : undefined;
  const exampleGoals = handle.exampleGoals?.length
    ? `Example goals: ${handle.exampleGoals.join("; ")}`
    : undefined;
  return [
    `${handle.name}${handle.summary ? ` — ${handle.summary}` : ""}`,
    aliases,
    formatCapabilities(handle),
    exampleGoals,
    "",
    handle.docs,
  ].filter((value) => value !== undefined).join("\n");
}

function registerTools(pi: ExtensionAPI): void {
  // --- exec_code ---
  pi.registerTool({
    name: "exec_code",
    label: "Exec Code",
    description: [
      "Execute TypeScript (or JavaScript) code in a Node.js child process.",
      "Supports top-level `await`, ES modules, and all `node:*` built-ins.",
      "Use `console.log()` / `console.error()` to produce output — everything written",
      "to stdout/stderr is captured and returned as the tool result.",
      "",
      "Pre-initialized handles are available as ready-to-use top-level variables — no import needed.",
      "If you are unsure which handles or SDKs are available for a task, call `search_spec` first.",
      "You may also import packages that exist in ~/.pi/agent/node_modules/.",
      "Code is type-checked before running; checker/setup errors are returned without executing. Pass typecheck:false to skip the check.",
      "Relative file paths resolve to a throwaway temp dir that is deleted after the run; write to an absolute path to persist files.",
      `Visible output is limited to ${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines; larger output includes a recovery-file path.`,
    ].join("\n"),
    promptSnippet:
      "Execute TypeScript code in Node.js using available pre-initialized handles and console.log for output.",
    promptGuidelines: [
      "Use exec_code when you need to call an API, fetch web content, process data, or run computations.",
      "Use console.log() to emit results; all stdout/stderr is returned in the tool result.",
      "When a task may benefit from an unfamiliar external API or SDK, use search_spec to discover registered handles first.",
      "You can import node:* built-ins (node:fs, node:path, node:crypto …) freely.",
      "For packages not exposed as handles, import them only if they are present in ~/.pi/agent/node_modules/.",
    ],
    parameters: Type.Object({
      code: Type.String({
        description:
          "TypeScript/JavaScript code to execute. Use console.log() for output. Top-level await is supported.",
      }),
      timeout: Type.Optional(
        Type.Integer({
          description:
            "Maximum total time for setup, type checking, and execution in milliseconds. Default: 30 000. Max: 120 000.",
          minimum: 1_000,
          maximum: 120_000,
        }),
      ),
      typecheck: Type.Optional(
        Type.Boolean({
          description:
            "Type-check the code with tsc before running (default: true). Set false to skip and run even if there are type errors.",
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate) {
      const handles = getRegisteredHandles();

      onUpdate?.({
        content: [{ type: "text", text: params.typecheck === false ? "Running code…" : "Type-checking and running code…" }],
        details: {},
      });

      const result = await executeCode(params.code, handles, {
        timeout: params.timeout,
        signal,
        typecheck: params.typecheck,
      });

      const parts: string[] = [];
      if (result.combinedOutput) {
        parts.push(result.combinedOutput);
      } else {
        if (result.output) parts.push(result.output);
        if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
      }
      if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
      if (result.fullOutputPath) {
        parts.push(`[Full combined output saved to: ${result.fullOutputPath}]`);
      }

      const text = truncateText(parts.join("\n\n") || "(no output)");

      if (result.exitCode !== 0) {
        const err = new Error(text);
        (err as Error & { details?: unknown }).details = {
          exitCode: result.exitCode,
          fullOutputPath: result.fullOutputPath,
        };
        throw err;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          exitCode: result.exitCode,
          fullOutputPath: result.fullOutputPath,
        },
      };
    },
  });

  // --- search_spec ---
  pi.registerTool({
    name: "search_spec",
    label: "Search Spec",
    description: [
      "Discover pre-registered code handles/SDKs and their usage documentation.",
      "Supports three actions: list the complete capability catalog, search it with a natural-language goal, or get one exact handle by name/alias.",
      "Search includes capability phrases, aliases, related task language, plurals, prefixes, and typo-tolerant fuzzy matching.",
      "Use this before exec_code when you need to know which APIs, clients, or utilities exist in the current environment.",
    ].join("\n"),
    promptSnippet:
      "List, search, or inspect available code handles and SDK documentation before writing exec_code programs.",
    promptGuidelines: [
      "Use search_spec before exec_code when you need to call an API, fetch web content, process data, or run computations.",
      "Use search_spec action=list when you do not yet know what capabilities are available.",
      "Use search_spec action=search with the user's goal in ordinary language, e.g. 'find current information online' or 'capture a webpage screenshot'.",
      "Use search_spec action=get with an exact handle name when you need its complete reference documentation.",
      "After reading search_spec output, write code for exec_code using canonical handle names exactly.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["list", "search", "get"] as const, {
          description: "Discovery mode. Defaults to search when goal is provided, get when name is provided, otherwise list.",
        }),
      ),
      goal: Type.Optional(
        Type.String({
          description: "Plain-language task to match. Used by action=search.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description: "Canonical handle name or alias. Used by action=get.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          description: "Maximum search matches to return. Default: 5. Max: 20.",
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),

    async execute(_id, params): Promise<AgentToolResult<SearchSpecDetails>> {
      const action = params.action ?? (params.name ? "get" : params.goal ? "search" : "list");

      if (action === "list") {
        const handles = listCodeHandles();
        const text = handles.length === 0
          ? "No code handles are currently registered."
          : [
              `Available code handles (${handles.length}):`,
              "",
              ...handles.map(formatCatalogEntry),
              "",
              "Use action=get with a handle name for its complete documentation.",
            ].join("\n");
        return {
          content: [{ type: "text", text: truncateText(text) }],
          details: {
            action,
            handleCount: handles.length,
            handles: handles.map((handle) => handle.name),
          },
        };
      }

      if (action === "get") {
        const requestedName = params.name?.trim();
        if (!requestedName) throw new Error("search_spec action=get requires `name`.");
        const handle = findCodeHandle(requestedName);
        if (!handle) {
          const available = listCodeHandles().map((item) => item.name);
          const suggestions = searchCodeHandles(requestedName)
            .filter((match) => match.score >= MIN_CODE_HANDLE_MATCH_SCORE)
            .slice(0, 3)
            .map((match) => match.handle.name);
          throw new Error(
            `Unknown code handle: ${requestedName}.` +
            (suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "") +
            (available.length > 0 ? ` Available handles: ${available.join(", ")}` : " No handles are registered."),
          );
        }
        return {
          content: [{ type: "text", text: truncateText(formatFullSpec(handle)) }],
          details: { action, canonicalName: handle.name },
        };
      }

      const goal = params.goal?.trim();
      if (!goal) throw new Error("search_spec action=search requires `goal`.");
      const limit = params.limit ?? 5;
      const matches = searchCodeHandles(goal)
        .filter((match) => match.score >= MIN_CODE_HANDLE_MATCH_SCORE)
        .slice(0, limit);

      if (matches.length === 0) {
        const handles = listCodeHandles();
        const msg = handles.length === 0
          ? "No code handles are currently registered."
          : [
              `No useful capability match for: ${goal}`,
              "",
              "Available handles:",
              ...handles.map(formatCatalogEntry),
              "",
              "Try a broader goal, action=list, or action=get with an exact name.",
            ].join("\n");
        return {
          content: [{ type: "text", text: truncateText(msg) }],
          details: { action, goal, matchCount: 0, handles: [] },
        };
      }

      const text = matches
        .map((match, index) => {
          const header = `${index + 1}. ${match.handle.name} — ${match.confidence} match (score ${match.score})`;
          const summary = match.handle.summary ?? "No summary provided.";
          const capabilities = formatCapabilities(match.handle);
          const why = match.reasons.length > 0 ? `Why matched: ${match.reasons.join(", ")}` : undefined;
          const next = `Use action=get, name=${JSON.stringify(match.handle.name)} for complete documentation.`;
          return [header, summary, capabilities, why, next].filter(Boolean).join("\n");
        })
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: truncateText(text) }],
        details: {
          action,
          goal,
          matchCount: matches.length,
          handles: matches.map((match) => ({
            name: match.handle.name,
            score: match.score,
            confidence: match.confidence,
            reasons: match.reasons,
          })),
        },
      };
    },
  });
}

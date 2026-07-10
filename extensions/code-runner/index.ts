import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeCode } from "./executor";
import { getRegisteredHandles, searchCodeHandles } from "./hooks";

export default function (pi: ExtensionAPI) {
  // Handle registration happens at extension module evaluation time. Do not
  // clear the shared registry here: doing so races other extensions and drops
  // their handles on reload/session replacement.
  pi.on("session_start", async () => {
    registerTools(pi);
  });
}

function sliceBytesHead(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  return buf.length <= maxBytes ? s : buf.subarray(0, maxBytes).toString("utf8");
}

function sliceBytesTail(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  return buf.length <= maxBytes
    ? s
    : buf.subarray(buf.length - maxBytes).toString("utf8");
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

  const headLines = Math.ceil(maxLines / 2);
  const tailLines = Math.floor(maxLines / 2);
  let headStr = lines.slice(0, headLines).join("\n");
  let tailStr = lines.slice(Math.max(headLines, totalLines - tailLines)).join("\n");

  // Split the byte budget between head and tail.
  const halfBytes = Math.floor(maxBytes / 2);
  headStr = sliceBytesHead(headStr, halfBytes);
  tailStr = sliceBytesTail(tailStr, halfBytes);

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
      "Code is type-checked with tsc before running; type errors are returned without executing. Pass typecheck:false to skip the check.",
      "Relative file paths resolve to a throwaway temp dir that is deleted after the run; write to an absolute path to persist files.",
    ].join("\n"),
    promptSnippet:
      "Execute TypeScript code in Node.js using available pre-initialized handles and console.log for output.",
    promptGuidelines: [
      "Use exec_code when you need to call an API, fetch web content, process data, or run computations.",
      "Use console.log() to emit results; all stdout/stderr is returned in the tool result.",
      "Pre-initialized handles may be available as top-level variables — use search_spec first if you need discovery.",
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
            "Maximum execution time in milliseconds. Default: 30 000. Max: 120 000.",
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
        content: [{ type: "text", text: "Running code…" }],
        details: {},
      });

      const result = await executeCode(params.code, handles, {
        timeout: params.timeout,
        signal,
        typecheck: params.typecheck,
      });

      const parts: string[] = [];
      if (result.output) parts.push(result.output);
      if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
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
    description:
      "Discover the best available code handles/SDKs for a goal. Use this before exec_code when you need to know which pre-registered APIs, clients, or utilities exist in the current environment.",
    promptSnippet:
      "Discover available code handles and docs for a programming goal before writing code.",
    promptGuidelines: [
      "Use search_spec before exec_code when you need to call an API, fetch web content, process data, or run computations.",
      "Pass the user's goal in plain language, e.g. 'search the web with exa' or 'query GitHub repos'.",
      "After reading search_spec output, write code for exec_code using the matched handle names exactly.",
      "When the user asks about capabilities that could involve external APIs or data processing, check search_spec first to see what's available.",
    ],
    parameters: Type.Object({
      goal: Type.String({
        description: "Plain-language goal or task to match against available code handles and their docs.",
      }),
      limit: Type.Optional(
        Type.Integer({
          description: "Maximum number of matching handles to return. Default: 5. Max: 20.",
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),

    async execute(_id, params) {
      const limit = params.limit ?? 5;
      const matches = searchCodeHandles(params.goal)
        .filter((m) => m.score > 0)
        .slice(0, limit);

      if (matches.length === 0) {
        const handles = getRegisteredHandles();
        const msg = handles.length === 0
          ? "No code handles are currently registered."
          : `No strong match for: ${params.goal}\n\nAvailable handles: ${handles.map((h) => h.name).join(", ")}`;
        return {
          content: [{ type: "text", text: msg }],
          details: { matchCount: 0, handles: [] },
        };
      }

      const text = matches
        .map((m, i) => {
          const header = `${i + 1}. ${m.handle.name}${m.handle.summary ? ` — ${m.handle.summary}` : ""}`;
          const why = m.reasons.length > 0 ? `Why matched: ${m.reasons.join(", ")}` : undefined;
          return [header, why, "", m.handle.docs].filter(Boolean).join("\n");
        })
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: truncateText(text) }],
        details: {
          matchCount: matches.length,
          handles: matches.map((m) => ({ name: m.handle.name, score: m.score })),
        },
      };
    },
  });
}

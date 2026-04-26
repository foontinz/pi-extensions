import * as os from "node:os";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { truncateOneLine } from "../platform/text.js";

export function formatToolCall(toolName: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = String(a.command ?? "...");
      return `$ ${truncateOneLine(command, 160)}`;
    }
    case "read": {
      const filePath = shortenPath(String(a.path ?? a.file_path ?? "..."));
      const offset = typeof a.offset === "number" ? a.offset : undefined;
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      const suffix = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
      return `read ${filePath}${suffix}`;
    }
    case "write":
    case "edit": {
      return `${toolName} ${shortenPath(String(a.path ?? a.file_path ?? "..."))}`;
    }
    case "grep": {
      return `grep /${String(a.pattern ?? "")}/ in ${shortenPath(String(a.path ?? "."))}`;
    }
    case "find": {
      return `find ${String(a.pattern ?? "*")} in ${shortenPath(String(a.path ?? "."))}`;
    }
    case "ls": {
      return `ls ${shortenPath(String(a.path ?? "."))}`;
    }
    default: {
      return `${toolName} ${truncateOneLine(JSON.stringify(a), 200)}`;
    }
  }
}

export function previewToolResult(result: unknown): string {
  if (!result) return "";
  if (hasContentArray(result)) {
    return truncateOneLine(
      result.content
        .map(formatToolResultContentPart)
        .filter(Boolean)
        .join("\n"),
      300,
    );
  }
  if (typeof result === "string") return truncateOneLine(result, 300);
  return truncateOneLine(safeJsonStringify(result), 300);
}

function hasContentArray(value: unknown): value is { content: unknown[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as { content?: unknown }).content);
}

function formatToolResultContentPart(part: unknown): string {
  if (typeof part !== "object" || part === null) return "";
  const type = (part as { type?: unknown }).type;
  if (type === "text") {
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return typeof type === "string" && type ? `[${type}]` : "";
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatToolResultMessage(msg: ToolResultMessage): string {
  const text = msg.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .filter(Boolean)
    .join("\n");
  return `${msg.isError ? "✗" : "✓"} ${msg.toolName}: ${truncateOneLine(text || "done", 300)}`;
}

export function getAssistantText(msg: AssistantMessage): string {
  return msg.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function textContent(content: Array<{ type: string; text?: string }>): string {
  return content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
}

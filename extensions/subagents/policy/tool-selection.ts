export const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"] as const;
export const RESERVED_SUBAGENT_TOOLS = ["run_agent", "list_agents", "stop_agent"] as const;

export interface ToolListParseOk {
  ok: true;
  tools: string[];
}

export interface ToolListParseRejected {
  ok: false;
  message: string;
  requestedTools: string[];
}

export type ToolListParseResult = ToolListParseOk | ToolListParseRejected;

export interface ToolSelectionOk {
  ok: true;
  tools: string[];
  activeTools: string[];
  requestedTools: string[];
}

export interface ToolSelectionRejected {
  ok: false;
  message: string;
  activeTools: string[];
  requestedTools: string[];
}

export type ToolSelectionResult = ToolSelectionOk | ToolSelectionRejected;

function stableUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function parseToolList(value: unknown): ToolListParseResult {
  const raw = typeof value === "string"
    ? value.split(",")
    : Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value
      : [];
  const requestedTools = raw.map((tool) => tool.trim());
  const emptyEntries = requestedTools.filter((tool) => tool.length === 0).length;
  const tools = stableUnique(requestedTools.filter(Boolean));
  if (emptyEntries > 0) {
    return { ok: false, requestedTools: tools, message: "Tool lists may not contain empty tool names." };
  }
  return { ok: true, tools };
}

export function validateToolSelection(activeTools: string[], requestedTools: string[] | undefined): ToolSelectionResult {
  const active = [...new Set(activeTools.map((tool) => tool.trim()).filter(Boolean))].sort();
  const activeSet = new Set(active);
  const defaultTools = DEFAULT_SUBAGENT_TOOLS.filter((tool) => activeSet.has(tool));
  const parsed = parseToolList(requestedTools ?? defaultTools);
  if (!parsed.ok) {
    return { ok: false, activeTools: active, requestedTools: parsed.requestedTools, message: parsed.message };
  }
  const requested = parsed.tools;
  const reserved = requested.filter((tool) => (RESERVED_SUBAGENT_TOOLS as readonly string[]).includes(tool));
  if (reserved.length > 0) {
    return {
      ok: false,
      activeTools: active,
      requestedTools: requested,
      message: `Refusing to start subagent with recursive subagent tools: ${reserved.join(", ")}. Nested subagent delegation is disabled by default.`,
    };
  }
  const disallowed = requested.filter((tool) => !activeSet.has(tool));
  if (disallowed.length > 0) {
    return {
      ok: false,
      activeTools: active,
      requestedTools: requested,
      message: `Refusing to start subagent with tools not active in the parent session: ${disallowed.join(", ")}. Active tools: ${active.join(", ") || "none"}.`,
    };
  }
  return { ok: true, tools: requested, activeTools: active, requestedTools: requested };
}

export const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"] as const;

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

export function validateToolSelection(activeTools: string[], requestedTools: string[] | undefined): ToolSelectionResult {
  const active = [...new Set(activeTools)].sort();
  const activeSet = new Set(active);
  const defaultTools = DEFAULT_SUBAGENT_TOOLS.filter((tool) => activeSet.has(tool));
  const requested = [...new Set(requestedTools ?? defaultTools)].sort();
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

export const meta = {
  name: "builtin:test-gap-audit",
  description: "Audit behavior and tests in parallel, then correlate meaningful gaps",
  resumable: false,
  maxAgents: 10,
  capabilities: ["read"],
  phases: [
    { id: "map", title: "Map behavior and tests" },
    { id: "correlate", title: "Correlate gaps" }
  ],
  whenToUse: "Use when changed or risky behavior needs a focused test-coverage audit",
  estimatedOutputTokens: 5000
}

phase("map")
const scope = args && typeof args === "object" && args.scope ? String(args.scope) : "the current repository"
const mapped = await parallel([
  () => agent(`Map externally observable behavior and high-risk branches in ${scope}. Cite files and lines.`, {
    id: "behavior-map",
    effects: "none",
    tools: ["read", "grep", "find", "ls"]
  }),
  () => agent(`Map existing tests for ${scope}, including fixtures and failure/race cases. Cite files and lines.`, {
    id: "test-map",
    effects: "none",
    tools: ["read", "grep", "find", "ls"]
  })
])
phase("correlate")
if (mapped.some((value) => value === null)) return { maps: mapped, gaps: null, partial: true }
const gaps = await agent(`Correlate these behavior and test maps. Return only material untested behavior, each with proposed test location and assertion:\n${JSON.stringify(mapped)}`, {
  id: "correlate-gaps",
  effects: "none",
  tools: ["read", "grep", "find", "ls"]
})
return { maps: mapped, gaps, partial: gaps === null }

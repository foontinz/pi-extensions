export const meta = {
  name: "builtin:code-review",
  description: "Review changed code in parallel and verify concrete findings",
  resumable: false,
  maxAgents: 12,
  capabilities: ["read"],
  phases: [
    { id: "review", title: "Review" },
    { id: "verify", title: "Verify" }
  ],
  whenToUse: "Use for a bounded independent review of repository changes",
  estimatedOutputTokens: 6000
}

phase("review")
const scope = args && typeof args === "object" && args.scope ? String(args.scope) : "the current repository changes"
const reviews = await parallel([
  () => agent(`Review ${scope} for correctness and regressions. Report only actionable findings with file and line evidence.`, {
    id: "correctness",
    phase: "review",
    effects: "none",
    tools: ["read", "grep", "find", "ls"]
  }),
  () => agent(`Review ${scope} for security, boundary, and failure-handling defects. Report only actionable findings with evidence.`, {
    id: "security",
    phase: "review",
    effects: "none",
    tools: ["read", "grep", "find", "ls"]
  }),
  () => agent(`Review ${scope} for missing or misleading tests. Report concrete test gaps tied to changed behavior.`, {
    id: "tests",
    phase: "review",
    effects: "none",
    tools: ["read", "grep", "find", "ls"]
  })
])
phase("verify")
const candidates = reviews.filter((value) => value !== null)
if (candidates.length === 0) return { reviews: [], verification: null, partial: true }
const verification = await agent(`Verify these review reports against the repository. Remove speculation and duplicates, preserve exact file/line evidence, and rank severity:\n${JSON.stringify(candidates)}`, {
  id: "verify-findings",
  phase: "verify",
  effects: "none",
  tools: ["read", "grep", "find", "ls"]
})
return { reviews: candidates, verification, partial: verification === null }

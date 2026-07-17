---
name: simple-system-flow
description: "Explain how a technical system works as a plain-language numbered arrow flow, with decision branches and clear ownership of each rule."
---

# Simple System Flow

Use when the user asks how a system works, when something happens, or which component controls a decision — and a step-by-step causal answer fits better than prose.

## Method

1. Start from the triggering action and keep strict chronological order.
2. Format the explanation as numbered steps joined by arrows:

```text
Step 1: Trigger
→
Step 2: State is created or loaded
→
Step 3: Work is dispatched
```

3. Use short, concrete sentences; define technical terms only when needed.
4. At every decision point, name the component that owns the rule — never attribute a decision to the wrong layer.
5. Show branches explicitly:

```text
Step 5A: Check passes → continue
Step 5B: Check fails  → return to Step 3
```

6. If the question is about a failure, add a minimal loop showing why it repeats, then state exactly which step and rule diverged from the normal flow:

```text
check rejects result
→ state stays pending
→ work is dispatched again
→ repeats until a safety limit stops it
```

7. End with one sentence summarizing the whole flow.

## Guardrails

- Plain language; do not open with an architecture essay.
- Do not skip steps whose timing matters (persistence, verification, retries).
- Keep the first answer self-contained so no follow-up is needed to reconstruct the flow.

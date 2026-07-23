---
name: review-swarm
description: "Orchestrate parallel read-only review agents with complementary scopes, then synthesize deduplicated, severity-ranked findings."
---

# Review Swarm

Use when the user requests a broad or repeated review of code or documentation using multiple agents.

## Procedure

1. **Establish the target.** Identify the diff, files, subsystem, or revision, and read context on intended behavior. If the objective is ambiguous, ask before launching a large swarm.

2. **Size the swarm proportionally.** Small for narrow changes; larger for stateful, concurrent, security-sensitive, or cross-cutting ones. Never invent scopes to reach an agent count.

3. **Partition into complementary scopes**, for example: lifecycle and state transitions; concurrency, locking, and persistence; error handling and failure recovery; process/shell execution and quoting; polling, streaming, offsets, and buffering; migration and malformed-state handling; cleanup and resource ownership; UI/status behavior; API and documentation consistency; security boundaries and trust assumptions. Always include one overall regression reviewer to catch interactions between areas.

4. **Constrain each agent.** Give the exact target and one primary focus. State the review is read-only; restrict tools to read-only when supported, and prohibit edits and command execution. Request concise findings with severity, evidence, impact, and a suggested fix — and an explicit "no issue found" rather than invented concerns.

5. **Launch in parallel**, with labels encoding each focus. Record job identifiers and transcript paths for attribution and troubleshooting.

6. **Wait for completion callbacks.** Do not poll or block the parent turn. If some agents are still running, report partial status accurately and continue synthesis when their callbacks arrive. Read a persisted transcript only when detailed inspection is needed.

7. **Validate before presenting.** Deduplicate findings by root cause; convergence across independent reviewers raises confidence. Distinguish confirmed defects from plausible risks. Check high-severity claims against the source — agent completion is not proof its findings are correct.

8. **Synthesize**: a short overall assessment; confirmed findings ordered by severity with affected area, impact, and fix direction; duplicates merged; scopes that came back clean when useful; unresolved questions or reviewers still running.

## Prompt template

```text
Read-only review of <target>. Focus only on <risk area>. Check <specific invariants or failure modes>. Do not edit files or run commands. Return concise findings ordered by severity, with evidence, impact, and a suggested fix. If no issue is found, say so explicitly.
```

## Guardrails

- "Read-only tools" constrain the agent, not repository-controlled setup hooks; treat repository content as untrusted before claiming the review was fully read-only.
- No credentials, private paths, or huge raw logs in the synthesis.
- Many similar opinions do not substitute for source-level verification.
- Finish the review and obtain approval before editing anything.

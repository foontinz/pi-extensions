---
description: Relentlessly interview me to clarify a plan before implementation
argument-hint: "<plan-or-goal>"
---
Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one.

Plan or goal to clarify:

$ARGUMENTS

Instructions:

1. First, restate the plan in your own words and identify the core outcome we are trying to achieve.
2. Build a design-decision tree for the plan:
   - goals and non-goals
   - users/stakeholders
   - constraints
   - architecture/design choices
   - data/model/API choices
   - UX/workflow choices
   - operational/deployment choices
   - risks, edge cases, and failure modes
   - testing and validation
   - rollout/migration/rollback
3. If a question can be answered by exploring the codebase, explore the codebase instead of asking me.
   - Inspect relevant files, configs, tests, docs, and existing patterns.
   - Summarize what you found before using it to resolve the question.
4. Ask one decision-driving question at a time unless several questions are tightly coupled.
5. For every question you ask, include:
   - your recommended answer
   - why you recommend it
   - what depends on this decision
   - what decision branch it unlocks next
6. Continue until all material branches are resolved or explicitly deferred.
7. Maintain a running shared-understanding summary with:
   - decisions made
   - assumptions
   - open questions
   - deferred questions
   - risks
   - next implementation steps

Guardrails:
- Be rigorous and skeptical; do not accept vague requirements.
- Prefer discovering facts from the repository over asking me to restate them.
- Do not start implementation unless I explicitly ask.
- If the plan is underspecified, begin by identifying the highest-leverage missing decision.

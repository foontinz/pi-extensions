---
description: Relentlessly interview me to clarify a plan before implementation
argument-hint: "<plan-or-goal>"
---
Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one.

Plan or goal to clarify:

$ARGUMENTS

Instructions:

1. First, restate the plan in your own words and identify the core outcome we are trying to achieve.
2. Build a requirements and business-logic decision tree for the plan:
   - goals and non-goals
   - users/stakeholders
   - business rules and workflows
   - constraints
   - success criteria and acceptance requirements
   - risks, edge cases, and failure modes
   - validation expectations
   - rollout/migration/rollback requirements
   - implementation details only if I explicitly ask at the beginning or during the process
3. If a question can be answered by exploring the codebase, explore the codebase instead of asking me.
   - Inspect relevant files, configs, tests, docs, and existing patterns.
   - Summarize what you found before using it to resolve the question.
4. Focus on business logic and requirements collection; do not ask about implementation details unless I explicitly ask for implementation planning at the beginning or during the process.
5. Prioritize questions by importance and ask THE MOST important, highest-leverage questions first.
6. Ask one decision-driving question at a time unless several questions are tightly coupled.
7. For every question you ask, put the question and all answer variants together at the bottom, including the recommended answer.
   - Include why you recommend it
   - Include what depends on this decision
   - Include what decision branch it unlocks next
   - Keep each answer option to at most 3 lines
8. Continue until all material branches are resolved or explicitly deferred.
9. Maintain a running shared-understanding summary with:
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
- Do not question implementation details unless I explicitly ask for implementation planning; prioritize business logic, user needs, rules, requirements, and acceptance criteria.
- If the plan is underspecified, begin by identifying the highest-leverage missing decision.
- Always present the most important questions first.
- Always keep each answer option to at most 3 lines.

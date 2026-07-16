import type {
  GoalCheckpointV2,
  GoalCriterion,
  GoalEvidence,
  GoalPhase,
} from "./state.ts";

/** Working packets are intentionally much smaller than a goal snapshot. */
export const GOAL_WORKING_PACKET_MIN_BYTES = 4 * 1024;
export const GOAL_WORKING_PACKET_MAX_BYTES = 8 * 1024;

export interface GoalWorkingPacketOptions {
  /** Must remain in the supported 4–8 KiB range. Defaults to 8 KiB. */
  maxBytes?: number;
}

/**
 * Instructions supplied to Pi's normal compactor. The summary is a context aid;
 * durable goal state remains authoritative.
 */
export const GOAL_COMPACTION_INSTRUCTIONS = [
  "Preserve the active objective verbatim, verified progress, file paths and symbols changed, key decisions and rejected approaches, blockers, test commands and results, and the next concrete action.",
  "Preserve goal, epoch, revision, active phase, and evidence locators when they are present.",
  "Do not include large logs or artifact contents; retain only their paths, hashes, and concise findings.",
  "Do not infer completion, verification, or checkpoint state. The durable goal checkpoint—not this summary—is authoritative.",
].join(" ");

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/** Truncate on Unicode code-point boundaries and never exceed maxBytes. */
export function truncateUtf8(value: string, maxBytes: number, suffix = "…"): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative integer");
  if (byteLength(value) <= maxBytes) return value;
  if (maxBytes === 0) return "";

  const suffixBytes = byteLength(suffix);
  if (suffixBytes > maxBytes) {
    let result = "";
    for (const character of suffix) {
      if (byteLength(result + character) > maxBytes) break;
      result += character;
    }
    return result;
  }

  let result = "";
  const contentBudget = maxBytes - suffixBytes;
  for (const character of value) {
    if (byteLength(result + character) > contentBudget) break;
    result += character;
  }
  return result + suffix;
}

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function quote(value: string): string {
  return JSON.stringify(oneLine(value));
}

function boundedQuotedLine(prefix: string, value: string, maxBytes = 720): string {
  const normalized = oneLine(value);
  let line = `${prefix}${quote(normalized)}`;
  if (byteLength(line) <= maxBytes) return line;

  const characters = Array.from(normalized);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    line = `${prefix}${quote(`${characters.slice(0, middle).join("")}…`)}`;
    if (byteLength(line) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return `${prefix}${quote(`${characters.slice(0, low).join("")}…`)}`;
}

function criterionLine(criterion: GoalCriterion): string {
  const evidenceIds = criterion.evidenceIds ?? [];
  const shownEvidence = evidenceIds.slice(0, 4).map((id) => quote(id)).join(",");
  const evidence = shownEvidence
    ? `; evidence=${shownEvidence}${evidenceIds.length > 4 ? `,+${evidenceIds.length - 4} omitted` : ""}`
    : "";
  return boundedQuotedLine(
    `- [${criterion.status}] ${criterion.id}: `,
    `${criterion.description}${evidence}`,
    680,
  );
}

function phaseLine(phase: GoalPhase, ordinal: number): string {
  const title = truncateUtf8(oneLine(phase.title), 180);
  return boundedQuotedLine(
    `- ${ordinal}. ${phase.id} [${phase.status}] ${title} — `,
    phase.intent,
    680,
  );
}

function evidenceLine(evidence: GoalEvidence): string {
  const criterion = evidence.criterionId ? ` criterion=${evidence.criterionId}` : "";
  const digest = evidence.digest ? ` digest=${evidence.digest}` : "";
  return boundedQuotedLine(
    `- ${evidence.id} [${evidence.kind}]${criterion}: `,
    `${evidence.description}; locator=${evidence.locator}${digest}`,
    700,
  );
}

interface PacketSection {
  title: string;
  empty: string;
  lines: string[];
  candidates: string[];
  included: number;
}

function interleave<T>(...groups: T[][]): T[] {
  const result: T[] = [];
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < longest; index++) {
    for (const group of groups) {
      if (index < group.length) result.push(group[index]);
    }
  }
  return result;
}

function activePhase(checkpoint: GoalCheckpointV2): { phase?: GoalPhase; index: number } {
  const explicit = checkpoint.activePhaseId
    ? checkpoint.phases.findIndex((phase) => phase.id === checkpoint.activePhaseId)
    : -1;
  if (explicit >= 0) return { phase: checkpoint.phases[explicit], index: explicit };
  const inferred = checkpoint.phases.findIndex((phase) =>
    phase.status === "running" || phase.status === "candidate_complete" || phase.status === "verifying" || phase.status === "blocked");
  return inferred >= 0 ? { phase: checkpoint.phases[inferred], index: inferred } : { index: -1 };
}

function renderPacket(
  checkpoint: GoalCheckpointV2,
  objectiveLine: string,
  nextActionLine: string,
  sections: PacketSection[],
): string {
  const phase = activePhase(checkpoint).phase;
  const protocolPhase = phase?.id ?? "(none; set_plan must establish one)";
  return [
    "<goal_working_packet>",
    "AUTHORITATIVE BOUNDED GOAL STATE — do not treat conversation history or compaction summaries as control state.",
    "",
    "## Identity / revision",
    `goalId=${checkpoint.goalId} epoch=${checkpoint.epoch} revision=${checkpoint.revision} planVersion=${checkpoint.planVersion}`,
    `lifecycle=${checkpoint.lifecycle}${checkpoint.pauseReason ? ` pauseReason=${checkpoint.pauseReason}` : ""}`,
    `scheduler=${checkpoint.scheduler.state}`,
    ...(checkpoint.waitFor
      ? [`waitFor.kind=${checkpoint.waitFor.kind} waitFor.id=${quote(checkpoint.waitFor.id)}`]
      : []),
    "",
    "## Objective",
    objectiveLine,
    ...sections.flatMap((section) => [
      "",
      `## ${section.title}`,
      ...(section.lines.length ? section.lines : [section.empty]),
    ]),
    "",
    "## Exact next action",
    nextActionLine,
    "",
    "## Strict goal_checkpoint protocol",
    `- This run belongs to goal=${checkpoint.goalId}, epoch=${checkpoint.epoch}, revision=${checkpoint.revision}, activePhase=${protocolPhase}.`,
    "- Work only on the exact next action and the bounded active phase. Inspect current files/evidence before repeating possibly interrupted work.",
    `- Before ending this run, call goal_checkpoint exactly once with expectedRevision=${checkpoint.revision} and an accurate action: set_plan, progress, phase_candidate_complete, goal_candidate_complete, blocked, or waiting_external.`,
    "- Supply concise durable summaries, decisions, evidence, and an exact nextAction—not raw logs. Evidence locators must exactly copy successful tool invocations/IDs; bare artifact paths require adapter-verified digests.",
    "- If the tool rejects a stale revision, stop changing goal state and reconcile from the newest checkpoint; never retry using guessed state.",
    "- phase_candidate_complete and goal_candidate_complete are claims only. They enter verification; they do not mark success. Never claim verification without observed evidence or explicit user acceptance.",
    "- Use blocked only for a concrete user decision or user-performed prerequisite. Include the exact question in openQuestions or the exact requested action in nextAction.",
    "- Use typed waiting_external only for one already-started owned enhanced-bash task or Workflow: pass waitFor={kind:\"background_task\",id:\"<exact bg_/mon_ id>\"} or waitFor={kind:\"workflow\",id:\"<exact runId>\"}. Use mon_ only for a finite watcher that exits; monitor output lines are not completion. Subagent waits are unavailable until typed completion metadata exists.",
    "- Use untyped waiting_external only when no typed callback exists, such as a person or third-party system. Omit waitFor and provide nextAction naming the dependency and exactly how completion will be recognized or reported.",
    "- Never use waiting_external for scheduler acceptance, phase acceptance, verification acceptance, or internal bookkeeping. Matching typed terminal metadata after the checkpoint wakes the goal automatically: do not poll, sleep, launch a duplicate continuation, call goal_resume from task output, or claim that a typed wait resumed from prose alone.",
    "- Do not use legacy text sentinels as a substitute for goal_checkpoint. Do not dispatch another continuation yourself.",
    "</goal_working_packet>",
  ].join("\n");
}

function checkedMaxBytes(options: GoalWorkingPacketOptions): number {
  const value = options.maxBytes ?? GOAL_WORKING_PACKET_MAX_BYTES;
  if (!Number.isSafeInteger(value)
    || value < GOAL_WORKING_PACKET_MIN_BYTES
    || value > GOAL_WORKING_PACKET_MAX_BYTES) {
    throw new RangeError(
      `goal working packet maxBytes must be between ${GOAL_WORKING_PACKET_MIN_BYTES} and ${GOAL_WORKING_PACKET_MAX_BYTES}`,
    );
  }
  return value;
}

/**
 * Build a deterministic packet solely from the durable checkpoint. It never
 * reads transcript history and deliberately excludes recentProgress and
 * artifact contents; evidence is represented only by concise descriptions and
 * locators.
 */
export function buildGoalWorkingPacket(
  checkpoint: GoalCheckpointV2,
  options: GoalWorkingPacketOptions = {},
): string {
  const maxBytes = checkedMaxBytes(options);
  const { phase, index: phaseIndex } = activePhase(checkpoint);
  const completedById = new Map(checkpoint.ledger.completedPhaseSummaries.map((item) => [item.phaseId, item.summary]));
  for (const item of checkpoint.phases) {
    if (item.status === "completed" && item.summary && !completedById.has(item.id)) completedById.set(item.id, item.summary);
  }

  const upcoming = checkpoint.phases
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => item.status === "pending" && (phaseIndex < 0 || index > phaseIndex))
    .slice(0, 5);

  const activeCandidates: string[] = [];
  if (phase) {
    activeCandidates.push(phaseLine(phase, phaseIndex + 1));
    activeCandidates.push(boundedQuotedLine("- active intent: ", phase.intent));
    for (const criterion of phase.criteria) activeCandidates.push(criterionLine(criterion));
    if (phase.nextAction) activeCandidates.push(boundedQuotedLine("- phase next: ", phase.nextAction));
  }

  const lifecycleBlockers: string[] = [];
  if (checkpoint.lifecycle === "blocked" || checkpoint.lifecycle === "waiting_external" || checkpoint.pauseReason) {
    lifecycleBlockers.push(`- lifecycle=${checkpoint.lifecycle}${checkpoint.pauseReason ? `; pauseReason=${checkpoint.pauseReason}` : ""}`);
  }
  const phaseBlockers = checkpoint.phases
    .filter((item) => item.status === "blocked" || item.status === "failed")
    .map((item) => boundedQuotedLine(
      `- phase ${item.id} [${item.status}]: `,
      item.summary ?? item.nextAction ?? item.intent,
    ));
  const questions = checkpoint.ledger.openQuestions.map((question) => boundedQuotedLine("- question: ", question));

  const constraintLines = checkpoint.constraints.map((value) => boundedQuotedLine("- constraint: ", value));
  const acceptanceLines = checkpoint.acceptanceCriteria.map(criterionLine);
  const decisionLines = checkpoint.ledger.decisions.map((decision) => boundedQuotedLine(
    `- decision ${decision.id}: `,
    `${decision.summary}${decision.rationale ? `; rationale=${decision.rationale}` : ""}`,
  ));
  const evidenceLines = checkpoint.evidence.map(evidenceLine);

  const sections: PacketSection[] = [
    {
      title: "Constraints / acceptance criteria",
      empty: "(none recorded)",
      lines: [],
      candidates: interleave(constraintLines, acceptanceLines),
      included: 0,
    },
    {
      title: "Completed phase summaries",
      empty: "(none completed)",
      lines: [],
      candidates: Array.from(completedById, ([phaseId, summary]) => boundedQuotedLine(`- ${phaseId}: `, summary)),
      included: 0,
    },
    {
      title: "Active phase",
      empty: "(no active phase; create or reconcile the rolling plan)",
      lines: [],
      candidates: activeCandidates,
      included: 0,
    },
    {
      title: "Upcoming phases (bounded horizon)",
      empty: "(none recorded; replan when the active phase is settled)",
      lines: [],
      candidates: upcoming.map(({ item, index }) => phaseLine(item, index + 1)),
      included: 0,
    },
    {
      title: "Decisions / evidence references",
      empty: "(none recorded)",
      lines: [],
      candidates: interleave(decisionLines, evidenceLines),
      included: 0,
    },
    {
      title: "Blockers / open questions",
      empty: "(none recorded)",
      lines: [],
      candidates: interleave(lifecycleBlockers, phaseBlockers, questions),
      included: 0,
    },
  ];

  let objectiveLine = boundedQuotedLine("objective=", checkpoint.objective, 2_300);
  const nextAction = checkpoint.ledger.nextAction ?? phase?.nextAction ?? "Record or reconcile the exact next action.";
  let nextActionLine = boundedQuotedLine("nextAction=", nextAction, 900);

  // The fixed protocol and all headings are reserved before optional details.
  let packet = renderPacket(checkpoint, objectiveLine, nextActionLine, sections);
  if (byteLength(packet) > maxBytes) {
    objectiveLine = boundedQuotedLine("objective=", checkpoint.objective, 700);
    nextActionLine = boundedQuotedLine("nextAction=", nextAction, 420);
    packet = renderPacket(checkpoint, objectiveLine, nextActionLine, sections);
  }
  if (byteLength(packet) > maxBytes) {
    // This can only be caused by unusually long identifiers. Preserve the
    // protocol and use a byte-safe final guard rather than returning overflow.
    return truncateUtf8(packet, maxBytes);
  }

  // Round-robin selection prevents one large ledger from starving later
  // categories. Array order is authoritative and therefore deterministic.
  const longest = Math.max(0, ...sections.map((section) => section.candidates.length));
  for (let candidateIndex = 0; candidateIndex < longest; candidateIndex++) {
    for (const section of sections) {
      const candidate = section.candidates[candidateIndex];
      if (!candidate) continue;
      section.lines.push(candidate);
      const attempt = renderPacket(checkpoint, objectiveLine, nextActionLine, sections);
      if (byteLength(attempt) <= maxBytes) {
        packet = attempt;
        section.included++;
      } else {
        section.lines.pop();
      }
    }
  }

  for (const section of sections) {
    if (section.included >= section.candidates.length) continue;
    let omitted = section.candidates.length - section.included;
    let marker = `- [… ${omitted} additional bounded entr${omitted === 1 ? "y" : "ies"} omitted]`;
    section.lines.push(marker);
    let attempt = renderPacket(checkpoint, objectiveLine, nextActionLine, sections);
    if (byteLength(attempt) > maxBytes && section.lines.length > 1) {
      section.lines.splice(section.lines.length - 2, 1);
      section.included--;
      omitted++;
      marker = `- [… ${omitted} additional bounded entr${omitted === 1 ? "y" : "ies"} omitted]`;
      section.lines[section.lines.length - 1] = marker;
      attempt = renderPacket(checkpoint, objectiveLine, nextActionLine, sections);
    }
    if (byteLength(attempt) <= maxBytes) packet = attempt;
    else section.lines.pop();
  }

  return packet;
}

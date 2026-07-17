import { sha256 } from "./storage.ts";
import { redactSecrets } from "./sessions.ts";
import type { AnalyzerCandidate, AnalyzerInvalidation, ApplyingLease, EvidenceRef, ForgeState, Proposal, ProvenanceRecord, Scope } from "./types.ts";

const TERMINAL = new Set(["accepted", "rejected", "invalidated"]);

function compact(value: string, maximum: number): string {
  const clean = redactSecrets(value).replace(/\0/g, "").trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`;
}

export function safeSlug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").slice(0, 64).replace(/-$/g, "");
}

function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return normalized.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

export function canonicalSkillMd(name: string, description: string, markdown: string): string {
  const slug = safeSlug(name);
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Skill name cannot be converted to a safe slug");
  const safeDescription = compact(description.replace(/\s+/g, " "), 1_024);
  if (!safeDescription) throw new Error("Skill description is empty");
  const body = compact(stripFrontmatter(redactSecrets(markdown)), 40_000);
  if (!body) throw new Error("SKILL.md body is empty");
  return `---\nname: ${slug}\ndescription: ${JSON.stringify(safeDescription)}\n---\n\n${body}\n`;
}

export function validateInstallableSkill(markdown: string, expectedName: string): { name: string; description: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("SKILL.md must begin with YAML frontmatter");
  const name = match[1]!.match(/^name:\s*([^\n]+)$/m)?.[1]?.trim();
  const rawDescription = match[1]!.match(/^description:\s*([^\n]+)$/m)?.[1]?.trim();
  if (!name || name !== expectedName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error("SKILL.md frontmatter has an unsafe or mismatched name");
  if (!rawDescription) throw new Error("SKILL.md frontmatter description is missing");
  let description = rawDescription;
  if (rawDescription.startsWith("\"")) {
    try { description = JSON.parse(rawDescription) as string; } catch { throw new Error("SKILL.md description is not valid JSON/YAML text"); }
  }
  if (!description || description.length > 1_024 || /[\r\n]/.test(description)) throw new Error("SKILL.md description is invalid");
  if (redactSecrets(markdown) !== markdown) throw new Error("SKILL.md appears to contain a secret");
  return { name, description };
}

function normalizeCandidate(candidate: AnalyzerCandidate, supplied: EvidenceRef[]): AnalyzerCandidate & { fingerprint: string; cited: EvidenceRef[] } {
  const skillName = safeSlug(candidate.skillName);
  const description = compact(candidate.description.replace(/\s+/g, " "), 1_024);
  const capabilityKey = safeSlug(candidate.capabilityKey) || skillName;
  const skillMd = canonicalSkillMd(skillName, description, candidate.skillMd);
  validateInstallableSkill(skillMd, skillName);
  const byRef = new Map(supplied.map((evidence) => [evidence.ref, evidence]));
  const cited: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const ref of candidate.evidenceRefs) {
    const evidence = byRef.get(ref);
    if (!evidence) throw new Error(`Candidate cited unknown evidence ref: ${ref}`);
    const occurrence = `${evidence.sessionId}\0${evidence.sessionPath}\0${evidence.entryId}\0${evidence.evidenceDigest}`;
    if (!seen.has(occurrence)) { seen.add(occurrence); cited.push(evidence); }
  }
  if (cited.length === 0) throw new Error("Candidate must cite at least one supplied evidence ref");
  const signals = [...new Set(candidate.proposedScope.signals.map((signal) => compact(signal, 300)).filter(Boolean))].slice(0, 12);
  if (signals.length === 0) throw new Error("Proposed scope must include at least one signal");
  const normalized: AnalyzerCandidate = {
    capabilityKey,
    title: compact(candidate.title, 200),
    rationale: compact(candidate.rationale, 2_000),
    confidence: Math.max(0, Math.min(1, candidate.confidence)),
    skillName,
    description,
    skillMd,
    proposedScope: { scope: candidate.proposedScope.scope, rationale: compact(candidate.proposedScope.rationale, 2_000), confidence: Math.max(0, Math.min(1, candidate.proposedScope.confidence)), signals },
    evidenceRefs: cited.map((evidence) => evidence.ref),
    operation: candidate.operation,
  };
  return { ...normalized, cited, fingerprint: proposalFingerprint(normalized) };
}

export function proposalFingerprint(candidate: Pick<AnalyzerCandidate, "capabilityKey" | "skillName" | "description" | "skillMd" | "proposedScope" | "operation">): string {
  return sha256(JSON.stringify({ capabilityKey: candidate.capabilityKey, skillName: candidate.skillName, description: candidate.description, skillMd: candidate.skillMd, proposedScope: candidate.proposedScope, operation: candidate.operation }));
}

function evidenceWeightKeys(proposal: Proposal): Set<string> {
  return new Set(proposal.provenance.flatMap((record) => record.evidence.map((item) => `${item.entryId}\0${item.evidenceDigest}`)));
}

function dedupeProvenance(records: ProvenanceRecord[]): ProvenanceRecord[] {
  const occurrenceSeen = new Set<string>();
  const output: ProvenanceRecord[] = [];
  for (const record of records) {
    const evidence = record.evidence.filter((item) => {
      const key = `${record.candidateFingerprint}\0${item.sessionId}\0${item.sessionPath}\0${item.entryId}\0${item.evidenceDigest}`;
      if (occurrenceSeen.has(key)) return false;
      occurrenceSeen.add(key);
      return true;
    });
    if (evidence.length) output.push({ ...record, evidence });
  }
  return output.slice(-500);
}

export function mergeCandidate(
  state: ForgeState,
  raw: AnalyzerCandidate,
  suppliedEvidence: EvidenceRef[],
  analysis: Omit<ProvenanceRecord, "evidence" | "candidateFingerprint">,
): { proposal?: Proposal; newlyReady: boolean; suppressed: boolean } {
  const candidate = normalizeCandidate(raw, suppliedEvidence);
  const related = state.proposals.filter((proposal) => proposal.capabilityKey === candidate.capabilityKey).sort((a, b) => b.revision - a.revision);
  const latest = related[0];
  const provenance: ProvenanceRecord = { ...analysis, candidateFingerprint: candidate.fingerprint, evidence: candidate.cited };
  if (latest) {
    const knownEvidence = evidenceWeightKeys(latest);
    const materiallyNew = candidate.cited.some((item) => !knownEvidence.has(`${item.entryId}\0${item.evidenceDigest}`));
    if (latest.status === "applying") return { proposal: latest, newlyReady: false, suppressed: true };
    if (TERMINAL.has(latest.status) && !materiallyNew) {
      latest.provenance = dedupeProvenance([...latest.provenance, provenance]);
      latest.updatedAt = new Date().toISOString();
      return { proposal: latest, newlyReady: false, suppressed: true };
    }
    if (latest.fingerprint === candidate.fingerprint && !TERMINAL.has(latest.status)) {
      latest.provenance = dedupeProvenance([...latest.provenance, provenance]);
      latest.updatedAt = new Date().toISOString();
      return { proposal: latest, newlyReady: false, suppressed: false };
    }
    // Reviewer content and non-ready states are immutable to the model. A
    // differing, lower-confidence candidate is not attached to retained content.
    if (!TERMINAL.has(latest.status) && (latest.status !== "ready" || latest.reviewerEditedAt || candidate.confidence < latest.confidence)) {
      return { proposal: latest, newlyReady: false, suppressed: true };
    }
    if (!TERMINAL.has(latest.status)) {
      Object.assign(latest, {
        fingerprint: candidate.fingerprint, title: candidate.title, rationale: candidate.rationale,
        confidence: candidate.confidence, skillName: candidate.skillName, description: candidate.description,
        skillMd: candidate.skillMd, proposedScope: candidate.proposedScope, operation: candidate.operation,
        provenance: dedupeProvenance([...latest.provenance, provenance]), updatedAt: new Date().toISOString(),
      });
      return { proposal: latest, newlyReady: false, suppressed: false };
    }
  }

  const revision = (latest?.revision ?? 0) + 1;
  const now = new Date().toISOString();
  const proposal: Proposal = {
    id: `forge-${sha256(`${candidate.capabilityKey}\0${candidate.fingerprint}\0${revision}`).slice(0, 14)}`,
    revision, capabilityKey: candidate.capabilityKey, fingerprint: candidate.fingerprint,
    title: candidate.title, rationale: candidate.rationale, confidence: candidate.confidence,
    skillName: candidate.skillName, description: candidate.description, skillMd: candidate.skillMd,
    proposedScope: candidate.proposedScope, operation: candidate.operation, status: "ready",
    createdAt: now, updatedAt: now, provenance: dedupeProvenance([provenance]),
  };
  if (state.proposals.some((item) => item.id === proposal.id)) throw new Error(`Duplicate proposal id: ${proposal.id}`);
  state.proposals.push(proposal);
  return { proposal, newlyReady: true, suppressed: false };
}

function requireStatus(proposal: Proposal, operation: string, allowed: Proposal["status"][]): void {
  if (!allowed.includes(proposal.status)) throw new Error(`Proposal ${proposal.id} cannot ${operation} from status ${proposal.status}`);
}

export function applyAnalyzerInvalidation(
  state: ForgeState,
  raw: AnalyzerInvalidation,
  suppliedEvidence: EvidenceRef[],
  analysis: Omit<ProvenanceRecord, "evidence" | "candidateFingerprint">,
): boolean {
  const capabilityKey = safeSlug(raw.capabilityKey);
  if (!capabilityKey) throw new Error("Invalidation capability key is empty or unsafe");
  const byRef = new Map(suppliedEvidence.map((evidence) => [evidence.ref, evidence]));
  const evidence: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const ref of raw.evidenceRefs) {
    const item = byRef.get(ref);
    if (!item) throw new Error(`Invalidation cited unknown evidence ref: ${ref}`);
    const key = `${item.sessionId}\0${item.sessionPath}\0${item.entryId}\0${item.evidenceDigest}`;
    if (!seen.has(key)) { seen.add(key); evidence.push(item); }
  }
  if (!evidence.length) throw new Error("Invalidation must cite correction/revert evidence");
  const proposal = state.proposals
    .filter((item) => item.capabilityKey === capabilityKey && ["ready", "deferred", "apply_failed"].includes(item.status))
    .sort((a, b) => b.revision - a.revision)[0];
  if (!proposal) return false;
  const rationale = compact(raw.rationale, 2_000);
  if (!rationale) throw new Error("Invalidation rationale is empty");
  // A correction invalidates support from the session that issued it, not
  // independent evidence from other sessions. Preserve the correction itself
  // as provenance with a distinct fingerprint.
  const remainingSupport = proposal.provenance.filter((record) => !(
    record.sessionId === analysis.sessionId
    && record.sessionPath === analysis.sessionPath
    && record.candidateFingerprint === proposal.fingerprint
  ));
  proposal.provenance = dedupeProvenance([...remainingSupport, {
    ...analysis,
    candidateFingerprint: sha256(`invalidation\0${capabilityKey}\0${rationale}`),
    evidence,
  }]);
  const independentlySupported = remainingSupport.some((record) => record.candidateFingerprint === proposal.fingerprint);
  if (!independentlySupported) {
    proposal.status = "invalidated";
    proposal.rejectionReason = rationale;
  }
  proposal.updatedAt = new Date().toISOString();
  return !independentlySupported;
}

export function invalidateSessionEvidence(state: ForgeState, sessionPath: string, reason: string): number {
  let invalidated = 0;
  for (const proposal of state.proposals) {
    // Installed and explicitly rejected revisions remain immutable audit records.
    if (proposal.status === "accepted" || proposal.status === "rejected" || proposal.status === "applying") continue;
    const remaining = proposal.provenance.filter((record) => record.sessionPath !== sessionPath);
    if (remaining.length === proposal.provenance.length) continue;
    proposal.provenance = remaining;
    proposal.updatedAt = new Date().toISOString();
    const stillSupported = remaining.some((record) => record.candidateFingerprint === proposal.fingerprint);
    if (!stillSupported) {
      proposal.status = "invalidated";
      proposal.rejectionReason = compact(reason, 2_000);
      invalidated++;
    }
  }
  return invalidated;
}

export function setScopeOverride(proposal: Proposal, scope: Scope): void {
  requireStatus(proposal, "change scope", ["ready", "deferred", "apply_failed"]);
  proposal.selectedScope = scope; proposal.updatedAt = new Date().toISOString();
}

export function editProposal(proposal: Proposal, markdown: string): void {
  requireStatus(proposal, "be edited", ["ready"]);
  const canonical = canonicalSkillMd(proposal.skillName, proposal.description, markdown);
  validateInstallableSkill(canonical, proposal.skillName);
  proposal.skillMd = canonical;
  proposal.fingerprint = proposalFingerprint(proposal);
  proposal.reviewerEditedAt = new Date().toISOString();
  proposal.updatedAt = proposal.reviewerEditedAt;
}

export function rejectProposal(proposal: Proposal, reason?: string): void {
  requireStatus(proposal, "be rejected", ["ready", "deferred", "apply_failed"]);
  proposal.status = "rejected"; proposal.rejectionReason = compact(reason ?? "", 2_000) || undefined; proposal.updatedAt = new Date().toISOString();
}

export function deferProposal(proposal: Proposal): void {
  requireStatus(proposal, "be deferred", ["ready"]);
  proposal.status = "deferred"; proposal.updatedAt = new Date().toISOString();
}

export function reopenProposal(state: ForgeState, proposal: Proposal): Proposal {
  if (proposal.status === "applying") throw new Error(`Proposal ${proposal.id} cannot be reopened while applying`);
  if (proposal.status === "accepted") {
    const revision = Math.max(...state.proposals.filter((item) => item.capabilityKey === proposal.capabilityKey).map((item) => item.revision), proposal.revision) + 1;
    const now = new Date().toISOString();
    const reopened: Proposal = { ...structuredClone(proposal), id: `forge-${sha256(`${proposal.capabilityKey}\0${proposal.fingerprint}\0${revision}`).slice(0, 14)}`, revision, status: "ready", createdAt: now, updatedAt: now };
    delete reopened.applying; delete reopened.installed; delete reopened.lastApplyError; delete reopened.rejectionReason;
    if (state.proposals.some((item) => item.id === reopened.id)) throw new Error("A reopened revision already exists");
    state.proposals.push(reopened);
    return reopened;
  }
  requireStatus(proposal, "be reopened", ["rejected", "deferred", "apply_failed"]);
  proposal.status = "ready"; delete proposal.rejectionReason; delete proposal.lastApplyError; delete proposal.applying; proposal.updatedAt = new Date().toISOString();
  return proposal;
}

export function beginApplying(proposal: Proposal, applying: ApplyingLease): void {
  requireStatus(proposal, "be accepted", ["ready"]);
  proposal.status = "applying"; proposal.applying = applying; delete proposal.lastApplyError; proposal.updatedAt = new Date().toISOString();
}

export function finishAccepted(proposal: Proposal, applying: ApplyingLease): void {
  if (proposal.status === "accepted" && proposal.installed?.contentDigest === applying.contentDigest) return;
  if (proposal.status !== "applying" || proposal.applying?.owner !== applying.owner || proposal.applying.token !== applying.token) throw new Error("Applying ownership was lost");
  proposal.status = "accepted"; proposal.selectedScope = applying.scope;
  proposal.installed = { scope: applying.scope, path: applying.path, contentDigest: applying.contentDigest, installedAt: new Date().toISOString() };
  delete proposal.applying; proposal.updatedAt = new Date().toISOString();
}

export function failApplying(proposal: Proposal, applying: ApplyingLease, message: string): void {
  if (proposal.status !== "applying" || proposal.applying?.owner !== applying.owner || proposal.applying.token !== applying.token) return;
  proposal.status = "apply_failed"; proposal.lastApplyError = compact(message, 2_000); delete proposal.applying; proposal.updatedAt = new Date().toISOString();
}

export const __testing = { normalizeCandidate, dedupeProvenance, evidenceWeightKeys, stripFrontmatter, TERMINAL, requireStatus };

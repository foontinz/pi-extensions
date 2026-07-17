import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";
import { __testing as analyzerTesting } from "../analyzer.ts";
import { canonicalSkillMd, editProposal, invalidateSessionEvidence, mergeCandidate, safeSlug, setScopeOverride, validateInstallableSkill } from "../proposals.ts";
import { __testing as storageTesting, sha256 } from "../storage.ts";
import type { AnalyzerCandidate, EvidenceRef, ForgeState } from "../types.ts";

function evidence(ref: string, sessionId: string, entryId = "same-entry", digest = sha256("digest")): EvidenceRef {
  return { ref, sessionId, sessionPath: `/sessions/${sessionId}.jsonl`, entryId, parentId: null, branchRelation: "root", timestamp: "2026-01-01T00:00:00Z", kind: "tool-success", excerpt: "tests passed", evidenceDigest: digest.length === 64 ? digest : sha256(digest) };
}

function candidate(overrides: Partial<AnalyzerCandidate> = {}): AnalyzerCandidate {
  return {
    capabilityKey: "reliable-tests",
    title: "Reliable tests",
    rationale: "Repeated successful workflow",
    confidence: 0.9,
    skillName: "reliable-tests",
    description: "Runs the project's reliable test workflow. Use when validating changes.",
    skillMd: "---\nname: ignored\ndescription: ignored\n---\n\n# Reliable tests\n\nRun the focused tests, then the full suite.",
    proposedScope: { scope: "project", rationale: "Uses repository-specific scripts", confidence: 0.88, signals: ["package scripts", "repo paths"] },
    evidenceRefs: ["r0"],
    operation: "create",
    ...overrides,
  };
}

function state(): ForgeState {
  return storageTesting.initialState("/project", "key");
}

function analysis(sessionId: string) {
  return { sessionId, sessionPath: `/sessions/${sessionId}.jsonl`, jobId: `job-${sessionId}`, analyzedAt: "2026-01-01T00:00:00Z", analyzerModel: "mock/model", analyzerPromptVersion: "v1" };
}

test("structured analyzer schema requires proposed scope with canonical value, rationale, confidence, and signals", () => {
  const tool = analyzerTesting.analyzerTool();
  const valid = { id: "call", type: "toolCall" as const, name: tool.name, arguments: { candidates: [candidate()], invalidations: [] } };
  assert.equal(validateToolArguments(tool, valid).candidates[0].proposedScope.scope, "project");
  const invalid = structuredClone(valid); invalid.arguments.candidates[0].proposedScope.scope = "global" as any;
  assert.throws(() => validateToolArguments(tool, invalid), /scope|union|Expected/i);
  const missing = structuredClone(valid) as any; delete missing.arguments.candidates[0].proposedScope.rationale;
  assert.throws(() => validateToolArguments(tool, missing));
});

test("proposal sanitization controls ids/paths/frontmatter, redacts secrets, and supports scope override/edit", () => {
  const forge = state();
  const result = mergeCandidate(forge, candidate({
    skillName: "../../My Unsafe Skill!!",
    skillMd: "# Workflow\n\nUse API_KEY=do-not-persist then run tests.",
  }), [evidence("r0", "s1")], analysis("s1"));
  const proposal = result.proposal!;
  assert.match(proposal.id, /^forge-[a-f0-9]+$/);
  assert.equal(proposal.skillName, "my-unsafe-skill");
  assert.match(proposal.skillMd, /^---\nname: my-unsafe-skill\n/);
  assert.doesNotMatch(proposal.skillMd, /do-not-persist/);
  assert.match(proposal.skillMd, /REDACTED/);
  setScopeOverride(proposal, "user");
  assert.equal(proposal.selectedScope, "user");
  editProposal(proposal, "# Edited\n\nA safe reviewed workflow.");
  assert.match(proposal.skillMd, /# Edited/);
  validateInstallableSkill(proposal.skillMd, proposal.skillName);
});

test("same capability preserves fork occurrences, dedupes evidence weight, and suppresses terminal wording without new evidence", () => {
  const forge = state();
  const first = mergeCandidate(forge, candidate(), [evidence("r0", "s1")], analysis("s1"));
  assert.equal(first.newlyReady, true);
  const forkCopy = mergeCandidate(forge, candidate(), [evidence("r0", "fork", "same-entry", "digest")], analysis("fork"));
  assert.equal(forge.proposals.length, 1);
  assert.equal(forkCopy.proposal?.provenance.flatMap((p) => p.evidence).length, 2, "fork/session occurrences remain auditable");

  first.proposal!.status = "accepted";
  const exact = mergeCandidate(forge, candidate({ title: "Different generated wording" }), [evidence("r0", "fork2", "same-entry", "digest")], analysis("fork2"));
  assert.equal(exact.suppressed, true);
  assert.equal(forge.proposals.length, 1);

  const material = mergeCandidate(forge, candidate(), [evidence("r0", "s2", "new-entry", "new-digest")], analysis("s2"));
  assert.equal(material.newlyReady, true);
  assert.equal(forge.proposals.length, 2);
  assert.equal(material.proposal?.revision, 2);
});

test("session rewrite invalidates when remaining provenance does not support the current fingerprint", () => {
  const forge = state();
  const proposal = mergeCandidate(forge, candidate(), [evidence("r0", "s1")], analysis("s1")).proposal!;
  proposal.provenance.push({
    ...analysis("s2"),
    candidateFingerprint: sha256("an-unrelated-invalidation-or-old-revision"),
    evidence: [evidence("r0", "s2", "other-entry", "other-digest")],
  });
  assert.equal(invalidateSessionEvidence(forge, "/sessions/s1.jsonl", "rewritten"), 1);
  assert.equal(proposal.status, "invalidated");
});

test("unknown/model-invented evidence references reject the whole candidate", () => {
  const forge = state();
  assert.throws(() => mergeCandidate(forge, candidate({ evidenceRefs: ["invented"] }), [evidence("r0", "s1")], analysis("s1")), /unknown evidence/);
  assert.equal(forge.proposals.length, 0);
});

test("safe skill validation rejects mismatched names and secret-bearing edited content", () => {
  const md = canonicalSkillMd("safe-name", "A safe description", "# Safe\n\nDo the work.");
  assert.deepEqual(validateInstallableSkill(md, "safe-name"), { name: "safe-name", description: "A safe description" });
  assert.throws(() => validateInstallableSkill(md, "other"), /mismatched/);
  assert.throws(() => validateInstallableSkill(md.replace("Do the work", "TOKEN=secret-value-here"), "safe-name"), /secret/);
  assert.equal(safeSlug("--A  Weird/path--"), "a-weird-path");
});

export const STATE_VERSION = 2;
export const ANALYZER_PROMPT_VERSION = "skill-forge-analyzer-v3";

export type Scope = "user" | "project";
export type InstallKind = "skill" | "prompt";
export type ProposalStatus = "ready" | "deferred" | "rejected" | "invalidated" | "applying" | "accepted" | "apply_failed";
export type JobStatus = "queued" | "leased" | "retry" | "dead";

export interface ForgeConfig {
  backgroundEnabled: boolean;
  paused: boolean;
  inventoryIntervalMs: number;
  maxRetries: number;
  maxRequestChars: number;
  maxEntriesPerChunk: number;
}

export interface FileStamp {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface EvidenceRef {
  ref: string;
  sessionId: string;
  sessionPath: string;
  entryId: string;
  parentId: string | null;
  branchRelation: "root" | "reply" | "orphan";
  timestamp: string;
  kind: string;
  excerpt: string;
  evidenceDigest: string;
}

export interface SessionWatermark {
  sessionId: string;
  path: string;
  nextEntryIndex: number;
  processedPrefixDigest: string;
  lastStamp: FileStamp;
  lastEntryCount: number;
  updatedAt: string;
}

export interface AnalysisJob {
  id: string;
  sessionId: string;
  sessionPath: string;
  startEntryIndex: number;
  endEntryIndex: number;
  rangeDigest: string;
  status: JobStatus;
  attempts: number;
  nextRunAt: number;
  createdAt: string;
  updatedAt: string;
  lease?: { owner: string; token: string; expiresAt: number };
  lastError?: string;
}

export interface ProposedScope {
  scope: Scope;
  rationale: string;
  confidence: number;
  signals: string[];
}

export interface AnalyzerInvalidation {
  capabilityKey: string;
  rationale: string;
  evidenceRefs: string[];
}

export interface ActiveProposalSummary {
  capabilityKey: string;
  title: string;
  skillName: string;
  rationale: string;
  proposedScope: Scope;
}

export interface AnalyzerCandidate {
  capabilityKey: string;
  title: string;
  rationale: string;
  confidence: number;
  skillName: string;
  description: string;
  skillMd: string;
  proposedScope: ProposedScope;
  evidenceRefs: string[];
  operation: "create" | "update";
}

export interface ProvenanceRecord {
  sessionId: string;
  sessionPath: string;
  jobId: string;
  analyzedAt: string;
  analyzerModel: string;
  analyzerPromptVersion: string;
  candidateFingerprint: string;
  evidence: EvidenceRef[];
}

export interface ApplyingLease {
  scope: Scope;
  /** Absent in states written before prompt installs existed; treat as "skill". */
  kind?: InstallKind;
  path: string;
  contentDigest: string;
  startedAt: string;
  owner: string;
  token: string;
  expiresAt: number;
}

export interface Proposal {
  id: string;
  revision: number;
  capabilityKey: string;
  fingerprint: string;
  title: string;
  rationale: string;
  confidence: number;
  skillName: string;
  description: string;
  skillMd: string;
  proposedScope: ProposedScope;
  selectedScope?: Scope;
  selectedKind?: InstallKind;
  operation: "create" | "update";
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
  provenance: ProvenanceRecord[];
  reviewerEditedAt?: string;
  rejectionReason?: string;
  applying?: ApplyingLease;
  installed?: { scope: Scope; kind?: InstallKind; path: string; contentDigest: string; installedAt: string };
  lastApplyError?: string;
}

export interface Diagnostic {
  id: string;
  at: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  sessionPath?: string;
  jobId?: string;
}

export interface ForgeState {
  version: number;
  project: { cwd: string; projectKey: string; createdAt: string; updatedAt: string };
  config: ForgeConfig;
  watermarks: Record<string, SessionWatermark>;
  jobs: AnalysisJob[];
  proposals: Proposal[];
  diagnostics: Diagnostic[];
}

export interface ParsedSession {
  sessionId: string;
  cwd: string;
  path: string;
  stamp: FileStamp;
  entries: Record<string, unknown>[];
  malformed: Array<{ line: number; digest: string; message: string }>;
}

export interface AnalysisChunk {
  sessionId: string;
  sessionPath: string;
  startEntryIndex: number;
  endEntryIndex: number;
  rangeDigest: string;
  transcript: string;
  evidence: EvidenceRef[];
}

export interface AnalyzerResult {
  candidates: AnalyzerCandidate[];
  invalidations?: AnalyzerInvalidation[];
  analyzerModel: string;
  analyzerPromptVersion: string;
}

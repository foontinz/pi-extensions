import { randomBytes } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { analyzeWithModel } from "./analyzer.ts";
import { canonicalExistingSkillNames } from "./analyzer.ts";
import { applyAnalyzerInvalidation, finishAccepted, invalidateSessionEvidence, mergeCandidate, reopenProposal } from "./proposals.ts";
import { addDiagnostic, ProjectStore, sha256 } from "./storage.ts";
import { belongsToProject, buildChunk, loadSession, prefixDigest, redactSecrets, sameFileIdentity, sameSnapshotStamp } from "./sessions.ts";
import type { ActiveProposalSummary, AnalysisChunk, AnalysisJob, AnalyzerResult, ForgeState, ParsedSession } from "./types.ts";

export type SessionListItem = { path: string; id: string; cwd: string };
export type SessionLister = (cwd: string, sessionDir: string) => Promise<SessionListItem[]>;
export type Analyzer = (ctx: ExtensionContext, chunk: AnalysisChunk, existingSkills: string[], signal?: AbortSignal, activeProposals?: ActiveProposalSummary[]) => Promise<AnalyzerResult>;

const LEASE_MS = 30 * 60_000;
const HEARTBEAT_MS = Math.floor(LEASE_MS / 3);

function nowIso(): string { return new Date().toISOString(); }
function jobId(sessionId: string, path: string, start: number, end: number, digest: string): string {
  return `job-${sha256(`${sessionId}\0${path}\0${start}\0${end}\0${digest}`).slice(0, 18)}`;
}

function activeJobFor(state: ForgeState, path: string, start: number): AnalysisJob | undefined {
  // Dead work remains durable coverage until an explicit /forge retry. Inventory
  // must never create a duplicate for the same watermark.
  return state.jobs.find((job) => job.sessionPath === path && job.startEntryIndex === start);
}

async function discoverSkillNames(root: string): Promise<string[]> {
  const names: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name === "SKILL.md") names.push(basename(dir));
    }
  }
  await walk(root, 0);
  return names;
}

export interface ForgeStatus {
  ready: number;
  queued: number;
  leased: number;
  retry: number;
  dead: number;
  sessions: number;
  paused: boolean;
  backgroundEnabled: boolean;
}

export class ForgeService {
  private worker?: Promise<void>;
  private readonly owner = `${process.pid}-${randomBytes(8).toString("hex")}`;
  private newlyReadySinceLastRead = 0;
  private loadedSkillNames: string[] = [];

  constructor(
    readonly store: ProjectStore,
    readonly agentDir: string,
    readonly projectConfigDirName: string,
    private readonly listSessions: SessionLister = (cwd, dir) => SessionManager.list(cwd, dir),
    private readonly analyzer: Analyzer = analyzeWithModel,
    private readonly isGenerationCurrent: () => boolean = () => true,
  ) {}

  setLoadedSkillNames(names: string[]): void { this.loadedSkillNames = canonicalExistingSkillNames(names); }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.recoverStaleLeases();
    await this.recoverLegacyAnalyzerProtocolFailures();
    await this.recoverApplying();
  }

  private async recoverLegacyAnalyzerProtocolFailures(): Promise<void> {
    await this.store.withLock((state) => {
      let recovered = 0;
      for (const job of state.jobs) {
        if ((job.status !== "dead" && job.status !== "retry")
          || !job.lastError?.includes("received 2 parts")) continue;
        job.status = "queued";
        job.attempts = 0;
        job.nextRunAt = Date.now();
        job.lastError = undefined;
        job.lease = undefined;
        job.updatedAt = nowIso();
        recovered++;
      }
      if (recovered) addDiagnostic(state, "info", "analyzer_protocol_recovered", `Requeued ${recovered} jobs rejected by the earlier strict thinking-block validator`);
    });
  }

  async inventory(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Promise<{ listed: number; queued: number; errors: number }> {
    let listed: SessionListItem[];
    try {
      listed = await this.listSessions(ctx.cwd, ctx.sessionManager.getSessionDir());
    } catch (error) {
      await this.store.withLock((state) => addDiagnostic(state, "error", "inventory_failed", errorMessage(error)));
      return { listed: 0, queued: 0, errors: 1 };
    }

    const snapshots: ParsedSession[] = [];
    const failures: Array<{ path: string; message: string; code: string }> = [];
    for (const item of listed) {
      try {
        const session = await loadSession(item.path);
        if (!(await belongsToProject(session, this.store.cwd))) {
          failures.push({ path: item.path, code: "other_project_excluded", message: `Listed session header belongs to another project: ${session.cwd}` });
          continue;
        }
        snapshots.push(session);
      } catch (error) {
        failures.push({ path: item.path, code: "session_unreadable", message: errorMessage(error) });
      }
    }

    let queued = 0;
    await this.store.withLock(async (state) => {
      const listedPaths = new Set(listed.map((item) => item.path));
      for (const failure of failures) addDiagnostic(state, failure.code === "other_project_excluded" ? "warning" : "error", failure.code, failure.message, { sessionPath: failure.path });
      for (const session of snapshots) {
        // A second Pi process may append and advance the durable watermark
        // after this process read its snapshot but before it acquired the state
        // lock. Never let that stale snapshot regress or invalidate newer state.
        try {
          const current = await stat(session.path);
          const currentStamp = { dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs };
          if (!sameSnapshotStamp(session.stamp, currentStamp)) {
            addDiagnostic(state, "info", "snapshot_stale", "Session changed before inventory commit; a later pass will use a fresh snapshot", { sessionPath: session.path });
            continue;
          }
        } catch (error) {
          addDiagnostic(state, "warning", "snapshot_disappeared", `Session disappeared before inventory commit: ${errorMessage(error)}`, { sessionPath: session.path });
          continue;
        }
        for (const malformed of session.malformed.slice(0, 10)) {
          addDiagnostic(state, "warning", "malformed_jsonl_line", `Ignored malformed JSONL line ${malformed.line} (${malformed.digest.slice(0, 12)}): ${malformed.message}`, { sessionPath: session.path });
        }
        const previous = state.watermarks[session.path];
        let start = previous?.nextEntryIndex ?? 0;
        const replaced = previous && (!sameFileIdentity(previous.lastStamp, session.stamp) || session.stamp.size < previous.lastStamp.size);
        const changedPrefix = previous && prefixDigest(session.entries, Math.min(start, session.entries.length)) !== previous.processedPrefixDigest;
        if (previous && (previous.sessionId !== session.sessionId || start > session.entries.length || replaced || changedPrefix)) {
          state.jobs = state.jobs.filter((job) => job.sessionPath !== session.path);
          const invalidated = invalidateSessionEvidence(
            state,
            session.path,
            "Supporting session history was replaced, removed, or rewritten; a fresh analysis is required.",
          );
          start = 0;
          addDiagnostic(
            state,
            "warning",
            "session_replayed",
            `Session was replaced, shrank, or rewrote analyzed history; scheduling a safe full replay${invalidated ? ` and invalidating ${invalidated} unsupported proposal(s)` : ""}`,
            { sessionPath: session.path },
          );
        }
        state.watermarks[session.path] = {
          sessionId: session.sessionId,
          path: session.path,
          nextEntryIndex: start,
          processedPrefixDigest: prefixDigest(session.entries, start),
          lastStamp: session.stamp,
          lastEntryCount: session.entries.length,
          updatedAt: nowIso(),
        };
        if (start < session.entries.length && !activeJobFor(state, session.path, start)) {
          const chunk = buildChunk(session, start, state.config.maxRequestChars, state.config.maxEntriesPerChunk);
          if (chunk) {
            const now = nowIso();
            const id = jobId(session.sessionId, session.path, chunk.startEntryIndex, chunk.endEntryIndex, chunk.rangeDigest);
            if (state.jobs.some((job) => job.id === id)) continue;
            state.jobs.push({
              id,
              sessionId: session.sessionId,
              sessionPath: session.path,
              startEntryIndex: chunk.startEntryIndex,
              endEntryIndex: chunk.endEntryIndex,
              rangeDigest: chunk.rangeDigest,
              status: "queued",
              attempts: 0,
              nextRunAt: Date.now(),
              createdAt: now,
              updatedAt: now,
            });
            queued++;
          }
        }
      }
      // A removed session can no longer support an installable proposal. Keep
      // accepted audit records immutable, invalidate unsupported drafts, and
      // discard obsolete work. Reappearance will trigger a full fresh replay.
      for (const path of Object.keys(state.watermarks)) {
        if (listedPaths.has(path)) continue;
        const invalidated = invalidateSessionEvidence(state, path, "Supporting session is no longer present in the current project session inventory.");
        state.jobs = state.jobs.filter((job) => job.sessionPath !== path);
        delete state.watermarks[path];
        addDiagnostic(state, "warning", "session_missing", `Previously inventoried session is no longer listed${invalidated ? `; invalidated ${invalidated} unsupported proposal(s)` : ""}`, { sessionPath: path });
      }
    });
    return { listed: listed.length, queued, errors: failures.length };
  }

  kick(ctx: ExtensionContext, signal: AbortSignal, force = false): Promise<void> {
    if (this.worker) return this.worker;
    const work = this.workerLoop(ctx, signal, force).finally(() => { if (this.worker === work) this.worker = undefined; });
    this.worker = work;
    return work;
  }

  async drain(): Promise<void> { await this.worker; }

  private async workerLoop(ctx: ExtensionContext, signal: AbortSignal, force: boolean): Promise<void> {
    while (!signal.aborted && this.isGenerationCurrent()) {
      const claimed = await this.claim(force);
      if (!claimed) return;
      const callController = new AbortController();
      const abortCall = () => callController.abort(signal.reason);
      signal.addEventListener("abort", abortCall, { once: true });
      const heartbeat = this.startHeartbeat(claimed, callController);
      let heartbeatStopped = false;
      const stopHeartbeat = () => { if (!heartbeatStopped) { heartbeatStopped = true; clearInterval(heartbeat); } };
      try {
        const session = await loadSession(claimed.sessionPath);
        const config = (await this.store.read()).config;
        const chunk = buildChunk(session, claimed.startEntryIndex, config.maxRequestChars, config.maxEntriesPerChunk);
        if (!chunk || chunk.endEntryIndex !== claimed.endEntryIndex || chunk.rangeDigest !== claimed.rangeDigest || session.sessionId !== claimed.sessionId) {
          stopHeartbeat();
          await this.invalidateClaim(claimed, "Session changed before analysis; replay will be re-inventoried");
          await this.inventory(ctx);
          continue;
        }
        const fallback = this.loadedSkillNames.length ? [] : [
          ...(await discoverSkillNames(join(this.agentDir, "skills"))),
          ...(await discoverSkillNames(join(this.store.cwd, this.projectConfigDirName, "skills"))),
        ];
        const existing = canonicalExistingSkillNames([...this.loadedSkillNames, ...fallback]);
        const activeProposals: ActiveProposalSummary[] = (await this.store.read()).proposals
          .filter((proposal) => ["ready", "deferred", "apply_failed"].includes(proposal.status)
            && proposal.provenance.some((record) => record.sessionId === chunk.sessionId && record.candidateFingerprint === proposal.fingerprint))
          .slice(-100)
          .map((proposal) => ({
            capabilityKey: proposal.capabilityKey,
            title: proposal.title,
            skillName: proposal.skillName,
            rationale: proposal.rationale,
            proposedScope: proposal.selectedScope ?? proposal.proposedScope.scope,
          }));
        const result = await this.analyzer(ctx, chunk, existing, callController.signal, activeProposals);
        stopHeartbeat(); // No renewal may race commit/release.
        if (signal.aborted || callController.signal.aborted || !this.isGenerationCurrent()) {
          await this.releaseWithoutFailure(claimed);
          return;
        }
        const verify = await loadSession(claimed.sessionPath);
        // Rebuild with the exact request bounds. The chunk digest includes the
        // preceding/following overlap shown to the analyzer, not only the
        // primary watermark range.
        const verifiedChunk = buildChunk(verify, claimed.startEntryIndex, config.maxRequestChars, config.maxEntriesPerChunk);
        const durableBeforeCommit = await this.store.read();
        const durableWatermark = durableBeforeCommit.watermarks[claimed.sessionPath];
        const priorPrefixChanged = !durableWatermark
          || durableWatermark.sessionId !== claimed.sessionId
          || durableWatermark.nextEntryIndex !== claimed.startEntryIndex
          || prefixDigest(verify.entries, claimed.startEntryIndex) !== durableWatermark.processedPrefixDigest;
        if (priorPrefixChanged || !verifiedChunk || verifiedChunk.endEntryIndex !== claimed.endEntryIndex || verifiedChunk.rangeDigest !== claimed.rangeDigest) {
          await this.invalidateClaim(claimed, "Session history or analyzer context changed during analysis; validated output was discarded and the full session will replay");
          await this.inventory(ctx);
          continue;
        }
        await this.commit(claimed, verify, chunk, result);
        // Inventory immediately; trigger-level notification occurs only after all
        // currently persisted corrections and following chunks are caught up.
        await this.inventory(ctx);
      } catch (error) {
        stopHeartbeat();
        if (signal.aborted || !this.isGenerationCurrent() || isAbort(error)) {
          await this.releaseWithoutFailure(claimed);
          return;
        }
        await this.fail(claimed, error);
      } finally {
        stopHeartbeat();
        signal.removeEventListener("abort", abortCall);
      }
    }
  }

  private startHeartbeat(job: AnalysisJob, controller: AbortController): NodeJS.Timeout {
    const timer = setInterval(() => {
      void this.renewLease(job).then((renewed) => { if (!renewed) controller.abort(new Error("Analysis lease ownership was lost")); }).catch(() => controller.abort(new Error("Analysis lease heartbeat failed")));
    }, HEARTBEAT_MS);
    timer.unref();
    return timer;
  }

  async renewLease(job: AnalysisJob): Promise<boolean> {
    return this.store.withLock((state) => {
      const durable = state.jobs.find((item) => item.id === job.id);
      if (!sameLease(durable, job)) return false;
      durable!.lease!.expiresAt = Date.now() + LEASE_MS;
      durable!.updatedAt = nowIso();
      return true;
    });
  }

  private async claim(force: boolean): Promise<AnalysisJob | undefined> {
    return this.store.withLock((state) => {
      const now = Date.now();
      for (const job of state.jobs) {
        if (job.status === "leased" && (job.lease?.expiresAt ?? 0) <= now) {
          job.status = "retry";
          job.nextRunAt = now;
          job.lease = undefined;
          job.lastError = "Recovered stale analysis lease after process exit or timeout";
          addDiagnostic(state, "warning", "stale_lease_recovered", job.lastError, { jobId: job.id, sessionPath: job.sessionPath });
        }
      }
      if (!force && (!state.config.backgroundEnabled || state.config.paused)) return undefined;
      if (state.jobs.some((job) => job.status === "leased")) return undefined;
      const job = state.jobs
        .filter((candidate) => (candidate.status === "queued" || candidate.status === "retry") && candidate.nextRunAt <= now)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.startEntryIndex - b.startEntryIndex)[0];
      if (!job) return undefined;
      const token = randomBytes(12).toString("hex");
      job.status = "leased";
      job.attempts++;
      job.updatedAt = nowIso();
      job.lease = { owner: this.owner, token, expiresAt: now + LEASE_MS };
      return structuredClone(job);
    });
  }

  private async commit(job: AnalysisJob, session: ParsedSession, chunk: AnalysisChunk, result: AnalyzerResult): Promise<void> {
    await this.store.withLock((state) => {
      const durable = state.jobs.find((item) => item.id === job.id);
      if (!sameLease(durable, job)) return;
      // Deterministic sanitization and evidence validation happen before the watermark moves.
      const analysis = {
        sessionId: chunk.sessionId,
        sessionPath: chunk.sessionPath,
        jobId: job.id,
        analyzedAt: nowIso(),
        analyzerModel: result.analyzerModel,
        analyzerPromptVersion: result.analyzerPromptVersion,
      };
      for (const invalidation of result.invalidations ?? []) {
        applyAnalyzerInvalidation(state, invalidation, chunk.evidence, analysis);
      }
      let newReady = 0;
      for (const candidate of result.candidates) {
        const merged = mergeCandidate(state, candidate, chunk.evidence, analysis);
        if (merged.newlyReady) newReady++;
      }
      const watermark = state.watermarks[job.sessionPath];
      if (!watermark || watermark.sessionId !== job.sessionId || watermark.nextEntryIndex !== job.startEntryIndex) {
        throw new Error("Watermark changed before analysis commit");
      }
      watermark.nextEntryIndex = job.endEntryIndex;
      watermark.processedPrefixDigest = prefixDigest(session.entries, job.endEntryIndex);
      watermark.lastStamp = session.stamp;
      watermark.lastEntryCount = session.entries.length;
      watermark.updatedAt = nowIso();
      state.jobs = state.jobs.filter((item) => item.id !== job.id);
      this.newlyReadySinceLastRead += newReady;
    });
  }

  private async fail(job: AnalysisJob, error: unknown): Promise<void> {
    await this.store.withLock((state) => {
      const durable = state.jobs.find((item) => item.id === job.id);
      if (!sameLease(durable, job)) return;
      const message = redactSecrets(errorMessage(error));
      durable!.lastError = message.slice(0, 2_000);
      durable!.lease = undefined;
      durable!.updatedAt = nowIso();
      if (durable!.attempts >= state.config.maxRetries) {
        durable!.status = "dead";
        addDiagnostic(state, "error", "job_dead", `Analysis exhausted ${durable!.attempts} attempts: ${message}`, { jobId: job.id, sessionPath: job.sessionPath });
      } else {
        durable!.status = "retry";
        durable!.nextRunAt = Date.now() + Math.min(5_000 * 2 ** (durable!.attempts - 1), 5 * 60_000);
        addDiagnostic(state, "warning", "job_retry", `Analysis attempt ${durable!.attempts} failed and will retry: ${message}`, { jobId: job.id, sessionPath: job.sessionPath });
      }
    });
  }

  private async invalidateClaim(job: AnalysisJob, message: string): Promise<void> {
    await this.store.withLock((state) => {
      const durable = state.jobs.find((item) => item.id === job.id);
      if (sameLease(durable, job)) state.jobs = state.jobs.filter((item) => item.id !== job.id);
      const unsupported = invalidateSessionEvidence(state, job.sessionPath, message);
      const watermark = state.watermarks[job.sessionPath];
      if (watermark) {
        watermark.nextEntryIndex = 0;
        watermark.processedPrefixDigest = prefixDigest([], 0);
      }
      addDiagnostic(state, "warning", "snapshot_invalidated", `${message}${unsupported ? `; invalidated ${unsupported} unsupported proposal(s)` : ""}`, { jobId: job.id, sessionPath: job.sessionPath });
    });
  }

  private async releaseWithoutFailure(job: AnalysisJob): Promise<void> {
    await this.store.withLock((state) => {
      const durable = state.jobs.find((item) => item.id === job.id);
      if (!sameLease(durable, job)) return;
      durable!.status = "queued";
      durable!.attempts = Math.max(0, durable!.attempts - 1);
      durable!.nextRunAt = Date.now();
      durable!.lease = undefined;
      durable!.updatedAt = nowIso();
    });
  }

  async recoverStaleLeases(): Promise<void> {
    await this.store.withLock((state) => {
      for (const job of state.jobs) {
        if (job.status !== "leased") continue;
        const pid = Number.parseInt(job.lease?.owner.split("-")[0] ?? "", 10);
        if ((job.lease?.expiresAt ?? 0) > Date.now() && processAlive(pid)) continue;
        job.status = "retry";
        job.nextRunAt = Date.now();
        job.lease = undefined;
        job.lastError = "Recovered stale analysis lease at session startup";
        addDiagnostic(state, "warning", "startup_lease_recovered", job.lastError, { jobId: job.id, sessionPath: job.sessionPath });
      }
    });
  }

  async retry(id: string | "all"): Promise<number> {
    return this.store.withLock((state) => {
      let count = 0;
      for (const job of state.jobs) {
        if (id !== "all" && job.id !== id && !job.id.startsWith(id)) continue;
        if (job.status === "dead" || job.status === "retry") {
          job.status = "queued";
          job.attempts = 0;
          job.nextRunAt = Date.now();
          job.lastError = undefined;
          count++;
        }
      }
      for (const proposal of [...state.proposals]) {
        if (id !== "all" && proposal.id !== id && !proposal.id.startsWith(id)) continue;
        if (proposal.status === "apply_failed") { reopenProposal(state, proposal); count++; }
      }
      return count;
    });
  }

  async status(): Promise<ForgeStatus> {
    const state = await this.store.read();
    return {
      ready: state.proposals.filter((proposal) => proposal.status === "ready").length,
      queued: state.jobs.filter((job) => job.status === "queued").length,
      leased: state.jobs.filter((job) => job.status === "leased").length,
      retry: state.jobs.filter((job) => job.status === "retry").length,
      dead: state.jobs.filter((job) => job.status === "dead").length,
      sessions: Object.keys(state.watermarks).length,
      paused: state.config.paused,
      backgroundEnabled: state.config.backgroundEnabled,
    };
  }

  takeNewReadyCount(): number { const count = this.newlyReadySinceLastRead; this.newlyReadySinceLastRead = 0; return count; }

  private async recoverApplying(): Promise<void> {
    await this.store.withLock(async (state) => {
      for (const proposal of state.proposals) {
        if (proposal.status !== "applying" || !proposal.applying) continue;
        const applying = proposal.applying;
        const pid = Number.parseInt(applying.owner.split("-")[0] ?? "", 10);
        if (applying.expiresAt > Date.now() && processAlive(pid)) continue;
        try {
          const kindDir = (applying.kind ?? "skill") === "prompt" ? "prompts" : "skills";
          const root = resolve(applying.scope === "project"
            ? join(this.store.cwd, this.projectConfigDirName, kindDir)
            : join(this.agentDir, kindDir));
          const expectedPath = (applying.kind ?? "skill") === "prompt" ? resolve(root, `${proposal.skillName}.md`) : resolve(root, proposal.skillName, "SKILL.md");
          if (resolve(applying.path) !== expectedPath) throw new Error("Applying path does not match its recorded scope and skill name");
          const value = await lstat(expectedPath);
          if (value.isSymbolicLink() || !value.isFile()) throw new Error("Applying destination is not a regular non-symlink file");
          const canonicalRoot = await realpath(root);
          const canonicalPath = await realpath(expectedPath);
          const rel = relative(canonicalRoot, canonicalPath);
          if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Applying destination resolves outside its scope root");
          const content = await readFile(expectedPath, "utf8");
          if (sha256(content) === applying.contentDigest) { finishAccepted(proposal, applying); continue; }
        } catch { /* missing, unsafe, or unreadable destination */ }
        proposal.status = "apply_failed";
        proposal.applying = undefined;
        proposal.lastApplyError = "Recovered expired/interrupted apply before a matching atomic installation was visible";
        addDiagnostic(state, "error", "apply_recovery_failed", proposal.lastApplyError, { jobId: proposal.id });
      }
    });
  }
}

function sameLease(durable: AnalysisJob | undefined, claimed: AnalysisJob): boolean {
  return Boolean(durable && durable.status === "leased" && durable.lease?.owner === claimed.lease?.owner && durable.lease?.token === claimed.lease?.token);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError" || (error instanceof Error && /aborted/i.test(error.message));
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export const __testing = { jobId, activeJobFor, discoverSkillNames, sameLease, processAlive, LEASE_MS, HEARTBEAT_MS };

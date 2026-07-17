import { getAgentDir, CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyInstall, prepareInstall, type InstallOptions } from "./install.ts";
import { deferProposal, editProposal, rejectProposal, reopenProposal, setScopeOverride } from "./proposals.ts";
import { ForgeService, type ForgeStatus } from "./service.ts";
import { ProjectStore, projectStateDir, sha256 } from "./storage.ts";
import type { Proposal, Scope } from "./types.ts";

interface Runtime {
  generation: number;
  sessionId: string;
  ctx: ExtensionContext;
  controller: AbortController;
  service?: ForgeService;
  initialized: Promise<void>;
  timer?: NodeJS.Timeout;
  trigger?: Promise<void>;
  rerun: boolean;
  force: boolean;
  lastNotificationAt: number;
  loadedSkillNames: string[];
}

export function renderStatus(status: ForgeStatus, width = 80): string {
  const activity = status.leased ? `${status.leased} analyzing` : status.retry ? `${status.retry} retry` : status.dead ? `${status.dead} dead` : status.queued ? `${status.queued} queued` : "caught up";
  const mode = status.paused ? "PAUSED" : status.backgroundEnabled ? "on" : "manual";
  const text = `forge ${status.ready} ready · ${activity} · ${mode}`;
  if (width <= 0) return "";
  return text.length <= width ? text : width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

function output(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message.slice(0, 8_000), level);
  else if (ctx.mode === "json") process.stderr.write(`${message}\n`);
  else process.stdout.write(`${message}\n`);
}

function proposalSummary(proposal: Proposal): string {
  const scope = proposal.selectedScope ?? proposal.proposedScope.scope;
  return `${proposal.id} [${proposal.status}] ${proposal.title} (${proposal.skillName}, ${scope}, ${(proposal.confidence * 100).toFixed(0)}%)`;
}

function proposalMetadata(proposal: Proposal): string {
  const provenance = proposal.provenance.flatMap((record) => record.evidence.map((evidence) =>
    `- ${record.sessionId} ${evidence.entryId} parent=${evidence.parentId ?? "root"} ${evidence.timestamp} ${evidence.kind}\n  ${evidence.sessionPath}\n  evidence=${evidence.evidenceDigest} candidate=${record.candidateFingerprint}\n  ${evidence.excerpt}`));
  return [
    proposalSummary(proposal),
    `Capability: ${proposal.capabilityKey} (${proposal.operation})`,
    `Rationale: ${proposal.rationale}`,
    `PROPOSED SCOPE: ${proposal.proposedScope.scope}`,
    `Scope rationale: ${proposal.proposedScope.rationale}`,
    `Scope confidence: ${(proposal.proposedScope.confidence * 100).toFixed(0)}%`,
    `Scope signals: ${proposal.proposedScope.signals.join("; ")}`,
    `Reviewer override: ${proposal.selectedScope ?? "none"}`,
    `Content digest: ${sha256(proposal.skillMd)}`,
    `Analyzer provenance: ${proposal.provenance.map((p) => `${p.analyzerModel}/${p.analyzerPromptVersion}`).join(", ")}`,
    "", "Evidence:", provenance.join("\n") || "none",
  ].join("\n");
}
function proposalDetail(proposal: Proposal): string { return `${proposalMetadata(proposal)}\n\nSKILL.md:\n${proposal.skillMd}`; }

function resolveProposal(proposals: Proposal[], id: string): Proposal {
  const matches = proposals.filter((proposal) => proposal.id === id || proposal.id.startsWith(id));
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous proposal id: ${id}` : `Unknown proposal id: ${id}`);
  return matches[0]!;
}

function contextSessionId(ctx: ExtensionContext): string {
  try { const id = ctx.sessionManager.getSessionId(); if (id) return id; } catch { /* test/legacy context */ }
  let file = "";
  try { file = ctx.sessionManager.getSessionFile?.() ?? ""; } catch { /* ignored */ }
  return `${ctx.cwd}\0${file}`;
}

export default function skillForge(pi: ExtensionAPI) {
  let generation = 0;
  let runtime: Runtime | undefined;

  const isCurrent = (candidate: Runtime) => candidate.generation === generation && runtime?.generation === candidate.generation
    && runtime.sessionId === candidate.sessionId && !candidate.controller.signal.aborted;
  const adoptContext = (candidate: Runtime, ctx: ExtensionContext): boolean => {
    if (!isCurrent(candidate) || contextSessionId(ctx) !== candidate.sessionId) return false;
    candidate.ctx = ctx; // Pi intentionally creates a fresh context per event.
    return true;
  };

  const refreshUi = async (candidate: Runtime): Promise<void> => {
    if (!isCurrent(candidate) || !candidate.service) return;
    const status = await candidate.service.status();
    if (!isCurrent(candidate) || !candidate.ctx.hasUI) return;
    candidate.ctx.ui.setStatus("skill-forge", renderStatus(status, 54));
    const newlyReady = candidate.service.takeNewReadyCount();
    if (newlyReady > 0 && Date.now() - candidate.lastNotificationAt > 30_000) {
      candidate.lastNotificationAt = Date.now();
      candidate.ctx.ui.notify(`${Math.min(newlyReady, 99)} new Skill Forge proposal${newlyReady === 1 ? " is" : "s are"} ready. Run /forge.`, "info");
    }
  };

  const trigger = (candidate: Runtime, options: { inventory?: boolean; force?: boolean } = {}): Promise<void> => {
    if (!isCurrent(candidate)) return Promise.resolve();
    candidate.rerun ||= options.inventory !== false; candidate.force ||= options.force === true;
    if (candidate.trigger) return candidate.trigger;
    const task = (async () => {
      await candidate.initialized;
      if (!isCurrent(candidate) || !candidate.service) return;
      do {
        const shouldInventory = candidate.rerun; const force = candidate.force;
        candidate.rerun = false; candidate.force = false;
        if (shouldInventory) await candidate.service.inventory(candidate.ctx);
        if (!isCurrent(candidate)) return;
        await candidate.service.kick(candidate.ctx, candidate.controller.signal, force);
      } while (isCurrent(candidate) && candidate.rerun);
      await refreshUi(candidate);
    })().catch(async (error) => {
      if (isCurrent(candidate)) {
        output(candidate.ctx, `Skill Forge background error: ${error instanceof Error ? error.message : String(error)}`, "error");
        await refreshUi(candidate).catch(() => undefined);
      }
    }).finally(() => { if (candidate.trigger === task) candidate.trigger = undefined; });
    candidate.trigger = task;
    return task;
  };

  pi.on("session_start", (_event, ctx) => {
    const currentGeneration = ++generation;
    runtime?.controller.abort(); if (runtime?.timer) clearInterval(runtime.timer);
    const controller = new AbortController();
    const candidate: Runtime = {
      generation: currentGeneration, sessionId: contextSessionId(ctx), ctx, controller,
      initialized: Promise.resolve(), rerun: false, force: false, lastNotificationAt: 0, loadedSkillNames: [],
    };
    // Publish pending ownership synchronously, before canonicalProject's first await.
    runtime = candidate;
    candidate.initialized = (async () => {
      const location = await projectStateDir(getAgentDir(), ctx.cwd);
      if (!isCurrent(candidate)) return;
      const service = new ForgeService(new ProjectStore(location.dir, location.cwd, location.key), getAgentDir(), CONFIG_DIR_NAME, undefined, undefined, () => isCurrent(candidate));
      candidate.service = service;
      service.setLoadedSkillNames(candidate.loadedSkillNames);
      await service.initialize();
      if (!isCurrent(candidate)) return;
      const state = await service.store.read();
      if (!isCurrent(candidate)) return;
      candidate.timer = setInterval(() => { if (isCurrent(candidate)) void trigger(candidate, { inventory: true }); }, Math.max(10_000, state.config.inventoryIntervalMs));
      candidate.timer.unref();
      await refreshUi(candidate);
      if (isCurrent(candidate)) void trigger(candidate, { inventory: true });
    })();
    return candidate.initialized.catch((error) => { if (isCurrent(candidate)) output(candidate.ctx, `Skill Forge failed to start: ${error instanceof Error ? error.message : String(error)}`, "error"); });
  });

  const onSessionActivity = (_value: unknown, ctx: ExtensionContext) => { const candidate = runtime; if (candidate && adoptContext(candidate, ctx)) void trigger(candidate, { inventory: true }); };
  pi.on("agent_settled", onSessionActivity);
  pi.on("session_compact", onSessionActivity);
  pi.on("session_tree", onSessionActivity);
  pi.on("before_agent_start", (event, ctx) => {
    const candidate = runtime;
    if (!candidate || !adoptContext(candidate, ctx)) return;
    candidate.loadedSkillNames = (event.systemPromptOptions.skills ?? []).map((skill) => skill.name);
    candidate.service?.setLoadedSkillNames(candidate.loadedSkillNames);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const candidate = runtime;
    if (!candidate || contextSessionId(ctx) !== candidate.sessionId) return;
    ++generation; // Invalidates this session, including pending startup.
    candidate.ctx = ctx;
    candidate.controller.abort(); if (candidate.timer) clearInterval(candidate.timer);
    await candidate.initialized.catch(() => undefined);
    if (candidate.service) await Promise.race([candidate.service.drain().catch(() => undefined), new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))]);
    if (ctx.hasUI) ctx.ui.setStatus("skill-forge", undefined);
    if (runtime?.generation === candidate.generation && runtime.sessionId === candidate.sessionId) runtime = undefined;
  });

  const getRuntime = async (ctx: ExtensionContext): Promise<Runtime> => {
    const candidate = runtime;
    if (!candidate || !adoptContext(candidate, ctx)) throw new Error("Skill Forge belongs to another session or is shutting down");
    await candidate.initialized;
    if (!adoptContext(candidate, ctx) || !candidate.service) throw new Error("Skill Forge is still starting or this session is shutting down; try again shortly");
    if ("getSystemPromptOptions" in ctx) {
      const skills = (ctx as ExtensionCommandContext).getSystemPromptOptions().skills ?? [];
      candidate.loadedSkillNames = skills.map((skill) => skill.name); candidate.service.setLoadedSkillNames(candidate.loadedSkillNames);
    }
    return candidate;
  };

  const installOptions = (candidate: Runtime, ctx: ExtensionCommandContext): InstallOptions => ({ projectCwd: candidate.service!.store.cwd, agentDir: getAgentDir(), configDirName: CONFIG_DIR_NAME, projectTrusted: ctx.isProjectTrusted() });
  const accept = async (candidate: Runtime, proposal: Proposal, requestedScope: Scope | undefined, ctx: ExtensionCommandContext): Promise<boolean> => {
    if (!ctx.hasUI) throw new Error("Acceptance requires an interactive UI so exact scope, digest, and SKILL.md content can be reviewed and confirmed");
    // Reconcile all newly persisted corrections before showing the final
    // confirmation. Refuse acceptance while any supporting session still has
    // unfinished/dead analysis work.
    await trigger(candidate, { inventory: true });
    const latestState = await candidate.service!.store.read();
    proposal = resolveProposal(latestState.proposals, proposal.id);
    if (proposal.status !== "ready") throw new Error(`Proposal ${proposal.id} is no longer ready after session reconciliation (${proposal.status})`);
    const supportingPaths = new Set(proposal.provenance
      .filter((record) => record.candidateFingerprint === proposal.fingerprint)
      .map((record) => record.sessionPath));
    const unfinished = latestState.jobs.filter((job) => supportingPaths.has(job.sessionPath));
    if (unfinished.length) throw new Error(`Proposal evidence is not fully analyzed (${unfinished.length} supporting job(s) queued/retrying/dead); resolve /forge doctor and /forge retry before acceptance`);
    const scope = requestedScope ?? proposal.selectedScope ?? proposal.proposedScope.scope;
    const options = installOptions(candidate, ctx);
    const plan = await prepareInstall(proposal, scope, options);
    const exact = await ctx.ui.confirm("Confirm exact Skill Forge installation", `Scope: ${scope}\nTarget: ${plan.path}\nSHA-256: ${plan.contentDigest}\n\nExact SKILL.md:\n${plan.content}`);
    if (!exact) { output(ctx, "Acceptance cancelled; proposal remains ready."); return false; }
    let collisionConfirmed = false;
    if (plan.collision === "different") {
      collisionConfirmed = await ctx.ui.confirm("Overwrite reviewed existing skill?", `Skill Forge will atomically replace ${plan.path}.\n\n${plan.diff}`);
      if (!collisionConfirmed) { output(ctx, "Acceptance cancelled; proposal remains ready."); return false; }
    }
    await applyInstall(candidate.service!.store, plan, collisionConfirmed, options);
    output(ctx, `Accepted ${proposal.id} as ${scope}: ${plan.path}`);
    await refreshUi(candidate);
    if (await ctx.ui.confirm("Reload skills?", "Reload Pi resources now so the accepted skill is available?")) { await ctx.reload(); return true; }
    return false;
  };

  const reviewInbox = async (candidate: Runtime, ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      const ready = (await candidate.service!.store.read()).proposals.filter((proposal) => proposal.status === "ready");
      output(ctx, ready.length ? ready.map(proposalSummary).join("\n") : "Skill Forge inbox is empty."); return;
    }
    while (isCurrent(candidate)) {
      const ready = (await candidate.service!.store.read()).proposals.filter((proposal) => proposal.status === "ready");
      if (!ready.length) { output(ctx, "Skill Forge inbox is empty."); return; }
      const choice = await ctx.ui.select("Skill Forge inbox", ready.map(proposalSummary)); if (!choice) return;
      let proposal = ready.find((item) => proposalSummary(item) === choice); if (!proposal) return;
      // Metadata is displayed separately; the editor buffer contains only SKILL.md.
      output(ctx, proposalMetadata(proposal));
      const reviewed = await ctx.ui.editor(`Review ${proposal.id} — SKILL.md only`, proposal.skillMd);
      if (reviewed === undefined) return;
      if (reviewed.trim() !== proposal.skillMd.trim()) await candidate.service!.store.withLock((fresh) => editProposal(resolveProposal(fresh.proposals, proposal!.id), reviewed));
      proposal = resolveProposal((await candidate.service!.store.read()).proposals, proposal.id);
      const action = await ctx.ui.select("Review action", [`accept (${proposal.selectedScope ?? proposal.proposedScope.scope})`, "accept as user", "accept as project", "set scope user", "set scope project", "reject", "defer", "back"]);
      if (!action || action === "back") continue;
      if (action.startsWith("set scope ")) { const scope = action.endsWith("user") ? "user" : "project"; await candidate.service!.store.withLock((fresh) => setScopeOverride(resolveProposal(fresh.proposals, proposal!.id), scope)); continue; }
      if (action === "reject") { const reason = await ctx.ui.input("Rejection reason", "optional"); await candidate.service!.store.withLock((fresh) => rejectProposal(resolveProposal(fresh.proposals, proposal!.id), reason)); continue; }
      if (action === "defer") { await candidate.service!.store.withLock((fresh) => deferProposal(resolveProposal(fresh.proposals, proposal!.id))); continue; }
      const scope = action === "accept as user" ? "user" : action === "accept as project" ? "project" : undefined;
      if (await accept(candidate, proposal, scope, ctx)) return;
    }
  };

  const commandHandler = async (rawArgs: string, ctx: ExtensionCommandContext): Promise<void> => {
    try {
      const candidate = await getRuntime(ctx); const service = candidate.service!; const args = rawArgs.trim();
      if (!args) { await reviewInbox(candidate, ctx); return; }
      const [command, id, third, ...rest] = args.split(/\s+/);
      if (command === "status") {
        const status = await service.status(); output(ctx, `${renderStatus(status)}\nBackground paused: ${status.paused ? "YES" : "no"}; enabled: ${status.backgroundEnabled ? "yes" : "no"}\nSessions: ${status.sessions}; jobs queued/leased/retry/dead: ${status.queued}/${status.leased}/${status.retry}/${status.dead}\nState: ${service.store.statePath}`); return;
      }
      if (command === "sync" || command === "analyze") { await trigger(candidate, { inventory: true, force: command === "analyze" }); output(ctx, command === "sync" ? "Skill Forge inventory synchronized." : "Skill Forge analysis queue drained as far as currently runnable."); return; }
      if (command === "pause" || command === "resume") {
        await service.store.withLock((state) => { state.config.paused = command === "pause"; });
        if (command === "resume") await trigger(candidate, { inventory: true }); await refreshUi(candidate);
        output(ctx, `Skill Forge background analysis ${command === "pause" ? "PAUSED" : "resumed"}.`); return;
      }
      if (command === "retry") { const count = await service.retry((id || "all") as string | "all"); await trigger(candidate, { inventory: true, force: true }); output(ctx, `Reset ${count} failed item${count === 1 ? "" : "s"}.`); return; }
      const state = await service.store.read();
      if (command === "doctor") {
        const diagnostics = state.diagnostics.slice(-30).map((item) => `${item.at} ${item.severity} ${item.code}: ${item.message}${item.sessionPath ? ` (${item.sessionPath})` : ""}`);
        output(ctx, ["Skill Forge doctor", `Project: ${state.project.cwd}`, `State: ${service.store.statePath}`, `Background: ${state.config.paused ? "PAUSED" : state.config.backgroundEnabled ? "enabled" : "manual"}`, `Sessions: ${Object.keys(state.watermarks).length}`, `Jobs: ${state.jobs.length}`, `Proposals: ${state.proposals.length}`, "Recent diagnostics:", diagnostics.join("\n") || "none"].join("\n")); return;
      }
      if (!id) throw new Error(`/forge ${command} requires a proposal id`);
      const proposal = resolveProposal(state.proposals, id);
      if (command === "inspect") { output(ctx, proposalDetail(proposal)); return; }
      if (command === "edit") {
        if (!ctx.hasUI) throw new Error("/forge edit requires a UI editor");
        const markdown = await ctx.ui.editor(`Edit ${proposal.id} SKILL.md`, proposal.skillMd); if (markdown === undefined) { output(ctx, "Edit cancelled."); return; }
        await service.store.withLock((fresh) => editProposal(resolveProposal(fresh.proposals, id), markdown)); await refreshUi(candidate); output(ctx, `Edited ${proposal.id}; it remains uninstalled until explicit acceptance.`); return;
      }
      if (command === "accept") { const scope = third as Scope | undefined; if (scope !== undefined && scope !== "user" && scope !== "project") throw new Error("Scope must be user or project"); await accept(candidate, proposal, scope, ctx); return; }
      if (command === "reject") { const reason = [third, ...rest].filter(Boolean).join(" "); await service.store.withLock((fresh) => rejectProposal(resolveProposal(fresh.proposals, id), reason)); }
      else if (command === "defer") await service.store.withLock((fresh) => deferProposal(resolveProposal(fresh.proposals, id)));
      else if (command === "reopen") await service.store.withLock((fresh) => { reopenProposal(fresh, resolveProposal(fresh.proposals, id)); });
      else if (command === "scope") { if (third !== "user" && third !== "project") throw new Error("Scope must be user or project"); await service.store.withLock((fresh) => setScopeOverride(resolveProposal(fresh.proposals, id), third)); }
      else throw new Error(`Unknown /forge subcommand: ${command}`);
      await refreshUi(candidate); output(ctx, `${command} applied to ${proposal.id}.`);
    } catch (error) { output(ctx, error instanceof Error ? error.message : String(error), "error"); }
  };

  pi.registerCommand("forge", { description: "Review and manage Skill Forge proposals", handler: commandHandler });
  pi.registerCommand("skill-forge", { description: "Alias for /forge", handler: commandHandler });
}

export const __testing = { renderStatus, proposalSummary, proposalMetadata, proposalDetail, resolveProposal, contextSessionId };

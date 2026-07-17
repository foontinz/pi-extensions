import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { ExtensionEditorComponent, getAgentDir, CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyInstall, prepareInstall, type InstallOptions } from "./install.ts";
import { deferProposal, editProposal, rejectProposal, reopenProposal, setKindOverride, setScopeOverride } from "./proposals.ts";
import { ForgeService, type ForgeStatus } from "./service.ts";
import { ProjectStore, projectStateDir, sha256 } from "./storage.ts";
import { Input, Key, matchesKey, SelectList, truncateToWidth, type AutocompleteItem, type SelectItem } from "@earendil-works/pi-tui";
import type { ForgeState, InstallKind, Proposal, Scope } from "./types.ts";

interface Runtime {
  generation: number;
  sessionId: string;
  ctx: ExtensionContext;
  controller: AbortController;
  service?: ForgeService;
  initialized: Promise<void>;
  timer?: NodeJS.Timeout;
  stateWatcher?: FSWatcher;
  stateWatchDebounce?: NodeJS.Timeout;
  trigger?: Promise<void>;
  rerun: boolean;
  force: boolean;
  lastNotificationAt: number;
  loadedSkills: Array<{ name: string; description?: string; filePath?: string; sourceInfo?: { scope?: string } }>;
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
  const kind = proposal.selectedKind ?? "skill";
  return `${proposal.id} [${proposal.status}] ${proposal.title} (${proposal.skillName}, ${kind}, ${scope}, ${(proposal.confidence * 100).toFixed(0)}%)`;
}

export function readyInboxProposals(state: ForgeState): Proposal[] {
  return state.proposals
    .filter((proposal) => proposal.status === "ready")
    .sort((a, b) => (b.confidence - a.confidence) || b.updatedAt.localeCompare(a.updatedAt));
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
    `Reviewer scope override: ${proposal.selectedScope ?? "none"}`,
    `Install kind: ${proposal.selectedKind ?? "skill (default)"}`,
    `Content digest: ${sha256(proposal.skillMd)}`,
    `Analyzer provenance: ${proposal.provenance.map((p) => `${p.analyzerModel}/${p.analyzerPromptVersion}`).join(", ")}`,
    "", "Evidence:", provenance.join("\n") || "none",
  ].join("\n");
}
function proposalDetail(proposal: Proposal): string { return `${proposalMetadata(proposal)}\n\nSKILL.md:\n${proposal.skillMd}`; }

const INBOX_MAX_VISIBLE = 10;

export function proposalItem(proposal: Proposal): SelectItem {
  const scope = proposal.selectedScope ?? proposal.proposedScope.scope;
  const kind = proposal.selectedKind ?? "skill";
  return {
    value: proposal.id,
    label: proposal.title || proposal.skillName,
    description: `${(proposal.confidence * 100).toFixed(0)}% · ${proposal.skillName} · ${kind} · ${scope} · ${proposal.id}`,
  };
}

export function filterProposalItems(items: SelectItem[], query: string): SelectItem[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  return items.filter((item) => {
    const haystack = `${item.label} ${item.description ?? ""} ${item.value}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

export interface InboxPick { proposal: Proposal; action: "review" | "reject" }

/** Pi's extension editor currently places prefilled cursors at EOF. Keep this
 * compatibility shim isolated until the public editor API supports placement. */
function positionExtensionEditorAtStart(component: ExtensionEditorComponent): boolean {
  const editor = (component as unknown as {
    editor?: { state?: { lines?: unknown[]; cursorLine?: number; cursorCol?: number }; scrollOffset?: number };
  }).editor;
  if (!editor?.state || !Array.isArray(editor.state.lines)) return false;
  editor.state.cursorLine = 0;
  editor.state.cursorCol = 0;
  editor.scrollOffset = 0;
  return true;
}

async function openEditorAtTop(ctx: ExtensionCommandContext, title: string, prefill: string): Promise<string | undefined> {
  if (ctx.mode !== "tui" || typeof (ctx.ui as { custom?: unknown }).custom !== "function") return ctx.ui.editor(title, prefill);
  return ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
    const component = new ExtensionEditorComponent(tui, keybindings, title, prefill, done, () => done(undefined));
    if (!positionExtensionEditorAtStart(component)) {
      // Compatibility fallback for a future editor implementation: move up
      // through more visual rows than the prefill can contain, then home.
      for (let index = 0; index <= prefill.length; index++) component.handleInput("\x1b[A");
      component.handleInput("\x1b[H");
    }
    return component;
  });
}

async function pickProposal(ctx: ExtensionCommandContext, proposals: Proposal[]): Promise<InboxPick | undefined> {
  if (typeof (ctx.ui as { custom?: unknown }).custom !== "function") {
    // Legacy hosts and test doubles without custom-component support.
    const summaries = proposals.map(proposalSummary);
    const choice = await ctx.ui.select("Skill Forge inbox", summaries);
    if (choice === undefined) return undefined;
    const index = summaries.indexOf(choice);
    return index >= 0 ? { proposal: proposals[index]!, action: "review" } : undefined;
  }
  const items = proposals.map(proposalItem);
  const picked = await ctx.ui.custom<{ id: string; action: "review" | "reject" } | undefined>((tui, theme, keybindings, done) => {
    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("muted", text),
      noMatch: (text: string) => theme.fg("muted", text),
    };
    const input = new Input();
    input.focused = true;
    let shown = items;
    let list: SelectList;
    const rebuild = () => {
      shown = filterProposalItems(items, input.getValue());
      list = new SelectList(shown, INBOX_MAX_VISIBLE, listTheme, { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 48 });
      list.onSelect = (item) => done({ id: item.value, action: "review" });
      list.onCancel = () => done(undefined);
    };
    rebuild();
    return {
      render(width: number) {
        const lines: string[] = [
          truncateToWidth(theme.fg("accent", theme.bold("Skill Forge inbox")), width),
          truncateToWidth(theme.fg("dim", `${shown.length}/${items.length} ready · type to filter · ↑↓ navigate · enter review · ctrl+r reject · esc close`), width),
          truncateToWidth(`› ${input.render(Math.max(1, width - 4))[0] ?? ""}`, width),
          "",
        ];
        if (shown.length) lines.push(...list.render(width).map((line) => truncateToWidth(line, width)));
        else lines.push(theme.fg("dim", "  no proposals match this filter"));
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("r"))) {
          const selected = list.getSelectedItem();
          if (selected) done({ id: selected.value, action: "reject" });
        } else if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")
          || keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) {
          list.handleInput(data);
        } else {
          const before = input.getValue();
          input.handleInput(data);
          if (input.getValue() !== before) rebuild();
        }
        tui.requestRender();
      },
    };
  });
  if (picked === undefined) return undefined;
  const proposal = proposals.find((item) => item.id === picked.id);
  return proposal ? { proposal, action: picked.action } : undefined;
}

const FORGE_SUBCOMMANDS: Array<{ value: string; description: string }> = [
  { value: "status", description: "Show queue, proposal, and background status" },
  { value: "sync", description: "Rescan all current-project sessions" },
  { value: "analyze", description: "Run all currently runnable analysis work" },
  { value: "pause", description: "Pause background model analysis" },
  { value: "resume", description: "Resume background model analysis" },
  { value: "inspect", description: "Show a proposal with scope and provenance" },
  { value: "edit", description: "Edit a ready proposal's SKILL.md" },
  { value: "accept", description: "Review and install a ready proposal" },
  { value: "reject", description: "Reject a proposal" },
  { value: "defer", description: "Defer a ready proposal" },
  { value: "reopen", description: "Reopen a rejected, deferred, failed, or accepted revision" },
  { value: "scope", description: "Override a proposal's user/project scope" },
  { value: "kind", description: "Override a proposal's install kind: skill or prompt template" },
  { value: "retry", description: "Retry failed analysis or installation work" },
  { value: "doctor", description: "Show recent diagnostics" },
];

function completionProposalStatuses(command: string): Set<Proposal["status"]> | undefined {
  if (command === "inspect") return undefined;
  if (command === "edit" || command === "accept" || command === "defer") return new Set(["ready"]);
  if (command === "reject" || command === "scope" || command === "kind") return new Set(["ready", "deferred", "apply_failed"]);
  if (command === "reopen") return new Set(["rejected", "deferred", "apply_failed", "accepted"]);
  return new Set();
}

export function buildForgeCompletions(prefix: string, state?: ForgeState): AutocompleteItem[] | null {
  const trailingSpace = /\s$/.test(prefix);
  const parts = prefix.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || (parts.length === 1 && !trailingSpace)) {
    const partial = (parts[0] ?? "").toLowerCase();
    const matches = FORGE_SUBCOMMANDS.filter((item) => item.value.startsWith(partial));
    return matches.length ? matches.map((item) => ({ ...item, label: item.value })) : null;
  }

  const command = parts[0]!.toLowerCase();
  if ((command === "accept" || command === "scope" || command === "kind") && (parts.length > 2 || (parts.length === 2 && trailingSpace))) {
    const id = parts[1];
    if (!id) return null;
    const settled = trailingSpace ? parts.slice(2) : parts.slice(2, -1);
    const partial = trailingSpace ? "" : parts[parts.length - 1]!.toLowerCase();
    let pool: string[] = command === "scope" ? ["user", "project"] : command === "kind" ? ["skill", "prompt"] : ["user", "project", "skill", "prompt"];
    if (command === "accept") {
      if (settled.length > 1) return null;
      if (settled.some((token) => token === "user" || token === "project")) pool = pool.filter((option) => option === "skill" || option === "prompt");
      if (settled.some((token) => token === "skill" || token === "prompt")) pool = pool.filter((option) => option === "user" || option === "project");
    } else if (settled.length > 0) return null;
    const descriptions: Record<string, string> = {
      user: "Install in the global user directory",
      project: "Install in this project's directory",
      skill: "Install as an auto-loaded skill (SKILL.md)",
      prompt: "Install as a /name slash-command prompt template",
    };
    const matches = pool.filter((option) => option.startsWith(partial));
    return matches.length ? matches.map((option) => {
      const value = `${command} ${id}${settled.length ? ` ${settled.join(" ")}` : ""} ${option}`;
      return { value, label: value, description: descriptions[option]! };
    }) : null;
  }

  if (command === "retry") {
    const partial = parts.length > 1 ? parts[1]! : "";
    const items: AutocompleteItem[] = [{ value: "retry all", label: "retry all", description: "Retry every failed job" }];
    if (state) {
      for (const job of state.jobs.filter((item) => item.status === "dead" || item.status === "retry")) {
        items.push({ value: `retry ${job.id}`, label: `retry ${job.id}`, description: `${job.status}: ${job.lastError ?? "analysis job"}`.slice(0, 180) });
      }
      for (const proposal of state.proposals.filter((item) => item.status === "apply_failed")) {
        items.push({ value: `retry ${proposal.id}`, label: `retry ${proposal.id}`, description: proposal.title });
      }
    }
    const matches = items.filter((item) => item.value.slice("retry ".length).startsWith(partial));
    return matches.length ? matches.slice(0, 100) : null;
  }

  const statuses = completionProposalStatuses(command);
  if (statuses === undefined || (statuses && statuses.size > 0)) {
    const partial = parts.length > 1 ? parts[1]! : "";
    const proposals = (state?.proposals ?? [])
      .filter((proposal) => statuses === undefined || statuses.has(proposal.status))
      .filter((proposal) => proposal.id.startsWith(partial) || proposal.title.toLowerCase().includes(partial.toLowerCase()))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100);
    return proposals.length ? proposals.map((proposal) => ({
      value: `${command} ${proposal.id}`,
      label: `${command} ${proposal.id}`,
      description: `[${proposal.status}] ${proposal.title} · ${proposal.selectedScope ?? proposal.proposedScope.scope}`,
    })) : null;
  }
  return null;
}

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
    runtime?.stateWatcher?.close(); clearTimeout(runtime?.stateWatchDebounce);
    const controller = new AbortController();
    const candidate: Runtime = {
      generation: currentGeneration, sessionId: contextSessionId(ctx), ctx, controller,
      initialized: Promise.resolve(), rerun: false, force: false, lastNotificationAt: 0, loadedSkills: [],
    };
    // Publish pending ownership synchronously, before canonicalProject's first await.
    runtime = candidate;
    candidate.initialized = (async () => {
      const location = await projectStateDir(getAgentDir(), ctx.cwd);
      if (!isCurrent(candidate)) return;
      const service = new ForgeService(new ProjectStore(location.dir, location.cwd, location.key), getAgentDir(), CONFIG_DIR_NAME, undefined, undefined, () => isCurrent(candidate));
      candidate.service = service;
      service.setLoadedSkills(candidate.loadedSkills);
      await service.initialize();
      if (!isCurrent(candidate)) return;
      const state = await service.store.read();
      if (!isCurrent(candidate)) return;
      candidate.timer = setInterval(() => { if (isCurrent(candidate)) void trigger(candidate, { inventory: true }); }, Math.max(10_000, state.config.inventoryIntervalMs));
      candidate.timer.unref();
      // Keep the footer status live: other sessions, background analysis, and
      // external tools all mutate state.json via atomic rename, so watch its
      // directory and refresh (debounced) whenever the file is replaced.
      try {
        const stateFile = basename(service.store.statePath);
        candidate.stateWatcher = watch(dirname(service.store.statePath), (_event, filename) => {
          if (filename && filename !== stateFile) return;
          clearTimeout(candidate.stateWatchDebounce);
          candidate.stateWatchDebounce = setTimeout(() => { if (isCurrent(candidate)) void refreshUi(candidate); }, 250);
          candidate.stateWatchDebounce.unref();
        });
      } catch { /* watching is best-effort; the interval timer still refreshes */ }
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
    candidate.loadedSkills = (event.systemPromptOptions.skills ?? []).map((skill) => ({
      name: skill.name, description: skill.description, filePath: skill.filePath, sourceInfo: skill.sourceInfo,
    }));
    candidate.service?.setLoadedSkills(candidate.loadedSkills);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const candidate = runtime;
    if (!candidate || contextSessionId(ctx) !== candidate.sessionId) return;
    ++generation; // Invalidates this session, including pending startup.
    candidate.ctx = ctx;
    candidate.controller.abort(); if (candidate.timer) clearInterval(candidate.timer);
    candidate.stateWatcher?.close(); clearTimeout(candidate.stateWatchDebounce);
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
      candidate.loadedSkills = skills.map((skill) => ({
        name: skill.name, description: skill.description, filePath: skill.filePath, sourceInfo: skill.sourceInfo,
      }));
      candidate.service.setLoadedSkills(candidate.loadedSkills);
    }
    return candidate;
  };

  const installOptions = (candidate: Runtime, ctx: ExtensionCommandContext): InstallOptions => ({ projectCwd: candidate.service!.store.cwd, agentDir: getAgentDir(), configDirName: CONFIG_DIR_NAME, projectTrusted: ctx.isProjectTrusted() });
  const accept = async (candidate: Runtime, proposal: Proposal, requestedScope: Scope | undefined, requestedKind: InstallKind | undefined, ctx: ExtensionCommandContext): Promise<boolean> => {
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
    const kind = requestedKind ?? proposal.selectedKind ?? "skill";
    const options = installOptions(candidate, ctx);
    const plan = await prepareInstall(proposal, scope, options, kind);
    const kindNote = kind === "prompt" ? ` (a /${proposal.skillName} slash-command template)` : " (an auto-loaded skill)";
    const exact = await ctx.ui.confirm("Confirm exact Skill Forge installation", `Scope: ${scope}\nKind: ${kind}${kindNote}\nTarget: ${plan.path}\nSHA-256: ${plan.contentDigest}\n\nExact content:\n${plan.content}`);
    if (!exact) { output(ctx, "Acceptance cancelled; proposal remains ready."); return false; }
    let collisionConfirmed = false;
    if (plan.collision === "different") {
      collisionConfirmed = await ctx.ui.confirm("Overwrite reviewed existing skill?", `Skill Forge will atomically replace ${plan.path}.\n\n${plan.diff}`);
      if (!collisionConfirmed) { output(ctx, "Acceptance cancelled; proposal remains ready."); return false; }
    }
    await applyInstall(candidate.service!.store, plan, collisionConfirmed, options);
    output(ctx, `Accepted ${proposal.id} as ${scope} ${kind}: ${plan.path}`);
    await refreshUi(candidate);
    if (await ctx.ui.confirm("Reload resources?", `Reload Pi resources now so the accepted ${kind} is available?`)) { await ctx.reload(); return true; }
    return false;
  };

  const reviewInbox = async (candidate: Runtime, ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      const ready = readyInboxProposals(await candidate.service!.store.read());
      output(ctx, ready.length ? ready.map(proposalSummary).join("\n") : "Skill Forge inbox is empty."); return;
    }
    while (isCurrent(candidate)) {
      const ready = readyInboxProposals(await candidate.service!.store.read());
      if (!ready.length) { output(ctx, "Skill Forge inbox is empty."); return; }
      const picked = await pickProposal(ctx, ready); if (!picked) return;
      if (picked.action === "reject") {
        const reason = await ctx.ui.input(`Reject ${picked.proposal.id} — reason`, "optional; esc cancels rejection");
        if (reason === undefined) continue; // Escaped: back to the inbox without rejecting.
        await candidate.service!.store.withLock((fresh) => rejectProposal(resolveProposal(fresh.proposals, picked.proposal.id), reason));
        await refreshUi(candidate);
        output(ctx, `Rejected ${picked.proposal.id}.`);
        continue;
      }
      let proposal = picked.proposal;
      // Keep the review buffer limited to SKILL.md. Do not emit proposal metadata
      // through ui.notify(): TUI notifications persist as a gray transcript block
      // after the temporary review UI closes. Full metadata remains available via
      // `/forge inspect <id>`.
      const reviewed = await openEditorAtTop(ctx, `Review ${proposal.id} — SKILL.md only`, proposal.skillMd);
      if (reviewed === undefined) continue; // Cancel review: return to the Forge inbox.
      if (reviewed.trim() !== proposal.skillMd.trim()) await candidate.service!.store.withLock((fresh) => editProposal(resolveProposal(fresh.proposals, proposal!.id), reviewed));
      proposal = resolveProposal((await candidate.service!.store.read()).proposals, proposal.id);
      const scope = proposal.selectedScope ?? proposal.proposedScope.scope;
      const kind = proposal.selectedKind ?? "skill";
      const otherScope: Scope = scope === "user" ? "project" : "user";
      const otherKind: InstallKind = kind === "skill" ? "prompt" : "skill";
      const action = await ctx.ui.select("Review action", [
        `accept (${kind}, ${scope})`,
        "accept as… (choose kind and scope)",
        `set kind ${otherKind}`,
        `set scope ${otherScope}`,
        "reject", "defer", "back",
      ]);
      if (!action || action === "back") continue;
      if (action.startsWith("set kind ")) { await candidate.service!.store.withLock((fresh) => setKindOverride(resolveProposal(fresh.proposals, proposal!.id), otherKind)); continue; }
      if (action.startsWith("set scope ")) { await candidate.service!.store.withLock((fresh) => setScopeOverride(resolveProposal(fresh.proposals, proposal!.id), otherScope)); continue; }
      if (action === "reject") { const reason = await ctx.ui.input("Rejection reason", "optional"); await candidate.service!.store.withLock((fresh) => rejectProposal(resolveProposal(fresh.proposals, proposal!.id), reason)); continue; }
      if (action === "defer") { await candidate.service!.store.withLock((fresh) => deferProposal(resolveProposal(fresh.proposals, proposal!.id))); continue; }
      if (action.startsWith("accept as…")) {
        const kindChoice = await ctx.ui.select("Install as", [
          "skill — SKILL.md the agent loads and applies on its own",
          "prompt — /name slash-command template you invoke manually",
        ]);
        if (!kindChoice) continue;
        const scopeChoice = await ctx.ui.select("Install scope", [
          "user — global, available in every project",
          "project — this repository only",
        ]);
        if (!scopeChoice) continue;
        const chosenKind: InstallKind = kindChoice.startsWith("prompt") ? "prompt" : "skill";
        const chosenScope: Scope = scopeChoice.startsWith("project") ? "project" : "user";
        if (await accept(candidate, proposal, chosenScope, chosenKind, ctx)) return;
        continue;
      }
      if (await accept(candidate, proposal, undefined, undefined, ctx)) return;
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
        const markdown = await openEditorAtTop(ctx, `Edit ${proposal.id} SKILL.md`, proposal.skillMd); if (markdown === undefined) { output(ctx, "Edit cancelled."); return; }
        await service.store.withLock((fresh) => editProposal(resolveProposal(fresh.proposals, id), markdown)); await refreshUi(candidate); output(ctx, `Edited ${proposal.id}; it remains uninstalled until explicit acceptance.`); return;
      }
      if (command === "accept") {
        let scope: Scope | undefined; let kind: InstallKind | undefined;
        for (const token of [third, ...rest].filter((value): value is string => Boolean(value))) {
          if (token === "user" || token === "project") scope = token;
          else if (token === "skill" || token === "prompt") kind = token;
          else throw new Error(`Unknown accept option: ${token} (expected user|project and/or skill|prompt)`);
        }
        await accept(candidate, proposal, scope, kind, ctx); return;
      }
      if (command === "reject") { const reason = [third, ...rest].filter(Boolean).join(" "); await service.store.withLock((fresh) => rejectProposal(resolveProposal(fresh.proposals, id), reason)); }
      else if (command === "defer") await service.store.withLock((fresh) => deferProposal(resolveProposal(fresh.proposals, id)));
      else if (command === "reopen") await service.store.withLock((fresh) => { reopenProposal(fresh, resolveProposal(fresh.proposals, id)); });
      else if (command === "scope") { if (third !== "user" && third !== "project") throw new Error("Scope must be user or project"); await service.store.withLock((fresh) => setScopeOverride(resolveProposal(fresh.proposals, id), third)); }
      else if (command === "kind") { if (third !== "skill" && third !== "prompt") throw new Error("Kind must be skill or prompt"); await service.store.withLock((fresh) => setKindOverride(resolveProposal(fresh.proposals, id), third)); }
      else throw new Error(`Unknown /forge subcommand: ${command}`);
      await refreshUi(candidate); output(ctx, `${command} applied to ${proposal.id}.`);
    } catch (error) { output(ctx, error instanceof Error ? error.message : String(error), "error"); }
  };

  const getArgumentCompletions = async (prefix: string): Promise<AutocompleteItem[] | null> => {
    const candidate = runtime;
    if (!candidate || !isCurrent(candidate)) return buildForgeCompletions(prefix);
    await candidate.initialized.catch(() => undefined);
    const state = candidate.service ? await candidate.service.store.read().catch(() => undefined) : undefined;
    return buildForgeCompletions(prefix, state);
  };

  pi.registerCommand("forge", {
    description: "Review and manage Skill Forge proposals",
    getArgumentCompletions,
    handler: commandHandler,
  });
}

export const __testing = { renderStatus, proposalSummary, proposalMetadata, proposalDetail, resolveProposal, contextSessionId, proposalItem, filterProposalItems, positionExtensionEditorAtStart, openEditorAtTop, pickProposal, readyInboxProposals };

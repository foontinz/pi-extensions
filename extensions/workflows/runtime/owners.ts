import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface WorkflowOwnerIdentity {
  sessionId: string;
  sessionFile?: string;
  instanceId: string;
  parentPid: number;
}

export interface OwnedRuntime {
  runId: string;
  owner: WorkflowOwnerIdentity;
  controller: AbortController;
}

export class WorkflowOwnerRegistry {
  readonly instanceId = randomUUID();
  private readonly contexts = new Map<string, ExtensionContext>();
  private readonly runs = new Map<string, OwnedRuntime>();

  owner(ctx: ExtensionContext): WorkflowOwnerIdentity {
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      instanceId: this.instanceId,
      parentPid: process.pid,
    };
  }

  bind(ctx: ExtensionContext): WorkflowOwnerIdentity {
    const owner = this.owner(ctx);
    this.contexts.set(owner.sessionId, ctx);
    return owner;
  }

  unbind(ctx: ExtensionContext): void {
    const owner = this.owner(ctx);
    if (this.contexts.get(owner.sessionId) === ctx) this.contexts.delete(owner.sessionId);
  }

  matchingContext(owner: WorkflowOwnerIdentity): ExtensionContext | undefined {
    return this.contexts.get(owner.sessionId);
  }

  register(runtime: OwnedRuntime): void {
    if (this.runs.has(runtime.runId)) throw new Error(`duplicate workflow runtime: ${runtime.runId}`);
    this.runs.set(runtime.runId, runtime);
  }

  finish(runId: string): void { this.runs.delete(runId); }

  stop(runId: string, requestingOwner: WorkflowOwnerIdentity, reason: unknown, scopeAll = false): boolean {
    const runtime = this.runs.get(runId);
    if (!runtime || (!scopeAll && runtime.owner.sessionId !== requestingOwner.sessionId)) return false;
    runtime.controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
    return true;
  }

  stopOwned(owner: WorkflowOwnerIdentity, reason: string): number {
    let count = 0;
    for (const runtime of this.runs.values()) {
      if (runtime.owner.sessionId !== owner.sessionId) continue;
      runtime.controller.abort(new Error(reason));
      count++;
    }
    return count;
  }

  list(owner?: WorkflowOwnerIdentity): OwnedRuntime[] {
    return [...this.runs.values()].filter((runtime) => !owner || runtime.owner.sessionId === owner.sessionId);
  }
}

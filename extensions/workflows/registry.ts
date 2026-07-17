import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_WORKFLOW_SCRIPT_BYTES } from "./core/limits.js";

export type WorkflowSourceKind = "inline" | "path" | "builtin" | "user" | "project";

export interface ResolvedWorkflowSource {
  kind: WorkflowSourceKind;
  qualifiedId?: string;
  sourcePath?: string;
  sourceDirectory: string;
  source: string;
  sha256: string;
  identity: string;
}

const QUALIFIED_NAME = /^(builtin|user|project):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/;

export class WorkflowResolutionError extends Error {
  readonly kind = "contract" as const;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkflowResolutionError";
  }
}

export class WorkflowResolver {
  constructor(
    private readonly agentDir = getAgentDir(),
    private readonly builtinDir = path.join(import.meta.dirname, "builtins"),
  ) {}

  resolveInline(source: string, cwd: string): ResolvedWorkflowSource {
    return resolved("inline", source, path.resolve(cwd));
  }

  resolvePath(reference: string, baseDirectory: string): ResolvedWorkflowSource {
    if (!reference.trim()) throw new WorkflowResolutionError("SOURCE_PATH_EMPTY", "scriptPath must not be empty");
    const requested = path.resolve(baseDirectory, reference);
    return this.readPath("path", requested);
  }

  resolveName(name: string, cwd: string, projectTrusted: boolean): ResolvedWorkflowSource {
    const match = QUALIFIED_NAME.exec(name);
    if (!match) {
      throw new WorkflowResolutionError("WORKFLOW_NAME_QUALIFIED", "workflow name must be qualified as builtin:<id>, user:<id>, or project:<id>");
    }
    const [, scope, id] = match as RegExpExecArray & { 1: "builtin" | "user" | "project"; 2: string };
    if (scope === "project" && !projectTrusted) {
      throw new WorkflowResolutionError("PROJECT_WORKFLOW_UNTRUSTED", "project workflows require an active project trust decision");
    }
    const root = scope === "builtin"
      ? this.builtinDir
      : scope === "user"
        ? path.join(this.agentDir, "workflows")
        : findProjectWorkflowRoot(cwd);
    if (!root) throw new WorkflowResolutionError("PROJECT_WORKFLOW_ROOT", `no trusted .pi/workflows directory found from ${cwd}`);
    const candidateNames = [`${id}.workflow.js`, `${id}.js`];
    for (const candidate of candidateNames) {
      const requested = path.join(root, candidate);
      if (!fs.existsSync(requested)) continue;
      const result = this.readContained(scope, name, requested, root);
      return result;
    }
    throw new WorkflowResolutionError("WORKFLOW_NOT_FOUND", `workflow ${name} was not found under ${root}`);
  }

  discover(cwd: string, projectTrusted: boolean): Array<{ qualifiedId: string; sourcePath: string }> {
    const sources: Array<{ scope: "builtin" | "user" | "project"; root: string | null }> = [
      { scope: "builtin", root: this.builtinDir },
      { scope: "user", root: path.join(this.agentDir, "workflows") },
      { scope: "project", root: projectTrusted ? findProjectWorkflowRoot(cwd) : null },
    ];
    const results: Array<{ qualifiedId: string; sourcePath: string }> = [];
    for (const source of sources) {
      if (!source.root) continue;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(source.root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if ((!entry.isFile() && !entry.isSymbolicLink()) || !/\.(?:workflow\.)?js$/.test(entry.name)) continue;
        const id = entry.name.replace(/(?:\.workflow)?\.js$/, "");
        try {
          const resolvedSource = this.readContained(source.scope, `${source.scope}:${id}`, path.join(source.root, entry.name), source.root);
          results.push({ qualifiedId: resolvedSource.qualifiedId!, sourcePath: resolvedSource.sourcePath! });
        } catch { /* discovery omits unsafe/broken entries; direct resolution gives diagnostics */ }
      }
    }
    return results.sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));
  }

  private readPath(kind: "path", requested: string): ResolvedWorkflowSource {
    let real: string;
    try { real = fs.realpathSync(requested); } catch (error) {
      throw new WorkflowResolutionError("SOURCE_READ", `cannot resolve workflow source ${requested}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new WorkflowResolutionError("SOURCE_NOT_FILE", `workflow source is not a regular file: ${real}`);
    if (stat.size > MAX_WORKFLOW_SCRIPT_BYTES) throw new WorkflowResolutionError("SOURCE_LIMIT", `workflow source exceeds ${MAX_WORKFLOW_SCRIPT_BYTES} bytes`);
    const source = fs.readFileSync(real, "utf8");
    return resolved(kind, source, path.dirname(real), real);
  }

  private readContained(
    kind: "builtin" | "user" | "project",
    qualifiedId: string,
    requested: string,
    root: string,
  ): ResolvedWorkflowSource {
    let realRoot: string;
    let real: string;
    try {
      realRoot = fs.realpathSync(root);
      real = fs.realpathSync(requested);
    } catch (error) {
      throw new WorkflowResolutionError("SOURCE_READ", `cannot resolve workflow ${qualifiedId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isWithin(real, realRoot)) throw new WorkflowResolutionError("SOURCE_ESCAPE", `workflow ${qualifiedId} escapes its ${kind} registry root`);
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new WorkflowResolutionError("SOURCE_NOT_FILE", `workflow ${qualifiedId} is not a regular file`);
    if (stat.size > MAX_WORKFLOW_SCRIPT_BYTES) throw new WorkflowResolutionError("SOURCE_LIMIT", `workflow ${qualifiedId} exceeds ${MAX_WORKFLOW_SCRIPT_BYTES} bytes`);
    const source = fs.readFileSync(real, "utf8");
    return { ...resolved(kind, source, path.dirname(real), real), qualifiedId };
  }
}

function resolved(kind: WorkflowSourceKind, source: string, sourceDirectory: string, sourcePath?: string): ResolvedWorkflowSource {
  const sha256 = createHash("sha256").update(source).digest("hex");
  const identity = sourcePath ? `${kind}:${sourcePath}:${sha256}` : `${kind}:${sha256}`;
  return { kind, sourcePath, sourceDirectory, source, sha256, identity };
}

function findProjectWorkflowRoot(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "workflows");
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch {}
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

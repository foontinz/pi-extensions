import { Buffer } from "node:buffer";
import { parse } from "acorn";
import type { JsonValue } from "./canonical-json.js";
import type { WorkflowMeta } from "./contracts.js";
import {
  MAX_WORKFLOW_METADATA_BYTES,
  MAX_WORKFLOW_METADATA_DEPTH,
  MAX_WORKFLOW_AGENTS,
  MAX_WORKFLOW_PARSER_NODES,
  MAX_WORKFLOW_SCRIPT_BYTES,
} from "./limits.js";

interface AstNode { type: string; start: number; end: number; [key: string]: unknown }
interface ProgramNode extends AstNode { body: AstNode[] }

export interface ParsedWorkflowScript {
  metadata: WorkflowMeta;
  /** Exact source with the metadata export replaced by spaces; newlines remain. */
  body: string;
  metadataRange: { start: number; end: number };
}

export class WorkflowMetadataError extends SyntaxError {
  override name = "WorkflowMetadataError";
  readonly code = "WORKFLOW_METADATA_INVALID";
  constructor(message: string, readonly offset?: number) {
    super(offset === undefined ? message : `${message} at offset ${offset}`);
  }
}

const REQUIRED_KEYS = new Set(["name", "description", "resumable", "maxAgents", "capabilities"]);
const OPTIONAL_KEYS = new Set(["phases", "whenToUse", "estimatedOutputTokens"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Parse and validate the mandatory first `export const meta = {...}` declaration. */
export function parseWorkflowMetadata(source: string): ParsedWorkflowScript {
  if (typeof source !== "string") throw new TypeError("workflow source must be a string");
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_SCRIPT_BYTES) {
    throw new WorkflowMetadataError(`workflow source exceeds ${MAX_WORKFLOW_SCRIPT_BYTES} bytes`);
  }

  let program: ProgramNode;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    }) as unknown as ProgramNode;
  } catch (error) {
    const parseError = error as Error & { pos?: number };
    throw new WorkflowMetadataError(parseError.message, parseError.pos);
  }
  countAst(program);

  const statement = program.body.find((candidate) => !isDirective(candidate));
  if (!statement) throw new WorkflowMetadataError("workflow must begin with export const meta = {...}");
  const expression = metadataInitializer(statement);
  const metadataBytes = Buffer.byteLength(source.slice(statement.start, statement.end), "utf8");
  if (metadataBytes > MAX_WORKFLOW_METADATA_BYTES) {
    throw new WorkflowMetadataError(`workflow metadata exceeds ${MAX_WORKFLOW_METADATA_BYTES} bytes`, statement.start);
  }
  const raw = literalValue(expression, "$metadata", 0);
  if (!plainObject(raw)) throw new WorkflowMetadataError("workflow metadata must be an object literal", expression.start);
  const metadata = validateMetadata(raw as Record<string, JsonValue>, expression.start);
  return {
    metadata,
    body: blankRange(source, statement.start, statement.end),
    metadataRange: { start: statement.start, end: statement.end },
  };
}

export const parseWorkflowScript = parseWorkflowMetadata;

function metadataInitializer(statement: AstNode): AstNode {
  if (statement.type !== "ExportNamedDeclaration") throw new WorkflowMetadataError("metadata must be the first non-directive statement", statement.start);
  const declaration = node(statement.declaration);
  if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowMetadataError("metadata must use `export const meta = {...}`", statement.start);
  }
  const declarations = declaration.declarations;
  if (!Array.isArray(declarations) || declarations.length !== 1) throw new WorkflowMetadataError("metadata export must declare only meta", statement.start);
  const declarator = node(declarations[0]);
  const id = node(declarator.id);
  if (id.type !== "Identifier" || id.name !== "meta") throw new WorkflowMetadataError("metadata export must be named meta", id.start);
  const init = node(declarator.init);
  if (init.type !== "ObjectExpression") throw new WorkflowMetadataError("meta must be a pure object literal", init.start);
  return init;
}

function validateMetadata(raw: Record<string, JsonValue>, offset: number): WorkflowMeta {
  for (const key of Object.keys(raw)) {
    if (!REQUIRED_KEYS.has(key) && !OPTIONAL_KEYS.has(key)) throw new WorkflowMetadataError(`unknown metadata key ${JSON.stringify(key)}`, offset);
  }
  for (const key of REQUIRED_KEYS) if (!(key in raw)) throw new WorkflowMetadataError(`missing required metadata key ${key}`, offset);
  if (typeof raw.name !== "string" || raw.name.length < 1 || raw.name.length > 160) throw new WorkflowMetadataError("meta.name must be a 1-160 character string", offset);
  if (typeof raw.description !== "string" || raw.description.length < 1 || raw.description.length > 2_000) throw new WorkflowMetadataError("meta.description must be a 1-2000 character string", offset);
  if (typeof raw.resumable !== "boolean") throw new WorkflowMetadataError("meta.resumable must be boolean", offset);
  if (!Number.isSafeInteger(raw.maxAgents) || (raw.maxAgents as number) < 1 || (raw.maxAgents as number) > MAX_WORKFLOW_AGENTS) {
    throw new WorkflowMetadataError(`meta.maxAgents must be an integer between 1 and ${MAX_WORKFLOW_AGENTS}`, offset);
  }
  if (!Array.isArray(raw.capabilities) || raw.capabilities.some((value) => typeof value !== "string" || !value)) {
    throw new WorkflowMetadataError("meta.capabilities must be an array of non-empty strings", offset);
  }
  const capabilities = [...new Set(raw.capabilities as string[])];
  if (capabilities.length !== raw.capabilities.length) throw new WorkflowMetadataError("meta.capabilities must be unique", offset);

  let phases: WorkflowMeta["phases"];
  if (raw.phases !== undefined) {
    if (!Array.isArray(raw.phases)) throw new WorkflowMetadataError("meta.phases must be an array", offset);
    const ids = new Set<string>();
    phases = raw.phases.map((value, index) => {
      if (!plainObject(value) || Object.keys(value).some((key) => key !== "id" && key !== "title")) {
        throw new WorkflowMetadataError(`meta.phases[${index}] must contain only id and title`, offset);
      }
      const phase = value as Record<string, JsonValue>;
      if (typeof phase.id !== "string" || !phase.id || typeof phase.title !== "string" || !phase.title) {
        throw new WorkflowMetadataError(`meta.phases[${index}] requires non-empty id and title`, offset);
      }
      if (ids.has(phase.id)) throw new WorkflowMetadataError(`duplicate phase id ${JSON.stringify(phase.id)}`, offset);
      ids.add(phase.id);
      return { id: phase.id, title: phase.title };
    });
  }
  if (raw.whenToUse !== undefined && typeof raw.whenToUse !== "string") throw new WorkflowMetadataError("meta.whenToUse must be a string", offset);
  if (raw.estimatedOutputTokens !== undefined && (!Number.isSafeInteger(raw.estimatedOutputTokens) || (raw.estimatedOutputTokens as number) < 0)) {
    throw new WorkflowMetadataError("meta.estimatedOutputTokens must be a non-negative safe integer", offset);
  }
  return {
    name: raw.name,
    description: raw.description,
    resumable: raw.resumable,
    maxAgents: raw.maxAgents as number,
    capabilities,
    ...(phases ? { phases } : {}),
    ...(raw.whenToUse !== undefined ? { whenToUse: raw.whenToUse } : {}),
    ...(raw.estimatedOutputTokens !== undefined ? { estimatedOutputTokens: raw.estimatedOutputTokens as number } : {}),
  };
}

function isDirective(statement: AstNode): boolean {
  return statement.type === "ExpressionStatement" && typeof statement.directive === "string";
}

function literalValue(ast: AstNode, path: string, depth: number): JsonValue {
  if (depth > MAX_WORKFLOW_METADATA_DEPTH) throw metadataError(ast, `${path} exceeds metadata depth ${MAX_WORKFLOW_METADATA_DEPTH}`);
  switch (ast.type) {
    case "Literal": {
      const value = ast.value;
      if (value === null || typeof value === "string" || typeof value === "boolean") return value;
      if (typeof value === "number" && Number.isFinite(value)) return value;
      throw metadataError(ast, `${path} contains a non-JSON literal`);
    }
    case "UnaryExpression": {
      if ((ast.operator !== "+" && ast.operator !== "-") || ast.prefix !== true) throw metadataError(ast, `${path} contains a forbidden unary expression`);
      const argument = node(ast.argument);
      if (argument.type !== "Literal" || typeof argument.value !== "number") throw metadataError(ast, `${path} contains a non-literal number`);
      const value = ast.operator === "-" ? -argument.value : argument.value;
      if (!Number.isFinite(value)) throw metadataError(ast, `${path} contains a non-finite number`);
      return value;
    }
    case "ArrayExpression": {
      if (!Array.isArray(ast.elements)) throw metadataError(ast, `${path} is malformed`);
      return ast.elements.map((entry, index) => {
        if (entry === null) throw metadataError(ast, `${path}[${index}] is sparse`);
        const element = node(entry);
        if (element.type === "SpreadElement") throw metadataError(element, `${path}[${index}] contains spread syntax`);
        return literalValue(element, `${path}[${index}]`, depth + 1);
      });
    }
    case "ObjectExpression": {
      if (!Array.isArray(ast.properties)) throw metadataError(ast, `${path} is malformed`);
      const result = Object.create(null) as Record<string, JsonValue>;
      for (const rawProperty of ast.properties) {
        const property = node(rawProperty);
        if (property.type === "SpreadElement") throw metadataError(property, `${path} contains spread syntax`);
        if (property.type !== "Property" || property.computed === true || property.method === true || property.kind !== "init" || property.shorthand === true) {
          throw metadataError(property, `${path} contains a computed, shorthand, method, or accessor property`);
        }
        const key = propertyName(node(property.key), path);
        if (FORBIDDEN_KEYS.has(key)) throw metadataError(property, `${path} contains forbidden key ${JSON.stringify(key)}`);
        if (Object.hasOwn(result, key)) throw metadataError(property, `${path} contains duplicate key ${JSON.stringify(key)}`);
        result[key] = literalValue(node(property.value), `${path}.${key}`, depth + 1);
      }
      return result;
    }
    default:
      throw metadataError(ast, `${path} must contain only JSON-compatible AST literals (found ${ast.type})`);
  }
}

function countAst(program: AstNode): void {
  let count = 0;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (++count > MAX_WORKFLOW_PARSER_NODES) throw new WorkflowMetadataError(`workflow AST exceeds ${MAX_WORKFLOW_PARSER_NODES} nodes`);
    for (const [key, child] of Object.entries(value)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) for (const item of child) visit(item);
      else visit(child);
    }
  };
  visit(program);
}
function propertyName(key: AstNode, path: string): string {
  if (key.type === "Identifier" && typeof key.name === "string") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  throw metadataError(key, `${path} property names must be static strings`);
}
function node(value: unknown): AstNode {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") throw new WorkflowMetadataError("malformed metadata AST");
  return value as AstNode;
}
function metadataError(ast: AstNode, message: string): WorkflowMetadataError { return new WorkflowMetadataError(message, ast.start); }
function blankRange(source: string, start: number, end: number): string {
  return source.slice(0, start) + source.slice(start, end).replace(/[^\r\n]/gu, " ") + source.slice(end);
}
function plainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

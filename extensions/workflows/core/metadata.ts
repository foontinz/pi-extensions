import { Buffer } from "node:buffer";
import { parse } from "acorn";
import type { JsonValue } from "./canonical-json.js";
import { cloneCanonicalJson } from "./canonical-json.js";
import type { WorkflowMeta } from "./contracts.js";
import { MAX_WORKFLOW_METADATA_BYTES, MAX_WORKFLOW_SCRIPT_BYTES } from "./limits.js";

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
interface ProgramNode extends AstNode { body: AstNode[] }

export interface ParsedWorkflowScript {
  metadata?: WorkflowMeta;
  /** Script with the metadata statement replaced by spaces (newlines preserved). */
  body: string;
  metadataRange?: { start: number; end: number };
}

export class WorkflowMetadataError extends SyntaxError {
  override name = "WorkflowMetadataError";
  constructor(message: string, readonly offset?: number) {
    super(offset === undefined ? message : `${message} at offset ${offset}`);
  }
}

/**
 * Parse optional metadata from the first non-directive statement. Metadata is
 * an object-literal expression, normally written `({ name: "example" });`.
 */
export function parseWorkflowMetadata(source: string): ParsedWorkflowScript {
  if (typeof source !== "string") throw new TypeError("workflow source must be a string");
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_SCRIPT_BYTES) {
    throw new WorkflowMetadataError(`workflow source exceeds ${MAX_WORKFLOW_SCRIPT_BYTES} bytes`);
  }

  let program: ProgramNode;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    }) as unknown as ProgramNode;
  } catch (error) {
    const parseError = error as Error & { pos?: number };
    throw new WorkflowMetadataError(parseError.message, parseError.pos);
  }

  const candidate = program.body.find((statement) => !isDirective(statement));
  if (!candidate || candidate.type !== "ExpressionStatement") return { body: source };
  const expression = node(candidate.expression);
  if (expression.type !== "ObjectExpression") return { body: source };

  const sourceBytes = Buffer.byteLength(source.slice(candidate.start, candidate.end), "utf8");
  if (sourceBytes > MAX_WORKFLOW_METADATA_BYTES) {
    throw new WorkflowMetadataError(`workflow metadata exceeds ${MAX_WORKFLOW_METADATA_BYTES} bytes`, candidate.start);
  }
  const value = literalValue(expression, "$metadata");
  const metadata = cloneCanonicalJson(value) as WorkflowMeta;
  const body = blankRange(source, candidate.start, candidate.end);
  return { metadata, body, metadataRange: { start: candidate.start, end: candidate.end } };
}

export const parseWorkflowScript = parseWorkflowMetadata;

function isDirective(statement: AstNode): boolean {
  return statement.type === "ExpressionStatement" && typeof statement.directive === "string";
}

function literalValue(ast: AstNode, path: string): JsonValue {
  switch (ast.type) {
    case "Literal": {
      const value = ast.value;
      if (value === null || typeof value === "string" || typeof value === "boolean") return value;
      if (typeof value === "number" && Number.isFinite(value)) return value;
      throw metadataError(ast, `${path} contains a non-JSON literal`);
    }
    case "UnaryExpression": {
      if ((ast.operator !== "+" && ast.operator !== "-") || ast.prefix !== true) {
        throw metadataError(ast, `${path} contains a forbidden unary expression`);
      }
      const argument = node(ast.argument);
      if (argument.type !== "Literal" || typeof argument.value !== "number") {
        throw metadataError(ast, `${path} contains a non-literal number`);
      }
      const value = ast.operator === "-" ? -argument.value : argument.value;
      if (!Number.isFinite(value)) throw metadataError(ast, `${path} contains a non-finite number`);
      return value;
    }
    case "ArrayExpression": {
      const elements = ast.elements;
      if (!Array.isArray(elements)) throw metadataError(ast, `${path} is malformed`);
      return elements.map((entry, index) => {
        if (entry === null) throw metadataError(ast, `${path}[${index}] is a sparse array element`);
        const element = node(entry);
        if (element.type === "SpreadElement") throw metadataError(element, `${path}[${index}] contains spread syntax`);
        return literalValue(element, `${path}[${index}]`);
      });
    }
    case "ObjectExpression": {
      if (!Array.isArray(ast.properties)) throw metadataError(ast, `${path} is malformed`);
      const result: Record<string, JsonValue> = {};
      const keys = new Set<string>();
      for (const rawProperty of ast.properties) {
        const property = node(rawProperty);
        if (property.type === "SpreadElement") throw metadataError(property, `${path} contains spread syntax`);
        if (property.type !== "Property") throw metadataError(property, `${path} contains an unsupported property`);
        if (property.computed === true) throw metadataError(property, `${path} contains a computed property`);
        if (property.method === true || property.kind !== "init") throw metadataError(property, `${path} contains a method or accessor`);
        if (property.shorthand === true) throw metadataError(property, `${path} contains shorthand syntax`);
        const key = propertyName(node(property.key), path);
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          throw metadataError(property, `${path} contains forbidden key ${JSON.stringify(key)}`);
        }
        if (keys.has(key)) throw metadataError(property, `${path} contains duplicate key ${JSON.stringify(key)}`);
        keys.add(key);
        result[key] = literalValue(node(property.value), `${path}.${key}`);
      }
      return result;
    }
    default:
      throw metadataError(ast, `${path} must contain only JSON-compatible literals (found ${ast.type})`);
  }
}

function propertyName(key: AstNode, path: string): string {
  if (key.type === "Identifier" && typeof key.name === "string") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  throw metadataError(key, `${path} property names must be static strings`);
}

function node(value: unknown): AstNode {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
    throw new WorkflowMetadataError("malformed workflow metadata AST");
  }
  return value as AstNode;
}

function metadataError(ast: AstNode, message: string): WorkflowMetadataError {
  return new WorkflowMetadataError(message, ast.start);
}

function blankRange(source: string, start: number, end: number): string {
  const blanked = source.slice(start, end).replace(/[^\r\n]/gu, " ");
  return source.slice(0, start) + blanked + source.slice(end);
}

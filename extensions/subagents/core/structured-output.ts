import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";
export const MAX_STRUCTURED_OUTPUT_SUBMISSIONS = 5;

const MAX_DIAGNOSTIC_CHARS = 2_000;
const MAX_PREVIEW_CHARS = 1_000;
const MAX_SCHEMA_NODES = 10_000;
const MAX_NESTING_DEPTH = 64;

/** A JSON Schema Draft 2020-12 document whose root describes an object. */
export type StructuredOutputSchema = Record<string, unknown>;

/** Option shared by in-process subagents, workflows, and run_agent. */
export interface StructuredOutputOptions {
  schema: StructuredOutputSchema;
}

export type StructuredOutputOutcome =
  | { status: "accepted"; value: Record<string, unknown>; submissions: number }
  | { status: "missing"; submissions: number; diagnostics: string[] }
  | {
      status: "exhausted";
      reason: "max-submissions" | "duplicate-valid";
      submissions: number;
      diagnostics: string[];
    };

export interface StructuredOutputCapability {
  tool: ToolDefinition;
  /** Must be the last appended system-prompt fragment. */
  finalReturnPrompt: string;
  outcome(): StructuredOutputOutcome;
}

const StructuredOutputParams = Type.Object({
  value: Type.Unknown({ description: "The final JSON object matching the requested schema." }),
});

/** Compile a bounded, synchronous Draft 2020-12 structured-output channel. */
export function createStructuredOutputCapability(options: StructuredOutputOptions): StructuredOutputCapability {
  const schema = validateAndCloneSchema(options.schema);
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    $data: false,
  });

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new Error(bound(`Invalid structured output schema: ${errorMessage(error)}. Schema: ${preview(schema)}`));
  }

  let submissions = 0;
  let accepted: Record<string, unknown> | undefined;
  let exhaustedReason: "max-submissions" | "duplicate-valid" | undefined;
  const diagnostics: string[] = [];

  const outcome = (): StructuredOutputOutcome => {
    if (exhaustedReason) {
      return { status: "exhausted", reason: exhaustedReason, submissions, diagnostics: [...diagnostics] };
    }
    if (accepted) return { status: "accepted", value: accepted, submissions };
    return { status: "missing", submissions, diagnostics: [...diagnostics] };
  };

  const tool: ToolDefinition<typeof StructuredOutputParams> = {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    label: "Structured Output",
    description: `Submit the final JSON object. This is the only return channel in schema mode. Invalid values may be corrected, with at most ${MAX_STRUCTURED_OUTPUT_SUBMISSIONS} total submissions.`,
    promptSnippet: "Submit the final JSON object required by the caller.",
    parameters: StructuredOutputParams,
    async execute(_id, { value }) {
      if (exhaustedReason) {
        return toolResult(`StructuredOutput rejected: submission limit already exhausted (${exhaustedReason}).`, true);
      }
      submissions += 1;

      const jsonProblem = jsonCompatibilityProblem(value, "value");
      const objectValue = !jsonProblem && isObject(value) ? value : undefined;
      let problem = jsonProblem;
      if (!problem && !objectValue) problem = "value must be a JSON object at the top level";
      if (!problem && objectValue && !validate(objectValue)) problem = formatAjvErrors(validate.errors, objectValue);

      if (!problem && objectValue) {
        if (accepted) {
          exhaustedReason = "duplicate-valid";
          const duplicate = bound(`StructuredOutput rejected: a valid value was already accepted; duplicate valid submissions are not allowed. Value: ${preview(objectValue)}`);
          diagnostics.push(duplicate);
          return toolResult(duplicate, true);
        }
        accepted = structuredClone(objectValue);
        return toolResult("Structured output accepted.", true);
      }

      const diagnostic = bound(`StructuredOutput rejected (submission ${submissions}/${MAX_STRUCTURED_OUTPUT_SUBMISSIONS}): ${problem}. Value: ${preview(value)}`);
      diagnostics.push(diagnostic);
      if (submissions >= MAX_STRUCTURED_OUTPUT_SUBMISSIONS) exhaustedReason = "max-submissions";
      return toolResult(
        exhaustedReason ? `${diagnostic} No submissions remain.` : `${diagnostic} Correct the value and call StructuredOutput again.`,
        Boolean(exhaustedReason),
      );
    },
  };

  const schemaPreview = preview(schema);
  const finalReturnPrompt = [
    "MANDATORY FINAL RETURN INSTRUCTION:",
    "Assistant text is not a return value and will be ignored.",
    `Call ${STRUCTURED_OUTPUT_TOOL_NAME} exactly once with {\"value\": <object>} matching this JSON Schema Draft 2020-12 schema:`,
    schemaPreview,
    `If a submission is rejected, correct it in this same session and submit again. At most ${MAX_STRUCTURED_OUTPUT_SUBMISSIONS} submissions are allowed.`,
  ].join("\n");

  return { tool: tool as ToolDefinition, finalReturnPrompt, outcome };
}

function validateAndCloneSchema(input: StructuredOutputSchema): StructuredOutputSchema {
  const problem = jsonCompatibilityProblem(input, "schema", true);
  if (problem) throw new Error(bound(`Invalid structured output schema: ${problem}. Schema: ${preview(input)}`));
  if (!isObject(input)) throw new Error("Invalid structured output schema: schema must be a JSON object");
  if (input.type !== undefined && input.type !== "object") {
    throw new Error(bound(`Invalid structured output schema: top-level type must be \"object\". Schema: ${preview(input)}`));
  }
  // Requiring object values independently is important for schemas which only
  // use `required`; adding the type here preserves their local #/$defs refs.
  return structuredClone({ ...input, type: "object" });
}

function jsonCompatibilityProblem(value: unknown, root: string, inspectSchema = false): string | undefined {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, path: string, depth: number): string | undefined => {
    if (++nodes > MAX_SCHEMA_NODES) return `${root} exceeds ${MAX_SCHEMA_NODES} nodes`;
    if (depth > MAX_NESTING_DEPTH) return `${root} exceeds nesting depth ${MAX_NESTING_DEPTH}`;
    if (current === null || typeof current === "string" || typeof current === "boolean") return undefined;
    if (typeof current === "number") return Number.isFinite(current) ? undefined : `${path} is not a finite JSON number`;
    if (typeof current !== "object") return `${path} contains non-JSON ${typeof current}`;
    if (seen.has(current)) return `${path} contains a cycle`;
    seen.add(current);
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      return `${path} contains a non-JSON object`;
    }
    for (const [key, child] of Object.entries(current)) {
      const childPath = `${path}/${escapePointer(key)}`;
      if (inspectSchema) {
        if (key === "$async") return `${childPath} uses unsupported async validation`;
        if (key === "$data") return `${childPath} uses disabled $data references`;
        if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#"))) {
          return `${childPath} must be a local reference beginning with #`;
        }
      }
      const problem = visit(child, childPath, depth + 1);
      if (problem) return problem;
    }
    seen.delete(current);
    return undefined;
  };

  return visit(value, root, 0);
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined, value: unknown): string {
  if (!errors?.length) return `value does not match the schema`;
  const messages = errors.slice(0, 12).map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message ?? error.keyword}`;
  });
  if (errors.length > messages.length) messages.push(`…and ${errors.length - messages.length} more error(s)`);
  return bound(`value does not match the schema: ${messages.join("; ")}; schemaPath=${errors[0]!.schemaPath}; value=${preview(value)}`);
}

function toolResult(text: string, terminate: boolean) {
  return { content: [{ type: "text" as const, text: bound(text) }], details: {}, terminate };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function preview(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return bound(String(value), MAX_PREVIEW_CHARS);
    return bound(json, MAX_PREVIEW_CHARS);
  } catch {
    return "[unserializable value]";
  }
}

function bound(value: string, max = MAX_DIAGNOSTIC_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

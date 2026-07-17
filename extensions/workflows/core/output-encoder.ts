import { Buffer } from "node:buffer";
import { ENCODED_OUTPUT_SCHEMA_VERSION, MAX_OUTPUT_BINARY_BYTES, MAX_OUTPUT_BYTES, MAX_OUTPUT_COLLECTION_ITEMS, MAX_OUTPUT_DEPTH, MAX_OUTPUT_NODES, MAX_OUTPUT_STRING_BYTES } from "./limits.js";

export type TruncationReason = "depth" | "nodes" | "collection-items" | "string-bytes" | "binary-bytes" | "output-bytes";
export type EncodedOutputValue = null | boolean | number | string | EncodedOutputValue[] | { [key: string]: EncodedOutputValue };
export interface EncodedWorkflowOutput {
  schemaVersion: typeof ENCODED_OUTPUT_SCHEMA_VERSION;
  encoding: "tagged-json-v1";
  truncated: boolean;
  truncations: number;
  value: EncodedOutputValue;
}
export interface OutputEncodingLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxCollectionItems?: number;
  maxStringBytes?: number;
  maxBinaryBytes?: number;
}

/** Encode arbitrary JS output into bounded JSON while preserving object identity. */
export function encodeWorkflowOutput(input: unknown, options: OutputEncodingLimits = {}): EncodedWorkflowOutput {
  const limits = {
    // The smallest possible tagged envelope is 134 UTF-8 bytes.
    maxBytes: limit(options.maxBytes ?? MAX_OUTPUT_BYTES, "maxBytes", 134),
    maxDepth: limit(options.maxDepth ?? MAX_OUTPUT_DEPTH, "maxDepth", 1),
    maxNodes: limit(options.maxNodes ?? MAX_OUTPUT_NODES, "maxNodes", 1),
    maxCollectionItems: limit(options.maxCollectionItems ?? MAX_OUTPUT_COLLECTION_ITEMS, "maxCollectionItems", 1),
    maxStringBytes: limit(options.maxStringBytes ?? MAX_OUTPUT_STRING_BYTES, "maxStringBytes", 1),
    maxBinaryBytes: limit(options.maxBinaryBytes ?? MAX_OUTPUT_BINARY_BYTES, "maxBinaryBytes", 1),
  };
  const references = new WeakMap<object, number>();
  let nextReference = 1;
  let nodes = 0;
  let truncations = 0;

  const truncated = (reason: TruncationReason, omitted?: number): EncodedOutputValue => {
    truncations += 1;
    return omitted === undefined ? { $type: "truncated", reason } : { $type: "truncated", reason, omitted };
  };
  const text = (value: string): string | EncodedOutputValue => {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes <= limits.maxStringBytes) return value;
    truncations += 1;
    return { $type: "string", value: truncateUtf8(value, limits.maxStringBytes), truncated: true, omittedBytes: bytes - limits.maxStringBytes };
  };
  const binary = (value: Uint8Array): { data: string; truncated?: true; omittedBytes?: number } => {
    if (value.byteLength <= limits.maxBinaryBytes) return { data: Buffer.from(value).toString("base64") };
    truncations += 1;
    return {
      data: Buffer.from(value.subarray(0, limits.maxBinaryBytes)).toString("base64"),
      truncated: true,
      omittedBytes: value.byteLength - limits.maxBinaryBytes,
    };
  };

  const visit = (value: unknown, depth: number): EncodedOutputValue => {
    nodes += 1;
    if (nodes > limits.maxNodes) return truncated("nodes");
    if (depth > limits.maxDepth) return truncated("depth");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return text(value);
    if (typeof value === "number") {
      if (Number.isNaN(value)) return { $type: "number", value: "NaN" };
      if (value === Infinity) return { $type: "number", value: "Infinity" };
      if (value === -Infinity) return { $type: "number", value: "-Infinity" };
      if (Object.is(value, -0)) return { $type: "number", value: "-0" };
      return value;
    }
    if (typeof value === "bigint") return { $type: "bigint", value: value.toString(10) };
    if (value === undefined) return { $type: "undefined" };
    if (typeof value === "symbol") return { $type: "symbol", description: text(value.description ?? "") };
    if (typeof value === "function") return { $type: "function", name: text(value.name) };
    if (typeof value !== "object") return { $type: "unsupported", kind: typeof value };

    const knownReference = references.get(value);
    if (knownReference !== undefined) return { $type: "ref", id: knownReference };
    const id = nextReference++;
    references.set(value, id);

    if (value instanceof Date) {
      const timestamp = value.getTime();
      return { $type: "date", $id: id, value: Number.isFinite(timestamp) ? value.toISOString() : null };
    }
    if (value instanceof Error) {
      const output: Record<string, EncodedOutputValue> = {
        $type: "error", $id: id, name: text(value.name), message: text(value.message),
      };
      if (value.stack !== undefined) output.stack = text(value.stack);
      const cause = Object.getOwnPropertyDescriptor(value, "cause");
      if (cause && "value" in cause) output.cause = visit(cause.value, depth + 1);
      const properties = ownEntries(value, new Set(["name", "message", "stack", "cause"]), visit, depth, limits.maxCollectionItems, truncated);
      if (properties.length > 0) output.properties = properties;
      return output;
    }
    if (value instanceof Map) {
      const entries: EncodedOutputValue[] = [];
      let index = 0;
      for (const [key, item] of value) {
        if (index >= limits.maxCollectionItems) {
          entries.push(truncated("collection-items", value.size - index));
          break;
        }
        entries.push([visit(key, depth + 1), visit(item, depth + 1)]);
        index += 1;
      }
      return { $type: "map", $id: id, entries };
    }
    if (value instanceof Set) {
      const values: EncodedOutputValue[] = [];
      let index = 0;
      for (const item of value) {
        if (index >= limits.maxCollectionItems) {
          values.push(truncated("collection-items", value.size - index));
          break;
        }
        values.push(visit(item, depth + 1));
        index += 1;
      }
      return { $type: "set", $id: id, values };
    }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) {
      const bytes = new Uint8Array(value);
      return { $type: value instanceof ArrayBuffer ? "array-buffer" : "shared-array-buffer", $id: id, ...binary(bytes) };
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return {
        $type: value instanceof DataView ? "data-view" : "typed-array",
        $id: id,
        name: value.constructor.name,
        byteOffset: value.byteOffset,
        byteLength: value.byteLength,
        ...binary(bytes),
      };
    }
    if (Array.isArray(value)) {
      const values: EncodedOutputValue[] = [];
      const count = Math.min(value.length, limits.maxCollectionItems);
      for (let index = 0; index < count; index += 1) {
        if (!Object.hasOwn(value, index)) values.push({ $type: "undefined", sparse: true });
        else {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          values.push(descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : { $type: "accessor" });
        }
      }
      if (value.length > count) values.push(truncated("collection-items", value.length - count));
      return { $type: "array", $id: id, values };
    }

    let constructorName = "Object";
    try { constructorName = value.constructor?.name || "Object"; } catch { constructorName = "Object"; }
    return {
      $type: "object",
      $id: id,
      className: text(constructorName),
      entries: ownEntries(value, new Set(), visit, depth, limits.maxCollectionItems, truncated),
    };
  };

  const envelope: EncodedWorkflowOutput = {
    schemaVersion: ENCODED_OUTPUT_SCHEMA_VERSION,
    encoding: "tagged-json-v1",
    truncated: false,
    truncations: 0,
    value: visit(input, 0),
  };
  envelope.truncated = truncations > 0;
  envelope.truncations = truncations;

  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > limits.maxBytes) {
    envelope.value = { $type: "truncated", reason: "output-bytes" };
    envelope.truncated = true;
    envelope.truncations = truncations + 1;
  }
  return envelope;
}

export const encodeOutput = encodeWorkflowOutput;

export function stringifyEncodedOutput(output: EncodedWorkflowOutput): string {
  return JSON.stringify(output) + "\n";
}

function ownEntries(
  value: object,
  excluded: Set<string>,
  visit: (value: unknown, depth: number) => EncodedOutputValue,
  depth: number,
  maxItems: number,
  truncated: (reason: TruncationReason, omitted?: number) => EncodedOutputValue,
): EncodedOutputValue[] {
  const entries: EncodedOutputValue[] = [];
  let omitted = 0;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || (typeof key === "string" && excluded.has(key))) continue;
    if (entries.length >= maxItems) { omitted += 1; continue; }
    const encodedKey: EncodedOutputValue = typeof key === "string" ? key : { $type: "symbol", description: key.description ?? "" };
    const encodedValue: EncodedOutputValue = "value" in descriptor ? visit(descriptor.value, depth + 1) : { $type: "accessor" };
    entries.push([encodedKey, encodedValue]);
  }
  if (omitted > 0) entries.push(truncated("collection-items", omitted));
  return entries;
}

function truncateUtf8(value: string, bytes: number): string {
  let output = Buffer.from(value, "utf8").subarray(0, bytes).toString("utf8");
  if (output.endsWith("�")) output = output.slice(0, -1);
  while (Buffer.byteLength(output, "utf8") > bytes) output = output.slice(0, -1);
  return output;
}

function limit(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}`);
  return value;
}

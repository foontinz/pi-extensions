import { MAX_CANONICAL_JSON_DEPTH, MAX_CANONICAL_JSON_NODES } from "./limits.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export interface CanonicalJsonOptions {
  maxDepth?: number;
  maxNodes?: number;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class CanonicalJsonError extends TypeError {
  override name = "CanonicalJsonError";
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path}`);
  }
}

/** Validate and copy a value without invoking getters or user serialization hooks. */
export function cloneCanonicalJson(value: unknown, options: CanonicalJsonOptions = {}): JsonValue {
  const maxDepth = positiveInteger(options.maxDepth ?? MAX_CANONICAL_JSON_DEPTH, "maxDepth");
  const maxNodes = positiveInteger(options.maxNodes ?? MAX_CANONICAL_JSON_NODES, "maxNodes");
  const ancestors = new WeakSet<object>();
  let nodes = 0;

  const visit = (candidate: unknown, path: string, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > maxNodes) throw new CanonicalJsonError(`JSON node limit ${maxNodes} exceeded`, path);
    if (depth > maxDepth) throw new CanonicalJsonError(`JSON depth limit ${maxDepth} exceeded`, path);

    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new CanonicalJsonError("non-finite numbers are not JSON", path);
      return candidate;
    }
    if (typeof candidate === "bigint") throw new CanonicalJsonError("BigInt is not JSON", path);
    if (typeof candidate === "function") throw new CanonicalJsonError("functions are not JSON", path);
    if (typeof candidate === "symbol") throw new CanonicalJsonError("symbols are not JSON", path);
    if (candidate === undefined) throw new CanonicalJsonError("undefined is not JSON", path);
    if (typeof candidate !== "object") throw new CanonicalJsonError("value is not JSON", path);

    if (ancestors.has(candidate)) throw new CanonicalJsonError("cyclic values are not JSON", path);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new CanonicalJsonError("arrays with custom prototypes are not JSON", path);
        }
        const keys = Reflect.ownKeys(candidate);
        if (keys.some((key) => typeof key === "symbol")) throw new CanonicalJsonError("symbol properties are not JSON", path);
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.hasOwn(candidate, index)) throw new CanonicalJsonError("sparse arrays are not JSON", `${path}[${index}]`);
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new CanonicalJsonError("array accessors and hidden elements are not JSON", `${path}[${index}]`);
          }
        }
        const expected = new Set(["length", ...Array.from({ length: candidate.length }, (_, index) => String(index))]);
        if (keys.some((key) => typeof key === "string" && !expected.has(key))) {
          throw new CanonicalJsonError("arrays with extra properties are not JSON", path);
        }
        return candidate.map((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalJsonError("objects with custom prototypes are not JSON", path);
      }
      const output: { [key: string]: JsonValue } = {};
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key === "symbol") throw new CanonicalJsonError("symbol properties are not JSON", path);
        if (FORBIDDEN_KEYS.has(key)) throw new CanonicalJsonError(`forbidden object key ${JSON.stringify(key)}`, `${path}.${key}`);
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new CanonicalJsonError("accessors and non-enumerable properties are not JSON", `${path}.${key}`);
        }
        output[key] = visit(descriptor.value, propertyPath(path, key), depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(candidate);
    }
  };

  return visit(value, "$", 0);
}

export function assertCanonicalJson(value: unknown, options?: CanonicalJsonOptions): asserts value is JsonValue {
  cloneCanonicalJson(value, options);
}

export function isCanonicalJson(value: unknown, options?: CanonicalJsonOptions): value is JsonValue {
  try {
    cloneCanonicalJson(value, options);
    return true;
  } catch (error) {
    if (error instanceof CanonicalJsonError) return false;
    throw error;
  }
}

/** Alias emphasizing that the returned value is detached from its input. */
export const canonicalJsonClone = cloneCanonicalJson;
export const validateCanonicalJson = assertCanonicalJson;

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

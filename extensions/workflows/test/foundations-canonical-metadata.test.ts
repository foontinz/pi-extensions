import assert from "node:assert/strict";
import test from "node:test";
import { CanonicalJsonError, cloneCanonicalJson, isCanonicalJson } from "../core/canonical-json.js";
import { validateWorkflowInput } from "../core/input.js";
import { parseWorkflowMetadata, WorkflowMetadataError } from "../core/metadata.js";

const meta = `export const meta = {
  name: "review",
  description: "Review code",
  resumable: false,
  maxAgents: 4,
  capabilities: ["read"],
  phases: [{ id: "review", title: "Review" }],
  estimatedOutputTokens: 1000
}`;

test("canonical JSON clones plain data without invoking code", () => {
  const shared = { value: 1 };
  const input = { nested: shared, again: shared, array: [true, null, "x"] };
  const copy = cloneCanonicalJson(input) as typeof input;
  assert.deepEqual(copy, input);
  assert.notEqual(copy, input);
  assert.notEqual(copy.nested, shared);
  assert.notEqual(copy.nested, copy.again);
  let invoked = false;
  const accessor = Object.defineProperty({}, "bad", { enumerable: true, get() { invoked = true; return 1; } });
  assert.throws(() => cloneCanonicalJson(accessor), CanonicalJsonError);
  assert.equal(invoked, false);
});

test("canonical JSON rejects every non-JSON or unsafe shape", () => {
  for (const value of [undefined, 1n, () => 1, Symbol("x"), NaN, Infinity, -Infinity, new Date(), new Map(), Object.create({ inherited: true })]) {
    assert.equal(isCanonicalJson(value), false, String(value));
  }
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  assert.throws(() => cloneCanonicalJson(cyclic), /cyclic/);
  assert.throws(() => cloneCanonicalJson([, 1]), /sparse/);
  assert.throws(() => cloneCanonicalJson({ constructor: "no" }), /forbidden/);
});

test("workflow input requires exactly one source and canonical bounded args", () => {
  assert.throws(() => validateWorkflowInput({}), /exactly one/);
  assert.throws(() => validateWorkflowInput({ script: meta, scriptPath: "x" }), /exactly one/);
  const input = { script: meta, args: { value: 1 } };
  const validated = validateWorkflowInput(input);
  assert.deepEqual(validated, input);
  assert.notEqual(validated.args, input.args);
  assert.throws(() => validateWorkflowInput({ script: meta, args: { bad: Infinity } as never }), /non-finite/);
});

test("required exported metadata is first, pure, fully validated, and blanked without offset drift", () => {
  const source = `"use strict";\n${meta}\nconst marker = 1;\nawait Promise.resolve();\nreturn marker;\n`;
  const parsed = parseWorkflowMetadata(source);
  assert.equal(parsed.metadata.name, "review");
  assert.deepEqual(parsed.metadata.phases, [{ id: "review", title: "Review" }]);
  assert.equal(parsed.body.length, source.length);
  assert.equal(parsed.body.indexOf("const marker"), source.indexOf("const marker"));
  assert.equal(parsed.body.split("\n").length, source.split("\n").length);
  assert.doesNotMatch(parsed.body, /export const meta/);
});

test("metadata parser rejects missing/dynamic/ambiguous metadata and TypeScript syntax", () => {
  const invalid = [
    "return 1",
    "const x = 1; export const meta = {}",
    "export let meta = {}",
    "export const other = {}",
    "export const meta = { name: identifier }",
    "export const meta = { ...other }",
    "export const meta = { [\"name\"]: \"x\" }",
    "export const meta = { method() {} }",
    "export const meta = { name: `template` }",
    "export const meta = { name: \"x\", name: \"y\" }",
    "export const meta = { __proto__: {} }",
    "export const meta = { name: \"x\" }",
    `${meta}\nconst value: string = "typescript"`,
  ];
  for (const source of invalid) assert.throws(() => parseWorkflowMetadata(source), WorkflowMetadataError, source);
});

test("phase IDs and metadata keys are unique and closed", () => {
  assert.throws(() => parseWorkflowMetadata(meta.replace("estimatedOutputTokens: 1000", "unknown: true")), /unknown metadata key/);
  assert.throws(() => parseWorkflowMetadata(meta.replace(
    'phases: [{ id: "review", title: "Review" }]',
    'phases: [{ id: "review", title: "One" }, { id: "review", title: "Two" }]'
  )), /duplicate phase id/);
});

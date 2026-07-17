import assert from "node:assert/strict";
import test from "node:test";
import { CanonicalJsonError, cloneCanonicalJson, isCanonicalJson } from "../core/canonical-json.js";
import { parseWorkflowMetadata, WorkflowMetadataError } from "../core/metadata.js";

test("canonical JSON clones plain data without invoking code", () => {
  const shared = { value: 1 };
  const input = { nested: shared, again: shared, array: [true, null, "x"] };
  const copy = cloneCanonicalJson(input) as typeof input;
  assert.deepEqual(copy, input);
  assert.notEqual(copy, input);
  assert.notEqual(copy.nested, shared);
  assert.notEqual(copy.nested, copy.again, "JSON aliases are copied as independent values");

  let invoked = false;
  const accessor = Object.defineProperty({}, "bad", { enumerable: true, get() { invoked = true; return 1; } });
  assert.throws(() => cloneCanonicalJson(accessor), CanonicalJsonError);
  assert.equal(invoked, false);
});

test("canonical JSON rejects every non-JSON or unsafe shape", () => {
  for (const value of [undefined, 1n, () => 1, Symbol("x"), NaN, Infinity, -Infinity, new Date(), new Map(), Object.create({ inherited: true })]) {
    assert.equal(isCanonicalJson(value), false, String(value));
  }
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => cloneCanonicalJson(cyclic), /cyclic/);
  assert.throws(() => cloneCanonicalJson([, 1]), /sparse/);
  assert.throws(() => cloneCanonicalJson({ constructor: "no" }), /forbidden/);
  assert.throws(() => cloneCanonicalJson({ a: { b: 1 } }, { maxDepth: 1 }), /depth/);
});

test("metadata parser uses the first non-directive object and preserves all offsets", () => {
  const source = `"use strict";\n({\n  name: "fanout",\n  tags: ["review", "safe"],\n  budget: { maxAgents: 4 },\n  negative: -2\n});\nconst marker = 1;\nawait Promise.resolve();\nreturn marker;\n`;
  const parsed = parseWorkflowMetadata(source);
  assert.deepEqual(parsed.metadata, {
    name: "fanout", tags: ["review", "safe"], budget: { maxAgents: 4 }, negative: -2,
  });
  assert.equal(parsed.body.length, source.length);
  assert.equal(parsed.body.indexOf("const marker"), source.indexOf("const marker"));
  assert.equal(parsed.body.split("\n").length, source.split("\n").length);
  assert.match(parsed.body, /^"use strict";/);
  assert.doesNotMatch(parsed.body, /fanout/);
});

test("metadata parser rejects executable and ambiguous literal syntax", () => {
  const invalid = [
    "({ value: identifier });",
    "({ value: call() });",
    "({ ...other });",
    "({ [\"key\"]: 1 });",
    "({ method() {} });",
    "({ get value() { return 1; } });",
    "({ value: `template` });",
    "({ value: [1,,2] });",
    "({ key: 1, key: 2 });",
    "({ __proto__: {} });",
    "({ constructor: 1 });",
    "({ value: /regex/ });",
  ];
  for (const source of invalid) assert.throws(() => parseWorkflowMetadata(source), WorkflowMetadataError, source);
});

test("metadata is optional and object expressions later in the script are not metadata", () => {
  const source = "const first = true;\n({ name: 'not metadata' });\nreturn first;";
  assert.deepEqual(parseWorkflowMetadata(source), { body: source });
  assert.doesNotThrow(() => parseWorkflowMetadata("await Promise.resolve();\nreturn 1;"));
});

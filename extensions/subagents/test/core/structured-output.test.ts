import assert from "node:assert/strict";
import test from "node:test";
import {
  createStructuredOutputCapability,
  MAX_STRUCTURED_OUTPUT_SUBMISSIONS,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "../../core/structured-output.js";

const schema = {
  type: "object",
  properties: { answer: { type: "integer" } },
  required: ["answer"],
  additionalProperties: false,
};

async function submit(capability: ReturnType<typeof createStructuredOutputCapability>, value: unknown) {
  return await capability.tool.execute("call", { value } as never, undefined, undefined, {} as never);
}

test("StructuredOutput accepts the first valid object and requests termination", async () => {
  const capability = createStructuredOutputCapability({ schema });
  assert.equal(capability.tool.name, STRUCTURED_OUTPUT_TOOL_NAME);
  const result = await submit(capability, { answer: 42 });
  assert.equal(result.terminate, true);
  assert.deepEqual(capability.outcome(), {
    status: "accepted",
    value: { answer: 42 },
    submissions: 1,
  });
});

test("invalid submissions return correction errors in the same session", async () => {
  const capability = createStructuredOutputCapability({ schema });
  const invalid = await submit(capability, { answer: "forty-two" });
  assert.equal(invalid.terminate, false);
  assert.match((invalid.content[0] as { text: string }).text, /Correct the value and call StructuredOutput again/);

  const valid = await submit(capability, { answer: 42 });
  assert.equal(valid.terminate, true);
  assert.equal(capability.outcome().status, "accepted");
});

test("five invalid submissions exhaust the channel", async () => {
  const capability = createStructuredOutputCapability({ schema });
  for (let index = 1; index <= MAX_STRUCTURED_OUTPUT_SUBMISSIONS; index++) {
    const result = await submit(capability, { answer: `bad-${index}` });
    assert.equal(result.terminate, index === MAX_STRUCTURED_OUTPUT_SUBMISSIONS);
  }
  const outcome = capability.outcome();
  assert.equal(outcome.status, "exhausted");
  if (outcome.status === "exhausted") {
    assert.equal(outcome.reason, "max-submissions");
    assert.equal(outcome.submissions, 5);
  }
  const extra = await submit(capability, { answer: 42 });
  assert.equal(extra.terminate, true);
  assert.equal(capability.outcome().status, "exhausted");
});

test("duplicate valid outcome has a bounded deterministic diagnostic", async () => {
  const capability = createStructuredOutputCapability({ schema });
  await submit(capability, { answer: 1 });
  await submit(capability, { answer: 2 });
  const outcome = capability.outcome();
  assert.equal(outcome.status, "exhausted");
  if (outcome.status === "exhausted") {
    assert.equal(outcome.reason, "duplicate-valid");
    assert.equal(outcome.submissions, 2);
    assert.match(outcome.diagnostics[0] ?? "", /duplicate valid submissions/);
    assert.ok(outcome.diagnostics[0]!.length <= 2_000);
  }
});

test("validation does not coerce, apply defaults, or remove additional properties", async () => {
  const capability = createStructuredOutputCapability({
    schema: {
      type: "object",
      properties: { count: { type: "integer", default: 1 } },
      required: ["count"],
      additionalProperties: false,
    },
  });
  assert.equal((await submit(capability, { count: "1" })).terminate, false, "must not coerce");
  const missing: Record<string, unknown> = {};
  assert.equal((await submit(capability, missing)).terminate, false, "must not apply defaults");
  assert.deepEqual(missing, {});
  const additional = { count: 1, extra: true };
  assert.equal((await submit(capability, additional)).terminate, false, "must not remove properties");
  assert.deepEqual(additional, { count: 1, extra: true });
});

test("schema validation is strict Draft 2020-12 with local refs", async () => {
  const capability = createStructuredOutputCapability({
    schema: {
      type: "object",
      $defs: { item: { type: "string", minLength: 2 } },
      properties: { name: { $ref: "#/$defs/item" } },
      required: ["name"],
    },
  });
  assert.equal((await submit(capability, { name: "x" })).terminate, false);
  assert.equal((await submit(capability, { name: "ok" })).terminate, true);
});

test("rejects remote refs, custom keywords, async/$data, non-JSON schemas, cycles, and non-object roots", () => {
  assert.throws(
    () => createStructuredOutputCapability({ schema: { type: "object", properties: { x: { $ref: "https://example.test/schema" } } } }),
    /local reference/,
  );
  assert.throws(() => createStructuredOutputCapability({ schema: { type: "object", customKeyword: true } }), /strict mode|unknown keyword/);
  assert.throws(() => createStructuredOutputCapability({ schema: { type: "object", $async: true } }), /async validation/);
  assert.throws(() => createStructuredOutputCapability({ schema: { type: "object", properties: { x: { const: { $data: "1/x" } } } } }), /\$data/);
  assert.throws(() => createStructuredOutputCapability({ schema: { type: "object", value: undefined } }), /non-JSON/);
  assert.throws(() => createStructuredOutputCapability({ schema: { type: "array" } }), /top-level type/);

  const cyclic: Record<string, unknown> = { type: "object" };
  cyclic.self = cyclic;
  assert.throws(() => createStructuredOutputCapability({ schema: cyclic }), /cycle/);
});

test("submitted values must be JSON objects and diagnostics are bounded", async () => {
  const capability = createStructuredOutputCapability({ schema });
  const primitive = await submit(capability, "json text");
  assert.equal(primitive.terminate, false);
  assert.match((primitive.content[0] as { text: string }).text, /top level/);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cycle = await submit(capability, cyclic);
  const text = (cycle.content[0] as { text: string }).text;
  assert.match(text, /cycle/);
  assert.ok(text.length <= 2_000);
});

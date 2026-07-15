import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeResponsesPayload } from "../index.js";

// Mirrors the real failing payload: gpt-5.5 over VISA's Responses gateway, where
// replayed assistant/reasoning/function_call items carry `status` (and `phase`),
// which the gateway rejects with: 400 "Unknown parameter: 'input[2].status'".
function failingPayload() {
  return {
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", status: "completed", summary: [], content: [] },
      {
        type: "function_call",
        status: "completed",
        phase: "final",
        name: "bash",
        arguments: "{\"cmd\":\"echo hi\"}",
        call_id: "call_1",
      },
      { type: "function_call_output", status: "completed", call_id: "call_1", output: "hi" },
    ],
    tools: [{ type: "function", name: "bash" }],
  };
}

test("strips status/phase from every Responses input item, deeply, without mutating the original", () => {
  const original = failingPayload();
  const snapshot = JSON.stringify(original);
  const out = sanitizeResponsesPayload(original);

  assert.ok(out, "should return a sanitized payload when status/phase present");
  const json = JSON.stringify(out);
  assert.equal(json.includes("\"status\""), false, "no status field should remain");
  assert.equal(json.includes("\"phase\""), false, "no phase field should remain");

  // Non-offending content is preserved.
  assert.equal(out!.model, "gpt-5.5");
  assert.equal((out!.input[2] as any).name, "bash");
  assert.equal((out!.input[2] as any).call_id, "call_1");
  assert.deepEqual(out!.tools, [{ type: "function", name: "bash" }]);

  // Original payload is untouched (later extensions/retries still see it).
  assert.equal(JSON.stringify(original), snapshot, "input payload must not be mutated");
});

test("returns undefined when there is nothing to strip", () => {
  assert.equal(
    sanitizeResponsesPayload({ model: "gpt-5.5", input: [{ type: "message", role: "user", content: [] }] }),
    undefined,
  );
});

test("ignores non-Responses payloads (e.g. chat-completions shape)", () => {
  assert.equal(
    sanitizeResponsesPayload({ model: "x", messages: [{ role: "user", content: "hi", status: "completed" }] }),
    undefined,
  );
});

test("handles nested status inside content arrays", () => {
  const out = sanitizeResponsesPayload({
    input: [{ type: "message", content: [{ type: "output_text", text: "x", status: "in_progress" }] }],
  });
  assert.ok(out);
  assert.equal(JSON.stringify(out).includes("status"), false);
});

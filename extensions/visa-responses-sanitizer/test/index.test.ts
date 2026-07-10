import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sanitizer from "../index.js";

type RequestHandler = (event: { payload: unknown }, ctx: { model?: { provider: string; api: string } }) => unknown;

function registeredHandler(): RequestHandler {
  let handler: RequestHandler | undefined;
  sanitizer({
    on(event: string, candidate: unknown) {
      if (event === "before_provider_request") handler = candidate as RequestHandler;
    },
  } as unknown as ExtensionAPI);
  assert.ok(handler, "sanitizer should register a provider request handler");
  return handler;
}

const visaResponses = { model: { provider: "visa-openai", api: "openai-responses" } };

test("sanitizes only visa-openai openai-responses input and does not mutate the original payload", () => {
  const handler = registeredHandler();
  const payload = {
    status: "top-level-status-must-remain",
    input: [{
      type: "message",
      status: "completed",
      phase: "response",
      content: [{ type: "output_text", status: "nested", phase: "nested-phase", text: "hello" }],
      metadata: { status: "metadata-status", keep: true },
    }],
  };
  const original = structuredClone(payload);

  const result = handler({ payload }, visaResponses) as typeof payload;
  assert.notStrictEqual(result, payload);
  assert.notStrictEqual(result.input, payload.input);
  assert.deepEqual(payload, original);
  assert.equal(result.status, "top-level-status-must-remain");
  assert.deepEqual(result.input, [{
    type: "message",
    content: [{ type: "output_text", text: "hello" }],
    metadata: { keep: true },
  }]);
});

test("leaves other providers and non-Responses Visa models exactly untouched", () => {
  const handler = registeredHandler();
  const payload = { input: [{ status: "completed", phase: "response" }] };

  for (const ctx of [
    { model: { provider: "openai", api: "openai-responses" } },
    { model: { provider: "visa-openai", api: "openai-completions" } },
    { model: undefined },
  ]) {
    assert.equal(handler({ payload }, ctx), undefined);
    assert.deepEqual(payload.input[0], { status: "completed", phase: "response" });
  }
});

test("returns unchanged when no rejected fields are present and preserves __proto__ data safely when cloning", () => {
  const handler = registeredHandler();
  const untouched = { input: [{ type: "message", content: "ok" }] };
  assert.equal(handler({ payload: untouched }, visaResponses), undefined);

  const item: Record<string, unknown> = { status: "completed", nested: { keep: true } };
  Object.defineProperty(item, "__proto__", {
    value: { phase: "metadata", keep: true },
    enumerable: true,
    configurable: true,
  });
  const payload = { input: [item] };
  const result = handler({ payload }, visaResponses) as { input: Array<Record<string, unknown>> };

  assert.equal(Object.getPrototypeOf(result.input[0]), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(result.input[0], "__proto__")?.value, { keep: true });
  assert.equal(Object.getOwnPropertyDescriptor(payload.input[0], "__proto__")?.value?.phase, "metadata");
  assert.equal("status" in result.input[0], false);
});

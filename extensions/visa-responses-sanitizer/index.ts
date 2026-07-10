/**
 * visa-responses-sanitizer
 *
 * VISA's `visa-openai` Responses gateway rejects `status` and `phase` on
 * replayed Responses input items, while the upstream OpenAI API accepts them.
 * Pi's openai-responses serializer can emit those fields for assistant text and
 * reasoning items, causing errors such as:
 *
 *   400 "Unknown parameter: 'input[50].status'"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Keep this minimal: add fields only after VISA reports them as unknown.
const STRIP_FIELDS = new Set<string>(["status", "phase"]);

function isResponsesStylePayload(payload: unknown): payload is { input: unknown[] } & Record<string, unknown> {
  return !!payload && typeof payload === "object" && Array.isArray((payload as { input?: unknown }).input);
}

function containsStripField(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) return value.some((item) => containsStripField(item, seen));
  for (const [key, child] of Object.entries(value)) {
    if (STRIP_FIELDS.has(key) || containsStripField(child, seen)) return true;
  }
  return false;
}

/** Mutate only an already-cloned value, preserving arbitrary nested item shapes. */
function stripFields(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) stripFields(item, seen);
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (STRIP_FIELDS.has(key)) {
      delete record[key];
    } else {
      stripFields(record[key], seen);
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    // This is intentionally narrow. Other OpenAI-compatible Responses
    // providers may accept or require these fields, so leave them untouched.
    if (ctx.model?.provider !== "visa-openai" || ctx.model.api !== "openai-responses") return;
    if (!isResponsesStylePayload(event.payload) || !containsStripField(event.payload.input)) return;

    // Do not mutate Pi's payload or nested input items: later extensions and
    // retry paths may still observe them. structuredClone also avoids unsafe
    // object-copy handling for keys such as "__proto__".
    try {
      const input = structuredClone(event.payload.input);
      stripFields(input);
      return { ...event.payload, input };
    } catch {
      // Provider payloads are expected to be structured-cloneable. If a custom
      // extension supplied an unsupported value, fail open rather than breaking
      // the request for a sanitizer-only compatibility workaround.
      return;
    }
  });
}

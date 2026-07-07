/**
 * visa-responses-sanitizer
 *
 * VISA's openai-responses gateway (used by `visa-openai/gpt-5.4`, `gpt-5.5`,
 * etc.) rejects certain extra/unknown fields on input items that the upstream
 * OpenAI Responses API silently accepts. Pi (via @earendil-works/pi-ai's
 * openai-responses-shared.js) serializes replayed assistant messages with
 * `status: "completed"` and sometimes `phase: "..."`, and reasoning items
 * deserialized from `thinkingSignature` can also carry a `status` field.
 *
 * After ~50+ turns the replay is long enough that one of those items triggers:
 *
 *   400 "Unknown parameter: 'input[50].status'"
 *
 * This extension hooks `before_provider_request` and recursively strips the
 * problematic fields from every item in `payload.input` before the request is
 * sent. It only touches openai-responses-style payloads (those are the only
 * ones with an `input` array of items), so other providers are untouched.
 *
 * If VISA starts rejecting additional unknown fields in the future, add them
 * to STRIP_FIELDS below.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Fields the VISA proxy rejects on Responses input items but that upstream
// OpenAI tolerates. Keep this list minimal — only add a field after you see a
// `Unknown parameter: 'input[N].<field>'` error for it.
const STRIP_FIELDS = new Set<string>(["status", "phase"]);

type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { [key: string]: Json };

function stripUnknown(value: Json): Json {
	if (Array.isArray(value)) {
		return value.map(stripUnknown);
	}
	if (value && typeof value === "object") {
		const out: { [key: string]: Json } = {};
		for (const [k, v] of Object.entries(value)) {
			if (STRIP_FIELDS.has(k)) continue;
			out[k] = stripUnknown(v as Json);
		}
		return out;
	}
	return value;
}

function isResponsesStylePayload(
	payload: unknown,
): payload is { input: unknown[] } & Record<string, unknown> {
	return (
		!!payload &&
		typeof payload === "object" &&
		Array.isArray((payload as { input?: unknown }).input)
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		const payload = event.payload;
		if (!isResponsesStylePayload(payload)) return;

		// Only sanitize the `input` array — leave top-level fields (model, tools,
		// reasoning, etc.) untouched so we don't accidentally remove `status`
		// from anywhere the API actually expects it.
		const sanitizedInput = (payload.input as Json[]).map(stripUnknown);

		// Fast-path: if nothing changed, don't allocate a new payload.
		if (sanitizedInput === payload.input) return;

		return { ...payload, input: sanitizedInput };
	});
}

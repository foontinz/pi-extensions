import assert from "node:assert/strict";
import test from "node:test";
import { calculateTps, registerTpsStatus } from "./tps-status.ts";

function harness(initialMode: "fast" | "standard" = "standard") {
	const events = new Map<string, Function[]>();
	let mode = initialMode;
	let now = 1_000;
	const statuses: Array<string | undefined> = [];
	const pi = {
		on(name: string, handler: Function) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
	} as any;
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (id: string, value: string | undefined) => {
				assert.equal(id, "tps");
				statuses.push(value);
			},
		},
	} as any;
	const controller = registerTpsStatus(pi, () => mode, () => now);
	const emit = async (name: string, event: unknown = {}) => {
		for (const handler of events.get(name) ?? []) await handler(event, ctx);
	};
	return {
		ctx,
		controller,
		statuses,
		emit,
		advance: (ms: number) => { now += ms; },
		setMode: (next: "fast" | "standard") => { mode = next; },
	};
}

test("calculates finite TPS only from valid token and timing data", () => {
	assert.equal(calculateTps(80, 2_000), 40);
	assert.equal(calculateTps(0, 500), 0);
	assert.equal(calculateTps(-1, 500), undefined);
	assert.equal(calculateTps(Number.NaN, 500), undefined);
	assert.equal(calculateTps(10, 0), undefined);
	assert.equal(calculateTps(10, Number.NaN), undefined);
});

test("shows a polished placeholder then measures a completed assistant response", async () => {
	const h = harness("standard");
	h.controller.refresh(h.ctx);
	assert.equal(h.statuses.at(-1), "— TPS");

	await h.emit("message_start", { message: { role: "assistant" } });
	h.advance(2_000);
	await h.emit("message_end", { message: { role: "assistant", usage: { output: 85 } } });
	assert.equal(h.statuses.at(-1), "42.5 TPS");
});

test("retains separate latest measurements for fast and standard modes", async () => {
	const h = harness("standard");
	await h.emit("message_start", { message: { role: "assistant" } });
	h.advance(1_000);
	await h.emit("message_end", { message: { role: "assistant", usage: { output: 20 } } });

	h.setMode("fast");
	h.controller.refresh(h.ctx);
	assert.equal(h.statuses.at(-1), "— TPS");
	await h.emit("message_start", { message: { role: "assistant" } });
	h.advance(500);
	await h.emit("message_end", { message: { role: "assistant", usage: { output: 60 } } });
	assert.equal(h.statuses.at(-1), "120 TPS");

	h.setMode("standard");
	h.controller.refresh(h.ctx);
	assert.equal(h.statuses.at(-1), "20.0 TPS");
});

test("invalid or incomplete assistant timing degrades gracefully", async () => {
	const h = harness();
	await h.emit("message_end", { message: { role: "assistant", usage: { output: 100 } } });
	assert.equal(h.statuses.at(-1), "— TPS");
	await h.emit("message_start", { message: { role: "assistant" } });
	await h.emit("message_end", { message: { role: "assistant", usage: {} } });
	assert.equal(h.statuses.at(-1), "— TPS");
	await h.emit("session_shutdown");
	assert.equal(h.statuses.at(-1), undefined);
});

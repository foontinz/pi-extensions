import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import openRouterProvider from "../index";

test("registers the reasoning model while the async factory is awaited", async () => {
	const providerRegistrations: Array<{ name: string; config: Record<string, unknown> }> = [];
	const eventHandlers = new Map<string, Array<(event: unknown) => Promise<unknown> | unknown>>();
	const previousApiKey = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "test-openrouter-key";

	const pi = {
		registerProvider(name: string, config: Record<string, unknown>) {
			providerRegistrations.push({ name, config });
		},
		on() {},
		events: {
			on(event: string, handler: (event: unknown) => Promise<unknown> | unknown) {
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(handler);
				eventHandlers.set(event, handlers);
			},
		},
	} as unknown as ExtensionAPI;

	try {
		await openRouterProvider(pi);

		assert.equal(providerRegistrations.length, 1);
		const registration = providerRegistrations[0];
		assert.equal(registration.name, "openrouter-free");
		assert.equal(registration.config.apiKey, "test-openrouter-key");

		const models = registration.config.models as Array<{ reasoning: boolean }>;
		assert.equal(models[0]?.reasoning, true);

		for (const handler of eventHandlers.get("envvars:changed") ?? []) {
			await handler({ name: "OPENROUTER_API_KEY" });
		}
		assert.equal(providerRegistrations.length, 2);
	} finally {
		if (previousApiKey === undefined) {
			delete process.env.OPENROUTER_API_KEY;
		} else {
			process.env.OPENROUTER_API_KEY = previousApiKey;
		}
	}
});

test("registers with the environment fallback when no key exists on a non-macOS platform", async () => {
	const providerRegistrations: Array<{ name: string; config: Record<string, unknown> }> = [];
	const previousApiKey = process.env.OPENROUTER_API_KEY;
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	delete process.env.OPENROUTER_API_KEY;
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });

	const pi = {
		registerProvider(name: string, config: Record<string, unknown>) {
			providerRegistrations.push({ name, config });
		},
		on() {},
		events: {
			on() {
				return () => undefined;
			},
		},
	} as unknown as ExtensionAPI;

	try {
		await openRouterProvider(pi);

		assert.equal(providerRegistrations.length, 1);
		assert.equal(providerRegistrations[0]?.config.apiKey, "$OPENROUTER_API_KEY");
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		if (previousApiKey === undefined) {
			delete process.env.OPENROUTER_API_KEY;
		} else {
			process.env.OPENROUTER_API_KEY = previousApiKey;
		}
	}
});

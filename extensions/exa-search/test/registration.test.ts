import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRegisteredHandles } from "../../code-runner/hooks";
import { getRegisteredEnvVar } from "../../envvars/hooks";
import exaSearch from "../index";
import { installExaSearch } from "../registration";

test("loading the Exa module does not register anything before its factory runs", () => {
	assert.equal(getRegisteredEnvVar("EXA_API_KEY"), undefined);
	assert.equal(getRegisteredHandles().some((handle) => handle.name === "exa"), false);
});

test("registers Exa from the factory and removes both registrations on session shutdown", async () => {
	const lifecycle = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const managed: string[] = [];
	const codeHandles: string[] = [];
	const removedManaged: string[] = [];
	const removedCodeHandles: string[] = [];
	const statuses: Array<{ name: string; statusId: string }> = [];
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		},
	} as unknown as ExtensionAPI;

	installExaSearch(pi, {
		registerManagedEnvVar(config) {
			managed.push(config.name);
			return config;
		},
		unregisterManagedEnvVar(name) {
			removedManaged.push(name);
			return true;
		},
		installEnvVarStatus(_pi, options) {
			statuses.push({ name: options.name, statusId: options.statusId });
		},
		registerCodeHandle(handle) {
			codeHandles.push(handle.name);
			assert.equal(handle.envVars?.[0], "EXA_API_KEY");
		},
		unregisterCodeHandle(name) {
			removedCodeHandles.push(name);
		},
	});

	assert.deepEqual(managed, ["EXA_API_KEY"]);
	assert.deepEqual(codeHandles, ["exa"]);
	assert.deepEqual(statuses, [{ name: "EXA_API_KEY", statusId: "exa-search" }]);

	for (const shutdown of lifecycle.get("session_shutdown") ?? []) {
		await shutdown();
		await shutdown();
	}
	assert.deepEqual(removedCodeHandles, ["exa"]);
	assert.deepEqual(removedManaged, ["EXA_API_KEY"]);
});

test("the public Exa factory registers and removes actual shared registrations", async () => {
	const lifecycle = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		},
		events: {
			on() {
				return () => undefined;
			},
			emit() {},
		},
	} as unknown as ExtensionAPI;

	exaSearch(pi);
	assert.equal(getRegisteredEnvVar("EXA_API_KEY")?.name, "EXA_API_KEY");
	assert.equal(getRegisteredHandles().some((handle) => handle.name === "exa"), true);

	for (const shutdown of lifecycle.get("session_shutdown") ?? []) {
		await shutdown({}, { hasUI: false });
	}
	assert.equal(getRegisteredEnvVar("EXA_API_KEY"), undefined);
	assert.equal(getRegisteredHandles().some((handle) => handle.name === "exa"), false);
});

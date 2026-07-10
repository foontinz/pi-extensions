import assert from "node:assert/strict";
import { access, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	cleanupStaleManagedEnvVarRegistrations,
	getRegisteredEnvVar,
	installEnvVarStatus,
	onEnvVarChanged,
	unregisterManagedEnvVar,
} from "../hooks";

function createPiHarness() {
	const lifecycle = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const listeners = new Map<string, Array<(event: unknown) => Promise<void> | void>>();
	let unsubscribeCalls = 0;
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		},
		events: {
			on(event: string, handler: (data: unknown) => Promise<void> | void) {
				const handlers = listeners.get(event) ?? [];
				handlers.push(handler);
				listeners.set(event, handlers);
				return () => {
					unsubscribeCalls++;
				};
			},
			emit() {},
		},
	} as unknown as ExtensionAPI;
	return { pi, lifecycle, listeners, get unsubscribeCalls() { return unsubscribeCalls; } };
}

test("env-var change listeners unsubscribe during session shutdown", async () => {
	const harness = createPiHarness();
	let calls = 0;
	onEnvVarChanged(harness.pi, "TEST_API_KEY", () => {
		calls++;
	});

	const listener = harness.listeners.get("envvars:changed")?.[0];
	await listener?.({ name: "TEST_API_KEY" });
	assert.equal(calls, 1);

	for (const shutdown of harness.lifecycle.get("session_shutdown") ?? []) {
		await shutdown();
	}
	assert.equal(harness.unsubscribeCalls, 1);
	await listener?.({ name: "TEST_API_KEY" });
	assert.equal(calls, 1, "a queued stale listener becomes inert after shutdown");
});

test("in-flight status refreshes cannot restore status after session shutdown", async () => {
	const harness = createPiHarness();
	const statuses: Array<[string, string | undefined]> = [];
	let resolveSource: ((source: "env" | undefined) => void) | undefined;
	let sourceStarted: (() => void) | undefined;
	const source = new Promise<"env" | undefined>((resolve) => { resolveSource = resolve; });
	const started = new Promise<void>((resolve) => { sourceStarted = resolve; });
	installEnvVarStatus(harness.pi, {
		name: "TEST_IN_FLIGHT_KEY",
		statusId: "test-in-flight-status",
		label: "Test key",
		getSource: async () => {
			sourceStarted?.();
			return source;
		},
	});
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (id: string, value: string | undefined) => statuses.push([id, value]),
			theme: { fg: (_color: string, value: string) => value },
		},
	};

	try {
		const refresh = harness.lifecycle.get("session_start")?.[0]?.({}, ctx);
		await started;
		for (const shutdown of harness.lifecycle.get("session_shutdown") ?? []) {
			await shutdown({}, ctx);
		}
		resolveSource?.("env");
		await refresh;
		assert.deepEqual(statuses, [["test-in-flight-status", undefined]]);
	} finally {
		unregisterManagedEnvVar("TEST_IN_FLIGHT_KEY");
	}
});

test("status installations clear their status and dispose their event listener on shutdown", async () => {
	const harness = createPiHarness();
	const statuses: Array<[string, string | undefined]> = [];
	installEnvVarStatus(harness.pi, { name: "TEST_STATUS_KEY", statusId: "test-status", label: "Test key" });

	try {
		for (const shutdown of harness.lifecycle.get("session_shutdown") ?? []) {
			await shutdown({}, {
				hasUI: true,
				ui: { setStatus: (id: string, value: string | undefined) => statuses.push([id, value]) },
			});
		}
		assert.equal(harness.unsubscribeCalls, 1);
		assert.equal(getRegisteredEnvVar("TEST_STATUS_KEY"), undefined);
		assert.deepEqual(statuses, [["test-status", undefined]]);
	} finally {
		unregisterManagedEnvVar("TEST_STATUS_KEY");
	}
});

test("cleans registry files that belong to dead Pi processes", async () => {
	const registryDirectory = dirname(new URL("../hooks.ts", import.meta.url).pathname);
	const staleFile = join(registryDirectory, ".envvar-registry.999999999.json");
	await writeFile(staleFile, JSON.stringify({ pid: 999_999_999, vars: [] }), "utf8");

	cleanupStaleManagedEnvVarRegistrations();
	await assert.rejects(() => access(staleFile));
	await rm(staleFile, { force: true });
});

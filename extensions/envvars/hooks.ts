import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getEnvVar, validateEnvVarName } from "./store";

export type EnvVarSource = "env" | "keychain" | undefined;

export interface ManagedEnvVar {
	name: string;
	label?: string;
	description?: string;
}

export interface EnvVarStatusOptions {
	name: string;
	statusId: string;
	label: string;
	missingHint?: string;
	showWhenPresent?: boolean;
	/** Allows callers that own the source to supply it without a Keychain lookup. */
	getSource?: (name: string) => Promise<EnvVarSource>;
}

interface RegistryFileShape {
	pid: number;
	vars: ManagedEnvVar[];
}

const REGISTRY_DIRECTORY = dirname(fileURLToPathCompat(import.meta.url));
const REGISTRY_FILE = join(REGISTRY_DIRECTORY, `.envvar-registry.${process.pid}.json`);
const REGISTRY_FILE_PATTERN = /^\.envvar-registry\.(\d+)\.json(?:\..+)?$/;

export function registerManagedEnvVar(config: string | ManagedEnvVar): ManagedEnvVar {
	cleanupStaleManagedEnvVarRegistrations();
	const normalized = typeof config === "string" ? { name: config } : config;
	const name = normalized.name.toUpperCase();
	validateEnvVarName(name);

	const registry = readRegistry();
	const merged = {
		...registry.get(name),
		...normalized,
		name,
	};
	registry.set(name, merged);
	writeRegistryAtomic(registry);
	return merged;
}

export function unregisterManagedEnvVar(name: string): boolean {
	cleanupStaleManagedEnvVarRegistrations();
	const normalizedName = name.toUpperCase();
	validateEnvVarName(normalizedName);
	const registry = readRegistry();
	const removed = registry.delete(normalizedName);
	if (removed) writeRegistryAtomic(registry);
	return removed;
}

export function listRegisteredEnvVars(): ManagedEnvVar[] {
	cleanupStaleManagedEnvVarRegistrations();
	return [...readRegistry().values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getRegisteredEnvVar(name: string): ManagedEnvVar | undefined {
	cleanupStaleManagedEnvVarRegistrations();
	return readRegistry().get(name.toUpperCase());
}

/**
 * @deprecated Registrations are owned by their extension and should be removed
 * with unregisterManagedEnvVar() during session shutdown. This remains for
 * compatibility with older callers, but extensions must not call it on load.
 */
export function clearManagedEnvVarRegistrations(): void {
	writeRegistryAtomic(new Map());
}

/** Remove registry files left behind by Pi processes that are no longer running. */
export function cleanupStaleManagedEnvVarRegistrations(): void {
	try {
		for (const entry of readdirSync(REGISTRY_DIRECTORY)) {
			const match = REGISTRY_FILE_PATTERN.exec(entry);
			if (!match) continue;
			const pid = Number(match[1]);
			if (pid === process.pid || isProcessRunning(pid)) continue;
			try {
				unlinkSync(join(REGISTRY_DIRECTORY, entry));
			} catch {
				// Another process may have cleaned the same stale entry.
			}
		}
	} catch {
		// A registry is only a convenience index; failure to clean old files
		// must not prevent an extension from registering its own variable.
	}
}

export async function getEnvVarSource(name: string): Promise<EnvVarSource> {
	validateEnvVarName(name);
	if (process.env[name]) return "env";
	try {
		return (await getEnvVar(name)) ? "keychain" : undefined;
	} catch {
		// Keychain storage is optional and unavailable off macOS. Status UI must
		// report a missing value rather than failing session_start.
		return undefined;
	}
}

/**
 * Subscribe to changes for one variable. The listener is automatically removed
 * when its extension session shuts down; callers may also dispose it earlier.
 */
export function onEnvVarChanged(pi: ExtensionAPI, name: string, handler: () => Promise<void> | void): () => void {
	const normalizedName = name.toUpperCase();
	validateEnvVarName(normalizedName);
	let disposed = false;
	const unsubscribe = pi.events.on("envvars:changed", async (event: unknown) => {
		if (disposed || !isEnvVarChangedEvent(event) || event.name !== normalizedName) return;
		await handler();
	});
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
	};
	pi.on("session_shutdown", dispose);
	return dispose;
}

export function installEnvVarStatus(pi: ExtensionAPI, options: EnvVarStatusOptions): void {
	const registration = registerManagedEnvVar({ name: options.name, label: options.label });
	let lastCtx: ExtensionContext | undefined;
	let active = true;
	let generation = 0;

	const refresh = async (ctx: ExtensionContext) => {
		const refreshGeneration = generation;
		const source = await (options.getSource ?? getEnvVarSource)(registration.name);
		// A Keychain lookup may finish after shutdown. Do not let that stale
		// refresh restore a status which shutdown has already cleared.
		if (!active || refreshGeneration !== generation || !ctx.hasUI) return;
		ctx.ui.setStatus(
			options.statusId,
			source
				? options.showWhenPresent
					? ctx.ui.theme.fg("accent", `${options.label}: ${source}`)
					: undefined
				: ctx.ui.theme.fg("warning", `${options.label}: missing (${options.missingHint ?? `/envvars set ${registration.name}`})`),
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		active = true;
		generation++;
		lastCtx = ctx;
		await refresh(ctx);
	});

	onEnvVarChanged(pi, registration.name, async () => {
		if (!lastCtx) return;
		await refresh(lastCtx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		active = false;
		generation++;
		lastCtx = undefined;
		unregisterManagedEnvVar(registration.name);
		if (ctx.hasUI) ctx.ui.setStatus(options.statusId, undefined);
	});
}

function isEnvVarChangedEvent(event: unknown): event is { name: string } {
	return typeof event === "object" && event !== null && "name" in event && typeof event.name === "string";
}

function readRegistry(): Map<string, ManagedEnvVar> {
	try {
		const data = readFileSync(REGISTRY_FILE, "utf8");
		const parsed = JSON.parse(data) as RegistryFileShape;
		if (!parsed || parsed.pid !== process.pid || !Array.isArray(parsed.vars)) return new Map();
		return new Map(parsed.vars.map((envVar) => [envVar.name, envVar]));
	} catch {
		return new Map();
	}
}

function writeRegistryAtomic(registry: Map<string, ManagedEnvVar>): void {
	mkdirSync(REGISTRY_DIRECTORY, { recursive: true });
	if (registry.size === 0) {
		try {
			unlinkSync(REGISTRY_FILE);
		} catch {
			// There may be no file yet, which is already the desired state.
		}
		return;
	}
	const tmp = `${REGISTRY_FILE}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	const payload: RegistryFileShape = {
		pid: process.pid,
		vars: [...registry.values()].sort((a, b) => a.name.localeCompare(b.name)),
	};
	writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
	renameSync(tmp, REGISTRY_FILE);
}

function isProcessRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function fileURLToPathCompat(url: string): string {
	if (url.startsWith("file://")) {
		return decodeURIComponent(new URL(url).pathname);
	}
	return url;
}

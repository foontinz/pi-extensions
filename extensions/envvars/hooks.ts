import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
}

const registry = new Map<string, ManagedEnvVar>();

export function registerManagedEnvVar(config: string | ManagedEnvVar): ManagedEnvVar {
	const normalized = typeof config === "string" ? { name: config } : config;
	const name = normalized.name.toUpperCase();
	validateEnvVarName(name);

	const merged = {
		...registry.get(name),
		...normalized,
		name,
	};
	registry.set(name, merged);
	return merged;
}

export function listRegisteredEnvVars(): ManagedEnvVar[] {
	return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getRegisteredEnvVar(name: string): ManagedEnvVar | undefined {
	return registry.get(name.toUpperCase());
}

export async function getEnvVarSource(name: string): Promise<EnvVarSource> {
	validateEnvVarName(name);
	if (process.env[name]) return "env";
	return (await getEnvVar(name)) ? "keychain" : undefined;
}

export function onEnvVarChanged(pi: ExtensionAPI, name: string, handler: () => Promise<void> | void): void {
	const normalizedName = name.toUpperCase();
	validateEnvVarName(normalizedName);
	pi.events.on("envvars:changed", async (event: unknown) => {
		if (!event || typeof event !== "object" || !("name" in event) || event.name !== normalizedName) return;
		await handler();
	});
}

export function installEnvVarStatus(pi: ExtensionAPI, options: EnvVarStatusOptions): void {
	const registration = registerManagedEnvVar({ name: options.name, label: options.label });
	let lastCtx: ExtensionContext | undefined;

	const refresh = async (ctx: ExtensionContext) => {
		const source = await getEnvVarSource(registration.name);
		if (!ctx.hasUI) return;
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
		lastCtx = ctx;
		await refresh(ctx);
	});

	onEnvVarChanged(pi, registration.name, async () => {
		if (!lastCtx) return;
		await refresh(lastCtx);
	});
}

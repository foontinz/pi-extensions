import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { clearManagedEnvVarRegistrations, listRegisteredEnvVars } from "./hooks";
import {
	clearStoredEnvVar,
	getEnvVar,
	listStoredEnvVars,
	loadStoredEnvVar,
	maskSecret,
	saveStoredEnvVar,
	validateEnvVarName,
} from "./store";

clearManagedEnvVarRegistrations();

export default function (pi: ExtensionAPI) {
	const getRegisteredNames = (): string[] => listRegisteredEnvVars().map((item) => item.name);

	const getStoredNames = async (): Promise<string[]> => listStoredEnvVars().catch(() => [] as string[]);

	const getKnownNames = async () => {
		const stored = await getStoredNames();
		const registered = getRegisteredNames();
		return Array.from(new Set([...registered, ...stored])).sort();
	};

	pi.registerCommand("envvars", {
		description: "Manage API keys and other env vars stored in the macOS Keychain",
		getArgumentCompletions: async (prefix) => {
			const parts = prefix.trim().split(/\s+/).filter(Boolean);
			if (parts.length <= 1) {
				const actions = ["list", "show", "set", "clear"];
				const partial = parts[0] ?? "";
				const matches = actions.filter((action) => action.startsWith(partial));
				return matches.length > 0 ? matches.map((action) => ({ value: action, label: action })) : null;
			}

			const [action, namePrefix = ""] = parts;
			if (!["show", "set", "clear"].includes(action)) return null;
			const known = await getKnownNames();
			const matches = known.filter((name) => name.startsWith(namePrefix.toUpperCase()));
			return matches.length > 0 ? matches.map((name) => ({ value: `${action} ${name}`, label: `${action} ${name}` })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [actionRaw = "list", nameRaw, ...rest] = trimmed ? trimmed.split(/\s+/) : [];
			const action = actionRaw || "list";

			if (action === "list") {
				const stored = await getStoredNames();
				const registered = getRegisteredNames();
				const staleStored = stored.filter((name) => !registered.includes(name));
				if (registered.length === 0 && staleStored.length === 0) {
					ctx.ui.notify("No managed env vars", "info");
					return;
				}

				const lines: string[] = [];
				if (registered.length > 0) {
					lines.push("Registered env vars:");
					for (const name of registered) {
						const hasEnv = Boolean(process.env[name]);
						const hasStored = stored.includes(name);
						const source = hasEnv ? "env" : hasStored ? "keychain" : "known";
						lines.push(`- ${name} (${source})`);
					}
				}

				if (staleStored.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push("Unregistered stored env vars:");
					for (const name of staleStored) {
						lines.push(`- ${name} (keychain, unregistered)`);
					}
					lines.push("Clear these with /envvars clear NAME if they are no longer needed.");
				}

				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (!nameRaw) {
				ctx.ui.notify("Usage: /envvars <list|show|set|clear> [NAME] [VALUE]", "warning");
				return;
			}

			const name = nameRaw.toUpperCase();
			validateEnvVarName(name);

			if (action === "show") {
				const envValue = process.env[name];
				const storedValue = await loadStoredEnvVar(name);
				const activeValue = await getEnvVar(name);
				ctx.ui.notify(
					[
						envValue ? `Environment value: ${maskSecret(envValue)}` : "Environment value: not set",
						storedValue ? `Keychain value: ${maskSecret(storedValue)}` : "Keychain value: not set",
						`Active source: ${process.env[name] ? "env" : storedValue ? "keychain" : "none"}`,
						activeValue ? `Active value: ${maskSecret(activeValue)}` : "Active value: not set",
					].join("\n"),
					"info",
				);
				return;
			}

			if (action === "clear") {
				const ok = !ctx.hasUI || (await ctx.ui.confirm("Clear env var", `Delete ${name} from the macOS Keychain?`));
				if (!ok) return;
				await clearStoredEnvVar(name);
				pi.events.emit("envvars:changed", { name, action: "clear" as const });
				ctx.ui.notify(`Cleared ${name} from macOS Keychain`, "info");
				return;
			}

			if (action !== "set") {
				ctx.ui.notify(`Unknown action: ${action}. Use list, show, set, or clear.`, "warning");
				return;
			}

			const inlineValue = rest.join(" ").trim();
			const value = inlineValue || (await ctx.ui.input(`Set ${name}`, `Enter a value to store for ${name} in the macOS Keychain`));
			if (!value?.trim()) {
				ctx.ui.notify("No value entered", "warning");
				return;
			}

			await saveStoredEnvVar(name, value.trim());
			pi.events.emit("envvars:changed", { name, action: "set" as const });
			ctx.ui.notify(`Stored ${name} in macOS Keychain`, "info");
		},
	});
}

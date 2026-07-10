import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installEnvVarStatus, onEnvVarChanged, registerManagedEnvVar } from "pi-extension-envvars/hooks";
import { getEnvVar } from "pi-extension-envvars/store";

const PROVIDER_NAME = "openrouter-free";
const API_KEY_ENV_VAR = "OPENROUTER_API_KEY";
const API_KEY_FALLBACK = "$OPENROUTER_API_KEY";

const MODELS = [
	{
		id: "liquid/lfm-2.5-1.2b-thinking:free",
		name: "Liquid LFM 2.5 1.2B Thinking (Free)",
		reasoning: true,
		input: ["text" as "text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 8192,
	},
];

export default async function (pi: ExtensionAPI) {
	registerManagedEnvVar({
		name: API_KEY_ENV_VAR,
		label: "OpenRouter key",
		description: "API key used by the openrouter-free provider",
	});
	installEnvVarStatus(pi, {
		name: API_KEY_ENV_VAR,
		statusId: "openrouter-free",
		label: "OpenRouter key",
	});

	const register = async () => {
		pi.registerProvider(PROVIDER_NAME, {
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: await resolveApiKey(),
			api: "openai-completions",
			headers: {
				"HTTP-Referer": "https://github.com/earendil-works/pi-mono",
				"X-Title": "pi openrouter extension",
			},
			models: MODELS,
		});
	};

	// Pi awaits async factories before startup and --list-models output.
	await register();

	onEnvVarChanged(pi, API_KEY_ENV_VAR, register);
}

async function resolveApiKey(): Promise<string> {
	const environmentKey = process.env[API_KEY_ENV_VAR];
	if (environmentKey !== undefined) return environmentKey;

	// The envvars store is backed by the macOS Keychain. Do not invoke it on
	// platforms where it is unavailable, and let Pi's environment expansion
	// resolve the key when no stored credential is available.
	if (process.platform !== "darwin") return API_KEY_FALLBACK;
	try {
		return (await getEnvVar(API_KEY_ENV_VAR)) ?? API_KEY_FALLBACK;
	} catch {
		return API_KEY_FALLBACK;
	}
}

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installEnvVarStatus, onEnvVarChanged, registerManagedEnvVar } from "pi-extension-envvars/hooks";
import { getEnvVar } from "pi-extension-envvars/store";

const PROVIDER_NAME = "openrouter-free";

const MODELS = [
	{
		id: "liquid/lfm-2.5-1.2b-thinking:free",
		name: "Liquid LFM 2.5 1.2B Thinking (Free)",
		reasoning: false,
		input: ["text" as "text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 8192,
	},
];

export default function (pi: ExtensionAPI) {
	registerManagedEnvVar({
		name: "OPENROUTER_API_KEY",
		label: "OpenRouter key",
		description: "API key used by the openrouter-free provider",
	});
	installEnvVarStatus(pi, {
		name: "OPENROUTER_API_KEY",
		statusId: "openrouter-free",
		label: "OpenRouter key",
	});

	const register = async () => {
		const apiKey = await getEnvVar("OPENROUTER_API_KEY");
		pi.registerProvider(PROVIDER_NAME, {
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: apiKey ?? "OPENROUTER_API_KEY",
			api: "openai-completions",
			headers: {
				"HTTP-Referer": "https://github.com/mariozechner/pi-coding-agent",
				"X-Title": "pi openrouter extension",
			},
			models: MODELS,
		});
	};

	pi.on("session_start", async () => {
		await register();
	});

	onEnvVarChanged(pi, "OPENROUTER_API_KEY", async () => {
		await register();
	});
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_ID = "fast-mode";
const PREFS_PATH = join(homedir(), ".pi", "agent", "fast-mode.json");

type SupportedMode =
	| {
		provider: "anthropic";
		id: "claude-opus-4-6" | "claude-opus-4-7";
		enabledTier: "auto";
		disabledTier: "standard_only";
	}
	| {
		provider: "openai-codex";
		id: "gpt-5.4";
		enabledTier: "priority";
		disabledTier: "default";
	};

interface FastModePrefs {
	version: 1;
	perModel: Record<string, boolean>;
}

const DEFAULT_PREFS: FastModePrefs = {
	version: 1,
	perModel: {},
};

const SUPPORTED_MODELS: SupportedMode[] = [
	{ provider: "anthropic", id: "claude-opus-4-6", enabledTier: "auto", disabledTier: "standard_only" },
	{ provider: "anthropic", id: "claude-opus-4-7", enabledTier: "auto", disabledTier: "standard_only" },
	{ provider: "openai-codex", id: "gpt-5.4", enabledTier: "priority", disabledTier: "default" },
];

export default function (pi: ExtensionAPI) {
	let prefs: FastModePrefs = { ...DEFAULT_PREFS, perModel: {} };

	const refreshStatus = (ctx: ExtensionContext | ExtensionCommandContext) => {
		const supported = getSupportedMode(ctx.model);
		if (!supported) {
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}
		const enabled = isFastEnabled(prefs, ctx.model);
		ctx.ui.setStatus(STATUS_ID, enabled ? `↯ fast ${ctx.model!.id}` : `fast off ${ctx.model!.id}`);
	};

	pi.on("session_start", async (_event, ctx) => {
		prefs = await loadPrefs();
		refreshStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		refreshStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const supported = getSupportedMode(ctx.model);
		if (!supported || !isRecord(event.payload)) {
			return;
		}

		const payload = { ...event.payload };
		payload.service_tier = isFastEnabled(prefs, ctx.model) ? supported.enabledTier : supported.disabledTier;
		return payload;
	});

	pi.registerCommand("fast", {
		description: "Toggle fast mode for supported models (claude-opus-4-6, claude-opus-4-7, gpt-5.4)",
		handler: async (_args, ctx) => {
			prefs = await loadPrefs();
			const supported = getSupportedMode(ctx.model);
			if (!ctx.model || !supported) {
				ctx.ui.notify(
					"Fast mode is only available for anthropic/claude-opus-4-6, anthropic/claude-opus-4-7, and openai-codex/gpt-5.4.",
					"info",
				);
				refreshStatus(ctx);
				return;
			}

			const key = getModelKey(ctx.model);
			const next = !isFastEnabled(prefs, ctx.model);
			prefs = {
				...prefs,
				perModel: {
					...prefs.perModel,
					[key]: next,
				},
			};
			await savePrefs(prefs);
			refreshStatus(ctx);
			ctx.ui.notify(
				next
					? `Fast mode ON for ${key}. Requests will use service_tier=${supported.enabledTier}.`
					: `Fast mode OFF for ${key}. Requests will use service_tier=${supported.disabledTier}.`,
				"info",
			);
		},
	});
}

function getSupportedMode(model: Model<any> | undefined): SupportedMode | undefined {
	if (!model) return undefined;
	return SUPPORTED_MODELS.find((entry) => entry.provider === model.provider && entry.id === model.id);
}

function getModelKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function isFastEnabled(prefs: FastModePrefs, model: Model<any> | undefined): boolean {
	if (!model) return false;
	return prefs.perModel[getModelKey(model)] === true;
}

async function loadPrefs(): Promise<FastModePrefs> {
	try {
		const raw = await readFile(PREFS_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<FastModePrefs>;
		return {
			version: 1,
			perModel: isRecord(parsed.perModel) ? coerceBooleanRecord(parsed.perModel) : {},
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...DEFAULT_PREFS, perModel: {} };
		}
		return { ...DEFAULT_PREFS, perModel: {} };
	}
}

async function savePrefs(prefs: FastModePrefs): Promise<void> {
	await mkdir(dirname(PREFS_PATH), { recursive: true });
	await writeFile(PREFS_PATH, `${JSON.stringify(prefs, null, "\t")}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceBooleanRecord(input: Record<string, unknown>): Record<string, boolean> {
	const output: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(input)) {
		if (typeof value === "boolean") {
			output[key] = value;
		}
	}
	return output;
}

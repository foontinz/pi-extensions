import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTpsStatus } from "./tps-status.ts";

const PREFS_FILE_NAME = "fast-mode.json";
const PREFS_LOCK_SUFFIX = ".fast-mode.lock";
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 60_000;

type SupportedMode =
	| {
		provider: "anthropic";
		id: "claude-opus-4-6" | "claude-opus-4-7" | "claude-opus-4-8";
		enabledTier: "auto";
		disabledTier: "standard_only";
	}
	| {
		provider: "openai";
		id: string;
		enabledTier: "fast";
		disabledTier?: undefined;
	}
	| {
		provider: "openai-codex";
		id: string;
		enabledTier: "priority";
		disabledTier?: undefined;
	};

interface LockOwner {
	pid?: number;
	token?: string;
}

interface FastModePrefs {
	version: 1;
	perModel: Record<string, boolean>;
}

type PrefsDocument = FastModePrefs & Record<string, unknown>;

type PrefsReadResult =
	| { kind: "missing" | "valid"; document: PrefsDocument }
	| { kind: "invalid"; error: Error };

const DEFAULT_PREFS: FastModePrefs = {
	version: 1,
	perModel: {},
};

// OpenAI API Fast mode support and pricing:
// https://developers.openai.com/api/docs/guides/fast-mode
const OPENAI_FAST_MODE_MODEL_IDS = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.6", // Compatibility alias used by earlier Pi model catalogs.
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5",
	"gpt-5-mini",
	"gpt-5.1-codex",
	"gpt-5-codex",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4.1-nano",
	"gpt-4o",
	"gpt-4o-2024-05-13",
	"gpt-4o-2024-08-06",
	"gpt-4o-2024-11-20",
	"gpt-4o-mini",
	"o3",
	"o4-mini",
] as const;

// ChatGPT-authenticated Codex Fast mode currently supports GPT-5.4–5.6:
// https://developers.openai.com/codex/speed
const OPENAI_CODEX_FAST_MODE_MODEL_IDS = [
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
] as const;

const SUPPORTED_MODELS: SupportedMode[] = [
	{ provider: "anthropic", id: "claude-opus-4-6", enabledTier: "auto", disabledTier: "standard_only" },
	{ provider: "anthropic", id: "claude-opus-4-7", enabledTier: "auto", disabledTier: "standard_only" },
	{ provider: "anthropic", id: "claude-opus-4-8", enabledTier: "auto", disabledTier: "standard_only" },
	...OPENAI_FAST_MODE_MODEL_IDS.map((id): SupportedMode => ({ provider: "openai", id, enabledTier: "fast" })),
	// The ChatGPT Codex backend rejects raw service_tier=fast. Codex's Fast
	// setting is represented by the priority wire tier and routed server-side.
	...OPENAI_CODEX_FAST_MODE_MODEL_IDS.map((id): SupportedMode => ({ provider: "openai-codex", id, enabledTier: "priority" })),
];

/**
 * ChatGPT Codex Fast mode uses `priority` as its wire-tier ID and subscription
 * credits are accounted provider-side. Pi extensions cannot alter that internal
 * accounting or infer the actual credit multiplier from the response.
 */
export const CODEX_SERVICE_TIER_ACCOUNTING_LIMITATION =
	"Codex Fast mode uses wire service_tier=priority; extensions cannot alter Pi's internal serviceTier accounting or ChatGPT credit usage.";

const stores = new Map<string, PrefsStore>();
const updateQueues = new Map<string, Promise<void>>();

export default function fastMode(pi: ExtensionAPI) {
	let prefs: FastModePrefs = copyPrefs(DEFAULT_PREFS);

	const refreshStatus = (ctx: ExtensionContext | ExtensionCommandContext) => {
		ctx.ui.setStatus("fast-mode", undefined);
	};
	const tpsStatus = registerTpsStatus(pi, (ctx) => isFastEnabled(prefs, ctx.model) ? "fast" : "standard");

	pi.on("session_start", async (_event, ctx) => {
		const result = await getPrefsStore().load();
		prefs = result.kind === "invalid" ? copyPrefs(DEFAULT_PREFS) : copyPrefs(result.document);
		refreshStatus(ctx);
		tpsStatus.refresh(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		refreshStatus(ctx);
		tpsStatus.refresh(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const supported = getSupportedMode(ctx.model);
		if (!supported || !isRecord(event.payload)) {
			return;
		}

		const payload = { ...event.payload };
		const enabled = isFastEnabled(prefs, ctx.model);
		if (enabled) {
			payload.service_tier = supported.enabledTier;
		} else {
			delete payload.service_tier;
			if (supported.disabledTier !== undefined) {
				payload.service_tier = supported.disabledTier;
			}
		}
		// For openai-codex this deliberately stops at the wire payload. Codex
		// handles ChatGPT Fast routing server-side; see the accounting limitation.
		return payload;
	});

	pi.registerCommand("fast", {
		description: "Toggle fast mode for supported Anthropic Opus, OpenAI API, and OpenAI Codex models",
		handler: async (_args, ctx) => {
			const supported = getSupportedMode(ctx.model);
			if (!ctx.model || !supported) {
				ctx.ui.notify(
					"Fast mode is unavailable for this model. OpenAI API and Codex support different model sets; see OpenAI's Fast mode documentation.",
					"info",
				);
				refreshStatus(ctx);
				tpsStatus.refresh(ctx);
				return;
			}

			const key = getModelKey(ctx.model);
			let enabled: boolean;
			try {
				const result = await getPrefsStore().toggle(key);
				prefs = result.prefs;
				enabled = result.enabled;
			} catch (error) {
				ctx.ui.notify(
					`Fast mode preferences were not changed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				refreshStatus(ctx);
				return;
			}

			refreshStatus(ctx);
			tpsStatus.refresh(ctx);
			const enabledMessage = supported.provider === "openai-codex"
				? "Codex Fast mode (wire service_tier=priority)"
				: `service_tier=${supported.enabledTier}`;
			const disabledMessage =
				supported.disabledTier !== undefined
					? `service_tier=${supported.disabledTier}`
					: "the provider default service tier (field omitted)";
			ctx.ui.notify(
				enabled
					? `Fast mode ON for ${key}. Requests will use ${enabledMessage}.`
					: `Fast mode OFF for ${key}. Requests will use ${disabledMessage}.`,
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

function getPrefsPath(): string {
	return join(getAgentDir(), PREFS_FILE_NAME);
}

function getPrefsStore(): PrefsStore {
	const path = getPrefsPath();
	let store = stores.get(path);
	if (!store) {
		store = new PrefsStore(path);
		stores.set(path, store);
	}
	return store;
}

class PrefsStore {
	constructor(private readonly path: string) {}

	async load(): Promise<PrefsReadResult> {
		return serializeUpdate(this.path, () => withFileLock(this.path, () => readPrefs(this.path)));
	}

	async toggle(key: string): Promise<{ prefs: FastModePrefs; enabled: boolean }> {
		return serializeUpdate(this.path, () =>
			withFileLock(this.path, async () => {
				const current = await readPrefs(this.path);
				if (current.kind === "invalid") {
					throw new Error(`Refusing to overwrite malformed fast-mode preferences: ${current.error.message}`);
				}
				const enabled = current.document.perModel[key] !== true;
				const next: PrefsDocument = {
					...current.document,
					version: 1,
					perModel: {
						...current.document.perModel,
						[key]: enabled,
					},
				};
				await writeJsonAtomically(this.path, next);
				return { prefs: copyPrefs(next), enabled };
			}),
		);
	}
}

async function readPrefs(path: string): Promise<PrefsReadResult> {
	try {
		await assertNotSymlink(path);
		const raw = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isPrefsDocument(parsed)) {
			return { kind: "invalid", error: new Error("fast-mode.json must contain version 1 and a boolean perModel record") };
		}
		return { kind: "valid", document: parsed };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "missing", document: defaultPrefsDocument() };
		}
		return {
			kind: "invalid",
			error: new Error(`fast-mode.json cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`),
		};
	}
}

function isPrefsDocument(value: unknown): value is PrefsDocument {
	return (
		isRecord(value) &&
		value.version === 1 &&
		isRecord(value.perModel) &&
		Object.values(value.perModel).every((entry) => typeof entry === "boolean")
	);
}

function copyPrefs(prefs: FastModePrefs): FastModePrefs {
	return {
		version: 1,
		perModel: { ...prefs.perModel },
	};
}

function defaultPrefsDocument(): PrefsDocument {
	return { version: 1, perModel: {} };
}

function serializeUpdate<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const previous = updateQueues.get(path) ?? Promise.resolve();
	const result = previous.catch(() => undefined).then(operation);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	updateQueues.set(path, tail);
	void tail.finally(() => {
		if (updateQueues.get(path) === tail) updateQueues.delete(path);
	});
	return result;
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	await assertNotSymlink(path);
	await mkdir(dirname(path), { recursive: true });
	const lockPath = `${path}${PREFS_LOCK_SUFFIX}`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	const token = randomUUID();
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	while (!handle) {
		try {
			handle = await open(lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const lockInfo = await stat(lockPath);
				if (Date.now() - lockInfo.mtimeMs > STALE_LOCK_MS && (await shouldRecoverStaleLock(lockPath))) {
					await unlink(lockPath);
					continue;
				}
			} catch (lockError) {
				if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
			}
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting to update ${path}`);
			}
			await delay(LOCK_RETRY_MS);
			continue;
		}
		try {
			await handle.writeFile(`${process.pid}\n${Date.now()}\n${token}\n`, "utf8");
			await handle.sync();
		} catch (error) {
			await handle.close();
			handle = undefined;
			await releaseOwnedLock(lockPath, token);
			throw error;
		}
	}

	try {
		await assertNotSymlink(path);
		return await operation();
	} finally {
		await handle.close();
		await releaseOwnedLock(lockPath, token);
	}
}

async function shouldRecoverStaleLock(lockPath: string): Promise<boolean> {
	try {
		return canRecoverStaleLock(parseLockOwner(await readFile(lockPath, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function parseLockOwner(contents: string): LockOwner {
	const [pidText, _createdAt, token] = contents.split("\n");
	const pid = Number(pidText);
	return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined, token: token || undefined };
}

function canRecoverStaleLock(owner: LockOwner): boolean {
	// A stopped process does not update the lock mtime, but kill(pid, 0) still
	// reports it as alive. Never steal its lock merely because it looks old.
	return owner.pid === undefined || !isProcessAlive(owner.pid);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
	try {
		const owner = parseLockOwner(await readFile(lockPath, "utf8"));
		if (owner.token === token) await unlink(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	await assertNotSymlink(path);
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
	const mode = await existingFileMode(path);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, "wx", mode);
		await handle.writeFile(`${JSON.stringify(value, null, "\t")}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		// Do not replace a link introduced while the temporary file was written.
		await assertNotSymlink(path);
		await rename(temporaryPath, path);
	} finally {
		if (handle) await handle.close();
		await rm(temporaryPath, { force: true });
	}
}

async function existingFileMode(path: string): Promise<number> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error("Refusing to use a symlinked fast-mode preferences file");
		return info.mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0o666;
		throw error;
	}
}

async function assertNotSymlink(path: string): Promise<void> {
	try {
		if ((await lstat(path)).isSymbolicLink()) {
			throw new Error("Refusing to use a symlinked fast-mode preferences file");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const __testing = {
	CODEX_SERVICE_TIER_ACCOUNTING_LIMITATION,
	getPrefsPath,
	readPrefs,
	getPrefsStore,
	getSupportedMode,
	isFastEnabled,
	canRecoverStaleLock,
	isProcessAlive,
};

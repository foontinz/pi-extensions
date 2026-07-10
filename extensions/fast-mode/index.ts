import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

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
		provider: "openai" | "openai-codex";
		id: "gpt-5.4" | "gpt-5.5" | "gpt-5.6" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
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

const SUPPORTED_MODELS: SupportedMode[] = [
	{ provider: "anthropic", id: "claude-opus-4-6", enabledTier: "auto", disabledTier: "standard_only" },
	{ provider: "anthropic", id: "claude-opus-4-7", enabledTier: "auto", disabledTier: "standard_only" },
	{ provider: "anthropic", id: "claude-opus-4-8", enabledTier: "auto", disabledTier: "standard_only" },
	{ provider: "openai", id: "gpt-5.4", enabledTier: "priority" },
	{ provider: "openai", id: "gpt-5.5", enabledTier: "priority" },
	{ provider: "openai", id: "gpt-5.6", enabledTier: "priority" },
	{ provider: "openai", id: "gpt-5.6-sol", enabledTier: "priority" },
	{ provider: "openai", id: "gpt-5.6-terra", enabledTier: "priority" },
	{ provider: "openai", id: "gpt-5.6-luna", enabledTier: "priority" },
	{ provider: "openai-codex", id: "gpt-5.4", enabledTier: "priority" },
	{ provider: "openai-codex", id: "gpt-5.5", enabledTier: "priority" },
	{ provider: "openai-codex", id: "gpt-5.6", enabledTier: "priority" },
	{ provider: "openai-codex", id: "gpt-5.6-sol", enabledTier: "priority" },
	{ provider: "openai-codex", id: "gpt-5.6-terra", enabledTier: "priority" },
	{ provider: "openai-codex", id: "gpt-5.6-luna", enabledTier: "priority" },
];

/**
 * Pi 0.80.5 exposes the outbound provider payload, not Codex's internal usage
 * accounting. Fast mode therefore changes the request tier only; an extension
 * cannot safely synthesize or mutate Codex's internal `serviceTier` cost data.
 */
export const CODEX_SERVICE_TIER_ACCOUNTING_LIMITATION =
	"Pi 0.80.5 public extensions can set the outbound Codex service_tier but cannot alter Codex internal serviceTier accounting.";

const stores = new Map<string, PrefsStore>();
const updateQueues = new Map<string, Promise<void>>();

export default function fastMode(pi: ExtensionAPI) {
	let prefs: FastModePrefs = copyPrefs(DEFAULT_PREFS);

	const refreshStatus = (ctx: ExtensionContext | ExtensionCommandContext) => {
		ctx.ui.setStatus("fast-mode", undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		const result = await getPrefsStore().load();
		prefs = result.kind === "invalid" ? copyPrefs(DEFAULT_PREFS) : copyPrefs(result.document);
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
		const enabled = isFastEnabled(prefs, ctx.model);
		if (enabled) {
			payload.service_tier = supported.enabledTier;
		} else {
			delete payload.service_tier;
			if (supported.disabledTier !== undefined) {
				payload.service_tier = supported.disabledTier;
			}
		}
		// For openai-codex this deliberately stops at the wire payload. See
		// CODEX_SERVICE_TIER_ACCOUNTING_LIMITATION above.
		return payload;
	});

	pi.registerCommand("fast", {
		description: "Toggle fast mode for supported Anthropic Opus and OpenAI GPT-5.4/5.5/5.6 models",
		handler: async (_args, ctx) => {
			const supported = getSupportedMode(ctx.model);
			if (!ctx.model || !supported) {
				ctx.ui.notify(
					"Fast mode is only available for Anthropic Opus 4.6/4.7/4.8 and OpenAI/OpenAI Codex GPT-5.4, GPT-5.5, and GPT-5.6 variants.",
					"info",
				);
				refreshStatus(ctx);
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
			const disabledMessage =
				supported.disabledTier !== undefined
					? `service_tier=${supported.disabledTier}`
					: "the provider default service tier (field omitted)";
			ctx.ui.notify(
				enabled
					? `Fast mode ON for ${key}. Requests will use service_tier=${supported.enabledTier}.`
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

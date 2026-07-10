import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const KEYCHAIN_SERVICE = "pi-envvars";
const INDEX_ACCOUNT = "__index__";
const INDEX_LOCK_STALE_MS = 30_000;
const INDEX_LOCK_RETRY_MS = 25;
const INDEX_LOCK_PATH = join(tmpdir(), `pi-envvars-index-${process.getuid?.() ?? "user"}.lock`);

export interface KeychainCommandResult {
	stdout: string;
	stderr: string;
}

export type KeychainCommandRunner = (
	file: string,
	args: readonly string[],
	input?: string,
) => Promise<KeychainCommandResult>;

export interface EnvVarStoreOptions {
	/** Override process execution in tests. */
	commandRunner?: KeychainCommandRunner;
	/** Override the platform check in tests. */
	platform?: NodeJS.Platform;
	/** Use a separate lock when testing or embedding a separate store instance. */
	indexLockPath?: string;
}

export interface EnvVarStore {
	getEnvVar(name: string): Promise<string | undefined>;
	loadStoredEnvVar(name: string): Promise<string | undefined>;
	saveStoredEnvVar(name: string, value: string): Promise<void>;
	/** Returns false when the item was already absent. */
	clearStoredEnvVar(name: string): Promise<boolean>;
	listStoredEnvVars(): Promise<string[]>;
}

export class KeychainCommandError extends Error {
	constructor(
		readonly command: string,
		readonly args: readonly string[],
		readonly exitCode: number | null,
		readonly stderr: string,
	) {
		super(`${command} failed${exitCode === null ? "" : ` (exit ${exitCode})`}${stderr ? `: ${stderr.trim()}` : ""}`);
		this.name = "KeychainCommandError";
	}
}

/**
 * A Keychain store can be constructed with a fake process runner for tests.
 * The exported functions below use the default macOS-backed instance.
 */
export function createEnvVarStore(options: EnvVarStoreOptions = {}): EnvVarStore {
	const commandRunner = options.commandRunner ?? runKeychainCommand;
	const platform = options.platform ?? process.platform;
	const indexLockPath = options.indexLockPath ?? INDEX_LOCK_PATH;

	const assertSupported = () => assertMacOSKeychain(platform);

	const loadStoredEnvVar = async (name: string): Promise<string | undefined> => {
		assertSupported();
		validateEnvVarName(name);
		try {
			const { stdout } = await commandRunner("security", [
				"find-generic-password",
				"-a",
				name,
				"-s",
				KEYCHAIN_SERVICE,
				"-w",
			]);
			const value = stdout.trim();
			return value || undefined;
		} catch (error) {
			if (isKeychainItemNotFoundError(error)) return undefined;
			throw error;
		}
	};

	const readIndex = async (): Promise<string[]> => {
		try {
			const { stdout } = await commandRunner("security", [
				"find-generic-password",
				"-a",
				INDEX_ACCOUNT,
				"-s",
				KEYCHAIN_SERVICE,
				"-w",
			]);
			const parsed = JSON.parse(stdout.trim()) as unknown;
			if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
				throw new Error("Invalid pi-envvars Keychain index; refusing to overwrite it");
			}
			return Array.from(new Set(parsed)).sort();
		} catch (error) {
			if (isKeychainItemNotFoundError(error)) return [];
			throw error;
		}
	};

	const upsertValue = async (account: string, value: string): Promise<void> => {
		// With no argument after -w, security prompts on stdin (twice for
		// confirmation). Supplying the value as an argument would expose it in
		// the process list.
		await commandRunner(
			"security",
			["add-generic-password", "-U", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"],
			`${value}\n${value}\n`,
		);
	};

	const writeIndex = async (index: string[]): Promise<void> => {
		if (index.length === 0) {
			try {
				await commandRunner("security", ["delete-generic-password", "-a", INDEX_ACCOUNT, "-s", KEYCHAIN_SERVICE]);
			} catch (error) {
				if (!isKeychainItemNotFoundError(error)) throw error;
			}
			return;
		}

		await upsertValue(INDEX_ACCOUNT, JSON.stringify(index));
	};

	const updateIndex = async (update: (current: string[]) => string[]) => {
		const current = await readIndex();
		const next = Array.from(new Set(update(current))).sort();
		await writeIndex(next);
	};

	return {
		async getEnvVar(name: string): Promise<string | undefined> {
			validateEnvVarName(name);
			return process.env[name] ?? loadStoredEnvVar(name);
		},

		loadStoredEnvVar,

		async saveStoredEnvVar(name: string, value: string): Promise<void> {
			assertSupported();
			validateEnvVarName(name);
			validateLineBasedSecret(value);
			// The lock covers the value write as well as the index update. Otherwise
			// another process could advertise a value before this write succeeds.
			await withIndexLock(indexLockPath, async () => {
				await upsertValue(name, value);
				await updateIndex((current) => [...current, name]);
			});
		},

		async clearStoredEnvVar(name: string): Promise<boolean> {
			assertSupported();
			validateEnvVarName(name);
			return withIndexLock(indexLockPath, async () => {
				let deleted = true;
				try {
					await commandRunner("security", ["delete-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE]);
				} catch (error) {
					if (isKeychainItemNotFoundError(error)) {
						deleted = false;
					} else {
						throw error;
					}
				}
				await updateIndex((current) => current.filter((item) => item !== name));
				return deleted;
			});
		},

		async listStoredEnvVars(): Promise<string[]> {
			assertSupported();
			return readIndex();
		},
	};
}

const defaultStore = createEnvVarStore();

export async function getEnvVar(name: string): Promise<string | undefined> {
	return defaultStore.getEnvVar(name);
}

export async function loadStoredEnvVar(name: string): Promise<string | undefined> {
	return defaultStore.loadStoredEnvVar(name);
}

export async function saveStoredEnvVar(name: string, value: string): Promise<void> {
	return defaultStore.saveStoredEnvVar(name, value);
}

/** Returns false when the key was already absent from the Keychain. */
export async function clearStoredEnvVar(name: string): Promise<boolean> {
	return defaultStore.clearStoredEnvVar(name);
}

export async function listStoredEnvVars(): Promise<string[]> {
	return defaultStore.listStoredEnvVars();
}

export function maskSecret(value: string): string {
	if (value.length <= 8) return "*".repeat(value.length);
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function validateEnvVarName(name: string): void {
	if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
		throw new Error(`Invalid env var name: ${name}. Use uppercase shell-style names like OPENROUTER_API_KEY.`);
	}
}

/** security's stdin prompt is line-based, so embedded line endings are unsafe. */
export function validateLineBasedSecret(value: string): void {
	if (/[\r\n]/.test(value)) {
		throw new Error("Secrets stored in macOS Keychain cannot contain carriage returns or line feeds.");
	}
}

export function assertMacOSKeychain(platform: NodeJS.Platform = process.platform): void {
	if (platform !== "darwin") {
		throw new Error("/envvars currently supports only macOS Keychain.");
	}
}

export function isKeychainItemNotFoundError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const record = error as { code?: unknown; exitCode?: unknown; stderr?: unknown; message?: unknown };
	// security exits with the low byte of errSecItemNotFound (-25300), i.e. 44.
	if (record.code === -25300 || record.exitCode === -25300 || record.code === 44 || record.exitCode === 44) return true;
	const details = [record.stderr, record.message].filter((value): value is string => typeof value === "string").join("\n");
	return /errSecItemNotFound|item (?:could not|was not) found|could not be found in the keychain|specified item.*not.*found/i.test(details);
}

async function withIndexLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
	const release = await acquireIndexLock(lockPath);
	try {
		return await operation();
	} finally {
		await release();
	}
}

async function acquireIndexLock(lockPath: string): Promise<() => Promise<void>> {
	await mkdir(dirname(lockPath), { recursive: true });

	for (;;) {
		try {
			await mkdir(lockPath);
			await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
			return async () => {
				await rm(lockPath, { recursive: true, force: true });
			};
		} catch (error) {
			if (!isFileExistsError(error)) throw error;
			if (await isStaleIndexLock(lockPath)) {
				await rm(lockPath, { recursive: true, force: true });
				continue;
			}
			await delay(INDEX_LOCK_RETRY_MS);
		}
	}
}

async function isStaleIndexLock(lockPath: string): Promise<boolean> {
	try {
		const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { pid?: unknown; createdAt?: unknown };
		if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
			return !isProcessRunning(owner.pid);
		}
		return typeof owner.createdAt === "number" && Date.now() - owner.createdAt > INDEX_LOCK_STALE_MS;
	} catch {
		try {
			return Date.now() - (await stat(lockPath)).mtimeMs > INDEX_LOCK_STALE_MS;
		} catch {
			return false;
		}
	}
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isFileExistsError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runKeychainCommand(file: string, args: readonly string[], input?: string): Promise<KeychainCommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let spawnError: Error | undefined;

		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.stdin.on("error", () => undefined);
		child.on("error", (error) => {
			spawnError = error;
		});
		child.on("close", (exitCode) => {
			if (spawnError) {
				reject(spawnError);
				return;
			}
			const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
			if (exitCode === 0) {
				resolve(result);
			} else {
				reject(new KeychainCommandError(file, args, exitCode, result.stderr));
			}
		});
		child.stdin.end(input);
	});
}

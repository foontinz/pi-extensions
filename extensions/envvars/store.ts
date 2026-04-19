import { execFile } from "node:child_process";
import { promisify } from "node:util";

const KEYCHAIN_SERVICE = "pi-envvars";
const INDEX_ACCOUNT = "__index__";
const execFileAsync = promisify(execFile);

export async function getEnvVar(name: string): Promise<string | undefined> {
	validateEnvVarName(name);
	return process.env[name] ?? (await loadStoredEnvVar(name));
}

export async function loadStoredEnvVar(name: string): Promise<string | undefined> {
	assertMacOSKeychain();
	validateEnvVarName(name);
	try {
		const { stdout } = await execFileAsync("security", [
			"find-generic-password",
			"-a",
			name,
			"-s",
			KEYCHAIN_SERVICE,
			"-w",
		]);
		const value = stdout.trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

export async function saveStoredEnvVar(name: string, value: string): Promise<void> {
	assertMacOSKeychain();
	validateEnvVarName(name);
	await execFileAsync("security", [
		"add-generic-password",
		"-U",
		"-a",
		name,
		"-s",
		KEYCHAIN_SERVICE,
		"-w",
		value,
	]);
	await writeIndex(await addToIndex(name));
}

export async function clearStoredEnvVar(name: string): Promise<void> {
	assertMacOSKeychain();
	validateEnvVarName(name);
	try {
		await execFileAsync("security", ["delete-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE]);
	} catch {
		// Ignore missing entry
	}
	await writeIndex(await removeFromIndex(name));
}

export async function listStoredEnvVars(): Promise<string[]> {
	assertMacOSKeychain();
	return readIndex();
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

export function assertMacOSKeychain(): void {
	if (process.platform !== "darwin") {
		throw new Error("/envvars currently supports only macOS Keychain.");
	}
}

async function readIndex(): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("security", [
			"find-generic-password",
			"-a",
			INDEX_ACCOUNT,
			"-s",
			KEYCHAIN_SERVICE,
			"-w",
		]);
		const parsed = JSON.parse(stdout.trim()) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string").sort();
	} catch {
		return [];
	}
}

async function writeIndex(index: string[]): Promise<void> {
	if (index.length === 0) {
		try {
			await execFileAsync("security", ["delete-generic-password", "-a", INDEX_ACCOUNT, "-s", KEYCHAIN_SERVICE]);
		} catch {
			// Ignore missing entry
		}
		return;
	}

	await execFileAsync("security", [
		"add-generic-password",
		"-U",
		"-a",
		INDEX_ACCOUNT,
		"-s",
		KEYCHAIN_SERVICE,
		"-w",
		JSON.stringify(index),
	]);
}

async function addToIndex(name: string): Promise<string[]> {
	const current = await readIndex();
	return Array.from(new Set([...current, name])).sort();
}

async function removeFromIndex(name: string): Promise<string[]> {
	const current = await readIndex();
	return current.filter((item) => item !== name).sort();
}

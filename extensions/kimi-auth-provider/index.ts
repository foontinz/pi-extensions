import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_NAME = "kimi";
const KIMI_BASE_URL = "https://api.kimi.com/coding";
const KIMI_CLIENT_ID = process.env.KIMI_CLIENT_ID?.trim() || "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_DEVICE_AUTH_ENDPOINT = "https://auth.kimi.com/api/oauth/device_authorization";
const KIMI_TOKEN_ENDPOINT = "https://auth.kimi.com/api/oauth/token";
const KIMI_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const REFRESH_TIMEOUT_MS = 30 * 1000;

const DEVICE_ID_DIR = path.join(os.homedir(), ".pi-kimi-auth");
const DEVICE_ID_FILE = path.join(DEVICE_ID_DIR, "device_id");

type KimiCredentials = OAuthCredentials & {
	deviceId?: string;
};

interface DeviceAuthorizationResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval?: number;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	token_type: string;
	expires_in: number;
	scope?: string;
}

interface OAuthErrorResponse {
	error?: string;
	error_description?: string;
	interval?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyTrimmedString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseJsonResponse(text: string): unknown {
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error("Invalid JSON response from Kimi");
	}
}

function parseDeviceAuthorizationResponse(value: unknown): DeviceAuthorizationResponse {
	if (!isRecord(value)) throw new Error("Invalid device authorization response from Kimi");

	const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = value;
	if (
		!nonEmptyTrimmedString(device_code) ||
		!nonEmptyTrimmedString(user_code) ||
		!nonEmptyTrimmedString(verification_uri) ||
		(verification_uri_complete !== undefined && !nonEmptyTrimmedString(verification_uri_complete)) ||
		typeof expires_in !== "number" ||
		!Number.isFinite(expires_in) ||
		expires_in <= 0 ||
		(interval !== undefined && (typeof interval !== "number" || !Number.isFinite(interval) || interval < 0))
	) {
		throw new Error("Invalid device authorization response from Kimi");
	}

	return {
		device_code: device_code.trim(),
		user_code: user_code.trim(),
		verification_uri: verification_uri.trim(),
		...(verification_uri_complete === undefined ? {} : { verification_uri_complete: verification_uri_complete.trim() }),
		expires_in,
		...(interval === undefined ? {} : { interval }),
	};
}

function parseTokenResponse(value: unknown, operation: "authorization" | "refresh"): TokenResponse {
	if (!isRecord(value)) throw new Error(`Invalid Kimi ${operation} token response`);

	const { access_token, refresh_token, token_type, expires_in, scope } = value;
	if (
		!nonEmptyTrimmedString(access_token) ||
		!nonEmptyTrimmedString(token_type) ||
		(refresh_token !== undefined && !nonEmptyTrimmedString(refresh_token)) ||
		typeof expires_in !== "number" ||
		!Number.isFinite(expires_in) ||
		expires_in <= 0 ||
		(scope !== undefined && typeof scope !== "string")
	) {
		throw new Error(`Invalid Kimi ${operation} token response`);
	}

	return {
		access_token: access_token.trim(),
		token_type: token_type.trim(),
		expires_in,
		...(refresh_token === undefined ? {} : { refresh_token: refresh_token.trim() }),
		...(scope === undefined ? {} : { scope }),
	};
}

function parseOAuthErrorResponse(value: unknown): OAuthErrorResponse {
	if (!isRecord(value)) return {};
	return {
		...(typeof value.error === "string" ? { error: value.error } : {}),
		...(typeof value.error_description === "string" ? { error_description: value.error_description } : {}),
		...(typeof value.interval === "number" ? { interval: value.interval } : {}),
	};
}

const KIMI_ANTHROPIC_COMPAT = {
	supportsEagerToolInputStreaming: false,
	supportsLongCacheRetention: false,
	supportsCacheControlOnTools: false,
};

const MODELS = [
	{
		id: "kimi-k2.7-code",
		name: "Kimi K2.7 Code",
		reasoning: true,
		input: ["text" as const, "image" as const],
		cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
		compat: KIMI_ANTHROPIC_COMPAT,
	},
	{
		id: "kimi-k2.7-code-highspeed",
		name: "Kimi K2.7 Code HighSpeed",
		reasoning: true,
		input: ["text" as const, "image" as const],
		cost: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
		compat: KIMI_ANTHROPIC_COMPAT,
	},
	{
		id: "kimi-k2.5",
		name: "Kimi K2.5",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
		compat: KIMI_ANTHROPIC_COMPAT,
	},
];

async function getDeviceId(): Promise<string> {
	try {
		const id = (await fs.readFile(DEVICE_ID_FILE, "utf-8")).trim();
		if (id) return id;
	} catch {
		// Generate a new ID below when no usable persisted ID exists.
	}

	const id = randomUUID();
	await fs.mkdir(DEVICE_ID_DIR, { recursive: true });
	await fs.writeFile(DEVICE_ID_FILE, id, { mode: 0o600 });
	return id;
}

async function getDeviceHeaders(deviceId?: string): Promise<Record<string, string>> {
	return {
		"X-Msh-Platform": "pi",
		"X-Msh-Version": "0.1.0",
		"X-Msh-Device-Name": os.hostname(),
		"X-Msh-Device-Model": `${os.platform()}-${os.arch()}`,
		"X-Msh-Os-Version": os.release(),
		"X-Msh-Device-Id": deviceId || (await getDeviceId()),
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};
}

interface RequestSignalScope {
	signal: AbortSignal | undefined;
	deadlineExceeded(): boolean;
	dispose(): void;
}

function createRequestSignal(signal?: AbortSignal, deadline?: number): RequestSignalScope {
	if (!signal && deadline === undefined) {
		return {
			signal: undefined,
			deadlineExceeded: () => false,
			dispose: () => {},
		};
	}

	const controller = new AbortController();
	let timedOut = false;
	const abortFromCaller = () => controller.abort();
	if (signal?.aborted) abortFromCaller();
	else signal?.addEventListener("abort", abortFromCaller, { once: true });

	let timeout: ReturnType<typeof setTimeout> | undefined;
	if (deadline !== undefined) {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, Math.max(0, deadline - Date.now()));
	}

	return {
		signal: controller.signal,
		deadlineExceeded: () => timedOut || (deadline !== undefined && Date.now() >= deadline),
		dispose: () => {
			if (timeout !== undefined) clearTimeout(timeout);
			signal?.removeEventListener("abort", abortFromCaller);
		},
	};
}

function abortedRequestError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function waitForRead<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) return Promise.reject(abortedRequestError());

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(abortedRequestError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

// Response.text() has no signal parameter. Read the stream directly so a login
// cancellation or device-code deadline also interrupts a stalled response body.
async function readResponseText(response: Response, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw abortedRequestError();
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const cancelRead = () => {
		void reader.cancel();
	};
	signal?.addEventListener("abort", cancelRead, { once: true });

	try {
		while (true) {
			const chunk = await waitForRead(reader.read(), signal);
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		signal?.removeEventListener("abort", cancelRead);
		if (signal?.aborted) {
			try {
				await reader.cancel();
			} catch {
				// Cancellation is best effort; the abort result remains authoritative.
			}
		}
		reader.releaseLock();
	}
}

function loginAbortError(signal: AbortSignal | undefined, scope: RequestSignalScope): Error | undefined {
	if (signal?.aborted) return new Error("Login cancelled");
	if (scope.deadlineExceeded()) return new Error("Kimi authorization timed out. Please try /login kimi again.");
	return undefined;
}

function refreshAbortError(scope: RequestSignalScope): Error | undefined {
	return scope.deadlineExceeded() ? new Error("Kimi token refresh timed out. Please try /login kimi again.") : undefined;
}

async function abortableSleep(ms: number, signal?: AbortSignal, deadline?: number): Promise<void> {
	const scope = createRequestSignal(signal, deadline);
	try {
		if (scope.signal?.aborted) throw abortedRequestError();
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timeout);
				scope.signal?.removeEventListener("abort", onAbort);
				reject(abortedRequestError());
			};
			const timeout = setTimeout(() => {
				scope.signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			scope.signal?.addEventListener("abort", onAbort, { once: true });
		});
	} catch (error) {
		throw loginAbortError(signal, scope) ?? error;
	} finally {
		scope.dispose();
	}
}

async function requestDeviceAuthorization(deviceId: string, signal?: AbortSignal): Promise<DeviceAuthorizationResponse> {
	const scope = createRequestSignal(signal, Date.now() + REQUEST_TIMEOUT_MS);
	try {
		if (scope.signal?.aborted) throw abortedRequestError();
		const response = await fetch(KIMI_DEVICE_AUTH_ENDPOINT, {
			method: "POST",
			headers: await getDeviceHeaders(deviceId),
			body: new URLSearchParams({ client_id: KIMI_CLIENT_ID }).toString(),
			signal: scope.signal,
		});
		const text = await readResponseText(response, scope.signal);
		if (!response.ok) {
			throw new Error(`Device authorization failed: ${response.status} ${text}`);
		}

		return parseDeviceAuthorizationResponse(parseJsonResponse(text));
	} catch (error) {
		throw loginAbortError(signal, scope) ?? error;
	} finally {
		scope.dispose();
	}
}

async function pollForToken(deviceCode: string, deviceId: string, deviceExpiresIn: number, intervalSeconds?: number, signal?: AbortSignal): Promise<TokenResponse> {
	if (!Number.isFinite(deviceExpiresIn) || deviceExpiresIn <= 0) {
		throw new Error("Invalid device authorization response from Kimi");
	}

	const deadline = Date.now() + Math.max(1, Math.floor(deviceExpiresIn * 1000));
	const configuredInterval =
		typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds) && intervalSeconds > 0
			? intervalSeconds
			: DEFAULT_POLL_INTERVAL_MS / 1000;
	let intervalMs = Math.max(1000, configuredInterval * 1000);

	while (Date.now() < deadline) {
		const scope = createRequestSignal(signal, deadline);
		let response!: Response;
		let text: string;
		try {
			if (scope.signal?.aborted) throw abortedRequestError();
			response = await fetch(KIMI_TOKEN_ENDPOINT, {
				method: "POST",
				headers: await getDeviceHeaders(deviceId),
				body: new URLSearchParams({
					grant_type: KIMI_GRANT_TYPE,
					device_code: deviceCode,
					client_id: KIMI_CLIENT_ID,
				}).toString(),
				signal: scope.signal,
			});
			text = await readResponseText(response, scope.signal);
		} catch (error) {
			throw loginAbortError(signal, scope) ?? error;
		} finally {
			scope.dispose();
		}

		const data = parseJsonResponse(text);
		if (response.ok) return parseTokenResponse(data, "authorization");

		const error = parseOAuthErrorResponse(data);
		switch (error.error) {
			case "authorization_pending":
				await abortableSleep(intervalMs, signal, deadline);
				continue;
			case "slow_down": {
				const serverInterval =
					typeof error.interval === "number" && Number.isFinite(error.interval) && error.interval > 0
						? error.interval
						: intervalMs / 1000 + 5;
				intervalMs = Math.min(serverInterval * 1000, 15000);
				await abortableSleep(intervalMs, signal, deadline);
				continue;
			}
			case "expired_token":
				throw new Error("Device code expired. Please restart /login kimi.");
			case "access_denied":
				throw new Error("Kimi authorization was denied.");
			default:
				throw new Error(`Token request failed: ${response.status} ${error.error || text}`);
		}
	}

	throw new Error("Kimi authorization timed out. Please try /login kimi again.");
}

async function loginKimi(callbacks: OAuthLoginCallbacks): Promise<KimiCredentials> {
	const deviceId = await getDeviceId();
	const device = await requestDeviceAuthorization(deviceId, callbacks.signal);
	const authUrl = device.verification_uri_complete || device.verification_uri;

	callbacks.onAuth({
		url: authUrl,
		instructions: device.verification_uri_complete ? undefined : `Enter code: ${device.user_code}`,
	});

	const token = await pollForToken(device.device_code, deviceId, device.expires_in, device.interval, callbacks.signal);

	return {
		access: token.access_token,
		refresh: token.refresh_token || "",
		expires: Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS,
		deviceId,
	};
}

async function refreshKimiToken(credentials: KimiCredentials): Promise<KimiCredentials> {
	if (typeof credentials.refresh !== "string" || !credentials.refresh.trim()) {
		throw new Error("No Kimi refresh token stored; run /login kimi again.");
	}

	const refreshToken = credentials.refresh.trim();
	const deviceId =
		typeof credentials.deviceId === "string" && credentials.deviceId.trim() ? credentials.deviceId.trim() : await getDeviceId();
	const scope = createRequestSignal(undefined, Date.now() + REFRESH_TIMEOUT_MS);
	try {
		const response = await fetch(KIMI_TOKEN_ENDPOINT, {
			method: "POST",
			headers: await getDeviceHeaders(deviceId),
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: KIMI_CLIENT_ID,
			}).toString(),
			signal: scope.signal,
		});
		const text = await readResponseText(response, scope.signal);

		if (!response.ok) {
			throw new Error(`Kimi token refresh failed: ${response.status} ${text}`);
		}

		const token = parseTokenResponse(parseJsonResponse(text), "refresh");

		return {
			access: token.access_token,
			refresh: token.refresh_token || refreshToken,
			expires: Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS,
			deviceId,
		};
	} catch (error) {
		throw refreshAbortError(scope) ?? error;
	} finally {
		scope.dispose();
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_NAME, {
		baseUrl: KIMI_BASE_URL,
		api: "anthropic-messages",
		headers: {
			"User-Agent": "KimiCLI/1.5",
		},
		models: MODELS,
		oauth: {
			name: "Kimi Code Subscription",
			login: loginKimi,
			refreshToken: refreshKimiToken,
			getApiKey: (credentials) => credentials.access,
		},
	});
}

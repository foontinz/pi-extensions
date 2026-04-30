import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROVIDER_NAME = "kimi";
const KIMI_BASE_URL = "https://api.moonshot.cn/v1";
const KIMI_CLIENT_ID = process.env.KIMI_CLIENT_ID || "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_DEVICE_AUTH_ENDPOINT = "https://auth.kimi.com/api/oauth/device_authorization";
const KIMI_TOKEN_ENDPOINT = "https://auth.kimi.com/api/oauth/token";
const KIMI_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

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

const MODELS = [
	{
		id: "kimi-k2.5",
		name: "Kimi K2.5",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
		compat: { supportsDeveloperRole: false },
	},
];

async function getDeviceId(): Promise<string> {
	try {
		return (await fs.readFile(DEVICE_ID_FILE, "utf-8")).trim();
	} catch {
		const id = randomUUID();
		await fs.mkdir(DEVICE_ID_DIR, { recursive: true });
		await fs.writeFile(DEVICE_ID_FILE, id, { mode: 0o600 });
		return id;
	}
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

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

async function requestDeviceAuthorization(deviceId: string): Promise<DeviceAuthorizationResponse> {
	const response = await fetch(KIMI_DEVICE_AUTH_ENDPOINT, {
		method: "POST",
		headers: await getDeviceHeaders(deviceId),
		body: new URLSearchParams({ client_id: KIMI_CLIENT_ID }).toString(),
	});

	if (!response.ok) {
		throw new Error(`Device authorization failed: ${response.status} ${await response.text()}`);
	}

	const data = (await response.json()) as DeviceAuthorizationResponse;
	if (!data.device_code || !data.user_code || !data.verification_uri) {
		throw new Error("Invalid device authorization response from Kimi");
	}

	return data;
}

async function pollForToken(deviceCode: string, deviceId: string, deviceExpiresIn: number, intervalSeconds?: number, signal?: AbortSignal): Promise<TokenResponse> {
	const deadline = Date.now() + deviceExpiresIn * 1000;
	let intervalMs = Math.max(1000, (intervalSeconds || DEFAULT_POLL_INTERVAL_MS / 1000) * 1000);

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled");

		const response = await fetch(KIMI_TOKEN_ENDPOINT, {
			method: "POST",
			headers: await getDeviceHeaders(deviceId),
			body: new URLSearchParams({
				grant_type: KIMI_GRANT_TYPE,
				device_code: deviceCode,
				client_id: KIMI_CLIENT_ID,
			}).toString(),
		});

		const text = await response.text();
		const data = text ? (JSON.parse(text) as (TokenResponse & { error?: string; error_description?: string; interval?: number })) : undefined;

		if (response.ok && data?.access_token) return data;

		switch (data?.error) {
			case "authorization_pending":
				await abortableSleep(intervalMs, signal);
				continue;
			case "slow_down":
				intervalMs = Math.min((data.interval || intervalMs / 1000 + 5) * 1000, 15000);
				await abortableSleep(intervalMs, signal);
				continue;
			case "expired_token":
				throw new Error("Device code expired. Please restart /login kimi.");
			case "access_denied":
				throw new Error("Kimi authorization was denied.");
			default:
				throw new Error(`Token request failed: ${response.status} ${data?.error || text}`);
		}
	}

	throw new Error("Kimi authorization timed out. Please try /login kimi again.");
}

async function loginKimi(callbacks: OAuthLoginCallbacks): Promise<KimiCredentials> {
	const deviceId = await getDeviceId();
	const device = await requestDeviceAuthorization(deviceId);
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
	if (!credentials.refresh) {
		throw new Error("No Kimi refresh token stored; run /login kimi again.");
	}

	const deviceId = credentials.deviceId || (await getDeviceId());
	const response = await fetch(KIMI_TOKEN_ENDPOINT, {
		method: "POST",
		headers: await getDeviceHeaders(deviceId),
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			client_id: KIMI_CLIENT_ID,
		}).toString(),
	});

	if (!response.ok) {
		throw new Error(`Kimi token refresh failed: ${response.status} ${await response.text()}`);
	}

	const token = (await response.json()) as TokenResponse;
	if (!token.access_token) throw new Error("Kimi token refresh failed: no access token in response");

	return {
		access: token.access_token,
		refresh: token.refresh_token || credentials.refresh,
		expires: Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS,
		deviceId,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_NAME, {
		baseUrl: KIMI_BASE_URL,
		api: "openai-completions",
		models: MODELS,
		oauth: {
			name: "Kimi Code Subscription",
			login: loginKimi,
			refreshToken: refreshKimiToken,
			getApiKey: (credentials) => credentials.access,
		},
	});
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const originalHome = process.env.HOME;
const testHome = await mkdtemp(path.join(os.tmpdir(), "pi-kimi-auth-test-"));
process.env.HOME = testHome;
const { default: kimiExtension } = await import("../index.ts");
if (originalHome === undefined) delete process.env.HOME;
else process.env.HOME = originalHome;

type KimiOAuth = {
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
};

function getOAuth(): KimiOAuth {
  let oauth: KimiOAuth | undefined;
  kimiExtension({
    registerProvider(_name: string, provider: { oauth?: KimiOAuth }) {
      oauth = provider.oauth;
    },
  } as unknown as ExtensionAPI);
  assert.ok(oauth, "Kimi provider registers OAuth handlers");
  return oauth;
}

function callbacks(signal?: AbortSignal): OAuthLoginCallbacks {
  return {
    onAuth() {},
    onDeviceCode() {},
    onPrompt: async () => "",
    onSelect: async () => undefined,
    signal,
  };
}

test("login cancellation reaches device authorization fetch and a stalled response body", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  let bodyCancelled = false;
  let markFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  let markBodyRead: (() => void) | undefined;
  const bodyRead = new Promise<void>((resolve) => {
    markBodyRead = resolve;
  });
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
    fetchSignal = init?.signal ?? undefined;
    markFetchStarted?.();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        markBodyRead?.();
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    return Promise.resolve(new Response(body));
  }) as unknown as typeof fetch;

  try {
    const login = getOAuth().login(callbacks(controller.signal));
    await fetchStarted;
    assert.ok(fetchSignal, "device authorization fetch receives an abort signal");
    await bodyRead;

    controller.abort();
    await assert.rejects(login, /Login cancelled/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fetchSignal.aborted, true);
    assert.equal(bodyCancelled, true, "response body reader is cancelled too");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("device-code deadline aborts a stalled token response body", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let tokenSignal: AbortSignal | undefined;
  let calls = 0;
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "device",
            user_code: "user",
            verification_uri: "https://auth.example.test",
            expires_in: 0.01,
          }),
        ),
      );
    }

    tokenSignal = init?.signal ?? undefined;
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull() {} })));
  }) as unknown as typeof fetch;

  try {
    await assert.rejects(getOAuth().login(callbacks()), /Kimi authorization timed out/);
    assert.ok(tokenSignal, "token polling fetch receives a deadline signal");
    assert.equal(tokenSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refresh has a bounded timeout signal", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timeoutMs: number | undefined;
  let refreshSignal: AbortSignal | undefined;

  globalThis.setTimeout = ((callback: (...args: never[]) => void, delay?: number, ...args: never[]) => {
    timeoutMs = delay;
    queueMicrotask(() => callback(...args));
    return {};
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      refreshSignal = init?.signal ?? undefined;
      if (refreshSignal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      refreshSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof fetch;

  try {
    await assert.rejects(
      getOAuth().refreshToken({ access: "old-access", refresh: "refresh-token", expires: 0, deviceId: "device" }),
      /Kimi token refresh timed out/,
    );
    assert.equal(timeoutMs, 30_000);
    assert.equal(refreshSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("rejects blank required device authorization strings", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const validDeviceResponse = {
    device_code: "device",
    user_code: "user",
    verification_uri: "https://auth.example.test",
    expires_in: 60,
  };

  try {
    for (const [field, value] of [
      ["device_code", "   "],
      ["user_code", "   "],
      ["verification_uri", "   "],
      ["verification_uri_complete", "   "],
    ] as const) {
      let calls = 0;
      globalThis.fetch = (() => {
        calls++;
        return Promise.resolve(new Response(JSON.stringify({ ...validDeviceResponse, [field]: value })));
      }) as unknown as typeof fetch;

      await assert.rejects(getOAuth().login(callbacks()), /Invalid device authorization response from Kimi/);
      assert.equal(calls, 1, `${field} is rejected before token polling`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects blank required token strings and trims accepted OAuth values", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const validDeviceResponse = {
    device_code: " device ",
    user_code: " user ",
    verification_uri: " https://auth.example.test ",
    expires_in: 60,
  };
  const validTokenResponse = {
    access_token: " access ",
    refresh_token: " refresh ",
    token_type: " Bearer ",
    expires_in: 60,
  };

  try {
    for (const field of ["access_token", "token_type", "refresh_token"] as const) {
      let calls = 0;
      globalThis.fetch = (() => {
        calls++;
        const body = calls === 1 ? validDeviceResponse : { ...validTokenResponse, [field]: "   " };
        return Promise.resolve(new Response(JSON.stringify(body)));
      }) as unknown as typeof fetch;

      await assert.rejects(getOAuth().login(callbacks()), /Invalid Kimi authorization token response/);
      assert.equal(calls, 2, `${field} is rejected from a successful token response`);
    }

    let authUrl: string | undefined;
    let tokenRequest: URLSearchParams | undefined;
    let calls = 0;
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (calls === 2) tokenRequest = new URLSearchParams(init?.body as string);
      return Promise.resolve(new Response(JSON.stringify(calls === 1 ? validDeviceResponse : validTokenResponse)));
    }) as unknown as typeof fetch;
    const loginCallbacks = callbacks();
    loginCallbacks.onAuth = ({ url }) => {
      authUrl = url;
    };

    const credentials = await getOAuth().login(loginCallbacks);
    assert.equal(authUrl, "https://auth.example.test");
    assert.equal(tokenRequest?.get("device_code"), "device");
    assert.equal(credentials.access, "access");
    assert.equal(credentials.refresh, "refresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(async () => {
  await rm(testHome, { recursive: true, force: true });
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRegisteredHandles } from "../../code-runner/hooks";
import playwrightBrowser, { PLAYWRIGHT_CODE_HANDLE } from "../index";

const execFileAsync = (command: string, args: string[]) =>
	new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		execFile(command, args, (error, stdout, stderr) => {
			if (error) {
				Object.assign(error, { stdout, stderr });
				reject(error);
				return;
			}
			resolve({ stdout, stderr });
		});
	});

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDirectory, "../../..");
const tscPath = join(projectRoot, "node_modules/typescript/bin/tsc");

test("registers the handle in the factory and removes it at session shutdown", async () => {
	let shutdownHandler: ((event: unknown) => Promise<unknown> | unknown) | undefined;
	const pi = {
		on(event: string, handler: (event: unknown) => Promise<unknown> | unknown) {
			if (event === "session_shutdown") shutdownHandler = handler;
		},
	} as unknown as ExtensionAPI;

	playwrightBrowser(pi);
	assert.equal(getRegisteredHandles().find((handle) => handle.name === "playwright")?.name, "playwright");

	await shutdownHandler?.({ type: "session_shutdown", reason: "quit" });
	assert.equal(getRegisteredHandles().find((handle) => handle.name === "playwright"), undefined);
});

test("generated helpers type-check and close resources after setup failures without launching a browser", async () => {
	const directory = await mkdtemp(join(dirname(testDirectory), ".playwright-browser-test-"));
	const setupPath = join(directory, "playwright-setup.ts");
	const runtimePath = join(directory, "playwright-runtime.ts");

	try {
		await writeFile(setupPath, `${PLAYWRIGHT_CODE_HANDLE.setupCode}\n`, "utf8");
		await execFileAsync(process.execPath, [
			tscPath,
			"--ignoreConfig",
			"--noEmit",
			"--target",
			"ES2022",
			"--module",
			"NodeNext",
			"--moduleResolution",
			"NodeNext",
			"--skipLibCheck",
			setupPath,
		]);

		await writeFile(
			runtimePath,
			`import assert from "node:assert/strict";
import * as importedPw from "playwright";

${PLAYWRIGHT_CODE_HANDLE.setupCode}

const closeOrder = [];
const page = {
  async setViewportSize() { throw new Error("viewport failed"); },
  async goto() {},
  async close() { closeOrder.push("page"); },
};
const context = {
  async newPage() { return page; },
  async close() { closeOrder.push("context"); },
};
const browser = {
  async newContext() { return context; },
  async close() { closeOrder.push("browser"); },
};
const originalLaunch = importedPw.chromium.launch;
Object.assign(importedPw.chromium, { launch: async () => browser });

try {
  await assert.rejects(
    openPage("https://example.test", { pageOptions: { viewportSize: { width: 1, height: 1 } } }),
    /viewport failed/,
  );
  assert.deepEqual(closeOrder, ["page", "context", "browser"]);

  closeOrder.length = 0;
  context.newPage = async () => { throw new Error("page failed"); };
  await assert.rejects(openPage("https://example.test"), /page failed/);
  assert.deepEqual(closeOrder, ["context", "browser"]);

  closeOrder.length = 0;
  context.newPage = async () => page;
  page.setViewportSize = async () => {};
  browser.newContext = async () => { throw new Error("context failed"); };
  await assert.rejects(withBrowser(async () => undefined), /context failed/);
  assert.deepEqual(closeOrder, ["browser"]);
} finally {
  Object.assign(importedPw.chromium, { launch: originalLaunch });
}
`,
			"utf8",
		);
		await execFileAsync(process.execPath, ["--no-warnings", runtimePath]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

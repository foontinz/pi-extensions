import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEnvVarStore, type KeychainCommandRunner } from "../store";

const missingItem = () => Object.assign(new Error("missing item"), {
	stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
});

function createTempLockPath(prefix: string): Promise<{ directory: string; lockPath: string }> {
	return mkdtemp(join(tmpdir(), prefix)).then((directory) => ({ directory, lockPath: join(directory, "index.lock") }));
}

test("stores Keychain values through stdin rather than process arguments", async () => {
	const { directory, lockPath } = await createTempLockPath("pi-envvars-argv-");
	const calls: Array<{ file: string; args: readonly string[]; input?: string }> = [];
	const runner: KeychainCommandRunner = async (file, args, input) => {
		calls.push({ file, args, input });
		if (file === "security" && args[0] === "find-generic-password") return { stdout: "[]", stderr: "" };
		return { stdout: "", stderr: "" };
	};

	try {
		const store = createEnvVarStore({ commandRunner: runner, platform: "darwin", indexLockPath: lockPath });
		const secret = "correct-horse-battery-staple";
		await store.saveStoredEnvVar("TEST_API_KEY", secret);

		assert.ok(calls.every(({ args }) => !args.join("\0").includes(secret)));
		const writes = calls.filter(({ file, args }) => file === "security" && args[0] === "add-generic-password");
		assert.equal(writes.length, 2);
		assert.equal(writes[0]?.args.at(-1), "-w");
		assert.equal(writes[0]?.input, `${secret}\n${secret}\n`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("clearing a missing item reports it without hiding real Keychain failures", async () => {
	const { directory, lockPath } = await createTempLockPath("pi-envvars-delete-");
	const calls: Array<{ file: string; args: readonly string[] }> = [];
	const missingRunner: KeychainCommandRunner = async (file, args) => {
		calls.push({ file, args });
		if (file === "security" && args[0] === "delete-generic-password" && args[2] === "TEST_API_KEY") throw missingItem();
		if (file === "security" && args[0] === "find-generic-password") return { stdout: '["TEST_API_KEY"]', stderr: "" };
		return { stdout: "", stderr: "" };
	};

	try {
		const store = createEnvVarStore({ commandRunner: missingRunner, platform: "darwin", indexLockPath: lockPath });
		assert.equal(await store.clearStoredEnvVar("TEST_API_KEY"), false);
		assert.ok(calls.some(({ args }) => args[0] === "find-generic-password"), "removes the stale index entry");

		const failedStore = createEnvVarStore({
			commandRunner: async (file, args) => {
				if (file === "security" && args[0] === "delete-generic-password") {
					throw Object.assign(new Error("access denied"), { stderr: "security: User interaction is not allowed." });
				}
				throw new Error("index should not be updated after a real deletion failure");
			},
			platform: "darwin",
			indexLockPath: lockPath,
		});
		await assert.rejects(() => failedStore.clearStoredEnvVar("TEST_API_KEY"), /access denied/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects line-ending secrets before starting security", async () => {
	const { directory, lockPath } = await createTempLockPath("pi-envvars-line-ending-");
	let calls = 0;
	const store = createEnvVarStore({
		commandRunner: async () => {
			calls++;
			return { stdout: "", stderr: "" };
		},
		platform: "darwin",
		indexLockPath: lockPath,
	});

	try {
		await assert.rejects(() => store.saveStoredEnvVar("TEST_API_KEY", "first\nsecond"), /cannot contain carriage returns or line feeds/);
		await assert.rejects(() => store.saveStoredEnvVar("TEST_API_KEY", "first\rsecond"), /cannot contain carriage returns or line feeds/);
		assert.equal(calls, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("recognizes security's macOS item-not-found exit code", async () => {
	const { directory, lockPath } = await createTempLockPath("pi-envvars-exit-44-");
	const runner: KeychainCommandRunner = async (_file, args) => {
		if (args[0] === "delete-generic-password" && args[2] === "TEST_API_KEY") {
			throw Object.assign(new Error("security exited 44"), { exitCode: 44 });
		}
		if (args[0] === "find-generic-password") return { stdout: '["TEST_API_KEY"]', stderr: "" };
		return { stdout: "", stderr: "" };
	};

	try {
		const store = createEnvVarStore({ commandRunner: runner, platform: "darwin", indexLockPath: lockPath });
		assert.equal(await store.clearStoredEnvVar("TEST_API_KEY"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("holds the index lock for the entire save transaction", async () => {
	const { directory, lockPath } = await createTempLockPath("pi-envvars-transaction-lock-");
	let releaseFirstWrite: (() => void) | undefined;
	let firstWriteStarted: (() => void) | undefined;
	const firstWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
	const started = new Promise<void>((resolve) => { firstWriteStarted = resolve; });
	const calls: string[] = [];
	const runner: KeychainCommandRunner = async (_file, args) => {
		const account = args[args.indexOf("-a") + 1];
		calls.push(`${args[0]}:${account}`);
		if (args[0] === "add-generic-password" && account === "ALPHA_API_KEY") {
			firstWriteStarted?.();
			await firstWrite;
		}
		if (args[0] === "find-generic-password") return { stdout: "[]", stderr: "" };
		return { stdout: "", stderr: "" };
	};

	try {
		const first = createEnvVarStore({ commandRunner: runner, platform: "darwin", indexLockPath: lockPath });
		const second = createEnvVarStore({ commandRunner: runner, platform: "darwin", indexLockPath: lockPath });
		const savingFirst = first.saveStoredEnvVar("ALPHA_API_KEY", "alpha-secret");
		await started;
		const savingSecond = second.saveStoredEnvVar("BETA_API_KEY", "beta-secret");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(calls, ["add-generic-password:ALPHA_API_KEY"]);
		releaseFirstWrite?.();
		await Promise.all([savingFirst, savingSecond]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("holds the index lock for the entire delete transaction", async () => {
	const { directory, lockPath } = await createTempLockPath("pi-envvars-delete-lock-");
	let releaseDelete: (() => void) | undefined;
	let deleteStarted: (() => void) | undefined;
	const deleting = new Promise<void>((resolve) => { releaseDelete = resolve; });
	const started = new Promise<void>((resolve) => { deleteStarted = resolve; });
	const calls: string[] = [];
	const runner: KeychainCommandRunner = async (_file, args) => {
		const account = args[args.indexOf("-a") + 1];
		calls.push(`${args[0]}:${account}`);
		if (args[0] === "delete-generic-password" && account === "ALPHA_API_KEY") {
			deleteStarted?.();
			await deleting;
		}
		if (args[0] === "find-generic-password") return { stdout: "[]", stderr: "" };
		return { stdout: "", stderr: "" };
	};

	try {
		const first = createEnvVarStore({ commandRunner: runner, platform: "darwin", indexLockPath: lockPath });
		const second = createEnvVarStore({ commandRunner: runner, platform: "darwin", indexLockPath: lockPath });
		const clearingFirst = first.clearStoredEnvVar("ALPHA_API_KEY");
		await started;
		const savingSecond = second.saveStoredEnvVar("BETA_API_KEY", "beta-secret");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(calls, ["delete-generic-password:ALPHA_API_KEY"]);
		releaseDelete?.();
		await Promise.all([clearingFirst, savingSecond]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("serializes index read-modify-write updates across store instances", async () => {
	const { directory, lockPath } = await createTempLockPath("pi-envvars-race-");
	let index: string[] = [];
	const runner: KeychainCommandRunner = async (file, args, input) => {
		if (file === "security" && args[0] === "find-generic-password") {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { stdout: JSON.stringify(index), stderr: "" };
		}
		if (file === "security" && args[0] === "add-generic-password") {
			const account = args[args.indexOf("-a") + 1];
			const value = input?.split("\n", 1)[0] ?? "";
			if (account === "__index__") index = JSON.parse(value) as string[];
			return { stdout: "", stderr: "" };
		}
		return { stdout: "", stderr: "" };
	};

	try {
		const first = createEnvVarStore({ commandRunner: runner, platform: "darwin", indexLockPath: lockPath });
		const second = createEnvVarStore({ commandRunner: runner, platform: "darwin", indexLockPath: lockPath });
		await Promise.all([
			first.saveStoredEnvVar("ALPHA_API_KEY", "alpha-secret"),
			second.saveStoredEnvVar("BETA_API_KEY", "beta-secret"),
		]);
		assert.deepEqual(index, ["ALPHA_API_KEY", "BETA_API_KEY"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("reclaims an index lock left by a dead process", async () => {
	const { directory, lockPath } = await createTempLockPath("pi-envvars-stale-lock-");
	await mkdir(lockPath);
	await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: 999_999_999, createdAt: Date.now() }), "utf8");
	const runner: KeychainCommandRunner = async (file, args) => {
		if (file === "security" && args[0] === "find-generic-password") return { stdout: "[]", stderr: "" };
		return { stdout: "", stderr: "" };
	};

	try {
		const store = createEnvVarStore({ commandRunner: runner, platform: "darwin", indexLockPath: lockPath });
		await store.saveStoredEnvVar("TEST_API_KEY", "secret");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastMode, { __testing, CODEX_SERVICE_TIER_ACCOUNTING_LIMITATION } from "./index.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function supportedModel(provider = "openai", id = "gpt-5.6") {
	return { provider, id } as any;
}

function createRegistration() {
	const events = new Map<string, Function>();
	const commands = new Map<string, any>();
	fastMode({
		on: (event: string, handler: Function) => events.set(event, handler),
		registerCommand: (name: string, options: unknown) => commands.set(name, options),
	} as any);
	return { events, commands };
}

function commandContext(model: any, notifications: string[]) {
	return {
		model,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus() {},
		},
	} as any;
}

test("never overwrites malformed preferences in an alternate Pi agent directory", async () => {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const root = await mkdtemp(join(tmpdir(), "pi-fast-mode-malformed-"));
	const agentDir = join(root, "alternate-agent");
	const prefsPath = join(agentDir, "fast-mode.json");
	process.env[AGENT_DIR_ENV] = agentDir;
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(prefsPath, '{"version":');
		const { commands } = createRegistration();
		const notifications: string[] = [];
		await commands.get("fast").handler("", commandContext(supportedModel(), notifications));
		assert.equal(await readFile(prefsPath, "utf8"), '{"version":');
		assert.match(notifications.at(-1) ?? "", /not changed.*Refusing to overwrite malformed/i);
		assert.equal(__testing.getPrefsPath(), prefsPath);
	} finally {
		if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses a symlinked preferences path rather than replacing it", async () => {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const root = await mkdtemp(join(tmpdir(), "pi-fast-mode-symlink-"));
	const agentDir = join(root, "alternate-agent");
	const targetPath = join(root, "target.json");
	const prefsPath = join(agentDir, "fast-mode.json");
	process.env[AGENT_DIR_ENV] = agentDir;
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(targetPath, JSON.stringify({ version: 1, perModel: {} }));
		await symlink(targetPath, prefsPath);
		const { commands } = createRegistration();
		const notifications: string[] = [];
		await commands.get("fast").handler("", commandContext(supportedModel(), notifications));
		assert.equal(await readFile(targetPath, "utf8"), JSON.stringify({ version: 1, perModel: {} }));
		assert.match(notifications.at(-1) ?? "", /not changed.*symlinked/i);
	} finally {
		if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("does not recover an old lock owned by a live (including stopped) process", () => {
	assert.equal(__testing.isProcessAlive(process.pid), true);
	assert.equal(__testing.canRecoverStaleLock({ pid: process.pid }), false);
	assert.equal(__testing.canRecoverStaleLock({ pid: 999_999_999 }), true);
});

test("serializes concurrent toggles and preserves valid preference fields", async () => {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const root = await mkdtemp(join(tmpdir(), "pi-fast-mode-race-"));
	const agentDir = join(root, "alternate-agent");
	const prefsPath = join(agentDir, "fast-mode.json");
	process.env[AGENT_DIR_ENV] = agentDir;
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(prefsPath, JSON.stringify({ version: 1, perModel: {}, futurePreference: "preserve me" }));
		const { commands } = createRegistration();
		await Promise.all([
			commands.get("fast").handler("", commandContext(supportedModel("openai", "gpt-5.6"), [])),
			commands.get("fast").handler("", commandContext(supportedModel("anthropic", "claude-opus-4-8"), [])),
		]);
		const prefs = JSON.parse(await readFile(prefsPath, "utf8"));
		assert.deepEqual(prefs.perModel, {
			"openai/gpt-5.6": true,
			"anthropic/claude-opus-4-8": true,
		});
		assert.equal(prefs.futurePreference, "preserve me");
	} finally {
		if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("supports OpenAI's documented Fast mode model sets", () => {
	for (const id of ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4-mini", "gpt-5.2", "gpt-4.1", "gpt-4o-mini", "o3", "o4-mini"]) {
		assert.equal(__testing.getSupportedMode(supportedModel("openai", id))?.enabledTier, "fast", id);
	}
	for (const id of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
		assert.equal(__testing.getSupportedMode(supportedModel("openai-codex", id))?.enabledTier, "priority", id);
	}
	assert.equal(__testing.getSupportedMode(supportedModel("openai", "gpt-5.5-pro")), undefined);
	assert.equal(__testing.getSupportedMode(supportedModel("openai-codex", "gpt-5.3-codex-spark")), undefined);
});

test("sends API Fast and Codex Fast wire tiers and documents the accounting limit", async () => {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const root = await mkdtemp(join(tmpdir(), "pi-fast-mode-payload-"));
	const agentDir = join(root, "alternate-agent");
	process.env[AGENT_DIR_ENV] = agentDir;
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "fast-mode.json"),
			JSON.stringify({ version: 1, perModel: { "openai-codex/gpt-5.6": true, "openai/gpt-4.1": true } }),
		);
		const { events } = createRegistration();
		await events.get("session_start")!({}, commandContext(undefined, []));
		const beforeRequest = events.get("before_provider_request")!;

		assert.deepEqual(
			beforeRequest({ payload: { keep: "value", service_tier: "old" } }, { model: supportedModel("openai-codex", "gpt-5.6") }),
			{ keep: "value", service_tier: "priority" },
		);
		assert.deepEqual(
			beforeRequest({ payload: { keep: "value", service_tier: "old" } }, { model: supportedModel("openai", "gpt-4.1") }),
			{ keep: "value", service_tier: "fast" },
		);
		assert.deepEqual(
			beforeRequest({ payload: { keep: "value" } }, { model: supportedModel("anthropic", "claude-opus-4-8") }),
			{ keep: "value", service_tier: "standard_only" },
		);
		assert.match(CODEX_SERVICE_TIER_ACCOUNTING_LIMITATION, /service_tier=priority.*cannot alter Pi's internal serviceTier accounting/);
		assert.equal(__testing.CODEX_SERVICE_TIER_ACCOUNTING_LIMITATION, CODEX_SERVICE_TIER_ACCOUNTING_LIMITATION);
	} finally {
		if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

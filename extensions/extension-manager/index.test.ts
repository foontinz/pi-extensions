import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extensionManager, { __testing } from "./index.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

async function makeFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-extension-manager-"));
	const agentDir = join(root, "alternate-agent");
	const projectDir = join(root, "project");
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await mkdir(join(projectDir, ".pi", "extensions"), { recursive: true });
	await Promise.all([
		writeFile(join(agentDir, "extensions", "enabled.ts"), "export default () => {};\n"),
		writeFile(join(agentDir, "extensions", "disabled.ts"), "export default () => {};\n"),
		writeFile(join(agentDir, "extensions", "glob-disabled.ts"), "export default () => {};\n"),
		writeFile(join(projectDir, ".pi", "extensions", "project.ts"), "export default () => {};\n"),
		writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ extensions: ["!extensions/*.ts", "+extensions/enabled.ts", "-extensions/disabled.ts"] }),
		),
		writeFile(join(projectDir, ".pi", "settings.json"), JSON.stringify({ extensions: ["-extensions/project.ts"] })),
	]);
	return { root, agentDir, projectDir };
}

function discoveryContext(cwd: string, trusted: boolean) {
	return { cwd, isProjectTrusted: () => trusted } as any;
}

test("uses Pi's alternate agent dir, trust gate, and extension filter precedence", async () => {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const fixture = await makeFixture();
	process.env[AGENT_DIR_ENV] = fixture.agentDir;
	try {
		const trusted = await __testing.discoverCandidates(discoveryContext(fixture.projectDir, true));
		const byName = new Map(trusted.map((candidate) => [candidate.path.split("/").at(-1), candidate]));
		assert.deepEqual(
			["disabled.ts", "enabled.ts", "glob-disabled.ts", "project.ts"].map((name) => [name, byName.get(name)?.scope, byName.get(name)?.disabled]),
			[
				["disabled.ts", "global", true],
				["enabled.ts", "global", false],
				["glob-disabled.ts", "global", true],
				["project.ts", "project", true],
			],
		);

		const untrusted = await __testing.discoverCandidates(discoveryContext(fixture.projectDir, false));
		assert.equal(untrusted.some((candidate) => candidate.scope === "project"), false);
		assert.equal(untrusted.every((candidate) => candidate.path.startsWith(fixture.agentDir)), true);
	} finally {
		if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previousAgentDir;
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("refuses malformed settings, serializes extension updates, and preserves unrelated settings", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-extension-manager-settings-"));
	const malformedPath = join(root, "malformed", "settings.json");
	const validPath = join(root, "valid", "settings.json");
	try {
		await mkdir(join(root, "malformed"), { recursive: true });
		await mkdir(join(root, "valid"), { recursive: true });
		await writeFile(malformedPath, '{"extensions":');
		await assert.rejects(__testing.updateSettings(malformedPath, () => []), /Refusing to overwrite/);
		assert.equal(await readFile(malformedPath, "utf8"), '{"extensions":');

		await writeFile(validPath, JSON.stringify({ untouched: { value: true }, extensions: [] }));
		await Promise.all(
			Array.from({ length: 24 }, (_, index) =>
				__testing.updateSettings(validPath, (paths) => [...paths, `+extension-${index}.ts`]),
			),
		);
		const saved = JSON.parse(await readFile(validPath, "utf8"));
		assert.deepEqual(saved.untouched, { value: true });
		assert.deepEqual(saved.extensions, Array.from({ length: 24 }, (_, index) => `+extension-${index}.ts`));

		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const projectSettingsPath = join(projectDir, ".pi", "settings.json");
		await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(join(projectDir, ".pi"), { recursive: true })]);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["+global.ts"] }));
		await writeFile(projectSettingsPath, JSON.stringify({ untouched: true, extensions: [] }));
		await __testing.updateSettings(projectSettingsPath, (paths) => [...paths, "-project.ts"], projectDir, agentDir, "project");
		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).extensions, ["+global.ts"]);
		assert.deepEqual(JSON.parse(await readFile(projectSettingsPath, "utf8")), {
			untouched: true,
			extensions: ["-project.ts"],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses symlinked settings rather than replacing the link", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-extension-manager-symlink-"));
	const targetPath = join(root, "target.json");
	const settingsPath = join(root, "settings.json");
	try {
		await writeFile(targetPath, JSON.stringify({ extensions: ["keep"] }));
		await symlink(targetPath, settingsPath);
		await assert.rejects(__testing.updateSettings(settingsPath, () => []), /symlinked settings/i);
		assert.equal(await readFile(targetPath, "utf8"), JSON.stringify({ extensions: ["keep"] }));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("guards the custom TUI command and clips every dialog line at narrow widths", async () => {
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const fixture = await makeFixture();
	process.env[AGENT_DIR_ENV] = fixture.agentDir;
	try {
		let command: any;
		extensionManager({ registerCommand: (_name: string, options: unknown) => (command = options) } as any);
		const notifications: string[] = [];
		await command.handler("", {
			mode: "print",
			ui: { notify: (message: string) => notifications.push(message) },
		} as any);
		assert.match(notifications[0] ?? "", /interactive terminal UI/);

		initTheme("dark", false);
		let component: { render(width: number): string[] } | undefined;
		await command.handler("", {
			cwd: fixture.projectDir,
			mode: "tui",
			hasUI: false,
			isProjectTrusted: () => true,
			ui: {
				notify() {},
				custom: async (factory: any) => {
					component = factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						() => {},
					);
				},
			},
			reload: async () => {},
		} as any);
		assert.ok(component);
		for (const width of [0, 1, 2, 8, 20]) {
			for (const line of component.render(width)) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
			}
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previousAgentDir;
		await rm(fixture.root, { recursive: true, force: true });
	}
});

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@mariozechner/pi-tui";

const COMMAND_NAME = "extensions-ui";
const GLOBAL_ROOT = join(homedir(), ".pi", "agent");
const GLOBAL_EXTENSIONS_DIR = join(GLOBAL_ROOT, "extensions");
const GLOBAL_SETTINGS_PATH = join(GLOBAL_ROOT, "settings.json");
const PROJECT_SETTINGS_DIRNAME = ".pi";
const PROJECT_EXTENSIONS_DIRNAME = "extensions";

type Scope = "global" | "project";

interface SettingsShape {
	extensions?: string[];
	[key: string]: unknown;
}

interface ExtensionCandidate {
	id: string;
	path: string;
	scope: Scope;
	settingsPath: string;
	label: string;
	disabled: boolean;
	origin: "auto" | "settings";
	isSelf: boolean;
}

export default function extensionManager(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: "Enable/disable discovered local extensions",
		handler: async (_args, ctx) => {
			let candidates = await discoverCandidates(ctx);
			if (candidates.length === 0) {
				ctx.ui.notify("No local extensions found in ~/.pi/agent/extensions, .pi/extensions, or settings.json extension paths.", "info");
				return;
			}

			let dirty = false;
			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [
								theme.fg("accent", theme.bold("Extension Manager")),
								theme.fg("dim", "Toggle local extensions. Changes are written to settings.json and applied after reload."),
								"",
							];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					toSettingItems(candidates),
					Math.min(candidates.length + 2, 18),
					getSettingsListTheme(),
					(id, newValue) => {
						void (async () => {
							const candidate = candidates.find((item) => item.id === id);
							if (!candidate) return;
							const nextDisabled = newValue === "disabled";
							if (candidate.disabled === nextDisabled) return;
							await setCandidateDisabled(candidate, nextDisabled);
							candidate.disabled = nextDisabled;
							dirty = true;
							settingsList.updateValue(id, nextDisabled ? "disabled" : "enabled");
							tui.requestRender();
						})().catch((error) => {
							ctx.ui.notify(`Failed to update extension setting: ${error instanceof Error ? error.message : String(error)}`, "error");
						});
					},
					() => done(undefined),
				);

				container.addChild(settingsList);

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});

			if (!dirty) return;
			const ok = !ctx.hasUI || (await ctx.ui.confirm("Reload extensions", "Settings updated. Reload extensions now?"));
			if (!ok) {
				ctx.ui.notify(`Saved changes. Run /reload later to apply them.`, "info");
				return;
			}
			await ctx.reload();
		},
	});
}

function toSettingItems(candidates: ExtensionCandidate[]): SettingItem[] {
	return candidates.map((candidate) => ({
		id: candidate.id,
		label: candidate.label,
		currentValue: candidate.disabled ? "disabled" : "enabled",
		values: ["enabled", "disabled"],
	}));
}

async function discoverCandidates(ctx: ExtensionCommandContext): Promise<ExtensionCandidate[]> {
	const projectRoot = ctx.cwd;
	const projectSettingsPath = join(projectRoot, PROJECT_SETTINGS_DIRNAME, "settings.json");
	const projectExtensionsDir = join(projectRoot, PROJECT_SETTINGS_DIRNAME, PROJECT_EXTENSIONS_DIRNAME);
	const selfPath = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

	const [globalSettings, projectSettings] = await Promise.all([
		readSettings(GLOBAL_SETTINGS_PATH),
		readSettings(projectSettingsPath),
	]);

	const candidates = new Map<string, ExtensionCandidate>();

	for (const path of await listDiscoveredExtensionEntryPoints(GLOBAL_EXTENSIONS_DIR)) {
		candidates.set(path, createCandidate(path, "global", GLOBAL_SETTINGS_PATH, globalSettings, selfPath, projectRoot, "auto"));
	}
	for (const path of await listDiscoveredExtensionEntryPoints(projectExtensionsDir)) {
		candidates.set(path, createCandidate(path, "project", projectSettingsPath, projectSettings, selfPath, projectRoot, "auto"));
	}

	for (const path of await listExplicitSettingsPaths(globalSettings.extensions ?? [], GLOBAL_ROOT)) {
		candidates.set(path, createCandidate(path, "global", GLOBAL_SETTINGS_PATH, globalSettings, selfPath, projectRoot, "settings"));
	}
	for (const path of await listExplicitSettingsPaths(projectSettings.extensions ?? [], join(projectRoot, PROJECT_SETTINGS_DIRNAME))) {
		candidates.set(path, createCandidate(path, "project", projectSettingsPath, projectSettings, selfPath, projectRoot, "settings"));
	}

	return [...candidates.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function createCandidate(
	path: string,
	scope: Scope,
	settingsPath: string,
	settings: SettingsShape,
	selfPath: string,
	projectRoot: string,
	origin: "auto" | "settings",
): ExtensionCandidate {
	const resolvedPath = resolve(path);
	return {
		id: `${scope}:${resolvedPath}`,
		path: resolvedPath,
		scope,
		settingsPath,
		label: formatLabel(resolvedPath, scope, projectRoot, origin, resolvedPath === selfPath),
		disabled: isPathDisabled(settings.extensions ?? [], resolvedPath),
		origin,
		isSelf: resolvedPath === selfPath,
	};
}

function formatLabel(path: string, scope: Scope, projectRoot: string, origin: "auto" | "settings", isSelf: boolean): string {
	const scopeLabel = scope === "global" ? "global" : "project";
	const originLabel = origin === "settings" ? "settings" : "auto";
	const selfLabel = isSelf ? " • self" : "";
	return `${displayPath(path, projectRoot)} [${scopeLabel} • ${originLabel}${selfLabel}]`;
}

function displayPath(path: string, projectRoot: string): string {
	const home = homedir();
	if (path.startsWith(projectRoot + "/")) {
		return relative(projectRoot, path) || ".";
	}
	if (path.startsWith(home + "/")) {
		return `~/${relative(home, path)}`;
	}
	return path;
}

function isPathDisabled(entries: string[], targetPath: string): boolean {
	return entries.some((entry) => normalizeDisableEntry(entry) === targetPath);
}

function normalizeDisableEntry(entry: string): string | undefined {
	if (!entry.startsWith("-")) return undefined;
	const raw = entry.slice(1).trim();
	if (!raw || looksLikePattern(raw)) return undefined;
	return resolve(raw);
}

function looksLikePattern(value: string): boolean {
	return value.includes("*") || value.includes("?") || value.includes("[") || value.startsWith("!") || value.startsWith("+");
}

async function listExplicitSettingsPaths(entries: string[], baseDir: string): Promise<string[]> {
	const results = new Set<string>();
	for (const entry of entries) {
		const trimmed = entry.trim();
		if (!trimmed || trimmed.startsWith("-") || trimmed.startsWith("!")) continue;
		if (looksLikePattern(trimmed)) continue;
		const raw = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
		const resolved = resolvePathLikePi(raw, baseDir);
		for (const item of await expandExtensionSource(resolved)) {
			results.add(item);
		}
	}
	return [...results];
}

async function listDiscoveredExtensionEntryPoints(rootDir: string): Promise<string[]> {
	const results = new Set<string>();
	for (const source of await listImmediateChildren(rootDir)) {
		for (const item of await expandExtensionSource(source)) {
			results.add(item);
		}
	}
	return [...results];
}

async function listImmediateChildren(dir: string): Promise<string[]> {
	try {
		const fs = await import("node:fs/promises");
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => !entry.name.startsWith("."))
			.map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

async function expandExtensionSource(sourcePath: string): Promise<string[]> {
	try {
		const stat = await import("node:fs/promises").then((fs) => fs.stat(sourcePath));
		if (stat.isFile()) {
			const ext = extname(sourcePath);
			if (ext === ".ts" || ext === ".js" || ext === ".mjs" || ext === ".cjs") {
				return [resolve(sourcePath)];
			}
			if (basename(sourcePath) === "package.json") {
				return await expandPackageJson(dirname(sourcePath));
			}
			return [];
		}
		if (!stat.isDirectory()) return [];
		const packageEntries = await expandPackageJson(sourcePath);
		if (packageEntries.length > 0) return packageEntries;
		const candidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
		const results: string[] = [];
		for (const candidate of candidates) {
			const fullPath = join(sourcePath, candidate);
			if (await pathExists(fullPath)) results.push(resolve(fullPath));
		}
		return results;
	} catch {
		return [];
	}
}

async function expandPackageJson(dir: string): Promise<string[]> {
	const packagePath = join(dir, "package.json");
	if (!(await pathExists(packagePath))) return [];
	try {
		const raw = await readFile(packagePath, "utf8");
		const parsed = JSON.parse(raw) as { pi?: { extensions?: unknown } };
		const entries = Array.isArray(parsed.pi?.extensions) ? parsed.pi!.extensions : [];
		return entries
			.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
			.map((entry) => resolve(dir, entry));
	} catch {
		return [];
	}
}

async function setCandidateDisabled(candidate: ExtensionCandidate, disabled: boolean): Promise<void> {
	const settings = await readSettings(candidate.settingsPath);
	const current = Array.isArray(settings.extensions) ? [...settings.extensions] : [];
	const normalizedTarget = resolve(candidate.path);
	const filtered = current.filter((entry) => normalizeDisableEntry(entry) !== normalizedTarget);
	if (disabled) {
		filtered.push(`-${normalizedTarget}`);
	}
	settings.extensions = filtered;
	await writeSettings(candidate.settingsPath, settings);
}

async function readSettings(path: string): Promise<SettingsShape> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as SettingsShape;
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

async function writeSettings(path: string, settings: SettingsShape): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function resolvePathLikePi(value: string, baseDir: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return resolve(baseDir, value);
}

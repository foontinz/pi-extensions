import { lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	getAgentDir,
	getSettingsListTheme,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, truncateToWidth } from "@earendil-works/pi-tui";

const COMMAND_NAME = "extensions-ui";
type Scope = "global" | "project";

type SettingsShape = Record<string, unknown> & {
	extensions?: string[];
};

type SettingsReadResult =
	| { kind: "missing"; settings: SettingsShape }
	| { kind: "valid"; settings: SettingsShape }
	| { kind: "invalid"; error: Error };

interface ExtensionCandidate {
	id: string;
	path: string;
	scope: Scope;
	settingsPath: string;
	settingsBaseDir: string;
	settingsCwd: string;
	settingsAgentDir: string;
	label: string;
	disabled: boolean;
	origin: "auto" | "settings";
	isSelf: boolean;
	updateVersion: number;
}

const updateQueues = new Map<string, Promise<void>>();

export default function extensionManager(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: "Enable/disable discovered local extensions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/extensions-ui is only available in the interactive terminal UI.", "info");
				return;
			}

			const candidates = await discoverCandidates(ctx);
			if (candidates.length === 0) {
				ctx.ui.notify(
					`No local extensions found in ${join(getAgentDir(), "extensions")}, ${CONFIG_DIR_NAME}/extensions, or settings.json extension paths.`,
					"info",
				);
				return;
			}

			let dirty = false;
			const pendingUpdates: Promise<void>[] = [];
			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(
					new (class {
						render(width: number) {
							return [
								truncateToWidth(theme.fg("accent", theme.bold("Extension Manager")), width),
								truncateToWidth(
									theme.fg("dim", "Toggle local extensions. Changes are written to settings.json and applied after reload."),
									width,
								),
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
						const candidate = candidates.find((item) => item.id === id);
						if (!candidate) return;
						const nextDisabled = newValue === "disabled";
						// SettingsList changes its own displayed value before calling us. Keep
						// every rapid toggle: the per-file update queue preserves their order.
						const updateVersion = ++candidate.updateVersion;
						const update = setCandidateDisabled(candidate, nextDisabled)
							.then(() => {
								candidate.disabled = nextDisabled;
								dirty = true;
							})
							.catch((error) => {
								if (candidate.updateVersion === updateVersion) {
									settingsList.updateValue(id, candidate.disabled ? "disabled" : "enabled");
								}
								ctx.ui.notify(
									`Failed to update extension setting: ${error instanceof Error ? error.message : String(error)}`,
									"error",
								);
							})
							.finally(() => tui.requestRender());
						pendingUpdates.push(update);
					},
					() => done(undefined),
				);

				container.addChild(settingsList);

				return {
					render(width: number) {
						// Child components are independently width-aware, but clipping here
						// also protects the dialog if their implementation changes.
						return container.render(width).map((line) => truncateToWidth(line, width));
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

			// SettingsList callbacks cannot be awaited by the component. Do not offer
			// reload until every queued, Pi-locked settings update has completed.
			await Promise.all(pendingUpdates);
			if (!dirty) return;
			const ok = !ctx.hasUI || (await ctx.ui.confirm("Reload extensions", "Settings updated. Reload extensions now?"));
			if (!ok) {
				ctx.ui.notify("Saved changes. Run /reload later to apply them.", "info");
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
	const agentDir = resolve(getAgentDir());
	const projectRoot = resolve(ctx.cwd);
	const projectBaseDir = join(projectRoot, CONFIG_DIR_NAME);
	const projectTrusted = ctx.isProjectTrusted();
	const globalSettingsPath = join(agentDir, "settings.json");
	const projectSettingsPath = join(projectBaseDir, "settings.json");
	const [globalSettingsResult, projectSettingsResult] = await Promise.all([
		readSettings(globalSettingsPath),
		projectTrusted ? readSettings(projectSettingsPath) : Promise.resolve<SettingsReadResult>({ kind: "missing", settings: {} }),
	]);

	// DefaultPackageManager is Pi's public implementation of local extension
	// discovery, manifests, ignore files, patterns, and +/-/! filter precedence.
	// Use a snapshot with packages removed: package resources need package-specific
	// filters and cannot be safely toggled through settings.extensions.
	const settingsManager = SettingsManager.fromStorage(
		new SnapshotSettingsStorage(
			withoutPackages(readableSettings(globalSettingsResult)),
			withoutPackages(readableSettings(projectSettingsResult)),
		),
		{ projectTrusted },
	);
	const packageManager = new DefaultPackageManager({ cwd: projectRoot, agentDir, settingsManager });
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	const selfPath = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

	return resolvedPaths.extensions
		.filter((resource) => resource.metadata.origin === "top-level")
		.map((resource) =>
			createCandidate(
				resource,
				globalSettingsPath,
				projectSettingsPath,
				agentDir,
				projectBaseDir,
				selfPath,
				projectRoot,
			),
		)
		.sort((a, b) => a.label.localeCompare(b.label));
}

function createCandidate(
	resource: ResolvedResource,
	globalSettingsPath: string,
	projectSettingsPath: string,
	agentDir: string,
	projectBaseDir: string,
	selfPath: string,
	settingsCwd: string,
): ExtensionCandidate {
	const scope: Scope = resource.metadata.scope === "project" ? "project" : "global";
	const path = resolve(resource.path);
	const settingsPath = scope === "global" ? globalSettingsPath : projectSettingsPath;
	const settingsBaseDir = scope === "global" ? agentDir : projectBaseDir;
	const origin = resource.metadata.source === "auto" ? "auto" : "settings";
	const isSelf = path === selfPath;
	return {
		id: `${scope}:${path}`,
		path,
		scope,
		settingsPath,
		settingsBaseDir,
		settingsCwd,
		settingsAgentDir: agentDir,
		label: formatLabel(path, scope, projectBaseDir, origin, isSelf),
		disabled: !resource.enabled,
		origin,
		isSelf,
		updateVersion: 0,
	};
}

function formatLabel(path: string, scope: Scope, projectRoot: string, origin: "auto" | "settings", isSelf: boolean): string {
	const scopeLabel = scope === "global" ? "global" : "project";
	const originLabel = origin === "settings" ? "settings" : "auto";
	const selfLabel = isSelf ? " • self" : "";
	return `${displayPath(path, projectRoot)} [${scopeLabel} • ${originLabel}${selfLabel}]`;
}

function displayPath(path: string, projectRoot: string): string {
	if (isWithin(path, projectRoot)) {
		return relative(projectRoot, path) || ".";
	}
	const home = homedir();
	if (isWithin(path, home)) {
		return `~/${relative(home, path)}`;
	}
	return path;
}

function isWithin(path: string, root: string): boolean {
	const pathFromRoot = relative(root, path);
	return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

async function setCandidateDisabled(candidate: ExtensionCandidate, disabled: boolean): Promise<void> {
	await updateSettings(
		candidate.settingsPath,
		(current) => {
			const filtered = current.filter(
				(entry) => !isExactOverrideForPath(entry, candidate.path, candidate.settingsBaseDir),
			);
			// Pi's filter order gives exact '-' overrides final precedence, while '+'
			// re-enables an extension excluded by a glob. Use those same operations.
			filtered.push(`${disabled ? "-" : "+"}${toPosixPath(candidate.path)}`);
			return filtered;
		},
		candidate.settingsCwd,
		candidate.settingsAgentDir,
		candidate.scope,
	);
}

function isExactOverrideForPath(entry: string, targetPath: string, baseDir: string): boolean {
	if (!entry.startsWith("+") && !entry.startsWith("-")) return false;
	const pattern = normalizeExactPattern(entry.slice(1));
	return pattern === toPosixPath(targetPath) || pattern === toPosixPath(relative(baseDir, targetPath));
}

function normalizeExactPattern(pattern: string): string {
	return toPosixPath(pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern);
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

async function readSettings(path: string): Promise<SettingsReadResult> {
	try {
		await assertNotSymlink(path);
		return parseSettings(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "missing", settings: {} };
		}
		return {
			kind: "invalid",
			error: new Error(`settings.json cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`),
		};
	}
}

function parseSettings(raw: string): SettingsReadResult {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) {
			return { kind: "invalid", error: new Error("settings.json must contain an object") };
		}
		if (parsed.extensions !== undefined && (!Array.isArray(parsed.extensions) || !parsed.extensions.every(isString))) {
			return { kind: "invalid", error: new Error("settings.json extensions must be an array of strings") };
		}
		return { kind: "valid", settings: parsed as SettingsShape };
	} catch (error) {
		return {
			kind: "invalid",
			error: new Error(`settings.json cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`),
		};
	}
}

function readableSettings(result: SettingsReadResult): SettingsShape {
	return result.kind === "invalid" ? {} : result.settings;
}

function withoutPackages(settings: SettingsShape): SettingsShape {
	return { ...settings, packages: [] };
}

async function updateSettings(
	path: string,
	updateExtensions: (current: string[]) => string[],
	cwd: string = dirname(path),
	agentDir: string = dirname(path),
	scope: Scope = "global",
): Promise<string[]> {
	return serializeUpdate(path, () =>
		withExtensionUpdateLock(path, async () => {
			// SettingsManager deliberately records load/write errors instead of
			// throwing. Validate the target before scheduling its public write so a
			// malformed file or pre-existing symlink is never silently replaced.
			await assertNotSymlink(path);
			const current = await readSettings(path);
			if (current.kind === "invalid") {
				throw new Error(`Refusing to overwrite malformed settings.json: ${current.error.message}`);
			}
			const paths = updateExtensions([...(current.settings.extensions ?? [])]);
			if (!paths.every(isString)) {
				throw new Error("settings.json extensions must be an array of strings");
			}

			// Use SettingsManager's public persistence API. Its own settings lock
			// coordinates the write with Pi and merges only the extensions field.
			// The outer extension-manager lock makes our read/modify/write atomic
			// across multiple Pi processes using this extension.
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: scope === "project" });
			await assertNotSymlink(path);
			if (scope === "project") settingsManager.setProjectExtensionPaths(paths);
			else settingsManager.setExtensionPaths(paths);
			await settingsManager.flush();
			const errors = settingsManager.drainErrors().filter((error) => error.scope === scope);
			if (errors.length > 0) throw errors[0]!.error;
			return paths;
		}),
	);
}

async function withExtensionUpdateLock<T>(settingsPath: string, operation: () => Promise<T>): Promise<T> {
	await mkdir(dirname(settingsPath), { recursive: true });
	// Use a distinct target from Pi's own settings lock to avoid recursive lock
	// acquisition when SettingsManager.flush() runs inside this critical section.
	const target = `${settingsPath}.extensions-ui-rmw`;
	const release = await lockfile.lock(target, {
		realpath: false,
		stale: 30_000,
		update: 10_000,
		retries: { retries: 50, minTimeout: 20, maxTimeout: 100 },
	});
	try {
		return await operation();
	} finally {
		await release();
	}
}

function serializeUpdate<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const previous = updateQueues.get(path) ?? Promise.resolve();
	const result = previous.catch(() => undefined).then(operation);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	updateQueues.set(path, tail);
	void tail.finally(() => {
		if (updateQueues.get(path) === tail) updateQueues.delete(path);
	});
	return result;
}

async function assertNotSymlink(path: string): Promise<void> {
	try {
		if ((await lstat(path)).isSymbolicLink()) {
			throw new Error("Refusing to use a symlinked settings.json");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

class SnapshotSettingsStorage {
	constructor(
		private global: SettingsShape,
		private project: SettingsShape,
	) {}

	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
		const current = JSON.stringify(scope === "global" ? this.global : this.project);
		const next = fn(current);
		if (next === undefined) return;
		const parsed = JSON.parse(next) as SettingsShape;
		if (scope === "global") this.global = parsed;
		else this.project = parsed;
	}
}

// Focused tests use these to exercise the public command without duplicating
// filesystem and Pi filter semantics in test-only copies.
export const __testing = {
	discoverCandidates,
	readSettings,
	setCandidateDisabled,
	updateSettings,
	isExactOverrideForPath,
};

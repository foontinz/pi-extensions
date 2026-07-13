import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	getAgentDir,
	SettingsManager,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Text } from "@earendil-works/pi-tui";
import {
	errorResult,
	getResultText,
	MODES,
	shortenPath,
	tightBox,
	type ViewMode,
	withInner,
} from "./render-helpers.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODE_DESCRIPTION: Record<ViewMode, string> = {
	minimized: "show only which tool ran (no output)",
	medium: "hide write/edit content & diffs, keep everything else",
	verbose: "full output (pi default)",
};

const PREFS_PATH = join(getAgentDir(), "tool-view.json");
const STATUS_KEY = "tool-view";

// Built-in tools we wrap. Each factory returns the original ToolDefinition
// (including the native renderCall / renderResult) which we delegate to in
// verbose mode and selectively suppress in the other modes.
const FACTORIES: Record<string, (cwd: string) => ToolDefinition<any, any, any>> = {
	read: createReadToolDefinition,
	write: createWriteToolDefinition,
	edit: createEditToolDefinition,
	bash: createBashToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};

/** Pi settings that affect managed tool execution. */
export interface ToolViewToolSettings {
	shellPath?: string;
	commandPrefix?: string;
	autoResizeImages: boolean;
}

type ToolSettingsReader = Pick<
	SettingsManager,
	"getShellPath" | "getShellCommandPrefix" | "getImageAutoResize"
>;

/** Read the settings that must be preserved when a built-in is re-registered. */
export function getToolViewToolSettings(settings: ToolSettingsReader): ToolViewToolSettings {
	return {
		shellPath: settings.getShellPath(),
		commandPrefix: settings.getShellCommandPrefix(),
		autoResizeImages: settings.getImageAutoResize(),
	};
}

/**
 * Create a managed definition with Pi's configured execution options. Exported
 * so other extensions can use the same setting-preserving wrapper behavior.
 */
export function createManagedToolDefinition(
	name: string,
	cwd: string,
	settings: ToolViewToolSettings,
): ToolDefinition<any, any, any> {
	switch (name) {
		case "bash":
			return createBashToolDefinition(cwd, {
				shellPath: settings.shellPath,
				commandPrefix: settings.commandPrefix,
			});
		case "read":
			return createReadToolDefinition(cwd, { autoResizeImages: settings.autoResizeImages });
		default:
			return FACTORIES[name]!(cwd);
	}
}

// Tools whose details are stripped in "medium" mode.
const DETAIL_HEAVY = new Set(["write", "edit"]);

type ToolSource = {
	name: string;
	sourceInfo: { source: string };
};

/**
 * Tool provenance is the only reliable way to decide whether a built-in can be
 * wrapped: sibling extensions may be installed but disabled, or enabled from a
 * completely different location. `getAllTools()` exposes the canonical source.
 */
export function selectManagedTools(
	activeTools: Iterable<string>,
	allTools: Iterable<ToolSource>,
	prefsExclude: Iterable<string>,
): string[] {
	const active = new Set(activeTools);
	const sourceByName = new Map(Array.from(allTools, (tool) => [tool.name, tool.sourceInfo.source]));
	const excluded = new Set(prefsExclude);

	return Object.keys(FACTORIES).filter(
		(name) => active.has(name) && sourceByName.get(name) === "builtin" && !excluded.has(name),
	);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const prefs = loadPrefs();
	let mode: ViewMode = prefs.mode;
	let toolsRegistered = false;
	let toolSettings: ToolViewToolSettings | undefined;

	// `shouldStrip` is read at render time (inside the renderers below), so a
	// mode change immediately affects every subsequent tool render without
	// re-registering anything.
	const shouldStrip = (toolName: string): boolean => {
		if (mode === "verbose") return false;
		if (mode === "minimized") return true;
		return DETAIL_HEAVY.has(toolName); // medium
	};

	const registerManagedTools = (cwd: string) => {
		if (toolsRegistered) return;
		if (!toolSettings) throw new Error("tool-view settings must be loaded before tool registration");

		for (const name of selectManagedTools(pi.getActiveTools(), pi.getAllTools(), prefs.exclude ?? [])) {
			// The base definition supplies schema, prompt metadata, and native
			// renderers. Execution gets a fresh definition for the invocation cwd.
			const base = createManagedToolDefinition(name, cwd, toolSettings);
			const baseRenderCall = base.renderCall;
			const baseRenderResult = base.renderResult;
			const label = base.label || name;

			pi.registerTool({
				...base,
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					return createManagedToolDefinition(name, ctx.cwd, toolSettings!).execute(
						toolCallId,
						params,
						signal,
						onUpdate,
						ctx,
					);
				},
				// Render our own framing so we can drop the default shell's vertical
				// padding (a blank line above & below every row) while keeping the
				// background tint + horizontal padding.
				renderShell: "self",
				renderCall(args: any, theme: Theme, context: any): Component {
					const inner = shouldStrip(name)
						? compactCall(label, name, args, theme, context)
						: baseRenderCall
							? baseRenderCall(args, theme, withInner(context))
							: new Text("", 0, 0);
					return tightBox(context, theme, inner);
				},
				renderResult(result: any, options: any, theme: Theme, context: any): Component {
					let inner: Component;
					if (shouldStrip(name)) {
						if (context.isError) {
							inner = errorResult(result, theme);
						} else {
							// Hide the body; the compact call line already says which tool ran.
							return new Container();
						}
					} else {
						inner = baseRenderResult
							? baseRenderResult(result, options, theme, withInner(context))
							: new Text(getResultText(result), 0, 0);
					}
					return tightBox(context, theme, inner);
				},
			} as ToolDefinition<any, any, any>);
		}
		toolsRegistered = true;
	};

	const refreshStatus = (ctx: ExtensionContext | ExtensionCommandContext) => {
		ctx.ui.setStatus(STATUS_KEY, `tools: ${mode}`);
	};

	pi.on("session_start", async (_event, ctx) => {
		mode = loadPrefs().mode;
		// Load once from the session cwd, just as Pi does, before creating any
		// replacement definitions. These options are reused for each call's cwd.
		toolSettings = getToolViewToolSettings(
			SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted?.() ?? false }),
		);
		// Tool metadata is only available after Pi binds the extension runtime.
		registerManagedTools(ctx.cwd);
		refreshStatus(ctx);
	});

	pi.registerCommand("toolview", {
		description:
			"Set tool-call verbosity: minimized | medium | verbose (no argument cycles)",
		getArgumentCompletions: (prefix) =>
			MODES.filter((m) => m.startsWith(prefix.trim().toLowerCase())).map((m) => ({
				value: m,
				label: m,
				description: MODE_DESCRIPTION[m],
			})),
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			let next: ViewMode;
			if (!arg) {
				next = MODES[(MODES.indexOf(mode) + 1) % MODES.length] as ViewMode;
			} else if (isMode(arg)) {
				next = arg;
			} else {
				ctx.ui.notify(
					`Unknown tool view "${arg}". Use: ${MODES.join(", ")}.`,
					"warning",
				);
				return;
			}

			mode = next;
			await saveMode(mode);
			refreshStatus(ctx);
			ctx.ui.notify(
				`Tool view: ${mode} — ${MODE_DESCRIPTION[mode]}. Applies to new tool calls.`,
				"info",
			);
		},
	});
}

// ---------------------------------------------------------------------------
// Compact renderers
// ---------------------------------------------------------------------------

function compactCall(
	label: string,
	toolName: string,
	args: any,
	theme: Theme,
	context: any,
): Component {
	const prev = context.lastComponent instanceof Box ? context.lastComponent.children[0] : undefined;
	// `prev` may be a native (non-Text) component if the mode just switched; only
	// reuse it when it is actually a Text, otherwise start fresh.
	const text = prev instanceof Text ? prev : new Text("", 0, 0);
	let content = theme.fg("toolTitle", theme.bold(`${label} `));
	const target = describeTarget(toolName, args, context.cwd);
	if (target) {
		content += theme.fg("accent", target);
	}
	text.setText(content);
	return text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeTarget(toolName: string, args: any, cwd: string): string {
	if (!args || typeof args !== "object") return "";
	switch (toolName) {
		case "bash": {
			const cmd = typeof args.command === "string" ? args.command : "";
			return firstLine(cmd, 80);
		}
		case "grep": {
			const pat = str(args.pattern);
			return pat ? `"${truncate(pat, 60)}"` : "";
		}
		case "find":
			return truncate(str(args.pattern) || str(args.name) || str(args.path), 80);
		default: {
			// read / write / edit / ls
			const p = str(args.path) || str(args.file_path);
			return p ? shortenPath(p, cwd) : "";
		}
	}
}

function firstLine(text: string, max: number): string {
	const line = text.split("\n")[0] ?? "";
	const extra = text.includes("\n") ? " …" : "";
	return truncate(line, max) + extra;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isMode(value: string): value is ViewMode {
	return (MODES as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface Prefs {
	version: 1;
	mode: ViewMode;
	/** Built-in tool names tool-view must NOT manage (e.g. owned by another extension). */
	exclude?: string[];
}

function loadPrefs(): Prefs {
	try {
		const raw = readFileSync(PREFS_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<Prefs>;
		return {
			version: 1,
			mode: parsed.mode && isMode(parsed.mode) ? parsed.mode : "verbose",
			exclude: Array.isArray(parsed.exclude)
				? parsed.exclude.filter((t): t is string => typeof t === "string")
				: undefined,
		};
	} catch {
		// missing or unreadable — fall back to defaults
	}
	return { version: 1, mode: "verbose" };
}

async function saveMode(mode: ViewMode): Promise<void> {
	const prefs = loadPrefs();
	prefs.mode = mode;
	await mkdir(dirname(PREFS_PATH), { recursive: true });
	await writeFile(PREFS_PATH, `${JSON.stringify(prefs, null, "\t")}\n`, "utf8");
}

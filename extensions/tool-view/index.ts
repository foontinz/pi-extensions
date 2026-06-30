import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type ViewMode = "minimized" | "medium" | "verbose";

const MODES: ViewMode[] = ["minimized", "medium", "verbose"];

const MODE_DESCRIPTION: Record<ViewMode, string> = {
	minimized: "show only which tool ran (no output)",
	medium: "hide write/edit content & diffs, keep everything else",
	verbose: "full output (pi default)",
};

const PREFS_PATH = join(homedir(), ".pi", "agent", "tool-view.json");
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

// Tools whose details are stripped in "medium" mode.
const DETAIL_HEAVY = new Set(["write", "edit"]);

// Other extensions in this agent dir that own a built-in tool. tool-view must
// NOT re-register those tools, otherwise it would clobber their behavior and
// pi reports a conflict. Maps a sibling extension dir name -> tools it owns.
const SIBLING_TOOL_OWNERS: Record<string, string[]> = {
	"enhanced-bash": ["bash"],
};

function computeExcluded(prefsExclude: string[]): Set<string> {
	const excluded = new Set(prefsExclude);
	// .../extensions/tool-view -> .../extensions (independent of this dir's name)
	const extensionsDir = dirname(dirname(fileURLToPath(import.meta.url)));
	for (const [sibling, ownedTools] of Object.entries(SIBLING_TOOL_OWNERS)) {
		if (existsSync(join(extensionsDir, sibling))) {
			for (const tool of ownedTools) excluded.add(tool);
		}
	}
	return excluded;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const prefs = loadPrefs();
	let mode: ViewMode = prefs.mode;
	const excluded = computeExcluded(prefs.exclude ?? []);

	// `shouldStrip` is read at render time (inside the renderers below), so a
	// mode change immediately affects every subsequent tool render without
	// re-registering anything.
	const shouldStrip = (toolName: string): boolean => {
		if (mode === "verbose") return false;
		if (mode === "minimized") return true;
		return DETAIL_HEAVY.has(toolName); // medium
	};

	const cwd = process.cwd();

	for (const [name, factory] of Object.entries(FACTORIES)) {
		if (excluded.has(name)) continue; // owned by another extension / opted out
		const base = factory(cwd);
		const baseRenderCall = base.renderCall;
		const baseRenderResult = base.renderResult;
		const label = base.label || name;

		pi.registerTool({
			...base,
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

	const refreshStatus = (ctx: ExtensionContext | ExtensionCommandContext) => {
		ctx.ui.setStatus(STATUS_KEY, `tools: ${mode}`);
	};

	pi.on("session_start", async (_event, ctx) => {
		mode = loadPrefs().mode;
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

// Wrap a slot's inner component in a Box with horizontal padding + background
// tint but NO vertical padding, reusing the existing Box across renders. The
// inner component is stored as the Box's only child so the wrapped native
// renderer keeps receiving its own component via `withInner()`.
function tightBox(context: any, theme: Theme, inner: Component): Component {
	const bgKey = context.isPartial
		? "toolPendingBg"
		: context.isError
			? "toolErrorBg"
			: "toolSuccessBg";
	const bgFn = (text: string) => theme.bg(bgKey, text);
	const box = context.lastComponent instanceof Box ? context.lastComponent : new Box(1, 0, bgFn);
	box.setBgFn(bgFn);
	box.clear();
	box.addChild(inner);
	return box;
}

// Give a native renderer a context whose `lastComponent` is the inner component
// it returned last time (the Box's child), not our Box wrapper.
function withInner(context: any): any {
	const prevInner =
		context.lastComponent instanceof Box ? context.lastComponent.children[0] : context.lastComponent;
	return { ...context, lastComponent: prevInner };
}

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

function errorResult(result: any, theme: Theme): Component {
	const out = getResultText(result);
	return new Text(out ? theme.fg("error", out) : theme.fg("error", "Error"), 0, 0);
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

function getResultText(result: any): string {
	if (!result || !Array.isArray(result.content)) return "";
	return result.content
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text || "")
		.join("\n");
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

function shortenPath(path: string, cwd: string): string {
	const home = homedir();
	if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
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

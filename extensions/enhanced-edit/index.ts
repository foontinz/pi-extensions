import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createEditToolDefinition,
	type ExtensionAPI,
	type Theme,
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
} from "../tool-view/render-helpers.js";

// enhanced-edit: overrides the built-in `edit` tool to (1) harden argument
// parsing before schema validation and (2) own its own display minimizing.
//
// Division of responsibility with the tool-view extension:
//   - tool-view is the single source of truth for the SELECTED VERBOSITY LEVEL
//     (it owns the `/toolview` command, the status line, and persists the mode
//     to ~/.pi/agent/tool-view.json). tool-view defers `edit` to us via its
//     SIBLING_TOOL_OWNERS map, so it does not render edit.
//   - enhanced-edit READS that level and applies the minimizing/render logic for
//     edit here (edit is "detail heavy": its diff is hidden in medium & minimized).

// ---------------------------------------------------------------------------
// Argument hardening (runs before schema validation + execute, on every call)
// ---------------------------------------------------------------------------

type Pair = { oldText: string; newText: string };

function toArray(edits: unknown): unknown[] {
	if (Array.isArray(edits)) return edits;
	if (edits && typeof edits === "object") return [edits]; // single object -> array
	if (typeof edits === "string") {
		// stringified JSON (array or single object)
		try {
			const p = JSON.parse(edits);
			if (Array.isArray(p)) return p;
			if (p && typeof p === "object") return [p];
		} catch {
			/* not JSON: fall through */
		}
	}
	return [];
}

// One (possibly malformed) edit -> 0+ clean {oldText,newText}. Extra keys are
// dropped; numbered pairs (oldText2/newText2, ...) are recovered as separate edits.
function normalize(edit: unknown): Pair[] {
	if (!edit || typeof edit !== "object") return [];
	const e = edit as Record<string, unknown>;
	const out: Pair[] = [];
	if (typeof e.oldText === "string" && typeof e.newText === "string") {
		out.push({ oldText: e.oldText, newText: e.newText });
	}
	for (let n = 2; n <= 20; n++) {
		const o = e[`oldText${n}`];
		const w = e[`newText${n}`];
		if (typeof o === "string" && typeof w === "string") {
			out.push({ oldText: o, newText: w });
		}
	}
	return out;
}

function harden(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;
	const a = { ...(input as Record<string, unknown>) };

	// singular `edit` -> `edits`
	if (a.edits === undefined && a.edit !== undefined) {
		a.edits = a.edit;
		delete a.edit;
	}

	const clean: Pair[] = [];
	// top-level flat oldText/newText
	if (typeof a.oldText === "string" && typeof a.newText === "string") {
		clean.push({ oldText: a.oldText, newText: a.newText });
	}
	for (const e of toArray(a.edits)) clean.push(...normalize(e));

	// Only rewrite when we actually recovered edits; otherwise pass through so
	// pi's own validation/error surfaces (don't mask genuinely empty calls).
	if (clean.length === 0) return input;

	const path = typeof a.path === "string" ? a.path : a.file_path;
	return { path, edits: clean };
}

// ---------------------------------------------------------------------------
// Selected level (owned by tool-view, read from its persisted prefs)
// ---------------------------------------------------------------------------

const TOOL_VIEW_PREFS = join(homedir(), ".pi", "agent", "tool-view.json");

// Small mtime-guarded cache so we don't re-read the prefs file on every partial
// render frame while still picking up `/toolview` changes immediately.
let cachedMode: ViewMode = "verbose";
let cachedMtimeMs = -1;

function readViewMode(): ViewMode {
	try {
		const mtime = statSync(TOOL_VIEW_PREFS).mtimeMs;
		if (mtime !== cachedMtimeMs) {
			cachedMtimeMs = mtime;
			const parsed = JSON.parse(readFileSync(TOOL_VIEW_PREFS, "utf8")) as { mode?: string };
			cachedMode = parsed.mode && (MODES as string[]).includes(parsed.mode) ? (parsed.mode as ViewMode) : "verbose";
		}
	} catch {
		// prefs missing/unreadable (tool-view not installed or never set) -> full output
		cachedMode = "verbose";
	}
	return cachedMode;
}

// edit is "detail heavy": its diff is hidden in medium as well as minimized.
function shouldStripEdit(): boolean {
	const mode = readViewMode();
	if (mode === "verbose") return false;
	return true; // medium or minimized
}

// ---------------------------------------------------------------------------
// Compact rendering (mirrors tool-view's framing for a single tool)
// ---------------------------------------------------------------------------

function compactCall(label: string, args: any, theme: Theme, context: any): Component {
	const prev = context.lastComponent instanceof Box ? context.lastComponent.children[0] : undefined;
	const text = prev instanceof Text ? prev : new Text("", 0, 0);
	let content = theme.fg("toolTitle", theme.bold(`${label} `));
	const p = (typeof args?.path === "string" && args.path) || (typeof args?.file_path === "string" && args.file_path) || "";
	if (p) content += theme.fg("accent", shortenPath(p, context.cwd));
	text.setText(content);
	return text;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const base = createEditToolDefinition(process.cwd());
	const basePrepare = (base as { prepareArguments?: (args: unknown) => unknown }).prepareArguments;
	const baseRenderCall = (base as any).renderCall;
	const baseRenderResult = (base as any).renderResult;
	const label = (base as any).label || "edit";

	pi.registerTool({
		...(base as any),
		// Own the framing so we can strip the default shell's vertical padding,
		// matching tool-view's tight rows.
		renderShell: "self",

		prepareArguments(args: unknown) {
			const prepped = harden(args);
			// chain pi's original prepare for anything we didn't touch
			return basePrepare ? basePrepare(prepped) : prepped;
		},

		renderCall(args: any, theme: Theme, context: any): Component {
			const inner = shouldStripEdit()
				? compactCall(label, args, theme, context)
				: baseRenderCall
					? baseRenderCall(args, theme, withInner(context))
					: new Text("", 0, 0);
			return tightBox(context, theme, inner);
		},

		renderResult(result: any, options: any, theme: Theme, context: any): Component {
			if (shouldStripEdit()) {
				if (context.isError) return tightBox(context, theme, errorResult(result, theme));
				// Hide the diff; the compact call line already says which file was edited.
				return context.lastComponent instanceof Container ? context.lastComponent : new Container();
			}
			const inner = baseRenderResult
				? baseRenderResult(result, options, theme, withInner(context))
				: new Text(getResultText(result), 0, 0);
			return tightBox(context, theme, inner);
		},
	} as any);
}

import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";

// Shared compact-render helpers for extensions that own a built-in tool's
// display framing (tool-view itself, and sibling owners such as enhanced-edit).
// These are pure/stateless and safe to import from another extension without
// executing an extension entry module.

export type ViewMode = "minimized" | "medium" | "verbose";

export const MODES: ViewMode[] = ["minimized", "medium", "verbose"];

// Wrap a slot's inner component in a Box with horizontal padding + background
// tint but NO vertical padding, reusing the existing Box across renders. The
// inner component is stored as the Box's only child so the wrapped native
// renderer keeps receiving its own component via `withInner()`.
export function tightBox(context: any, theme: Theme, inner: Component): Component {
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
export function withInner(context: any): any {
	const prevInner =
		context.lastComponent instanceof Box ? context.lastComponent.children[0] : context.lastComponent;
	return { ...context, lastComponent: prevInner };
}

export function shortenPath(path: string, cwd: string): string {
	const home = homedir();
	if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

export function getResultText(result: any): string {
	if (!result || !Array.isArray(result.content)) return "";
	return result.content
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text || "")
		.join("\n");
}

export function errorResult(result: any, theme: Theme): Component {
	const out = getResultText(result);
	return new Text(out ? theme.fg("error", out) : theme.fg("error", "Error"), 0, 0);
}

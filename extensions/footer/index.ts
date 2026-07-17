/**
 * Compact footer extension.
 *
 * Replaces the built-in three-line footer with a two-line layout:
 *
 *   ~/.pi/agent (main)                                  gpt-5.6-sol · low
 *   ↑77k ↓8.7k R1.3M $1.31 (sub) · 17%/372k                 MCP: 0/2
 *   forge 0 ready · caught up · on
 *
 * Differences from the built-in footer:
 * - no provider name next to the model
 * - no cache-hit percentage
 * - integer context percentage, two-decimal cost
 * - extension statuses share the stats line when they fit (third line only
 *   as overflow)
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Extension statuses hidden from the footer (keyed by their setStatus key). */
const HIDDEN_STATUS_KEYS = new Set(["tool-view"]);
/** Statuses pinned to their own left-aligned row directly below token usage. */
const BELOW_STATS_STATUS_KEYS = new Set(["skill-forge"]);

/** Minimal structural view of the TUI theme (fg color names vary by version). */
interface FooterTheme {
	fg(color: string, text: string): string;
}

/** Minimal structural view of ReadonlyFooterDataProvider. */
interface FooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function partitionExtensionStatuses(statuses: ReadonlyMap<string, string>): { inline: string; belowStats: string } {
	const entries = Array.from(statuses.entries())
		.filter(([key]) => !HIDDEN_STATUS_KEYS.has(key))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, text]) => [key, sanitizeStatusText(text)] as const)
		.filter(([, text]) => text.length > 0);
	return {
		inline: entries.filter(([key]) => !BELOW_STATS_STATUS_KEYS.has(key)).map(([, text]) => text).join(" · "),
		belowStats: entries.filter(([key]) => BELOW_STATS_STATUS_KEYS.has(key)).map(([, text]) => text).join(" · "),
	};
}

/**
 * Lay out a left part and a right part on one line of the given width.
 * The right part is right-aligned when it fits (with at least two spaces of
 * separation); otherwise null is returned so the caller can wrap it.
 */
export function layoutRow(left: string, right: string, width: number): string | null {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (!right) return left;
	if (leftWidth + 2 + rightWidth > width) return null;
	return left + " ".repeat(width - leftWidth - rightWidth) + right;
}

class CompactFooterComponent {
	private theme: FooterTheme;
	private footerData: FooterData;
	private getCtx: () => ExtensionContext | undefined;
	private getThinkingLevel: () => string;

	constructor(
		theme: FooterTheme,
		footerData: FooterData,
		getCtx: () => ExtensionContext | undefined,
		getThinkingLevel: () => string,
	) {
		this.theme = theme;
		this.footerData = footerData;
		this.getCtx = getCtx;
		this.getThinkingLevel = getThinkingLevel;
	}

	/** Required by the TUI Component contract; nothing cached between renders. */
	invalidate(): void {}

	render(width: number): string[] {
		const ctx = this.getCtx();
		if (!ctx) return [];
		const dim = (text: string) => this.theme.fg("dim", text);

		// --- line 1: cwd (branch) [• session name]        model · thinking ---
		let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		const sessionName = ctx.sessionManager.getSessionName();
		if (sessionName) pwd = `${pwd} • ${sessionName}`;

		let modelPart = ctx.model?.id ?? "no-model";
		if (ctx.model?.reasoning) {
			const level = this.getThinkingLevel();
			if (level && level !== "off") modelPart = `${modelPart} · ${level}`;
		}

		// --- line 2: token/cost stats · context%        extension statuses ---
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}
		}

		const statsParts: string[] = [];
		if (totalInput) statsParts.push(dim(`↑${formatTokens(totalInput)}`));
		if (totalOutput) statsParts.push(dim(`↓${formatTokens(totalOutput)}`));
		if (totalCacheRead) statsParts.push(dim(`R${formatTokens(totalCacheRead)}`));
		if (totalCacheWrite) statsParts.push(dim(`W${formatTokens(totalCacheWrite)}`));
		const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
		if (totalCost || usingSubscription) {
			statsParts.push(dim(`$${totalCost.toFixed(2)}${usingSubscription ? " (sub)" : ""}`));
		}

		const contextUsage = ctx.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const percentValue = contextUsage?.percent ?? null;
		const percentText =
			percentValue === null
				? `?/${formatTokens(contextWindow)}`
				: `${Math.round(percentValue)}%/${formatTokens(contextWindow)}`;
		let percentPart: string;
		if (percentValue !== null && percentValue > 90) {
			percentPart = this.theme.fg("error", percentText);
		} else if (percentValue !== null && percentValue > 70) {
			percentPart = this.theme.fg("warning", percentText);
		} else {
			percentPart = dim(percentText);
		}
		statsParts.push(percentPart);

		const stats = statsParts.join(" ");
		const { inline: statuses, belowStats } = partitionExtensionStatuses(this.footerData.getExtensionStatuses());

		const ellipsis = dim("...");
		const lines: string[] = [];

		const line1 = layoutRow(pwd, modelPart, width);
		lines.push(truncateToWidth(dim(line1 ?? pwd), width, ellipsis));
		if (line1 === null) lines.push(truncateToWidth(dim(modelPart), width, ellipsis));

		const line2 = statuses ? layoutRow(stats, dim(statuses), width) : stats;
		if (line2 !== null) {
			lines.push(truncateToWidth(line2, width, ellipsis));
			if (belowStats) lines.push(truncateToWidth(dim(belowStats), width, ellipsis));
		} else {
			lines.push(truncateToWidth(stats, width, ellipsis));
			if (belowStats) lines.push(truncateToWidth(dim(belowStats), width, ellipsis));
			lines.push(truncateToWidth(dim(statuses), width, ellipsis));
		}
		return lines;
	}
}

export default function compactFooter(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter(
			(_tui, theme, footerData) =>
				new CompactFooterComponent(
					theme,
					footerData,
					() => currentCtx,
					() => pi.getThinkingLevel(),
				),
		);
	});

	pi.on("model_select", async (_event, ctx) => {
		currentCtx = ctx;
	});
}

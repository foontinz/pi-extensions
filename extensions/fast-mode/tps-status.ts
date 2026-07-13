import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "tps";
const MIN_ELAPSED_MS = 1;

type Mode = "fast" | "standard";

type AssistantMessage = {
	role?: unknown;
	usage?: { output?: unknown };
};

export interface TpsStatusController {
	refresh(ctx: ExtensionContext): void;
}

export function registerTpsStatus(
	pi: ExtensionAPI,
	getMode: (ctx: ExtensionContext) => Mode,
	now: () => number = Date.now,
): TpsStatusController {
	let responseStartedAt: number | undefined;
	const latestByMode = new Map<Mode, number>();

	const refresh = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const mode = getMode(ctx);
		const tps = latestByMode.get(mode);
		ctx.ui.setStatus(STATUS_ID, renderStatus(ctx, mode, tps));
	};

	pi.on("message_start", (event, _ctx) => {
		if (isAssistantMessage(event.message)) responseStartedAt = now();
	});
	pi.on("message_end", (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		const startedAt = responseStartedAt;
		responseStartedAt = undefined;
		const elapsedMs = startedAt === undefined ? Number.NaN : now() - startedAt;
		const outputTokens = event.message.usage?.output;
		const tps = calculateTps(outputTokens, elapsedMs);
		if (tps !== undefined) latestByMode.set(getMode(ctx), tps);
		refresh(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		responseStartedAt = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
	});

	return { refresh };
}

export function calculateTps(outputTokens: unknown, elapsedMs: number): number | undefined {
	if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens < 0) return undefined;
	if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_ELAPSED_MS) return undefined;
	return outputTokens / (elapsedMs / 1_000);
}

function renderStatus(ctx: ExtensionContext, mode: Mode, tps: number | undefined): string {
	const theme = ctx.ui.theme;
	const value = tps === undefined ? "—" : formatTps(tps);
	const color = mode === "fast" ? "success" : "accent";
	return theme.fg(color, `${value} TPS`);
}

function formatTps(value: number): string {
	if (value >= 100) return value.toFixed(0);
	if (value >= 10) return value.toFixed(1);
	return value.toFixed(2);
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return typeof message === "object" && message !== null && (message as AssistantMessage).role === "assistant";
}

export const __testing = { formatTps };

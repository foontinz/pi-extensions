import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { MorphClient } from "@morphllm/morphsdk";
import { Type } from "@sinclair/typebox";
import { installEnvVarStatus, registerManagedEnvVar } from "pi-extension-envvars/hooks";
import { getEnvVar } from "pi-extension-envvars/store";

const WarpGrepParams = Type.Object({
	query: Type.String({
		description: "Natural-language code search query, e.g. 'Find where JWT tokens are validated'",
	}),
	answerQuestion: Type.Optional(
		Type.String({
			description: "The actual question you want answered from the search results. Defaults to query.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description: "Repository root or subdirectory to search. Defaults to the current working directory.",
		}),
	),
	fullOutput: Type.Optional(
		Type.Boolean({
			description: "Return raw WarpGrep output without aggregation. Use when you need the full unfiltered search result.",
		}),
	),
	maxTurns: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 6,
			description: "Reserved for compatibility. The Morph SDK manages WarpGrep search turns internally.",
		}),
	),
});

const WarpGrepGitHubParams = Type.Object({
	query: Type.String({
		description: "Natural-language code search query, e.g. 'Find where JWT tokens are validated'",
	}),
	answerQuestion: Type.Optional(
		Type.String({
			description: "The actual question you want answered from the search results. Defaults to query.",
		}),
	),
	github: Type.String({
		description: "GitHub repository as owner/repo or full GitHub URL",
	}),
	branch: Type.Optional(
		Type.String({
			description: "Optional branch to search",
		}),
	),
	fullOutput: Type.Optional(
		Type.Boolean({
			description: "Return raw WarpGrep output without aggregation. Use when you need the full unfiltered search result.",
		}),
	),
});

interface WarpGrepResultDetails {
	query: string;
	answerQuestion: string;
	repoRoot: string;
	summary?: string;
	files?: string[];
	success: boolean;
	error?: string;
	aggregated?: boolean;
	truncated?: boolean;
	fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
	registerManagedEnvVar({
		name: "MORPH_API_KEY",
		label: "WarpGrep key",
		description: "Morph API key used by warp_grep and warp_grep_github retrieval",
	});
	registerManagedEnvVar({
		name: "OPENROUTER_API_KEY",
		label: "WarpGrep aggregator key",
		description: "OpenRouter API key used by WarpGrep result aggregation via x-ai/grok-4.20",
	});
	installEnvVarStatus(pi, {
		name: "MORPH_API_KEY",
		statusId: "warp-grep",
		label: "WarpGrep key",
	});
	installEnvVarStatus(pi, {
		name: "OPENROUTER_API_KEY",
		statusId: "warp-grep-aggregator",
		label: "WarpGrep aggregator key",
		missingHint: "/envvars set OPENROUTER_API_KEY",
	});

	pi.registerTool({
		name: "warp_grep",
		label: "WarpGrep",
		description: `Semantic code search powered by the Morph TypeScript SDK. Use natural-language queries to find flows, handlers, and relevant code spans. Results are aggregated with OpenRouter using x-ai/grok-4.20 unless fullOutput=true. Pass answerQuestion to tell the aggregator what answer you actually need. Requires MORPH_API_KEY and, unless fullOutput=true, OPENROUTER_API_KEY or a key stored via /envvars set OPENROUTER_API_KEY. Final output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} if needed.`,
		promptSnippet: "Search the codebase semantically with a natural-language query, then answer the actual question you need from the search results.",
		promptGuidelines: [
			"Use warp_grep early when the user asks how a subsystem works, where behavior is implemented, or where an error originates.",
			"Prefer broad semantic queries like 'Find the auth middleware flow' instead of exact keyword lookups.",
			"Set answerQuestion to the specific question you want answered from the retrieved code, not just what to search for.",
			"Use fullOutput=true only when you need raw unaggregated snippets.",
		],
		parameters: WarpGrepParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const apiKey = await getMorphApiKey();
			const repoRoot = resolve(ctx.cwd, normalizeAtPath(params.path || "."));
			onUpdate?.({
				content: [{ type: "text" as const, text: "WarpGrep searching local repository via Morph SDK..." }],
				details: { repoRoot },
			});

			const morph = createMorphClient(apiKey);
			const result = await morph.warpGrep.execute({
				searchTerm: params.query,
				repoRoot,
			});

			onUpdate?.({
				content: [{ type: "text" as const, text: params.fullOutput ? "WarpGrep returning raw search results..." : "WarpGrep aggregating search results with OpenRouter (x-ai/grok-4.20)..." }],
				details: { aggregated: !params.fullOutput, query: params.query, answerQuestion: params.answerQuestion ?? params.query },
			});

			return formatWarpGrepToolResult({
				query: params.query,
				answerQuestion: params.answerQuestion ?? params.query,
				result,
				headerLines: [`Repo root: ${repoRoot}`],
				repoRoot,
				fullOutput: params.fullOutput,
			});
		},
	});

	pi.registerTool({
		name: "warp_grep_github",
		label: "WarpGrep GitHub",
		description: `Semantic GitHub code search powered by the Morph TypeScript SDK. Search public GitHub repositories by owner/repo or URL. Results are aggregated with OpenRouter using x-ai/grok-4.20 unless fullOutput=true. Pass answerQuestion to tell the aggregator what answer you actually need. Requires MORPH_API_KEY and, unless fullOutput=true, OPENROUTER_API_KEY or a key stored via /envvars set OPENROUTER_API_KEY. Final output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} if needed.`,
		promptSnippet: "Search a public GitHub repository semantically, then answer the actual question you need from the retrieved code.",
		promptGuidelines: [
			"Use warp_grep_github when the user asks to inspect a public GitHub repository that is not available locally.",
			"Pass github as owner/repo or a full GitHub URL.",
			"Set answerQuestion to the specific question you want answered from the retrieved code, not just what to search for.",
			"Use fullOutput=true only when you need raw unaggregated snippets.",
		],
		parameters: WarpGrepGitHubParams,
		async execute(_toolCallId, params, _signal, onUpdate) {
			const apiKey = await getMorphApiKey();
			onUpdate?.({
				content: [{ type: "text" as const, text: `WarpGrep searching GitHub repository ${params.github} via Morph SDK...` }],
				details: { github: params.github, branch: params.branch },
			});

			const morph = createMorphClient(apiKey);
			const result = await morph.warpGrep.searchGitHub({
				searchTerm: params.query,
				github: params.github,
				branch: params.branch,
			});

			onUpdate?.({
				content: [{ type: "text" as const, text: params.fullOutput ? "WarpGrep returning raw GitHub search results..." : "WarpGrep aggregating GitHub search results with OpenRouter (x-ai/grok-4.20)..." }],
				details: { aggregated: !params.fullOutput, query: params.query, answerQuestion: params.answerQuestion ?? params.query },
			});

			return formatWarpGrepToolResult({
				query: params.query,
				answerQuestion: params.answerQuestion ?? params.query,
				result,
				headerLines: [
					`GitHub: ${params.github}`,
					params.branch ? `Branch: ${params.branch}` : undefined,
				],
				repoRoot: "github",
				fullOutput: params.fullOutput,
			});
		},
	});
}

function createMorphClient(apiKey: string): MorphClient {
	return new MorphClient({ apiKey, timeout: 30000 });
}

async function getMorphApiKey(): Promise<string> {
	const apiKey = await getEnvVar("MORPH_API_KEY");
	if (!apiKey) {
		throw new Error("MORPH_API_KEY is not set. Export it or run /envvars set MORPH_API_KEY.");
	}
	return apiKey;
}

async function getOpenRouterApiKey(): Promise<string> {
	const apiKey = await getEnvVar("OPENROUTER_API_KEY");
	if (!apiKey) {
		throw new Error("OPENROUTER_API_KEY is not set. Export it or run /envvars set OPENROUTER_API_KEY, or call the tool with fullOutput=true.");
	}
	return apiKey;
}

async function formatWarpGrepToolResult({
	query,
	answerQuestion,
	result,
	headerLines,
	repoRoot,
	fullOutput,
}: {
	query: string;
	answerQuestion: string;
	result: { success: boolean; summary?: string; error?: string; contexts?: Array<{ file: string; content: string }> };
	headerLines: Array<string | undefined>;
	repoRoot: string;
	fullOutput?: boolean;
}) {
	if (!result.success) {
		throw new Error(result.error || "WarpGrep search failed");
	}

	const files = result.contexts?.map((context) => context.file) ?? [];
	const rawSections = [
		`WarpGrep query: ${query}`,
		...headerLines,
		result.summary ? `Summary: ${result.summary}` : undefined,
		files.length > 0 ? `Files: ${files.join(", ")}` : undefined,
		undefined,
		...(result.contexts?.flatMap((context) => [`=== ${context.file} ===`, context.content, ""]) ?? []),
	]
		.filter((value): value is string => value !== undefined)
		.join("\n")
		.trim();

	const aggregated = !fullOutput;
	const sections = aggregated ? await aggregateWarpGrepOutput(rawSections, { query, answerQuestion }) : rawSections;

	const truncation = truncateHead(sections, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	const details: WarpGrepResultDetails = {
		query,
		answerQuestion,
		repoRoot,
		summary: result.summary,
		files,
		success: true,
		aggregated,
	};

	let text = truncation.content;
	if (truncation.truncated) {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-warp-grep-"));
		const tempFile = join(tempDir, "output.txt");
		await withFileMutationQueue(tempFile, async () => {
			await writeFile(tempFile, sections, "utf8");
		});
		details.truncated = true;
		details.fullOutputPath = tempFile;
		text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full ${aggregated ? "aggregated" : "raw"} output saved to: ${tempFile}]`;
	}

	if (aggregated) {
		text = `[OpenRouter aggregated WarpGrep output via x-ai/grok-4.20]\nQuestion: ${answerQuestion}\n\n${text}`;
	} else {
		text = `[Raw WarpGrep output]\n\n${text}`;
	}

	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

async function aggregateWarpGrepOutput(
	rawOutput: string,
	options: { query: string; answerQuestion: string },
): Promise<string> {
	const apiKey = await getOpenRouterApiKey();
	const evidence = truncateHead(rawOutput, {
		maxLines: 1200,
		maxBytes: 120_000,
	}).content;

	const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${apiKey}`,
			"HTTP-Referer": "https://github.com/mariozechner/pi-coding-agent",
			"X-Title": "pi warp-grep aggregator",
		},
		body: JSON.stringify({
			model: "x-ai/grok-4.20",
			temperature: 0,
			messages: [
				{
					role: "system",
					content:
						"You aggregate code search results into a precise answer. Answer only from the provided evidence. Do not invent files, symbols, or behavior. If the evidence is insufficient, say so. Keep the answer concise but complete. Always include an Evidence section with file paths cited exactly as they appear in the evidence.",
				},
				{
					role: "user",
					content: [
						`Search query: ${options.query}`,
						`Actual question to answer: ${options.answerQuestion}`,
						"Using only the evidence below, produce:",
						"1. Answer",
						"2. Evidence",
						"3. Caveats or open questions (only if needed)",
						"Do not mention information not supported by the evidence.",
						"Evidence:",
						evidence,
					].join("\n\n"),
				},
			],
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`OpenRouter aggregation failed: ${response.status} ${response.statusText}. Response: ${text}`);
	}

	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
	};
	const content = data.choices?.[0]?.message?.content;
	if (typeof content === "string" && content.trim()) return content.trim();
	if (Array.isArray(content)) {
		const text = content
			.filter((item): item is { text?: string } => typeof item === "object" && item !== null)
			.map((item) => item.text ?? "")
			.join("\n")
			.trim();
		if (text) return text;
	}

	throw new Error("OpenRouter aggregation returned no text.");
}

function normalizeAtPath(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

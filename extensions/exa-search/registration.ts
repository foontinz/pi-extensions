import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ExaManagedEnvVar {
	name: string;
	label?: string;
	description?: string;
}

export interface ExaCodeHandle {
	name: string;
	summary?: string;
	keywords?: string[];
	envVars?: string[];
	setupCode: string;
	docs: string;
}

export interface ExaRegistrationDependencies {
	registerManagedEnvVar(config: ExaManagedEnvVar): ExaManagedEnvVar;
	unregisterManagedEnvVar(name: string): boolean;
	installEnvVarStatus(pi: ExtensionAPI, options: {
		name: string;
		statusId: string;
		label: string;
		missingHint?: string;
		showWhenPresent?: boolean;
	}): void;
	registerCodeHandle(handle: ExaCodeHandle): void;
	unregisterCodeHandle(name: string): void;
}

const EXA_ENV_VAR: ExaManagedEnvVar = {
	name: "EXA_API_KEY",
	label: "Exa key",
	description: "API key used by the exa handle in exec_code",
};

const EXA_HANDLE: ExaCodeHandle = {
	name: "exa",
	summary: "Search the public web, fetch page contents from URLs, and generate cited answers with Exa.",
	keywords: [
		"search", "web", "internet", "research", "docs", "documentation",
		"news", "content", "crawl", "url", "urls", "fetch", "exa",
	],
	envVars: ["EXA_API_KEY"],
	setupCode: `
import Exa from "exa-js";
if (!process.env.EXA_API_KEY) {
  console.error("[exa] EXA_API_KEY is not set. Run: /envvars set EXA_API_KEY");
}
const exa = process.env.EXA_API_KEY ? new Exa(process.env.EXA_API_KEY) : undefined as unknown as InstanceType<typeof Exa>;
`.trim(),
	docs: `
## \`exa\` — Exa search & content client

Pre-initialized \`Exa\` instance from [exa-js](https://docs.exa.ai).
Available when \`EXA_API_KEY\` is configured.

### Search

\`\`\`typescript
const results = await exa.search("your query", {
  type: "neural",          // "auto" | "keyword" | "neural" | "hybrid" | "deep" | "deep-lite" | "deep-reasoning"
  numResults: 5,
  startPublishedDate: "2024-01-01",
  endPublishedDate: "2025-01-01",
  includeDomains: ["github.com"],
  excludeDomains: ["reddit.com"],
  category: "research paper",  // "company" | "news" | "pdf" | "personal site"
  contents: {
    text: { maxCharacters: 5000 },
    highlights: true,
    summary: true,
    maxAgeHours: 0,            // always fetch fresh
  },
});
console.log(results.results.map(r => ({ title: r.title, url: r.url })));
\`\`\`

### Fetch content from specific URLs

\`\`\`typescript
const contents = await exa.getContents(
  ["https://example.com/page", "https://other.com/doc"],
  { text: true, maxAgeHours: 0, livecrawlTimeout: 10000 },
);
console.log(contents.results[0].text);
\`\`\`

### Answer a question with citations

\`\`\`typescript
const answer = await exa.answer("What is the Exa API?", { text: true });
console.log(answer.answer);
console.log(answer.citations?.map(c => c.url));
\`\`\`

### Search + fetch contents in one call

\`\`\`typescript
const results = await exa.searchAndContents("latest TypeScript 5.x features", {
  type: "neural",
  numResults: 3,
  text: { maxCharacters: 3000 },
});
for (const r of results.results) {
  console.log("---", r.title);
  console.log(r.text?.slice(0, 500));
}
\`\`\`
`.trim(),
};

/** Register Exa only for this extension instance and clean it up on shutdown. */
export function installExaSearch(pi: ExtensionAPI, dependencies: ExaRegistrationDependencies): void {
	dependencies.registerManagedEnvVar(EXA_ENV_VAR);
	dependencies.registerCodeHandle(EXA_HANDLE);
	dependencies.installEnvVarStatus(pi, {
		name: EXA_ENV_VAR.name,
		statusId: "exa-search",
		label: EXA_ENV_VAR.label ?? "Exa key",
	});

	let disposed = false;
	pi.on("session_shutdown", () => {
		if (disposed) return;
		disposed = true;
		dependencies.unregisterCodeHandle(EXA_HANDLE.name);
		dependencies.unregisterManagedEnvVar(EXA_ENV_VAR.name);
	});
}

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCodeHandle } from "../code-runner/hooks";
import { installEnvVarStatus, registerManagedEnvVar } from "pi-extension-envvars/hooks";

registerManagedEnvVar({
	name: "EXA_API_KEY",
	label: "Exa key",
	description: "API key used by the exa handle in exec_code",
});

registerCodeHandle({
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
});

export default function (pi: ExtensionAPI) {
	installEnvVarStatus(pi, {
		name: "EXA_API_KEY",
		statusId: "exa-search",
		label: "Exa key",
	});
}

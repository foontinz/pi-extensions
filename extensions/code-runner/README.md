# Code Runner

Pi extension that adds two tools:

- `search_spec` discovers registered code handles and their documentation.
- `exec_code` runs TypeScript/JavaScript with registered handles available as top-level variables.

## Discovery

`search_spec` supports staged discovery instead of requiring an exact keyword query:

```text
{ action: "list" }
{ action: "search", goal: "capture a webpage screenshot" }
{ action: "get", name: "playwright" }
```

- **list** returns a compact catalog of every registered handle and capability.
- **search** ranks natural-language goals using names, aliases, capability phrases, keywords, related terms, plural normalization, prefixes, and typo-tolerant fuzzy matching.
- **get** returns the complete reference for one canonical name or alias.

If `action` is omitted, `goal` implies `search`, `name` implies `get`, and no arguments imply `list`.

## Registering a handle

Other extensions can register an API client or utility:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodeHandle, unregisterCodeHandle } from "../code-runner/hooks";

export default function (pi: ExtensionAPI) {
  registerCodeHandle({
    name: "example",
    aliases: ["example client"],
    summary: "Read and update Example resources.",
    keywords: ["example", "resource", "records"],
    capabilities: [
      "list Example records",
      "create and update Example resources",
    ],
    exampleGoals: [
      "show the latest Example records",
      "update this Example resource",
    ],
    envVars: ["EXAMPLE_API_KEY"],
    setupCode: `
import { ExampleClient } from "example-sdk";
const example = new ExampleClient(process.env.EXAMPLE_API_KEY);
    `.trim(),
    docs: "## `example`\n\nComplete usage reference and examples...",
  });

  pi.on("session_shutdown", () => unregisterCodeHandle("example"));
}
```

Good discovery metadata matters:

- `summary`: one concise sentence describing the handle.
- `aliases`: alternate names, not a keyword dump.
- `keywords`: important nouns and verbs users may say.
- `capabilities`: short verb-object phrases such as “capture webpage screenshots”.
- `exampleGoals`: representative requests written as users would ask them.
- `docs`: complete method reference and executable examples.

## Execution behavior

- Uses ESM with top-level `await`.
- Type-checks by default; checker/setup failures stop execution instead of failing open.
- `timeout` is one total deadline shared by setup, checking, and execution.
- Relative paths use a temporary working directory removed after execution.
- Absolute paths persist normally.
- Visible output is bounded by Pi's standard output budget. Larger output is retained in a temporary recovery file up to the hard safety limit.

Run without type checking only when needed:

```text
{ code: "console.log('hello')", typecheck: false }
```

## Development

```bash
npm --prefix extensions/code-runner run check
npm --prefix extensions/code-runner test
```

# pi-extensions

A Pi extensions workspace rooted at `~/.pi/agent`, so extensions live in the native `extensions/` directory and are auto-discovered by pi without extra path configuration.

Included extensions/packages:

- `extensions/code-runner` — `exec_code` + `search_spec` tools for TypeScript code execution with pluggable handles
- `extensions/exa-search` — registers the `exa` handle (web search, URL fetching, cited answers)
- `extensions/playwright-browser` — registers the `playwright` handle (browser automation, page scripting, screenshots)
- `extensions/envvars` — macOS Keychain-backed env var management (`/envvars`)
- `extensions/openrouter-provider` — OpenRouter model provider
- `extensions/fast-mode` — per-model request acceleration toggle
- `extensions/usage` — `/usage` command for cross-session token/cost heatmap and per-model totals
- `extensions/subagents` — non-blocking background Pi subagents (`run_agent`, `poll_agent`, `stop_agent` tools), with repo-root `.pi/worktree.env` copy/setup support, normalized postCopy confirmation/env hardening, and guarded symlink copies
- `extensions/extension-manager` — interactive extension toggle UI

## Workspace usage

This repo uses npm workspaces rooted at `extensions/*`, directly under `~/.pi/agent`.

```bash
npm install
npm run check
```

## Code execution (code-runner + exa-search)

The `code-runner` extension provides two tools:

- **`exec_code`** — execute TypeScript/JavaScript in a child process with pre-initialized handles available as top-level variables
- **`search_spec`** — discover available handles/SDKs by goal matching before writing code

Other extensions register "handles" — pre-initialized API clients injected into every `exec_code` run. Currently registered:

| Handle | Extension | Description |
|--------|-----------|-------------|
| `exa` | exa-search | Exa web search, URL content fetching, cited answers |
| `playwright` | playwright-browser | Browser automation, DOM interaction, screenshots, in-page JavaScript |

### Adding a new handle

Create a new extension directory and register the handle at module top level:

```ts
import { registerCodeHandle } from "../code-runner/hooks";
import { registerManagedEnvVar } from "pi-extension-envvars/hooks";

registerManagedEnvVar({ name: "MY_API_KEY", label: "My key" });

registerCodeHandle({
  name: "myClient",
  summary: "Short description for discovery",
  keywords: ["relevant", "search", "terms"],
  envVars: ["MY_API_KEY"],
  setupCode: `
import MySDK from "my-sdk";
const myClient = new MySDK(process.env.MY_API_KEY);
`.trim(),
  docs: `## \`myClient\` — My SDK client\n\n...usage examples...`,
});
```

Then add the SDK package to your extension's `package.json` dependencies and run `npm install`. The package gets hoisted to root `node_modules/` and becomes available to `exec_code`.

### How it works

1. Handle extensions register via `registerCodeHandle()` at module load time
2. Registrations are persisted to a shared JSON file (workaround for jiti module duplication)
3. `exec_code` reads the registry, prepends all handle setup code, resolves env vars from keychain, and runs the combined script via `tsx`
4. `search_spec` reads the registry and ranks handles by goal relevance

## Extension manager

`extensions/extension-manager` adds an `/extensions-ui` command that opens an interactive toggle UI for local extensions.

## Fast mode

`extensions/fast-mode` adds a `/fast` command that toggles per-model request acceleration.

## Usage dashboard

`extensions/usage` adds a `/usage` command that scans local Pi session logs and shows:

- a GitHub-style heatmap of spend across days
- total spend and turns
- a per-model breakdown including input, output, cache, and total cost

## CI

GitHub Actions runs workspace typechecking on every push to `main` and on pull requests.

## Notes

- Environment files (`.env`, `.env.*`, `.envrc`) are gitignored.
- Extensions needing API keys should use the `extensions/envvars` hooks API (`registerManagedEnvVar()` + `installEnvVarStatus()`) so `/envvars` discovery stays consistent.
- Temp execution dirs (`.run-*`) and registry/state files like `.handle-registry.json` and `.envvar-registry.json` are gitignored.

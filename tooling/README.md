# tooling/

Standalone maintenance/benchmark scripts. These are **not** pi extensions — they
are one-off CLIs you run directly with `npx tsx`.

## bench-models

Measures **time-to-first-token (TTFT)** and **tokens-per-second (TPS)** for your
pinned pi models (the ones enabled in `settings.json` → `enabledModels`, i.e. the
models you cycle with Ctrl+P). It streams a short prompt through pi's own
provider stack, so it uses the exact same auth, base URLs and wire APIs pi does.

```bash
# Benchmark pinned models (3 runs each)
npx tsx tooling/bench-models.ts

# Faster/slower or more thorough
npx tsx tooling/bench-models.ts --runs 5 --warmup
npx tsx tooling/bench-models.ts --max-tokens 512

# Specific models (bypass the pinned list)
npx tsx tooling/bench-models.ts --models visa/claude-opus-4-8,visa-openai/gpt-5.5

# Machine-readable output (per-run detail included)
npx tsx tooling/bench-models.ts --json > bench.json
```

### Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--models <a/b,c/d>` | pinned `enabledModels` | Models to benchmark (`provider/id`) |
| `--runs <n>` | `3` | Runs per model (median + best reported) |
| `--max-tokens <n>` | `256` | Cap output tokens per run |
| `--prompt <text>` | a counting prompt | Prompt to send |
| `--warmup` | off | One uncounted warmup run per model (warms caches/connections) |
| `--timeout <ms>` | `120000` | Per-run timeout |
| `--json` | off | Emit JSON instead of a table |

### Metrics

- **TTFT** — time from request start to the first streamed token, including
  connection/queue latency **and any server-side reasoning** (models that hide
  their thinking, like the VISA reasoning models, do all reasoning before the
  first token arrives).
- **TPS** — `output tokens / total wall-clock` (end-to-end throughput). Output
  tokens are the provider's billed `usage.output`, which **includes hidden
  reasoning tokens**. End-to-end is used (rather than a post-first-token decode
  window) because reasoning tokens are produced during the TTFT window, so a
  decode-window rate would overstate throughput. It's verifiable: `tps × total
  ≈ out tok`.

Example:

```
MODEL                 API                   RUNS   TTFT med  TTFT best   TPS med  TPS best  out tok     total
─────────────────────────────────────────────────────────────────────────────────────────────────────────
visa/claude-opus-4-8  anthropic-messages       2      2.42s      1.70s     184.3     186.2      200     3.51s
visa-openai/gpt-5.5   openai-responses         2      1.74s      1.30s     143.4     145.9      200     3.13s
```

Requires the provider credentials pi uses (e.g. `GENAI_API_AUTH_TOKEN` in the
environment for the VISA providers).

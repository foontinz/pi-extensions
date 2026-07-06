#!/usr/bin/env -S npx tsx
/**
 * bench-models — time-to-first-token (TTFT) and tokens-per-second (TPS) benchmark
 * for pinned models in pi.
 *
 * "Pinned" models are the ones enabled in your pi settings (`enabledModels` in
 * settings.json — the models you cycle through with Ctrl+P). Override with
 * `--models`.
 *
 * Usage:
 *   npx tsx tooling/bench-models.ts                       # benchmark pinned models
 *   npx tsx tooling/bench-models.ts --runs 5              # 5 runs per model
 *   npx tsx tooling/bench-models.ts --models visa/claude-opus-4-8,visa-openai/gpt-5.5
 *   npx tsx tooling/bench-models.ts --max-tokens 512 --warmup
 *   npx tsx tooling/bench-models.ts --json > bench.json
 *
 * Metrics (per model, aggregated over runs):
 *   TTFT  time from request start to the first streamed token (thinking or text),
 *         including connection + queue latency.
 *   TPS   output tokens / total wall-clock time (end-to-end throughput). Output
 *         tokens are the provider's billed `usage.output`, which for reasoning
 *         models includes hidden reasoning tokens. Those reasoning tokens are
 *         generated server-side *before* the first token (during the TTFT
 *         window), so dividing by the post-first-token window would overstate
 *         throughput — hence end-to-end wall-clock is used and is verifiable
 *         against `out tok` (tps × total ≈ out tok).
 */

import { parseArgs } from "node:util";
import { AuthStorage, getAgentDir, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai/compat";

// ─── CLI ──────────────────────────────────────────────────────────────────────

interface Options {
  models?: string[];
  runs: number;
  maxTokens: number;
  prompt: string;
  warmup: boolean;
  json: boolean;
  timeoutMs: number;
}

const DEFAULT_PROMPT = "Count from 1 to 200, one number per line, with no other text.";

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      models: { type: "string" },
      runs: { type: "string", default: "3" },
      "max-tokens": { type: "string", default: "256" },
      prompt: { type: "string", default: DEFAULT_PROMPT },
      warmup: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      timeout: { type: "string", default: "120000" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const models = values.models
    ? values.models
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  return {
    models,
    runs: Math.max(1, Number(values.runs) || 3),
    maxTokens: Math.max(1, Number(values["max-tokens"]) || 256),
    prompt: values.prompt || DEFAULT_PROMPT,
    warmup: Boolean(values.warmup),
    json: Boolean(values.json),
    timeoutMs: Math.max(1000, Number(values.timeout) || 120000),
  };
}

function printHelp(): void {
  process.stdout.write(
    `bench-models — TTFT & TPS benchmark for pinned pi models\n\n` +
      `Options:\n` +
      `  --models <a/b,c/d>   Models to benchmark (default: pinned enabledModels)\n` +
      `  --runs <n>           Runs per model (default: 3)\n` +
      `  --max-tokens <n>     Cap output tokens per run (default: 256)\n` +
      `  --prompt <text>      Prompt to send (default: a counting prompt)\n` +
      `  --warmup             Do one uncounted warmup run per model\n` +
      `  --timeout <ms>       Per-run timeout (default: 120000)\n` +
      `  --json               Emit machine-readable JSON\n` +
      `  --help               Show this help\n`,
  );
}

// ─── benchmark core ─────────────────────────────────────────────────────────

interface RunResult {
  ok: boolean;
  ttftMs: number;
  textTtftMs: number;
  totalMs: number;
  genMs: number;
  outputTokens: number;
  tps: number;
  stopReason?: string;
  error?: string;
}

interface ModelReport {
  key: string;
  api: string;
  runs: RunResult[];
  skipped?: string;
}

async function runOnce(
  model: Model<Api>,
  auth: { apiKey?: string; headers?: Record<string, string> },
  opts: Options,
): Promise<RunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), opts.timeoutMs);

  const start = performance.now();
  let ttftMs = 0;
  let textTtftMs = 0;
  let outputTokens = 0;
  let stopReason: string | undefined;
  let error: string | undefined;
  let textChars = 0;
  let completed = false;

  try {
    const events = stream(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: opts.prompt }], timestamp: Date.now() }] },
      { apiKey: auth.apiKey, headers: auth.headers, maxTokens: opts.maxTokens, signal: controller.signal },
    );

    for await (const ev of events) {
      if ((ev.type === "text_delta" || ev.type === "thinking_delta") && ttftMs === 0) {
        ttftMs = performance.now() - start;
      }
      if (ev.type === "text_delta") {
        if (textTtftMs === 0) textTtftMs = performance.now() - start;
        textChars += ev.delta.length;
      } else if (ev.type === "done") {
        completed = true;
        stopReason = ev.reason;
        outputTokens = ev.message.usage?.output ?? 0;
      } else if (ev.type === "error") {
        error = ev.error.errorMessage || "stream error";
        stopReason = ev.reason;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  const totalMs = Math.max(1, performance.now() - start);
  // Fallback token estimate (~4 chars/token) when the provider reports no usage.
  if (outputTokens === 0 && textChars > 0) outputTokens = Math.round(textChars / 4);
  const streamed = ttftMs > 0;
  const genMs = streamed ? Math.max(1, totalMs - ttftMs) : totalMs;
  // End-to-end throughput: total output tokens (incl. hidden reasoning that runs
  // before the first token) over wall-clock. Verifiable: tps × totalMs/1000 ≈ tokens.
  const tps = outputTokens > 0 ? outputTokens / (totalMs / 1000) : 0;

  return {
    ok: !error && (streamed || completed),
    ttftMs: streamed ? ttftMs : totalMs,
    textTtftMs,
    totalMs,
    genMs,
    outputTokens,
    tps,
    stopReason,
    error,
  };
}

async function benchModel(
  key: string,
  registry: ModelRegistry,
  opts: Options,
  progress: (msg: string) => void,
): Promise<ModelReport> {
  const [provider, ...rest] = key.split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) return { key, api: "?", runs: [], skipped: `invalid model key "${key}" (expected provider/id)` };

  const model = registry.find(provider, modelId);
  if (!model) return { key, api: "?", runs: [], skipped: "not found in model registry (dynamic/unpinned provider?)" };

  const ra = await registry.getApiKeyAndHeaders(model);
  if (!ra.ok) return { key, api: model.api, runs: [], skipped: `auth: ${ra.error}` };
  if (ra.env) for (const [k, v] of Object.entries(ra.env)) process.env[k] = v;
  const auth = { apiKey: ra.apiKey, headers: ra.headers };

  if (opts.warmup) {
    progress(`${key}  warmup…`);
    await runOnce(model, auth, opts);
  }

  const runs: RunResult[] = [];
  for (let i = 0; i < opts.runs; i++) {
    progress(`${key}  run ${i + 1}/${opts.runs}…`);
    const r = await runOnce(model, auth, opts);
    runs.push(r);
    if (!r.ok) progress(`${key}  run ${i + 1}/${opts.runs} failed: ${r.error ?? "no tokens"}`);
  }
  return { key, api: model.api, runs };
}

// ─── stats & formatting ───────────────────────────────────────────────────────

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface Agg {
  key: string;
  api: string;
  ok: number;
  failed: number;
  ttftMedMs: number;
  ttftBestMs: number;
  tpsMed: number;
  tpsBest: number;
  outTokMed: number;
  totalMedMs: number;
  skipped?: string;
  error?: string;
}

function aggregate(report: ModelReport): Agg {
  if (report.skipped) {
    return { key: report.key, api: report.api, ok: 0, failed: 0, ttftMedMs: 0, ttftBestMs: 0, tpsMed: 0, tpsBest: 0, outTokMed: 0, totalMedMs: 0, skipped: report.skipped };
  }
  const ok = report.runs.filter((r) => r.ok);
  const failed = report.runs.length - ok.length;
  const firstErr = report.runs.find((r) => r.error)?.error;
  return {
    key: report.key,
    api: report.api,
    ok: ok.length,
    failed,
    ttftMedMs: median(ok.map((r) => r.ttftMs)),
    ttftBestMs: ok.length ? Math.min(...ok.map((r) => r.ttftMs)) : 0,
    tpsMed: median(ok.map((r) => r.tps)),
    tpsBest: ok.length ? Math.max(...ok.map((r) => r.tps)) : 0,
    outTokMed: median(ok.map((r) => r.outputTokens)),
    totalMedMs: median(ok.map((r) => r.totalMs)),
    error: ok.length === 0 ? firstErr : undefined,
  };
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c("1", s);
const dim = (s: string) => c("2", s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);
const red = (s: string) => c("31", s);

function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function padEnd(s: string, w: number): string {
  const len = stripAnsi(s).length;
  return len >= w ? s : s + " ".repeat(w - len);
}
function padStart(s: string, w: number): string {
  const len = stripAnsi(s).length;
  return len >= w ? s : " ".repeat(w - len) + s;
}
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function printTable(aggs: Agg[]): void {
  const cols = [
    { h: "MODEL", w: Math.max(5, ...aggs.map((a) => a.key.length)) },
    { h: "API", w: Math.max(3, ...aggs.map((a) => a.api.length)) },
    { h: "RUNS", w: 6 },
    { h: "TTFT med", w: 9 },
    { h: "TTFT best", w: 9 },
    { h: "TPS med", w: 8 },
    { h: "TPS best", w: 8 },
    { h: "out tok", w: 7 },
    { h: "total", w: 8 },
  ];
  const header = cols
    .map((col, i) => (i <= 1 ? padEnd(bold(col.h), col.w) : padStart(bold(col.h), col.w)))
    .join("  ");
  process.stdout.write(header + "\n");
  process.stdout.write(dim("─".repeat(stripAnsi(header).length)) + "\n");

  // Highlight the fastest TPS among successful models.
  const bestTps = Math.max(0, ...aggs.filter((a) => !a.skipped && a.ok > 0).map((a) => a.tpsMed));

  for (const a of aggs) {
    if (a.skipped) {
      process.stdout.write(padEnd(a.key, cols[0].w) + "  " + dim(`skipped — ${a.skipped}`) + "\n");
      continue;
    }
    if (a.ok === 0) {
      process.stdout.write(
        padEnd(a.key, cols[0].w) + "  " + padEnd(a.api, cols[1].w) + "  " + red(`failed — ${a.error ?? "no tokens"}`) + "\n",
      );
      continue;
    }
    const runsStr = a.failed > 0 ? yellow(`${a.ok}/${a.ok + a.failed}`) : `${a.ok}`;
    const tpsMedStr = a.tpsMed === bestTps ? green(bold(a.tpsMed.toFixed(1))) : a.tpsMed.toFixed(1);
    const row = [
      padEnd(a.key, cols[0].w),
      padEnd(dim(a.api), cols[1].w),
      padStart(runsStr, cols[2].w),
      padStart(fmtMs(a.ttftMedMs), cols[3].w),
      padStart(dim(fmtMs(a.ttftBestMs)), cols[4].w),
      padStart(tpsMedStr, cols[5].w),
      padStart(dim(a.tpsBest.toFixed(1)), cols[6].w),
      padStart(String(Math.round(a.outTokMed)), cols[7].w),
      padStart(dim(fmtMs(a.totalMedMs)), cols[8].w),
    ].join("  ");
    process.stdout.write(row + "\n");
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));

  const authStorage = AuthStorage.create();
  const registry = ModelRegistry.create(authStorage);

  let keys = opts.models;
  if (!keys) {
    const settings = SettingsManager.create(process.cwd(), getAgentDir());
    keys = settings.getEnabledModels();
  }
  if (!keys || keys.length === 0) {
    process.stderr.write(
      "No models to benchmark. Pin models in pi (enabledModels in settings.json) or pass --models provider/id,...\n",
    );
    process.exit(1);
  }

  const isTTY = process.stderr.isTTY;
  const progress = (msg: string): void => {
    if (opts.json) return;
    if (isTTY) process.stderr.write(`\r\x1b[K${dim(msg)}`);
    else process.stderr.write(msg + "\n");
  };

  if (!opts.json) {
    process.stderr.write(
      dim(`Benchmarking ${keys.length} model(s) · ${opts.runs} run(s) each · max-tokens=${opts.maxTokens}${opts.warmup ? " · warmup" : ""}\n`),
    );
  }

  const reports: ModelReport[] = [];
  for (const key of keys) {
    reports.push(await benchModel(key, registry, opts, progress));
  }
  if (isTTY && !opts.json) process.stderr.write("\r\x1b[K");

  const aggs = reports.map(aggregate);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          prompt: opts.prompt,
          runs: opts.runs,
          maxTokens: opts.maxTokens,
          generatedAt: new Date().toISOString(),
          results: reports.map((r, i) => ({ ...aggs[i], detail: r.runs })),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  process.stdout.write("\n");
  printTable(aggs);
  process.stdout.write(
    "\n" +
      dim(`TTFT = time to first token (incl. connection + server-side reasoning).  TPS = output tokens / total wall-clock (output incl. hidden reasoning tokens).  Prompt: "${opts.prompt.slice(0, 60)}${opts.prompt.length > 60 ? "…" : ""}"\n`),
  );
}

main().catch((e) => {
  process.stderr.write(`\n${red("bench-models failed:")} ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});

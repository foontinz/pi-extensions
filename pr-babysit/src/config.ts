import { readFile } from "node:fs/promises";

import { type AppPaths, appPaths } from "./paths.ts";

export interface Config {
  provider: string | null;
  model: string | null;
  pollIntervalSec: number;
  runTimeoutMin: number;
  maxConcurrentRuns: number;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  provider: null,
  model: null,
  pollIntervalSec: 60,
  runTimeoutMin: 15,
  maxConcurrentRuns: 2,
});

const ALLOWED_KEYS = new Set([
  "provider",
  "model",
  "pollIntervalSec",
  "runTimeoutMin",
  "maxConcurrentRuns",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalName(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`config.${field} must be a non-empty printable string`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, fallback: number, min: number, max: number): number {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isInteger(candidate) || typeof candidate !== "number" || candidate < min || candidate > max) {
    throw new Error(`config.${field} must be an integer from ${min} to ${max}`);
  }
  return candidate;
}

export function parseConfig(value: unknown): Config {
  if (!isRecord(value)) {
    throw new Error("config must be a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Unknown config field: ${key}`);
    }
  }

  const provider = optionalName(value.provider, "provider");
  const model = optionalName(value.model, "model");
  if ((provider === null) !== (model === null)) {
    throw new Error("config.provider and config.model must either both be set or both be omitted");
  }

  return {
    provider,
    model,
    pollIntervalSec: boundedInteger(value.pollIntervalSec, "pollIntervalSec", DEFAULT_CONFIG.pollIntervalSec, 5, 3600),
    runTimeoutMin: boundedInteger(value.runTimeoutMin, "runTimeoutMin", DEFAULT_CONFIG.runTimeoutMin, 1, 1440),
    maxConcurrentRuns: boundedInteger(
      value.maxConcurrentRuns,
      "maxConcurrentRuns",
      DEFAULT_CONFIG.maxConcurrentRuns,
      1,
      32,
    ),
  };
}

export async function loadConfig(app: AppPaths = appPaths()): Promise<Config> {
  let text: string;
  try {
    text = await readFile(app.configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw new Error(`Unable to read config ${app.configFile}: ${(error as Error).message}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${app.configFile}: ${(error as Error).message}`);
  }

  try {
    return parseConfig(value);
  } catch (error) {
    throw new Error(`Invalid config ${app.configFile}: ${(error as Error).message}`);
  }
}

export function requireAgentModel(config: Config): { provider: string; model: string } {
  if (config.provider === null || config.model === null) {
    throw new Error("config.json must set provider and model before an agent can run");
  }
  return { provider: config.provider, model: config.model };
}

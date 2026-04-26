export function parseOptionalNonNegativeIntegerEnv(name: string, fallback: number, sourceEnv: NodeJS.ProcessEnv = process.env): number {
  const raw = sourceEnv[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

const POST_COPY_PRESERVED_ENV_KEYS = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

export function buildPostCopyEnv(extraEnv: Record<string, string> | undefined, sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of POST_COPY_PRESERVED_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv ?? {})) env[key] = value;
  return env;
}

export function getPostCopyBaseEnvKeys(sourceEnv: NodeJS.ProcessEnv = process.env): string[] {
  const keys = POST_COPY_PRESERVED_ENV_KEYS.filter((key) => sourceEnv[key] !== undefined) as string[];
  return keys.sort();
}

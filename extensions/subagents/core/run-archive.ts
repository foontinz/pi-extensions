import * as fs from "node:fs";
import * as path from "node:path";

/** Default retention for persisted run transcripts / event logs: 3 days. */
export const DEFAULT_RUN_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Age-out old entries in a runs directory. Each direct child (file or dir) whose
 * most-recent mtime is older than `maxAgeMs` is removed. Best-effort: never throws
 * (returns the count pruned), so it is safe to call on session start.
 */
export function pruneOldRuns(dir: string, maxAgeMs: number = DEFAULT_RUN_RETENTION_MS): number {
  let pruned = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // Missing/unreadable dir — nothing to prune.
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      // Stat the entry directly (lstat: never follow symlinks). Prune runs at
      // session start, before any run launches, and runs are far shorter-lived
      // than the retention window — so a directory's own mtime is a fine proxy
      // and we don't need to walk the whole tree.
      const mtime = fs.lstatSync(full).mtimeMs;
      if (mtime >= cutoff) continue;
      fs.rmSync(full, { recursive: true, force: true });
      pruned += 1;
    } catch {
      // Skip entries we cannot stat/remove.
    }
  }
  return pruned;
}

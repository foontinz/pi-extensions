import { execFileSync } from "node:child_process";

export const TMUX_COMMAND_TIMEOUT_MS = 5_000;
const TMUX_AVAILABILITY_CACHE_MS = 30_000;

export type TmuxCommandResult = { ok: true } | { ok: false; error: string };
export type TmuxCaptureResult = { ok: true; stdout: string } | { ok: false; error: string };

let tmuxAvailabilityCache: { checkedAt: number; ok: boolean } | undefined;

export function resetTmuxAvailabilityCache(): void {
  tmuxAvailabilityCache = undefined;
}

export function isTmuxAvailable(now = Date.now()): boolean {
  if (tmuxAvailabilityCache && now - tmuxAvailabilityCache.checkedAt < TMUX_AVAILABILITY_CACHE_MS) {
    return tmuxAvailabilityCache.ok;
  }
  const ok = runTmuxSync(["-V"]).ok;
  tmuxAvailabilityCache = { checkedAt: now, ok };
  return ok;
}

export function tmuxSessionExists(sessionName: string | undefined): boolean {
  if (!sessionName) return false;
  return runTmuxSync(["has-session", "-t", sessionName]).ok;
}

export function listTmuxSessions(): Set<string> | undefined {
  if (!isTmuxAvailable()) return undefined;
  const result = runTmuxCaptureSync(["list-sessions", "-F", "#{session_name}"]);
  if (!result.ok) return undefined;
  return new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

export function runTmuxCaptureSync(args: string[]): TmuxCaptureResult {
  try {
    const stdout = execFileSync("tmux", args, {
      encoding: "utf-8",
      timeout: TMUX_COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function runTmuxSync(args: string[]): TmuxCommandResult {
  try {
    execFileSync("tmux", args, {
      stdio: "ignore",
      timeout: TMUX_COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

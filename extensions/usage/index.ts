/**
 * /usage — interactive cross-session usage explorer.
 *
 * Loads deduplicated per-turn cost/token data (see core.ts) and opens the
 * tabbed UsagePanel (see ui.ts): heatmap overview with a day cursor, plus
 * per-model, per-project, and per-day tables with time-range filtering.
 */

import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadUsageData } from "./core.js";
import { UsagePanel } from "./ui.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Explore cost/token usage across all sessions (heatmap, models, projects, days)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Loading session data…", "info");
      // The default SessionManager directory is scoped to the current cwd, but
      // this panel advertises totals across all projects. Scan the common
      // default sessions root in that case; honor an explicitly configured
      // session directory exactly.
      const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
        usesDefaultSessionDir?: () => boolean;
      };
      const sessionsRoot = sessionManager.usesDefaultSessionDir?.() === true
        ? join(getAgentDir(), "sessions")
        : sessionManager.getSessionDir();
      const data = await loadUsageData(sessionsRoot);

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const panel = new UsagePanel(data, theme, done);
        return {
          render:      (w)   => panel.render(w),
          invalidate:  ()    => panel.invalidate(),
          handleInput: (raw) => { panel.handleInput(raw); tui.requestRender(); },
        };
      });
    },
  });
}

import { compactPreview } from "../output/preview.js";

export interface RunAgentStartJobView {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  label: string;
  supervisor: string;
  tmuxSession?: string;
  effectiveTools: string[];
  pid?: number;
  errorMessage?: string;
  cwd: string;
}

export function formatRunAgentStartResult(job: RunAgentStartJobView, _suggestedPollIntervalMs: number): string {
  const lines = [
    job.status === "running" ? `Started background agent ${job.id}.` : `Failed to start background agent ${job.id}.`,
    `Status: ${job.status}`,
    `Label: ${job.label}`,
    `Supervisor: ${job.supervisor}${job.tmuxSession ? ` (${job.tmuxSession})` : ""}`,
    `Tools: ${job.effectiveTools.length > 0 ? job.effectiveTools.join(", ") : "none"}`,
  ];
  if (job.status === "running") {
    lines.push(job.tmuxSession ? `Attach: tmux attach -t ${job.tmuxSession}` : `PID: ${job.pid ?? "(spawn pending)"}`);
  } else if (job.errorMessage) {
    lines.push(`Error: ${compactPreview(job.errorMessage, 500, 3)}`);
  }
  lines.push(
    `CWD: ${job.cwd}`,
    "",
    "The final result will be sent back to this Pi session when the subagent finishes.",
    job.tmuxSession ? `For live output/debugging, attach with: tmux attach -t ${job.tmuxSession}` : "",
  );
  return lines.filter((line) => line !== "").join("\n");
}

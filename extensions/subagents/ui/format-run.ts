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

export function formatRunAgentStartResult(job: RunAgentStartJobView, suggestedPollIntervalMs: number): string {
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
  lines.push(`CWD: ${job.cwd}`, "", `Poll later with: poll_agent({ id: "${job.id}", sinceSeq: 0, waitMs: ${suggestedPollIntervalMs} })`);
  return lines.join("\n");
}

import { compactPreview } from "../output/preview.js";

export interface RunAgentStartJobView {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  label: string;
  supervisor: string;
  effectiveTools: string[];
  errorMessage?: string;
  cwd: string;
}

export function formatRunAgentStartResult(job: RunAgentStartJobView, _suggestedPollIntervalMs: number): string {
  const lines = [
    job.status === "running" ? `Started background agent ${job.id}.` : `Failed to start background agent ${job.id}.`,
    `Status: ${job.status}`,
    `Label: ${job.label}`,
    `Supervisor: ${job.supervisor === "process" ? "in-process" : job.supervisor}`,
    `Tools: ${job.effectiveTools.length > 0 ? job.effectiveTools.join(", ") : "none"}`,
  ];
  if (job.status !== "running" && job.errorMessage) {
    lines.push(`Error: ${compactPreview(job.errorMessage, 500, 3)}`);
  }
  lines.push(
    `CWD: ${job.cwd}`,
    "",
    "The final result will be sent back to this Pi session when the subagent finishes.",
  );
  return lines.filter((line) => line !== "").join("\n");
}

import { compactPreview } from "../output/preview.js";

export interface RunAgentStartJobView {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  label: string;
  supervisor: string;
  effectiveTools: string[];
  errorMessage?: string;
  cwd: string;
  /** Isolated dir where the agent's full transcript is persisted (read/grep). */
  transcriptDir?: string;
}

export function formatRunAgentStartResult(job: RunAgentStartJobView): string {
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
  lines.push(`CWD: ${job.cwd}`);
  if (job.transcriptDir) lines.push(`Transcript (written as the agent runs): ${job.transcriptDir} (read/grep the JSONL session to inspect progress or what the agent did)`);
  lines.push(
    "",
    "The final result will be sent back to this Pi session when the subagent finishes.",
  );
  return lines.filter((line) => line !== "").join("\n");
}

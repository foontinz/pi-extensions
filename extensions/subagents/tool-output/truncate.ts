import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@mariozechner/pi-coding-agent";

export function truncateForTool(text: string): string {
  const truncation = truncateTail(text || "(empty)", {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return truncation.content;
  return (
    truncation.content +
    `\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines` +
    ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`
  );
}

import { truncateOneLine } from "../platform/text.js";

export function compactPreview(text: string, maxChars: number, maxLines: number): string {
  const joined = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(" / ");
  return truncateOneLine(joined || "(empty)", maxChars);
}

export function truncateOneLine(text: string, maxChars: number): string {
  const oneLine = squashWhitespace(text);
  return oneLine.length > maxChars ? `${oneLine.slice(0, Math.max(0, maxChars - 1))}…` : oneLine;
}

export function truncateString(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function displayCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

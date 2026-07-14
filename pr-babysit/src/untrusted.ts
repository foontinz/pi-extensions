const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Serialize attacker-controlled PR data without allowing literal markup delimiters. */
export function safeUntrusted(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "string") return entry.replace(CONTROL_CHARACTERS, "�");
    return entry;
  }, 2);
  if (serialized === undefined) throw new Error("Untrusted PR content is not JSON serializable");
  return serialized
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

export function untrustedBlock(value: unknown): string {
  return [
    "<untrusted_pr_content encoding=\"escaped-json\">",
    safeUntrusted(value),
    "</untrusted_pr_content>",
  ].join("\n");
}

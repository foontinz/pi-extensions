import { closeSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";

export const MAX_RECOVERABLE_OUTPUT_BYTES = 50 * 1024 * 1024;

function countNewlines(chunk: Buffer): number {
  let count = 0;
  for (const byte of chunk) if (byte === 0x0a) count++;
  return count;
}

export function sliceUtf8Head(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

export function sliceUtf8Tail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

function keepHead(text: string, maxBytes: number, maxLines: number): string {
  return sliceUtf8Head(text.split("\n").slice(0, maxLines).join("\n"), maxBytes);
}

function keepTail(text: string, maxBytes: number, maxLines: number): string {
  const lines = text.split("\n");
  return sliceUtf8Tail(lines.slice(Math.max(0, lines.length - maxLines)).join("\n"), maxBytes);
}

/**
 * Keeps a display-safe head/tail preview without retaining a command's entire
 * output in memory. The complete output is recorded by RecoverableOutput.
 */
export class BoundedOutputPreview {
  private readonly decoder = new StringDecoder("utf8");
  private text = "";
  private head = "";
  private tail = "";
  private hasData = false;
  private ended = false;
  private truncatedValue = false;
  private totalBytesValue = 0;
  private totalLinesValue = 0;

  constructor(
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly maxLines = DEFAULT_MAX_LINES,
  ) {}

  append(chunk: Buffer): void {
    if (this.ended || chunk.length === 0) return;
    this.hasData = true;
    this.totalBytesValue += chunk.length;
    this.totalLinesValue += countNewlines(chunk);
    this.appendText(this.decoder.write(chunk));
  }

  finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.appendText(this.decoder.end());
  }

  get truncated(): boolean {
    return this.truncatedValue;
  }

  get totalBytes(): number {
    return this.totalBytesValue;
  }

  get totalLines(): number {
    return this.hasData ? this.totalLinesValue + 1 : 0;
  }

  toString(): string {
    this.finish();
    if (!this.truncatedValue) return this.text.trimEnd();

    const shownBytes = Buffer.byteLength(this.head, "utf8") + Buffer.byteLength(this.tail, "utf8");
    const shownLines = this.head.split("\n").length + this.tail.split("\n").length;
    const elision =
      `\n\n… [output truncated: omitted ${Math.max(0, this.totalLines - shownLines)} of ${this.totalLines} lines, ` +
      `${formatSize(Math.max(0, this.totalBytes - shownBytes))} of ${formatSize(this.totalBytes)}] …\n\n`;
    return `${this.head}${elision}${this.tail}`.trimEnd();
  }

  private appendText(value: string): void {
    if (!value) return;
    if (!this.truncatedValue) {
      this.text += value;
      if (this.totalBytesValue <= this.maxBytes && this.totalLines <= this.maxLines) return;

      this.truncatedValue = true;
      const payloadBytes = this.maxBytes >= 512 ? this.maxBytes - 256 : this.maxBytes;
      const payloadLines = this.maxLines >= 8 ? this.maxLines - 4 : this.maxLines;
      const halfBytes = Math.max(1, Math.floor(payloadBytes / 2));
      const headLines = Math.max(1, Math.ceil(payloadLines / 2));
      const tailLines = Math.max(1, Math.floor(payloadLines / 2));
      this.head = keepHead(this.text, halfBytes, headLines);
      this.tail = keepTail(this.text, halfBytes, tailLines);
      this.text = "";
      return;
    }

    this.tail = keepTail(
      this.tail + value,
      Math.max(1, Math.floor((this.maxBytes >= 512 ? this.maxBytes - 256 : this.maxBytes) / 2)),
      Math.max(1, Math.floor((this.maxLines >= 8 ? this.maxLines - 4 : this.maxLines) / 2)),
    );
  }
}

/**
 * Persists complete interleaved stdout/stderr once the result would exceed
 * Pi's normal result budget. Until then it keeps only a bounded staging area.
 */
export class RecoverableOutput {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private recordedBytes = 0;
  private totalLines = 0;
  private hasData = false;
  private hardLimitReachedValue = false;
  private lastChannel: string | undefined;
  private fd: number | undefined;
  private outputPathValue: string | undefined;
  private persistenceFailed = false;
  private closed = false;

  constructor(
    private readonly prefix: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly maxLines = DEFAULT_MAX_LINES,
    private readonly hardLimitBytes = MAX_RECOVERABLE_OUTPUT_BYTES,
  ) {}

  /**
   * Record one stream chunk. Returns false once the hard recovery-file limit is
   * exceeded so the caller can terminate the producing process tree.
   */
  append(channel: "stdout" | "stderr", chunk: Buffer): boolean {
    if (this.closed || chunk.length === 0) return !this.hardLimitReachedValue;
    this.hasData = true;
    this.totalBytes += chunk.length;
    this.totalLines += countNewlines(chunk);

    const remaining = Math.max(0, this.hardLimitBytes - this.recordedBytes);
    const accepted = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
    const header = this.lastChannel === channel ? undefined : Buffer.from(`[${channel}]\n`, "utf8");
    this.lastChannel = channel;
    if (header && accepted.length > 0) this.write(header);
    if (accepted.length > 0) {
      this.recordedBytes += accepted.length;
      this.write(accepted);
    }

    if (!this.persistenceFailed && this.fd === undefined && (this.totalBytes > this.maxBytes || this.lineCount > this.maxLines)) {
      this.persist();
    }

    if (accepted.length < chunk.length && !this.hardLimitReachedValue) {
      this.hardLimitReachedValue = true;
      this.write(Buffer.from(`\n\n[output stopped after reaching the ${formatSize(this.hardLimitBytes)} safety limit]\n`, "utf8"));
    }
    return !this.hardLimitReachedValue;
  }

  get hardLimitReached(): boolean {
    return this.hardLimitReachedValue;
  }

  /** Persist staged output when a derived preview (for example channel labels) truncates first. */
  ensurePersisted(): void {
    if (!this.closed && this.fd === undefined && !this.persistenceFailed && this.chunks.length > 0) {
      this.persist();
    }
  }

  finish(): string | undefined {
    if (this.closed) return this.outputPathValue;
    this.closed = true;
    if (this.fd !== undefined) {
      try { closeSync(this.fd); } catch {}
      this.fd = undefined;
    }
    this.chunks = [];
    return this.outputPathValue;
  }

  private get lineCount(): number {
    return this.hasData ? this.totalLines + 1 : 0;
  }

  private write(chunk: Buffer): void {
    if (this.fd === undefined) {
      if (!this.persistenceFailed) {
        // Copy chunks because stream buffers are not guaranteed to remain owned
        // by the caller after the data event returns.
        this.chunks.push(Buffer.from(chunk));
      }
      return;
    }
    this.writeAll(chunk);
  }

  private persist(): void {
    try {
      const dir = mkdtempSync(join(tmpdir(), `${this.prefix}-`));
      const outputPath = join(dir, "output.log");
      this.fd = openSync(outputPath, "w", 0o600);
      this.outputPathValue = outputPath;
      for (const chunk of this.chunks) this.writeAll(chunk);
      this.chunks = [];
    } catch {
      // Keep the visible preview useful even when the filesystem cannot hold
      // a recovery file. Dropping staging chunks still bounds memory.
      if (this.fd !== undefined) {
        try { closeSync(this.fd); } catch {}
      }
      this.fd = undefined;
      this.outputPathValue = undefined;
      this.persistenceFailed = true;
      this.chunks = [];
    }
  }

  private writeAll(chunk: Buffer): void {
    if (this.fd === undefined) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        offset += writeSync(this.fd, chunk, offset, chunk.length - offset);
      }
    } catch {
      try { closeSync(this.fd); } catch {}
      this.fd = undefined;
      this.outputPathValue = undefined;
      this.persistenceFailed = true;
    }
  }
}

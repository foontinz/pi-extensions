import { StringDecoder } from "node:string_decoder";

export interface MonitorLine {
  text: string;
  truncated: boolean;
}

/**
 * Frames UTF-8 process output into bounded lines without retaining an
 * unterminated or binary-looking stream forever.
 */
export class MonitorLineFramer {
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";
  private discardingUntilNewline = false;

  constructor(
    private readonly onLine: (line: MonitorLine) => void,
    private readonly maxLineChars = 4_096,
  ) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.consume(this.decoder.write(chunk));
  }

  end(): void {
    this.consume(this.decoder.end());
    if (!this.discardingUntilNewline && this.buffered.length > 0) {
      this.emit(this.buffered, false);
    }
    this.buffered = "";
    this.discardingUntilNewline = false;
  }

  private consume(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      if (this.discardingUntilNewline) {
        const newline = text.indexOf("\n", offset);
        if (newline === -1) return;
        this.discardingUntilNewline = false;
        offset = newline + 1;
        continue;
      }

      const newline = text.indexOf("\n", offset);
      const end = newline === -1 ? text.length : newline;
      const piece = text.slice(offset, end);
      const remaining = this.maxLineChars - this.buffered.length;

      if (piece.length > remaining) {
        this.buffered += piece.slice(0, Math.max(0, remaining));
        this.emit(this.buffered, true);
        this.buffered = "";
        if (newline === -1) {
          this.discardingUntilNewline = true;
          return;
        }
        offset = newline + 1;
        continue;
      }

      this.buffered += piece;
      if (newline === -1) return;
      this.emit(this.buffered, false);
      this.buffered = "";
      offset = newline + 1;
    }
  }

  private emit(text: string, truncated: boolean): void {
    const normalized = text.endsWith("\r") ? text.slice(0, -1) : text;
    this.onLine({
      text: truncated ? `${normalized}… [line truncated]` : normalized,
      truncated,
    });
  }
}

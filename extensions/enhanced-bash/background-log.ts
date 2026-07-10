import { closeSync, copyFileSync, openSync, writeSync } from "node:fs";

/** Keep enough history for practical builds without allowing runaway jobs to fill a disk. */
export const MAX_BACKGROUND_LOG_BYTES = 10 * 1024 * 1024;
/** Recovery files retain complete output after the visible log is capped. */
export const MAX_BACKGROUND_RECOVERY_BYTES = 50 * 1024 * 1024;
const TRUNCATION_MARKER = "\n[background output truncated: log size limit reached]\n";
const RECOVERY_TRUNCATION_MARKER = "\n[full background output truncated: recovery size limit reached]\n";

/**
 * Synchronously writes process output to a capped log. Writes happen from
 * stream data callbacks, so this avoids an unbounded WriteStream queue while
 * still keeping the background job's memory use constant. If the visible log
 * reaches its cap, a separately capped recovery file preserves the complete
 * stream (up to MAX_BACKGROUND_RECOVERY_BYTES).
 */
export class BoundedBackgroundLog {
  private fd: number | undefined;
  private recoveryFd: number | undefined;
  private writtenBytes = 0;
  private droppedBytesValue = 0;
  private truncatedValue = false;
  private errorValue: string | undefined;
  private recoveryPathValue: string | undefined;
  private recoveryWrittenBytes = 0;
  private recoveryDroppedBytesValue = 0;
  private recoveryTruncatedValue = false;
  private recoveryFailed = false;
  private readonly dataLimit: number;
  private readonly marker: Buffer;
  private readonly recoveryDataLimit: number;
  private readonly recoveryMarker: Buffer;

  constructor(
    readonly path: string,
    private readonly maxBytes = MAX_BACKGROUND_LOG_BYTES,
    private readonly maxRecoveryBytes = MAX_BACKGROUND_RECOVERY_BYTES,
  ) {
    this.marker = Buffer.from(TRUNCATION_MARKER).subarray(0, Math.max(0, maxBytes));
    this.dataLimit = Math.max(0, maxBytes - this.marker.length);
    this.recoveryMarker = Buffer.from(RECOVERY_TRUNCATION_MARKER).subarray(0, Math.max(0, maxRecoveryBytes));
    this.recoveryDataLimit = Math.max(0, maxRecoveryBytes - this.recoveryMarker.length);
    this.fd = openSync(path, "w", 0o600);
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.fd === undefined) {
      this.droppedBytesValue += chunk.length;
      this.appendRecovery(chunk);
      return;
    }
    if (this.truncatedValue) {
      this.droppedBytesValue += chunk.length;
      this.appendRecovery(chunk);
      return;
    }

    const remaining = this.dataLimit - this.writtenBytes;
    if (chunk.length <= remaining) {
      this.writePrimary(chunk);
      this.writtenBytes += chunk.length;
      return;
    }

    // Copy the already-written raw prefix before appending the overflowing
    // chunk, then stream all later data into the bounded recovery file.
    this.startRecovery();
    this.appendRecovery(chunk);
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      this.writePrimary(retained);
      this.writtenBytes += retained.length;
      this.droppedBytesValue += chunk.length - retained.length;
    } else {
      this.droppedBytesValue += chunk.length;
    }
    this.truncatedValue = true;
    this.writePrimary(this.marker);
  }

  close(): void {
    if (this.fd !== undefined) {
      try { closeSync(this.fd); } catch {}
      this.fd = undefined;
    }
    if (this.recoveryFd !== undefined) {
      try { closeSync(this.recoveryFd); } catch {}
      this.recoveryFd = undefined;
    }
  }

  get truncated(): boolean {
    return this.truncatedValue;
  }

  get droppedBytes(): number {
    return this.droppedBytesValue;
  }

  get error(): string | undefined {
    return this.errorValue;
  }

  get recoveryPath(): string | undefined {
    return this.recoveryPathValue;
  }

  get recoveryTruncated(): boolean {
    return this.recoveryTruncatedValue;
  }

  get recoveryDroppedBytes(): number {
    return this.recoveryDroppedBytesValue;
  }

  private startRecovery(): void {
    if (this.recoveryFd !== undefined || this.recoveryFailed) return;
    try {
      const path = `${this.path}.full`;
      copyFileSync(this.path, path, 0);
      this.recoveryFd = openSync(path, "a", 0o600);
      this.recoveryPathValue = path;
      this.recoveryWrittenBytes = this.writtenBytes;
    } catch (err) {
      this.recoveryFailed = true;
      this.errorValue ??= err instanceof Error ? err.message : String(err);
    }
  }

  private appendRecovery(chunk: Buffer): void {
    if (this.recoveryFd === undefined || this.recoveryFailed) return;
    if (this.recoveryTruncatedValue) {
      this.recoveryDroppedBytesValue += chunk.length;
      return;
    }
    const remaining = this.recoveryDataLimit - this.recoveryWrittenBytes;
    if (chunk.length <= remaining) {
      this.writeRecovery(chunk);
      this.recoveryWrittenBytes += chunk.length;
      return;
    }
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      this.writeRecovery(retained);
      this.recoveryWrittenBytes += retained.length;
      this.recoveryDroppedBytesValue += chunk.length - retained.length;
    } else {
      this.recoveryDroppedBytesValue += chunk.length;
    }
    this.recoveryTruncatedValue = true;
    this.writeRecovery(this.recoveryMarker);
  }

  private writePrimary(chunk: Buffer): void {
    this.writeAll(chunk, "primary");
  }

  private writeRecovery(chunk: Buffer): void {
    this.writeAll(chunk, "recovery");
  }

  private writeAll(chunk: Buffer, target: "primary" | "recovery"): void {
    const fd = target === "primary" ? this.fd : this.recoveryFd;
    if (fd === undefined) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        offset += writeSync(fd, chunk, offset, chunk.length - offset);
      }
    } catch (err) {
      this.errorValue ??= err instanceof Error ? err.message : String(err);
      if (target === "primary") {
        try { closeSync(fd); } catch {}
        this.fd = undefined;
      } else {
        try { closeSync(fd); } catch {}
        this.recoveryFd = undefined;
        this.recoveryFailed = true;
        this.recoveryPathValue = undefined;
      }
    }
  }
}

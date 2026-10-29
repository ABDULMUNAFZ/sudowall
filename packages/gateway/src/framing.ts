/**
 * Newline-delimited message framing for the MCP stdio transport.
 *
 * Works on bytes, so the size limit is exact and multi-byte characters split across chunks are
 * reassembled correctly. Each message is the exact text between newlines (a trailing `\r`, which
 * is JSON whitespace, is kept so forwarding stays byte-for-byte).
 */
export interface FramerHandlers {
  message(text: string): void;
  /** A message exceeded the limit; its bytes were discarded up to the next newline. */
  oversize(byteLength: number): void;
}

const NEWLINE = 0x0a;

export class LineFramer {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private discarding = false;
  private discarded = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly handlers: FramerHandlers,
  ) {}

  push(chunk: Buffer): void {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(NEWLINE, from);
      if (nl === -1) {
        this.append(chunk.subarray(from));
        return;
      }
      this.append(chunk.subarray(from, nl));
      this.flush();
      from = nl + 1;
    }
  }

  private append(part: Buffer): void {
    if (part.length === 0) return;
    if (this.discarding) {
      this.discarded += part.length;
      return;
    }
    if (this.buffered + part.length > this.maxBytes) {
      this.discarding = true;
      this.discarded = this.buffered + part.length;
      this.chunks = [];
      this.buffered = 0;
      return;
    }
    this.chunks.push(part);
    this.buffered += part.length;
  }

  private flush(): void {
    if (this.discarding) {
      const n = this.discarded;
      this.discarding = false;
      this.discarded = 0;
      this.handlers.oversize(n);
      return;
    }
    const text = Buffer.concat(this.chunks, this.buffered).toString('utf8');
    this.chunks = [];
    this.buffered = 0;
    if (text.trim().length === 0) return; // blank lines carry no message
    this.handlers.message(text);
  }
}

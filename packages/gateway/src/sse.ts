/**
 * Minimal Server-Sent Events parser (WHATWG HTML §9.2) for MCP Streamable HTTP. Only `data`
 * fields matter to MCP; each event's data lines joined by "\n" is one JSON-RPC message.
 *
 * The size limit counts UTF-8 bytes and applies before an event is delivered: an event whose
 * data, or a line that, grows past `maxBytes` is dropped and reported once as oversize.
 */
export class SseParser {
  private buf = '';
  /** UTF-8 bytes of `buf`. */
  private bufBytes = 0;
  private data: string[] = [];
  /** UTF-8 bytes of the current event's data, counting the "\n" that joins its lines. */
  private dataBytes = 0;
  /** True while the rest of an oversize event is skipped (until its blank line). */
  private discarding = false;

  constructor(
    private readonly onEvent: (data: string) => void,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
    private readonly onOversize: (byteLength: number) => void = () => undefined,
  ) {}

  push(chunk: string): void {
    this.buf += chunk;
    this.bufBytes += Buffer.byteLength(chunk);
    let i;
    while ((i = this.nextLineEnd()) >= 0) {
      const line = this.buf.slice(0, i);
      const skip = this.buf[i] === '\r' && this.buf[i + 1] === '\n' ? 2 : 1;
      this.buf = this.buf.slice(i + skip);
      this.bufBytes -= Buffer.byteLength(line) + skip;
      this.line(line);
    }
    if (this.bufBytes + this.dataBytes > this.maxBytes) {
      // An unfinished line is already over the limit: drop it and the rest of its event.
      const n = this.bufBytes + this.dataBytes;
      this.buf = '';
      this.bufBytes = 0;
      this.drop(n);
    }
  }

  /** UTF-8 bytes buffered and not yet delivered. */
  get pending(): number {
    return this.bufBytes + this.dataBytes;
  }

  private nextLineEnd(): number {
    const n = this.buf.indexOf('\n');
    const r = this.buf.indexOf('\r');
    if (r === -1) return n;
    if (n === -1) return r === this.buf.length - 1 ? -1 : r; // a lone trailing \r may precede \n
    return Math.min(n, r);
  }

  private drop(byteLength: number): void {
    this.data = [];
    this.dataBytes = 0;
    if (!this.discarding) {
      this.discarding = true;
      this.onOversize(byteLength);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.discarding) {
        this.discarding = false;
        return;
      }
      if (this.data.length > 0) {
        const payload = this.data.join('\n');
        this.data = [];
        this.dataBytes = 0;
        this.onEvent(payload);
      }
      return;
    }
    if (this.discarding || line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field !== 'data') return;
    this.dataBytes += Buffer.byteLength(value) + (this.data.length > 0 ? 1 : 0);
    if (this.dataBytes > this.maxBytes) {
      this.drop(this.dataBytes);
      return;
    }
    this.data.push(value);
  }
}

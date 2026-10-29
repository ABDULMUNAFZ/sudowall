/**
 * Minimal Server-Sent Events parser (WHATWG HTML §9.2) for MCP Streamable HTTP. Only `data`
 * fields matter to MCP; each event's data lines joined by "\n" is one JSON-RPC message.
 */
export class SseParser {
  private buf = '';
  private data: string[] = [];

  constructor(private readonly onEvent: (data: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let i;
    while ((i = this.nextLineEnd()) >= 0) {
      const line = this.buf.slice(0, i);
      const skip = this.buf[i] === '\r' && this.buf[i + 1] === '\n' ? 2 : 1;
      this.buf = this.buf.slice(i + skip);
      this.line(line);
    }
  }

  /** Bytes currently buffered (for size limits). */
  get pending(): number {
    return this.buf.length + this.data.reduce((n, d) => n + d.length, 0);
  }

  private nextLineEnd(): number {
    const n = this.buf.indexOf('\n');
    const r = this.buf.indexOf('\r');
    if (r === -1) return n;
    if (n === -1) return r === this.buf.length - 1 ? -1 : r; // a lone trailing \r may precede \n
    return Math.min(n, r);
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) {
        const payload = this.data.join('\n');
        this.data = [];
        this.onEvent(payload);
      }
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
  }
}

import { spawn, type ChildProcess } from 'node:child_process';
import { spawnPlan } from './win-spawn.js';
import type { Readable, Writable } from 'node:stream';
import type { Channel, CloseReason } from './channel.js';
import { LineFramer } from './framing.js';
import type { Logger } from './log.js';

type Handlers = {
  message: ((text: string) => void)[];
  oversize: ((n: number) => void)[];
  close: ((r: CloseReason) => void)[];
};

abstract class FramedChannel implements Channel {
  protected readonly handlers: Handlers = { message: [], oversize: [], close: [] };
  protected closed = false;
  protected readonly framer: LineFramer;

  constructor(maxBytes: number) {
    this.framer = new LineFramer(maxBytes, {
      message: (t) => {
        for (const h of this.handlers.message) h(t);
      },
      oversize: (n) => {
        for (const h of this.handlers.oversize) h(n);
      },
    });
  }

  abstract send(text: string): void;
  abstract close(): Promise<void>;

  onMessage(h: (text: string) => void): void {
    this.handlers.message.push(h);
  }
  onOversize(h: (n: number) => void): void {
    this.handlers.oversize.push(h);
  }
  onClose(h: (r: CloseReason) => void): void {
    this.handlers.close.push(h);
  }

  protected fireClose(reason: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.handlers.close) h(reason);
  }
}

/** Client-facing stdio: the MCP client is our parent process, talking over stdin/stdout. */
export class StdioServerChannel extends FramedChannel {
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    maxBytes: number,
  ) {
    super(maxBytes);
    input.on('data', (chunk: Buffer) => {
      this.framer.push(chunk);
    });
    input.on('end', () => {
      this.fireClose({ kind: 'eof' });
    });
    input.on('error', (e) => {
      this.fireClose({ kind: 'error', message: e.message });
    });
    output.on('error', (e) => {
      this.fireClose({ kind: 'error', message: e.message });
    });
  }

  send(text: string): void {
    if (this.closed) return;
    this.output.write(`${text}\n`);
  }

  close(): Promise<void> {
    this.fireClose({ kind: 'eof' });
    // Stop reading so an open stdin does not keep the process alive after shutdown.
    this.input.pause();
    this.input.destroy();
    return Promise.resolve();
  }
}

export interface SpawnSpec {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd?: string | undefined;
}

/** Upstream stdio: a child process speaking MCP on its stdin/stdout. stderr goes to the log. */
export class StdioUpstreamChannel extends FramedChannel {
  private readonly child: ChildProcess;
  private readonly exited: Promise<void>;

  constructor(
    spec: SpawnSpec,
    maxBytes: number,
    private readonly log: Logger,
    private readonly shutdownGraceMs: number,
  ) {
    super(maxBytes);
    // On Windows, `npx` and other .cmd launchers need cmd.exe (see win-spawn.ts).
    const plan = spawnPlan(spec.command, spec.args, spec.env);
    this.child = spawn(plan.command, plan.args, {
      env: spec.env,
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.fireClose({ kind: 'exit', code, signal });
        resolve();
      });
      this.child.once('error', (e) => {
        // Spawn failures (ENOENT, EACCES) arrive here without an exit event.
        this.fireClose({ kind: 'error', message: e.message });
        resolve();
      });
    });
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.framer.push(chunk);
    });
    let errBuf = '';
    this.child.stderr?.on('data', (chunk: Buffer) => {
      errBuf += chunk.toString('utf8');
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        this.log.info('upstream stderr', { line: errBuf.slice(0, Math.min(i, 2000)) });
        errBuf = errBuf.slice(i + 1);
      }
      if (errBuf.length > 8192) {
        this.log.info('upstream stderr', { line: errBuf.slice(0, 2000) });
        errBuf = '';
      }
    });
    this.child.stdin?.on('error', (e) => {
      this.log.warn('upstream stdin error', { error: e.message });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  send(text: string): void {
    if (this.closed) return;
    this.child.stdin?.write(`${text}\n`);
  }

  /** Closes stdin, then SIGTERM, then SIGKILL after the grace period (MCP stdio shutdown). */
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin?.end();
    const grace = (ms: number) =>
      new Promise<boolean>((r) => {
        const t = setTimeout(() => {
          r(false);
        }, ms);
        void this.exited.then(() => {
          clearTimeout(t);
          r(true);
        });
      });
    if (await grace(Math.min(500, this.shutdownGraceMs))) return;
    this.child.kill('SIGTERM');
    if (await grace(this.shutdownGraceMs)) return;
    this.child.kill('SIGKILL');
    await this.exited;
  }
}

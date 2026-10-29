import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventSchema, type Event } from '@tortoisegate/core';
import { z } from 'zod';

/** Where gateway events go. `write` resolves only once the event is accepted by the store. */
export interface EventSink {
  write(event: Event): Promise<void>;
  close(): Promise<void>;
}

/** Validates every event against the core schema before handing it on (catches gateway bugs). */
export class ValidatingSink implements EventSink {
  constructor(private readonly inner: EventSink) {}

  async write(event: Event): Promise<void> {
    const r = EventSchema.safeParse(event);
    if (!r.success) {
      throw new Error(
        `gateway produced an invalid ${event.type} event:\n${z.prettifyError(r.error)}`,
      );
    }
    await this.inner.write(event);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

export class MemorySink implements EventSink {
  readonly events: Event[] = [];
  /** Set to make writes fail (tests of sink-failure behaviour). */
  failWith: Error | undefined;

  write(event: Event): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.events.push(event);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Appends one JSON object per line to `path` (mode 0600). When the file would exceed
 * `rotateBytes`, it is renamed to `path.1` (older files shift up) and `keepFiles` are kept.
 * Writes are serialised. Phase 1 does not fsync each line; the Phase 2 ledger owns durability.
 */
export class JsonlFileSink implements EventSink {
  private handle: FileHandle | undefined;
  private size = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly rotateBytes: number,
    private readonly keepFiles: number,
  ) {}

  write(event: Event): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const run = this.queue.then(() => this.append(line));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async ensureOpen(): Promise<FileHandle> {
    if (this.handle !== undefined) return this.handle;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.handle = await open(this.path, 'a', 0o600);
    this.size = (await this.handle.stat()).size;
    return this.handle;
  }

  private async append(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line);
    let h = await this.ensureOpen();
    if (this.size > 0 && this.size + bytes > this.rotateBytes) {
      await this.rotate();
      h = await this.ensureOpen();
    }
    await h.write(line);
    this.size += bytes;
  }

  private async rotate(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
    await rm(`${this.path}.${this.keepFiles}`, { force: true });
    for (let i = this.keepFiles - 1; i >= 1; i--) {
      const from = `${this.path}.${i}`;
      if (await exists(from)) await rename(from, `${this.path}.${i + 1}`);
    }
    await rename(this.path, `${this.path}.1`);
  }

  async close(): Promise<void> {
    await this.queue;
    await this.handle?.close();
    this.handle = undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Exposed-name assignments, persisted so names stay stable across restarts. */
export interface NameStore {
  load(): Record<string, string>;
  save(map: Record<string, string>): void;
}

export class MemoryNameStore implements NameStore {
  constructor(private map: Record<string, string> = {}) {}
  load(): Record<string, string> {
    return { ...this.map };
  }
  save(map: Record<string, string>): void {
    this.map = { ...map };
  }
}

export class FileNameStore implements NameStore {
  constructor(private readonly path: string) {}

  load(): Record<string, string> {
    try {
      const v: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
      return Object.fromEntries(
        Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
    } catch {
      return {};
    }
  }

  save(map: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export interface NamespaceOptions {
  scheme: 'on-collision' | 'always';
  separator: string;
}

const key = (server: string, name: string) => `${server}\u0000${name}`;

/**
 * Maps (server, upstream name) pairs to the names the client sees.
 *
 * - `always`: every name becomes `<server><sep><name>`.
 * - `on-collision`: a name is prefixed only if more than one upstream offers it. A name that was
 *   already assigned (persisted) keeps its assignment, so a server that adds a clashing tool
 *   later cannot take over or rename a tool the client already knows.
 * Exposed names are always unique; a leftover clash gets a numeric suffix.
 */
export class Namespacer {
  private assigned: Record<string, string>;
  private forward = new Map<string, string>();
  private reverse = new Map<string, { server: string; name: string }>();

  constructor(
    private readonly opts: NamespaceOptions,
    private readonly store: NameStore,
  ) {
    this.assigned = store.load();
  }

  /** Recomputes the mapping from the current lists (servers in config order). */
  update(lists: readonly { server: string; names: readonly string[] }[]): void {
    const owners = new Map<string, number>();
    for (const l of lists)
      for (const n of new Set(l.names)) owners.set(n, (owners.get(n) ?? 0) + 1);
    const taken = new Set<string>();
    this.forward = new Map();
    this.reverse = new Map();
    const place = (server: string, name: string, exposed: string) => {
      let unique = exposed;
      for (let i = 2; taken.has(unique); i++) unique = `${exposed}${this.opts.separator}${i}`;
      taken.add(unique);
      this.forward.set(key(server, name), unique);
      this.reverse.set(unique, { server, name });
      this.assigned[key(server, name)] = unique;
    };
    const pending: { server: string; name: string }[] = [];
    // Previously assigned names first, so they keep their spelling.
    for (const l of lists) {
      for (const name of new Set(l.names)) {
        const prior = this.assigned[key(l.server, name)];
        if (prior !== undefined && !taken.has(prior)) place(l.server, name, prior);
        else pending.push({ server: l.server, name });
      }
    }
    for (const { server, name } of pending) {
      const prefixed =
        this.opts.scheme === 'always' || (owners.get(name) ?? 0) > 1 || taken.has(name);
      place(server, name, prefixed ? `${server}${this.opts.separator}${name}` : name);
    }
    this.store.save(this.assigned);
  }

  exposedName(server: string, name: string): string | undefined {
    return this.forward.get(key(server, name));
  }

  resolve(exposed: string): { server: string; name: string } | undefined {
    return this.reverse.get(exposed);
  }
}

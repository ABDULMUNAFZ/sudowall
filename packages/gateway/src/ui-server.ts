import { createPrivateKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import {
  SIGNING_KEY_FILE,
  openStateDb,
  rawPublicKey,
  verifyDatabase,
  type StateDb,
} from '@sudowall/ledger';
import { IncidentNotFound, incidentReport, sha256ValueId } from '@sudowall/graph';
import { ApprovalStore } from './approvals.js';
import type { Logger } from './log.js';

export interface UiServerOptions {
  /** The shared state database. */
  dbPath: string;
  /** Holds the ledger signing key; its public key is what Verify checks against. */
  keyDir: string;
  /** 0 picks a free port. The host is always 127.0.0.1. */
  port: number;
  /** Built web app (apps/web-ui/dist). */
  staticDir: string;
  log: Logger;
  now?: () => number;
}

export interface RunningUi {
  /** Open this in a browser; the token is in the fragment, so it is never sent to the server. */
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY = 16 * 1024;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function installationPublicKey(keyDir: string): Buffer | undefined {
  const path = join(keyDir, SIGNING_KEY_FILE);
  if (!existsSync(path)) return undefined;
  return rawPublicKey(createPrivateKey(readFileSync(path, 'utf8')));
}

function hasTable(db: StateDb, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

interface FeedItem {
  seq: number;
  ts: string;
  type: string;
  [k: string]: unknown;
}

/** Recent decisions from the ledger (already redacted before storage). */
function feed(db: StateDb, limit: number): FeedItem[] {
  if (!hasTable(db, 'ledger_entries')) return [];
  const rows = db
    .prepare(
      "SELECT seq, event_json FROM ledger_entries WHERE type IN ('tool.call', 'approval.resolved') ORDER BY seq DESC LIMIT ?",
    )
    .all(limit) as { seq: number; event_json: string }[];
  return rows.map(({ seq, event_json }) => {
    const e = JSON.parse(event_json) as Record<string, unknown>;
    if (e['type'] === 'tool.call') {
      const d = e['decision'] as Record<string, unknown>;
      return {
        seq,
        ts: String(e['ts']),
        type: 'tool.call',
        eventId: e['id'],
        server: (e['server'] as { id: string }).id,
        tool: e['tool'],
        verdict: d['verdict'],
        effective: d['effective'],
        mode: d['mode'],
        reason: d['reason'],
        ruleIds: (d['matchedRules'] as { ruleId: string }[]).map((r) => r.ruleId),
      };
    }
    return {
      seq,
      ts: String(e['ts']),
      type: 'approval.resolved',
      callEventId: e['callEventId'],
      outcome: e['outcome'],
      resultingAction: e['resultingAction'],
      channel: e['channel'],
    };
  });
}

function ledgerStatus(db: StateDb) {
  if (!hasTable(db, 'ledger_entries'))
    return { entries: 0, lastSeq: null, lastCheckpointSeq: null };
  const c = db.prepare('SELECT COUNT(*) AS n, MAX(seq) AS last FROM ledger_entries').get() as {
    n: number;
    last: number | null;
  };
  const cp = db.prepare('SELECT MAX(to_seq) AS s FROM ledger_checkpoints').get() as {
    s: number | null;
  };
  return { entries: c.n, lastSeq: c.last, lastCheckpointSeq: cp.s };
}

/**
 * The local approval and status UI. Binds 127.0.0.1 only. Every API call needs the bearer token
 * printed at start; state-changing calls also need the CSRF token, a same-origin `Origin` header
 * and a JSON body. `Host` must name this server (DNS rebinding).
 */
export async function startUiServer(o: UiServerOptions): Promise<RunningUi> {
  const now = o.now ?? Date.now;
  const index = join(o.staticDir, 'index.html');
  if (!existsSync(index)) {
    throw new Error(`web UI is not built: ${index} is missing (run pnpm build)`);
  }
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const db = openStateDb(o.dbPath);
  const approvals = new ApprovalStore(db);
  let port = 0;

  const allowedHosts = () => new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]);
  const allowedOrigins = () =>
    new Set([`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`]);

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  const readJson = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const type = req.headers['content-type'] ?? '';
      if (!/^application\/json(;|$)/.test(type)) {
        reject(new HttpError(415, 'expected application/json'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if (v === null || typeof v !== 'object' || Array.isArray(v))
            throw new Error('not an object');
          resolve(v as Record<string, unknown>);
        } catch {
          reject(new HttpError(400, 'body must be a JSON object'));
        }
      });
      req.on('error', reject);
    });

  const serveStatic = (path: string, res: ServerResponse) => {
    const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
    const file = normalize(join(o.staticDir, rel));
    if (
      !file.startsWith(normalize(o.staticDir) + sep) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      throw new HttpError(404, 'not found');
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(readFileSync(file));
  };

  const api = async (req: IncomingMessage, path: string, res: ServerResponse) => {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), token)) {
      throw new HttpError(401, 'missing or wrong token');
    }
    if (req.method === 'GET' && path === '/api/state') {
      const t = now();
      send(res, 200, {
        now: t,
        csrfToken,
        pending: approvals.pending(t),
        recentApprovals: approvals.recent(20),
        feed: feed(db, 100),
        ledger: ledgerStatus(db),
      });
      return;
    }
    const inc = /^\/api\/incident\/([0-9a-f-]{36})$/.exec(path);
    if (req.method === 'GET' && inc !== null) {
      // Read-only, like /api/state. The graph is built in memory from the ledger and never leaves
      // this process, so plain value hashes are enough here.
      if (!hasTable(db, 'ledger_entries')) throw new HttpError(404, 'no ledger yet');
      const expected = installationPublicKey(o.keyDir);
      try {
        const r = await incidentReport({
          db,
          ref: inc[1] ?? '',
          valueId: sha256ValueId,
          ...(expected === undefined ? {} : { expectedPublicKey: expected }),
        });
        send(res, 200, { call: r.call, path: r.path, ledger: r.ledger });
      } catch (e) {
        if (e instanceof IncidentNotFound) throw new HttpError(404, e.message);
        throw e;
      }
      return;
    }
    if (req.method === 'GET') throw new HttpError(404, 'not found');
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    const origin = req.headers.origin;
    if (origin === undefined || !allowedOrigins().has(origin)) {
      throw new HttpError(403, 'cross-origin request refused');
    }
    const csrf = req.headers['x-tg-csrf'];
    if (typeof csrf !== 'string' || !sameSecret(csrf, csrfToken)) {
      throw new HttpError(403, 'missing or wrong CSRF token');
    }
    const body = await readJson(req);
    const m = /^\/api\/approvals\/([0-9a-f-]{36})$/.exec(path);
    if (m !== null) {
      const decision = body['decision'];
      const hash = body['argumentsSha256'];
      if ((decision !== 'approve' && decision !== 'deny') || typeof hash !== 'string') {
        throw new HttpError(400, 'expected { decision: "approve" | "deny", argumentsSha256 }');
      }
      const id = m[1] ?? '';
      const result = approvals.resolve(
        id,
        decision === 'approve' ? 'approved' : 'denied',
        hash,
        'web-ui',
        now(),
      );
      o.log.info('approval decided in the UI', { approvalId: id, decision, result });
      send(res, result === 'ok' ? 200 : result === 'not-found' ? 404 : 409, { result });
      return;
    }
    if (path === '/api/ledger/verify') {
      const expected = installationPublicKey(o.keyDir);
      const r = hasTable(db, 'ledger_meta')
        ? verifyDatabase(db, expected === undefined ? {} : { expectedPublicKey: expected })
        : ({ ok: false, kind: 'BAD_HEADER', message: 'no ledger yet' } as const);
      send(res, 200, { ...r, signerChecked: expected !== undefined });
      return;
    }
    throw new HttpError(404, 'not found');
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const host = req.headers.host;
        if (host === undefined || !allowedHosts().has(host)) {
          throw new HttpError(421, 'unexpected Host header');
        }
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (path.startsWith('/api/')) await api(req, path, res);
        else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(path, res);
        else throw new HttpError(405, 'method not allowed');
      } catch (e) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (e instanceof HttpError) send(res, e.status, { error: e.message });
        else {
          o.log.error('UI REQUEST FAILED', { error: (e as Error).message });
          send(res, 500, { error: 'internal error' });
        }
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => {
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}/#token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

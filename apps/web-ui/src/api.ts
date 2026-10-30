export interface Approval {
  id: string;
  eventId: string;
  serverId: string;
  tool: string;
  argumentsSha256: string;
  explanation: string;
  details: {
    arguments: unknown;
    matchedRules: { ruleId: string; action: string }[];
    evidence: { argPath: string; match: string; label: string; sources: string[] }[];
  };
  createdAt: number;
  expiresAt: number;
  status: string;
  resolvedAt: number | null;
  channel: string | null;
}

export type FeedItem =
  | {
      seq: number;
      ts: string;
      type: 'tool.call';
      eventId: string;
      server: string;
      tool: string;
      verdict: string;
      effective: string;
      mode: string;
      reason: string;
      ruleIds: string[];
      /** Up to two `name: value` pairs from the (redacted) arguments. */
      summary: { name: string; value: string }[];
    }
  | {
      seq: number;
      ts: string;
      type: 'approval.resolved';
      callEventId: string;
      outcome: string;
      resultingAction: string;
      channel: string;
    };

export interface State {
  now: number;
  csrfToken: string;
  pending: Approval[];
  recentApprovals: Approval[];
  feed: FeedItem[];
  ledger: { entries: number; lastSeq: number | null; lastCheckpointSeq: number | null };
}

export type VerifyResult =
  | {
      ok: true;
      entries: number;
      checkpoints: number;
      unsignedTail: number;
      keyId: string;
      signerChecked: boolean;
    }
  | { ok: false; kind: string; message: string; seq?: number; signerChecked: boolean };

export interface IncidentStep {
  depth: number;
  argPath: string;
  value: { kind: string; display: string };
  match: { type: string; nearKind: string };
  source: { id: string; label: string; serverId: string; origin: string; observedAt: string };
  producedBy?: { eventId: string; serverId: string; tool: string; ts: string; verdict: string };
}

export interface Incident {
  call: {
    eventId: string;
    seq: number;
    ts: string;
    serverId: string;
    tool: string;
    verdict: string;
    effective: string;
    rules: string[];
    reason: string;
    outcome: string;
    approval?: { outcome: string; channel: string };
  };
  path: IncidentStep[];
  ledger: { ok: boolean; message: string; entries: number[]; allSigned: boolean };
}

/** Product context served by `sudowall ui` and the demo (packages/cli/src/product.ts). */
export interface Product {
  version: string;
  config: {
    path: string | null;
    found: boolean;
    mode: 'observe' | 'enforce';
    canChangeMode: boolean;
  };
  policy:
    | {
        name: string;
        path: string;
        defaults: { sink: string; other: string };
        rules: { id: string; action: string; reason: string; appliesTo: string }[];
        lists: { id: string; kind: string; count: number }[];
      }
    | { error: string }
    | null;
  agents:
    | {
        clients: {
          client: string;
          file: string;
          servers: {
            name: string;
            state: 'protected' | 'not protected' | 'skipped';
            remote: boolean;
            detail: string;
          }[];
        }[];
        notFound: string[];
      }
    | { error: string };
  activity: {
    days: number;
    calls: number;
    observe: { wouldAsk: number; wouldBlock: number };
    enforce: { asked: number; blocked: number };
  } | null;
  integrations: {
    tigergraph: { configured: boolean };
    templates: string[];
    remoteServers: number;
    dodoPayments: boolean;
    viaSocket: boolean;
  };
}

const TOKEN_KEY = 'sudowall-token';

/** The token arrives in the URL fragment; keep it for this tab and remove it from the address bar. */
export function takeToken(): string | null {
  const m = /(?:^|&)token=([A-Za-z0-9_-]+)/.exec(window.location.hash.slice(1));
  if (m?.[1] !== undefined) {
    try {
      sessionStorage.setItem(TOKEN_KEY, m[1]);
    } catch {
      // Storage can be unavailable; the token still works for this page load.
    }
    history.replaceState(null, '', window.location.pathname);
    return m[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export class Api {
  private csrf = '';

  constructor(private readonly token: string) {}

  async state(): Promise<State> {
    const r = await fetch('/api/state', {
      headers: { Authorization: `Bearer ${this.token}` },
      cache: 'no-store',
    });
    if (!r.ok)
      throw new Error(
        r.status === 401 ? 'The access token is missing or wrong.' : `HTTP ${String(r.status)}`,
      );
    const s = (await r.json()) as State;
    this.csrf = s.csrfToken;
    return s;
  }

  private async post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const r = await fetch(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'X-TG-CSRF': this.csrf,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }

  async decide(a: Approval, decision: 'approve' | 'deny'): Promise<string> {
    const r = await this.post(`/api/approvals/${a.id}`, {
      decision,
      argumentsSha256: a.argumentsSha256,
    });
    return (
      (r.body as { result?: string; error?: string }).result ??
      (r.body as { error?: string }).error ??
      'error'
    );
  }

  async incident(eventId: string): Promise<Incident> {
    const r = await fetch(`/api/incident/${encodeURIComponent(eventId)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(`Could not load the explanation (HTTP ${String(r.status)}).`);
    return (await r.json()) as Incident;
  }

  async product(): Promise<Product | null> {
    const r = await fetch('/api/product', {
      headers: { Authorization: `Bearer ${this.token}` },
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(`Could not load settings (HTTP ${String(r.status)}).`);
    return (await r.json()) as Product | null;
  }

  async setMode(mode: 'observe' | 'enforce'): Promise<void> {
    const r = await this.post('/api/mode', { mode });
    if (r.status !== 200) {
      throw new Error((r.body as { error?: string }).error ?? `HTTP ${String(r.status)}`);
    }
  }

  async verify(): Promise<VerifyResult> {
    return (await this.post('/api/ledger/verify', {})).body as VerifyResult;
  }
}

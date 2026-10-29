import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Api,
  takeToken,
  type Approval,
  type FeedItem,
  type Incident,
  type State,
  type VerifyResult,
} from './api.js';
import { count, ledgerSummary, visible, visibleJson } from './text.js';

const POLL_MS = 1000;

function field(args: unknown, names: string[]): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  for (const n of names) {
    const v = (args as Record<string, unknown>)[n];
    if (typeof v === 'string' || typeof v === 'number') return String(v);
  }
  return undefined;
}

const time = (ts: string | number) => new Date(ts).toLocaleTimeString();

function PendingCard({
  a,
  now,
  api,
  onDone,
}: {
  a: Approval;
  now: number;
  api: Api;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recipient = field(a.details.arguments, ['to', 'recipient', 'address']);
  const amount = field(a.details.arguments, ['amount', 'value']);
  const left = Math.max(0, Math.ceil((a.expiresAt - now) / 1000));
  const decide = (d: 'approve' | 'deny') => {
    setBusy(true);
    setError(null);
    api
      .decide(a, d)
      .then((r) => {
        if (r !== 'ok') setError(`Not applied: ${r}`);
        onDone();
      })
      .catch((e: unknown) => {
        setError((e as Error).message);
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <article className="card pending" data-testid="pending-approval" data-approval-id={a.id}>
      <header>
        <span className="tool">
          {a.serverId}/{a.tool}
        </span>
        <span className="countdown">{left} s left</span>
      </header>
      <dl className="key">
        {recipient !== undefined && (
          <>
            <dt>Recipient</dt>
            <dd className="mono" data-testid="recipient">
              {visible(recipient)}
            </dd>
          </>
        )}
        {amount !== undefined && (
          <>
            <dt>Amount</dt>
            <dd className="mono" data-testid="amount">
              {visible(amount)}
            </dd>
          </>
        )}
        <dt>Rules</dt>
        <dd>{a.details.matchedRules.map((r) => r.ruleId).join(', ') || 'default stance'}</dd>
        {a.details.evidence.map((e, i) => (
          <div key={i} className="evidence">
            <dt>Source of {e.argPath}</dt>
            <dd>
              {e.match} match with {e.label} content from {e.sources.map(visible).join(', ')}
            </dd>
          </div>
        ))}
      </dl>
      <p className="reason">{visible(a.explanation)}</p>
      <details>
        <summary>All arguments</summary>
        <pre className="mono">{visibleJson(a.details.arguments)}</pre>
        <p className="hash mono">sha256 {a.argumentsSha256}</p>
      </details>
      {error !== null && <p className="error">{error}</p>}
      <div className="actions">
        <button
          type="button"
          className="deny"
          disabled={busy}
          onClick={() => {
            decide('deny');
          }}
        >
          Deny
        </button>
        <button
          type="button"
          className="approve"
          disabled={busy}
          onClick={() => {
            decide('approve');
          }}
        >
          Approve
        </button>
      </div>
    </article>
  );
}

function sourceName(s: Incident['path'][number]['source']): string {
  return s.serverId === '' ? 'your policy list' : `${s.serverId}/${s.origin}`;
}

function IncidentPanel({ i, onClose }: { i: Incident; onClose: () => void }) {
  const c = i.call;
  return (
    <section className="card incident" aria-labelledby="incident-h" data-testid="incident">
      <header>
        <h3 id="incident-h">
          Why {c.serverId}/{c.tool} was{' '}
          <span className={`badge ${c.effective}`}>
            {c.verdict === 'ask' ? 'paused' : c.verdict === 'block' ? 'blocked' : 'allowed'}
          </span>
        </h3>
        <button type="button" className="close" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="reason">{visible(c.reason)}</p>
      {c.approval !== undefined && (
        <p className="muted">
          A person {c.approval.outcome} it in the {c.approval.channel}. Outcome: {c.outcome}.
        </p>
      )}
      <h4>Where its values came from</h4>
      {i.path.length === 0 && (
        <p className="muted">No argument matched untrusted content or a known value.</p>
      )}
      <ol className="flow">
        {i.path.map((p, k) => (
          <li key={k} className="flow-row" style={{ marginLeft: `${String(p.depth * 1.5)}rem` }}>
            <span className={`node source ${p.source.label}`}>
              <small>
                {p.source.label === 'user' ? 'trusted list' : `${p.source.label} result`}
              </small>
              {visible(sourceName(p.source))}
              {p.producedBy !== undefined && (
                <small className="mono">read by call {p.producedBy.eventId.slice(0, 8)}</small>
              )}
            </span>
            <span className="arrow" aria-hidden="true">
              {p.match.type === 'near' ? 'looks like' : 'contained'}
            </span>
            <span className="node value">
              <small>{p.value.kind}</small>
              <span className="mono">{visible(p.value.display)}</span>
            </span>
            <span className="arrow" aria-hidden="true">
              used as
            </span>
            <span className="node call">
              <small>{p.depth === 0 ? 'this call' : 'an earlier call'}</small>
              <span className="mono">{visible(p.argPath)}</span>
            </span>
            <span className="sr-only">
              {`${p.argPath} (${p.value.kind} ${p.value.display}) ${p.match.type === 'near' ? `looks like a value from ${sourceName(p.source)} (${p.match.nearKind})` : `was found in ${p.source.label} content from ${sourceName(p.source)}`}.`}
            </span>
          </li>
        ))}
      </ol>
      <p className={i.ledger.ok ? 'ok' : 'error'} data-testid="incident-ledger">
        {i.ledger.ok ? 'Ledger verified' : 'Ledger verification FAILED'}: {i.ledger.message}.
        Entries {i.ledger.entries.join(', ')}
        {i.ledger.allSigned ? ', all signed.' : ', not all signed yet.'}
      </p>
    </section>
  );
}

function FeedRow({ f, onExplain }: { f: FeedItem; onExplain: (eventId: string) => void }) {
  if (f.type === 'approval.resolved') {
    return (
      <tr className={`row ${f.resultingAction}`}>
        <td>{time(f.ts)}</td>
        <td>approval</td>
        <td>
          <span className={`badge ${f.resultingAction}`}>{f.outcome}</span>
        </td>
        <td>
          {f.channel}: call {f.callEventId.slice(0, 8)}{' '}
          {f.resultingAction === 'allow' ? 'released' : 'not run'}
        </td>
      </tr>
    );
  }
  return (
    <tr className={`row ${f.effective}`}>
      <td>{time(f.ts)}</td>
      <td className="mono">
        {f.server}/{f.tool}
      </td>
      <td>
        <span className={`badge ${f.verdict}`}>{f.verdict}</span>
        {f.mode === 'observe' && f.verdict !== 'allow' && (
          <span className="note"> (observe: allowed)</span>
        )}
      </td>
      <td>
        {visible(f.reason)}{' '}
        <button
          type="button"
          className="link"
          onClick={() => {
            onExplain(f.eventId);
          }}
        >
          Explain
        </button>
      </td>
    </tr>
  );
}

export function App() {
  const token = useMemo(takeToken, []);
  const api = useMemo(() => (token === null ? null : new Api(token)), [token]);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [incident, setIncident] = useState<Incident | null>(null);

  const refresh = useCallback(() => {
    if (api === null) return;
    api
      .state()
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((e: unknown) => {
        setError((e as Error).message);
      });
  }, [api]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => {
      clearInterval(t);
    };
  }, [refresh]);

  if (api === null) {
    return (
      <main className="empty">
        <h1>Tortoise Gate</h1>
        <p>
          Open the address printed by <code>tortoisegate ui</code>; it contains the access token.
        </p>
      </main>
    );
  }

  const explain = (eventId: string) => {
    api
      .incident(eventId)
      .then((i) => {
        setIncident(i);
      })
      .catch((e: unknown) => {
        setError((e as Error).message);
      });
  };

  const runVerify = () => {
    setVerifying(true);
    api
      .verify()
      .then(setVerify)
      .catch((e: unknown) => {
        setError((e as Error).message);
      })
      .finally(() => {
        setVerifying(false);
      });
  };

  return (
    <main>
      <header className="top">
        <h1>Tortoise Gate</h1>
        <p className="tagline">Nothing moves until it&rsquo;s checked.</p>
        <p className="about" data-testid="about">
          Every tool call your AI agent makes through the gate is checked here. Risky ones wait for
          your decision, and everything is kept in a tamper-evident record.
        </p>
      </header>
      {error !== null && <p className="error banner">{error}</p>}

      <section aria-labelledby="pending-h">
        <h2 id="pending-h">
          Waiting for you <span className="count">{state?.pending.length ?? 0}</span>
        </h2>
        {state !== null && state.pending.length === 0 && (
          <p className="muted">No calls are waiting for approval.</p>
        )}
        <div className="cards">
          {state?.pending.map((a) => (
            <PendingCard key={a.id} a={a} now={state.now} api={api} onDone={refresh} />
          ))}
        </div>
      </section>

      <section aria-labelledby="ledger-h" className="ledger">
        <h2 id="ledger-h">Ledger</h2>
        <p data-testid="ledger-summary">
          {ledgerSummary(state?.ledger.entries ?? 0, state?.ledger.lastCheckpointSeq ?? null)}
        </p>
        <button type="button" onClick={runVerify} disabled={verifying} data-testid="verify">
          {verifying ? 'Verifying...' : 'Verify'}
        </button>
        {verify !== null && (
          <p className={verify.ok ? 'ok' : 'error'} data-testid="verify-result">
            {verify.ok
              ? `Verified: ${count(verify.entries, 'entry', 'entries')}, ${count(verify.checkpoints, 'checkpoint', 'checkpoints')}, ${String(verify.unsignedTail)} not yet signed. Key ${verify.keyId}.`
              : `FAILED${verify.seq !== undefined ? ` at entry ${String(verify.seq)}` : ''}: ${verify.kind}: ${verify.message}`}
            {!verify.signerChecked && ' (signer not checked: no local signing key)'}
          </p>
        )}
      </section>

      <section aria-labelledby="feed-h">
        <h2 id="feed-h">Live decisions</h2>
        {incident !== null && (
          <IncidentPanel
            i={incident}
            onClose={() => {
              setIncident(null);
            }}
          />
        )}
        {state !== null && state.feed.length === 0 && (
          <p className="muted">No tool calls yet. Decisions appear here as your agent works.</p>
        )}
        <table className="feed" data-testid="feed">
          <thead>
            <tr>
              <th>Time</th>
              <th>Tool</th>
              <th>Decision</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {state?.feed.map((f) => (
              <FeedRow key={f.seq} f={f} onExplain={explain} />
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

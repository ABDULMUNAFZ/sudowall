import { useState } from 'react';
import type { Api, Approval, FeedItem, Incident, Product } from './api.js';
import { approvalWords, outcome, plainReason, sentence } from './describe.js';
import { visible, visibleJson } from './text.js';

export const time = (ts: string | number) => new Date(ts).toLocaleTimeString();

function field(args: unknown, names: string[]): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  for (const n of names) {
    const v = (args as Record<string, unknown>)[n];
    if (typeof v === 'string' || typeof v === 'number') return String(v);
  }
  return undefined;
}

/** A call waiting for a person. Shows the values in full and where they came from. */
export function PendingCard({
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
  const recipient = field(a.details.arguments, ['to', 'recipient', 'address', 'email']);
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
        <span>
          Your agent wants to use <span className="mono">{a.tool}</span> on{' '}
          <span className="mono">{a.serverId}</span>
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
      <p className="reason">{visible(plainReason(a.explanation))}</p>
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

/** Why a call was decided as it was, and where each of its values came from. */
export function IncidentView({ i }: { i: Incident }) {
  const c = i.call;
  return (
    <section className="card incident" aria-labelledby="incident-h" data-testid="incident">
      <h3 id="incident-h">
        Why {c.serverId}/{c.tool} was{' '}
        <span className={`badge ${c.effective}`}>
          {c.verdict === 'ask' ? 'paused' : c.verdict === 'block' ? 'blocked' : 'allowed'}
        </span>
      </h3>
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
          <li key={k} className={`flow-row depth-${String(Math.min(p.depth, 4))}`}>
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
      {i.pathTruncated && (
        <p className="muted" data-testid="incident-truncated">
          The path is longer than shown: tracing stopped at its depth limit.
        </p>
      )}
      {i.unreadableEntries.length > 0 && (
        <p className="error">
          {i.unreadableEntries.length === 1 ? 'Ledger entry' : 'Ledger entries'}{' '}
          {i.unreadableEntries.join(', ')} could not be read and were left out of this trace.
        </p>
      )}
      <p className={i.ledger.ok ? 'ok' : 'error'} data-testid="incident-ledger">
        {i.ledger.ok ? 'Ledger verified' : 'Ledger verification FAILED'}: {i.ledger.message}.
        Entries {i.ledger.entries.join(', ')}
        {i.ledger.allSigned ? ', all signed.' : ', not all signed yet.'}
      </p>
    </section>
  );
}

/** Calls and approvals as plain sentences, newest first. */
export function ActivityTable({
  items,
  onExplain,
}: {
  items: FeedItem[];
  onExplain: (eventId: string) => void;
}) {
  return (
    <table className="feed" data-testid="feed">
      <thead>
        <tr>
          <th>Time</th>
          <th>What your agent did</th>
          <th>SudoWall</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        {items.map((f) => {
          if (f.type === 'approval.resolved') {
            return (
              <tr key={f.seq} className={`row ${f.resultingAction}`}>
                <td>{time(f.ts)}</td>
                <td>Your decision on a paused call</td>
                <td>
                  <span className={`badge ${f.resultingAction}`}>{f.outcome}</span>
                </td>
                <td>{approvalWords(f.outcome, f.resultingAction)}</td>
              </tr>
            );
          }
          const o = outcome(f);
          return (
            <tr key={f.seq} className={`row ${f.effective}`}>
              <td>{time(f.ts)}</td>
              <td>
                <span className="what">{visible(sentence(f))}</span>
                <small className="mono tool-id">
                  {f.server}/{f.tool}
                </small>
              </td>
              <td>
                <span className={`badge ${o.tone}`}>{o.label}</span>
              </td>
              <td>
                {visible(plainReason(f.reason))}{' '}
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
        })}
      </tbody>
    </table>
  );
}

/** A command with a copy button. */
export function Command({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command">
      <code>{cmd}</code>
      <button
        type="button"
        className="copy"
        onClick={() => {
          void navigator.clipboard
            .writeText(cmd)
            .then(() => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 1500);
            })
            .catch(() => {
              setCopied(false);
            });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Watching only (observe) or protecting (enforce), with the switch when it can be changed. */
export function ModeBanner({
  product,
  api,
  onChanged,
}: {
  product: Product;
  api: Api;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { mode, canChangeMode, path } = product.config;
  const protecting = mode === 'enforce';
  const change = (next: 'observe' | 'enforce') => {
    setBusy(true);
    setNote(null);
    api
      .setMode(next)
      .then(() => {
        setNote(
          'Saved. Restart Claude Code, Claude Desktop or Cursor so the gate starts with the new setting.',
        );
        onChanged();
      })
      .catch((e: unknown) => {
        setNote(`Not changed: ${(e as Error).message}`);
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <section
      className={`mode ${protecting ? 'on' : 'off'}`}
      aria-label="Protection"
      data-testid="mode"
    >
      <div>
        <strong>{protecting ? 'Protecting' : 'Watching only'}</strong>
        <p>
          {protecting
            ? 'Risky actions wait for your decision and leaks are blocked.'
            : 'SudoWall records every action and shows what it would do, but stops nothing yet.'}
        </p>
        {note !== null && <p className="note-line">{note}</p>}
      </div>
      {canChangeMode ? (
        <button
          type="button"
          className={protecting ? 'secondary' : 'approve'}
          disabled={busy}
          onClick={() => {
            change(protecting ? 'observe' : 'enforce');
          }}
        >
          {protecting ? 'Switch to watching only' : 'Turn on protection'}
        </button>
      ) : (
        <p className="muted small">
          {path === null
            ? 'No config yet: run npx sudowall protect --apply.'
            : 'This run’s setting is fixed.'}
        </p>
      )}
    </section>
  );
}

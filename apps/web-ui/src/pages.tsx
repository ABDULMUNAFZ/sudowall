import { useEffect, useRef, useState } from 'react';
import type { Api, FeedItem, Incident, Product, State, VerifyResult } from './api.js';
import {
  ActivityTable,
  Command,
  IncidentView,
  ModeBanner,
  PendingCard,
  time,
} from './components.js';
import { outcome, plainReason, sentence } from './describe.js';
import { count, ledgerSummary, visible } from './text.js';

const DOCS = 'https://github.com/ABDULMUNAFZ/sudowall/blob/main/docs';

export interface PageProps {
  api: Api;
  state: State | null;
  product: Product | null;
  refresh: () => void;
  go: (route: string) => void;
}

type Call = Extract<FeedItem, { type: 'tool.call' }>;
const calls = (s: State | null): Call[] =>
  (s?.feed ?? []).filter((f): f is Call => f.type === 'tool.call');

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <span className="n">{n}</span>
      <span className="l">{label}</span>
    </div>
  );
}

function PendingList({ api, state, refresh }: Pick<PageProps, 'api' | 'state' | 'refresh'>) {
  if (state === null) return null;
  if (state.pending.length === 0) return <p className="muted">Nothing is waiting for you.</p>;
  return (
    <div className="cards">
      {state.pending.map((a) => (
        <PendingCard key={a.id} a={a} now={state.now} api={api} onDone={refresh} />
      ))}
    </div>
  );
}

export function Overview({ api, state, product, refresh, go }: PageProps) {
  const recent = calls(state);
  const act = product?.activity;
  const watching = product?.config.mode !== 'enforce';
  const blocked =
    act === null || act === undefined ? 0 : act.observe.wouldBlock + act.enforce.blocked;
  const asked = act === null || act === undefined ? 0 : act.observe.wouldAsk + act.enforce.asked;
  const total = act?.calls ?? recent.length;
  const highlights = recent.filter((f) => f.verdict !== 'allow').slice(0, 5);
  return (
    <>
      <header className="page-head">
        <h1>Overview</h1>
        <p className="about" data-testid="about">
          Every tool call your AI agent makes through the gate is checked here. Risky ones wait for
          your decision, and everything is kept in a tamper-evident record.
        </p>
      </header>
      {product !== null && <ModeBanner product={product} api={api} onChanged={refresh} />}

      <section aria-labelledby="stats-h">
        <h2 id="stats-h">Last {act?.days ?? 7} days</h2>
        <div className="stats">
          <Stat n={total} label="actions checked" />
          <Stat n={blocked} label={watching ? 'would have been blocked' : 'blocked'} tone="block" />
          <Stat n={asked} label={watching ? 'would have asked you' : 'paused for you'} tone="ask" />
          <Stat n={Math.max(0, total - blocked - asked)} label="allowed" tone="allow" />
        </div>
      </section>

      <section aria-labelledby="pending-h">
        <h2 id="pending-h">
          Waiting for you <span className="count">{state?.pending.length ?? 0}</span>
        </h2>
        <PendingList api={api} state={state} refresh={refresh} />
      </section>

      <section aria-labelledby="hl-h">
        <h2 id="hl-h">What SudoWall stopped or questioned</h2>
        {highlights.length === 0 ? (
          <p className="muted">
            Nothing risky yet. Your agent&rsquo;s actions show up here when one needs a second look.
          </p>
        ) : (
          <ul className="highlights">
            {highlights.map((f) => {
              const o = outcome(f);
              return (
                <li key={f.seq}>
                  <span className={`badge ${o.tone}`}>{o.label}</span>
                  <span className="what">{visible(sentence(f))}</span>
                  <span className="muted">{visible(plainReason(f.reason))}</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      go(`incident/${f.eventId}`);
                    }}
                  >
                    Explain
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <button
          type="button"
          className="link"
          onClick={() => {
            go('activity');
          }}
        >
          See all activity
        </button>
      </section>

      <section aria-labelledby="ledger-mini-h">
        <h2 id="ledger-mini-h">Record</h2>
        <p data-testid="ledger-summary">
          {ledgerSummary(state?.ledger.entries ?? 0, state?.ledger.lastCheckpointSeq ?? null)}
        </p>
      </section>
    </>
  );
}

export function Activity({ state, go }: PageProps) {
  const [filter, setFilter] = useState<'all' | 'block' | 'ask' | 'allow'>('all');
  const items = (state?.feed ?? []).filter((f) =>
    filter === 'all'
      ? true
      : f.type === 'tool.call'
        ? outcome(f).tone === filter
        : f.resultingAction === filter,
  );
  return (
    <>
      <header className="page-head">
        <h1>Activity</h1>
        <p className="muted">
          Every action your agent took through the gate, newest first. Explain shows where each
          value came from.
        </p>
      </header>
      <div className="filters" role="group" aria-label="Show">
        {(
          [
            ['all', 'Everything'],
            ['block', 'Blocked'],
            ['ask', 'Paused or asked'],
            ['allow', 'Allowed'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={filter === k ? 'chip on' : 'chip'}
            aria-pressed={filter === k}
            onClick={() => {
              setFilter(k);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {state !== null && state.feed.length === 0 && (
        <p className="muted">No actions yet. They appear here as your agent works.</p>
      )}
      <div className="table-wrap">
        <ActivityTable
          items={items}
          onExplain={(id) => {
            go(`incident/${id}`);
          }}
        />
      </div>
    </>
  );
}

export function Approvals({ api, state, refresh }: PageProps) {
  const done = (state?.recentApprovals ?? []).filter((a) => a.status !== 'pending');
  return (
    <>
      <header className="page-head">
        <h1>Approvals</h1>
        <p className="muted">
          Actions SudoWall paused for you. Approve runs exactly the call shown; anything you do not
          decide in time is denied.
        </p>
      </header>
      <section aria-labelledby="pending-h">
        <h2 id="pending-h">
          Waiting for you <span className="count">{state?.pending.length ?? 0}</span>
        </h2>
        <PendingList api={api} state={state} refresh={refresh} />
      </section>
      <section aria-labelledby="history-h">
        <h2 id="history-h">Decided</h2>
        {done.length === 0 ? (
          <p className="muted">No decisions yet.</p>
        ) : (
          <ul className="list">
            {done.map((a) => (
              <li key={a.id}>
                <span className={`badge ${a.status === 'approved' ? 'allow' : 'block'}`}>
                  {a.status}
                </span>
                <span className="mono">
                  {a.serverId}/{a.tool}
                </span>
                <span className="muted">
                  {a.resolvedAt === null ? '' : time(a.resolvedAt)}
                  {a.channel === null ? '' : ` in the ${a.channel}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function Agents({ product }: PageProps) {
  const agents = product?.agents;
  return (
    <>
      <header className="page-head">
        <h1>Your agents</h1>
        <p className="muted">
          The MCP servers configured in Claude Code, Claude Desktop and Cursor on this computer, and
          whether each one runs through SudoWall.
        </p>
      </header>
      {agents === undefined || product === null ? (
        <p className="muted">Loading…</p>
      ) : 'error' in agents ? (
        <p className="error">Could not read a client config: {agents.error}</p>
      ) : (
        <>
          {agents.clients.length === 0 && (
            <p className="muted">No Claude Code, Claude Desktop or Cursor config found.</p>
          )}
          {agents.clients.map((c) => (
            <section key={c.file} className="card agent">
              <header>
                <h2>{c.client}</h2>
                <span className="muted mono small">{c.file}</span>
              </header>
              {c.servers.length === 0 ? (
                <p className="muted">No MCP servers.</p>
              ) : (
                <ul className="list">
                  {c.servers.map((s) => (
                    <li key={s.name}>
                      <span
                        className={`badge ${s.state === 'protected' ? 'allow' : s.state === 'not protected' ? 'ask' : 'block'}`}
                      >
                        {s.state}
                      </span>
                      <strong>{s.name}</strong>
                      {s.remote && <span className="tag">remote</span>}
                      <span className="mono small muted">{visible(s.detail)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          {agents.notFound.length > 0 && (
            <p className="muted">Not found on this computer: {agents.notFound.join(', ')}.</p>
          )}
          <section aria-labelledby="agents-how-h">
            <h2 id="agents-how-h">Change it</h2>
            <p>See what would change, then apply it (each file is backed up first):</p>
            <Command cmd="npx sudowall protect" />
            <Command cmd="npx sudowall protect --apply" />
            <p>Undo, restoring every original entry exactly:</p>
            <Command cmd="npx sudowall unprotect --apply" />
            <p className="muted">Restart the app afterwards so it starts the servers again.</p>
          </section>
        </>
      )}
    </>
  );
}

const ACTION_TITLE: Record<string, string> = {
  block: 'Blocked',
  ask: 'Asks you first',
  allow: 'Allowed',
};

export function Policy({ api, product, refresh }: PageProps) {
  const p = product?.policy;
  return (
    <>
      <header className="page-head">
        <h1>Policy</h1>
        <p className="muted">
          The fixed rules SudoWall applies. No AI decides: the same call always gets the same
          answer, with a reason.
        </p>
      </header>
      {product !== null && <ModeBanner product={product} api={api} onChanged={refresh} />}
      {p === null || p === undefined ? (
        <p className="muted">
          No policy loaded. <code>npx sudowall protect --apply</code> creates one.
        </p>
      ) : 'error' in p ? (
        <p className="error">The policy file has a problem: {p.error}</p>
      ) : (
        <>
          <p>
            Using <strong>{p.name}</strong> <span className="mono small muted">{p.path}</span>.
            Anything no rule covers is <strong>{p.defaults.other}</strong>
            {p.defaults.sink !== p.defaults.other && (
              <>
                ; payment-style actions no rule covers are <strong>{p.defaults.sink}</strong>
              </>
            )}
            .
          </p>
          {(['block', 'ask', 'allow'] as const).map((action) => {
            const rules = p.rules.filter((r) => r.action === action);
            if (rules.length === 0) return null;
            return (
              <section key={action} aria-labelledby={`rules-${action}`}>
                <h2 id={`rules-${action}`}>
                  <span className={`badge ${action}`}>{ACTION_TITLE[action]}</span>{' '}
                  {count(rules.length, 'rule', 'rules')}
                </h2>
                <ul className="rules">
                  {rules.map((r) => (
                    <li key={r.id}>
                      <span>{r.reason}</span>
                      <small className="muted">
                        {r.appliesTo} · <span className="mono">{r.id}</span>
                      </small>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {p.lists.length > 0 && (
            <section aria-labelledby="lists-h">
              <h2 id="lists-h">Your lists</h2>
              <ul className="list">
                {p.lists.map((l) => (
                  <li key={l.id}>
                    <strong>{l.id}</strong>
                    <span className="muted">
                      {count(l.count, 'value', 'values')} ({l.kind})
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted">Edit them in the policy file above.</p>
            </section>
          )}
        </>
      )}
      <section aria-labelledby="templates-h">
        <h2 id="templates-h">Start from another template</h2>
        <p>
          <strong>everyday</strong> fits most setups; <strong>money-moving</strong> guards wallet
          payments; <strong>dodo-payments</strong> guards the Dodo Payments MCP server.
        </p>
        {(product?.integrations.templates ?? ['everyday']).map((t) => (
          <Command key={t} cmd={`npx sudowall init --template ${t} --force`} />
        ))}
      </section>
    </>
  );
}

export function Ledger({ api, state }: PageProps) {
  const [verify, setVerify] = useState<(VerifyResult & { at: number; entries0: number }) | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entries = state?.ledger.entries ?? 0;
  const run = () => {
    setBusy(true);
    setError(null);
    api
      .verify()
      .then((r) => {
        setVerify({ ...r, at: Date.now(), entries0: entries });
      })
      .catch((e: unknown) => {
        setError((e as Error).message);
      })
      .finally(() => {
        setBusy(false);
      });
  };
  // Check once on arrival, so the page never shows an old result as current.
  const first = useRef(true);
  useEffect(() => {
    if (first.current && state !== null) {
      first.current = false;
      run();
    }
  });
  const stale = verify !== null && verify.entries0 !== entries;
  return (
    <>
      <header className="page-head">
        <h1>Tamper-evident record</h1>
        <p className="muted">
          Every action and decision is written to a hash-chained ledger and signed with a key that
          stays on this computer. If anyone edits even one entry, verification names it.
        </p>
      </header>
      <p data-testid="ledger-summary">
        {ledgerSummary(entries, state?.ledger.lastCheckpointSeq ?? null)}
      </p>
      <button type="button" onClick={run} disabled={busy} data-testid="verify">
        {busy ? 'Checking…' : 'Check it now'}
      </button>
      {error !== null && <p className="error">{error}</p>}
      {verify !== null && (
        <p className={verify.ok ? 'ok' : 'error'} data-testid="verify-result">
          {verify.ok
            ? `Verified: ${count(verify.entries, 'entry', 'entries')}, ${count(verify.checkpoints, 'checkpoint', 'checkpoints')}, ${String(verify.unsignedTail)} not yet signed. Key ${verify.keyId}.`
            : `FAILED${verify.seq !== undefined ? ` at entry ${String(verify.seq)}` : ''}: ${verify.kind}: ${verify.message}`}
          {!verify.signerChecked && ' (signer not checked: no local signing key)'}
          {` Checked at ${time(verify.at)}.`}
        </p>
      )}
      {stale && <p className="muted">New entries since this check. Check again to include them.</p>}
      <section aria-labelledby="proves-h">
        <h2 id="proves-h">What it proves, and what it does not</h2>
        <ul className="plain">
          <li>It proves the record was not edited after it was written.</li>
          <li>It does not prove the agent behaved well; it shows exactly what it did.</li>
        </ul>
        <p>From a terminal, or to share with someone who has your public key:</p>
        <Command cmd="npx sudowall ledger verify" />
        <Command cmd="npx sudowall ledger export --out ledger.jsonl" />
      </section>
    </>
  );
}

function Integration({
  name,
  status,
  tone,
  children,
}: {
  name: string;
  status: string;
  tone: 'allow' | 'ask' | 'muted';
  children: React.ReactNode;
}) {
  return (
    <section className="card integration">
      <header>
        <h2>{name}</h2>
        <span className={`badge ${tone}`}>{status}</span>
      </header>
      {children}
    </section>
  );
}

export function Integrations({ product }: PageProps) {
  const i = product?.integrations;
  const agents = product !== null && 'clients' in product.agents ? product.agents : null;
  const protectedCount =
    agents?.clients.flatMap((c) => c.servers).filter((s) => s.state === 'protected').length ?? 0;
  const policyName =
    product?.policy !== null && product?.policy !== undefined && 'name' in product.policy
      ? product.policy.name
      : null;
  return (
    <>
      <header className="page-head">
        <h1>Integrations</h1>
        <p className="muted">What SudoWall works with, and what is set up on this computer.</p>
      </header>
      <div className="grid">
        <Integration
          name="Claude Code, Claude Desktop, Cursor"
          status={
            protectedCount > 0 ? `${String(protectedCount)} servers protected` : 'not protected yet'
          }
          tone={protectedCount > 0 ? 'allow' : 'ask'}
        >
          <p>
            <code>protect</code> finds the MCP servers in these apps and runs each one through the
            gate, local or remote.
          </p>
          <Command cmd="npx sudowall protect --apply" />
        </Integration>
        <Integration
          name="Dodo Payments"
          status={
            policyName === 'dodo-payments'
              ? 'policy active'
              : i?.dodoPayments === true
                ? 'server found'
                : 'available'
          }
          tone={policyName === 'dodo-payments' ? 'allow' : 'muted'}
        >
          <p>
            Reads the payment code your agent writes for the Dodo Payments MCP server: refunds and
            changes ask you; a change using an email or URL from a support ticket is blocked.
          </p>
          <Command cmd="npx sudowall init --template dodo-payments --force" />
          <a href={`${DOCS}/integrations/dodo-payments.md`} target="_blank" rel="noreferrer">
            Setup guide
          </a>
        </Integration>
        <Integration
          name="viaSocket and remote servers"
          status={
            (i?.remoteServers ?? 0) > 0
              ? `${String(i?.remoteServers ?? 0)} remote ${i?.remoteServers === 1 ? 'server' : 'servers'}${i?.viaSocket === true ? ', viaSocket found' : ''}`
              : 'available'
          }
          tone={(i?.remoteServers ?? 0) > 0 ? 'allow' : 'muted'}
        >
          <p>
            Remote MCP servers (viaSocket&rsquo;s 2,500+ apps, Notion, Linear) run through the gate
            with a pinned bridge; credentials stay out of command lines.
          </p>
          <a href={`${DOCS}/integrations/remote-servers.md`} target="_blank" rel="noreferrer">
            How it works
          </a>
        </Integration>
        <Integration
          name="TigerGraph"
          status={i?.tigergraph.configured === true ? 'connected' : 'optional, not set up'}
          tone={i?.tigergraph.configured === true ? 'allow' : 'muted'}
        >
          <p>
            Runs incident forensics on a graph: which untrusted source a value came from and which
            other actions it reached. Works locally without it; nothing is sent unless you set it
            up.
          </p>
          <Command cmd="npx sudowall graph sync" />
          <a href={`${DOCS}/graph.md`} target="_blank" rel="noreferrer">
            Set up TigerGraph
          </a>
        </Integration>
        <Integration
          name="Wallets (EVM)"
          status={policyName === 'money-moving' ? 'policy active' : 'available'}
          tone={policyName === 'money-moving' ? 'allow' : 'muted'}
        >
          <p>
            Catches payments to addresses copied from emails and lookalikes of addresses you trust
            (address poisoning). Test chains only until a security review.
          </p>
          <Command cmd="npx sudowall init --template money-moving --force" />
        </Integration>
      </div>
    </>
  );
}

export function IncidentPage({ api, go, id }: PageProps & { id: string }) {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .incident(id)
      .then((i) => {
        if (live) setIncident(i);
      })
      .catch((e: unknown) => {
        if (live) setError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [api, id]);
  return (
    <>
      <header className="page-head">
        <button
          type="button"
          className="link"
          onClick={() => {
            go('activity');
          }}
        >
          ← Activity
        </button>
        <h1>Explain a decision</h1>
      </header>
      {error !== null && <p className="error">{error}</p>}
      {incident === null && error === null && <p className="muted">Loading…</p>}
      {incident !== null && <IncidentView i={incident} />}
    </>
  );
}

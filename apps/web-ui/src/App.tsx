import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Api, takeToken, type Product, type State } from './api.js';
import {
  Activity,
  Agents,
  Approvals,
  IncidentPage,
  Integrations,
  Ledger,
  Overview,
  Policy,
  type PageProps,
} from './pages.js';

const POLL_MS = 1000;
/** Product context (config, policy, client configs) changes rarely; read it less often. */
const PRODUCT_POLL_MS = 5000;

const NAV = [
  ['', 'Overview'],
  ['activity', 'Activity'],
  ['approvals', 'Approvals'],
  ['agents', 'Your agents'],
  ['policy', 'Policy'],
  ['ledger', 'Record'],
  ['integrations', 'Integrations'],
] as const;

/** The route is the URL fragment: `#/activity`, `#/incident/<id>`; none is the overview. */
const routeFromHash = () => window.location.hash.replace(/^#\/?/, '');

function Mark() {
  return <img src="brand/mark-white.png" alt="" className="mark-icon" width="34" height="34" />;
}

export function App() {
  const token = useMemo(takeToken, []);
  const api = useMemo(() => (token === null ? null : new Api(token)), [token]);
  const [state, setState] = useState<State | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [productError, setProductError] = useState<string | null>(null);
  const [route, setRoute] = useState(routeFromHash);
  // Polls never overlap: a tick is skipped while the previous request is in flight, and an answer
  // older than one already shown (a manual refresh raced a tick) is dropped.
  const poll = useRef({ seq: 0, shown: 0, busy: false, abort: new AbortController() });
  const productPoll = useRef({ seq: 0, shown: 0, busy: false });

  useEffect(() => {
    const on = () => {
      setRoute(routeFromHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('hashchange', on);
    };
  }, []);

  const refresh = useCallback(
    (force = false) => {
      if (api === null) return;
      const pl = poll.current;
      if (pl.busy && !force) return;
      pl.busy = true;
      const seq = ++pl.seq;
      api
        .state(pl.abort.signal)
        .then((s) => {
          if (seq < pl.shown) return;
          pl.shown = seq;
          setState(s);
          setError(null);
        })
        .catch((e: unknown) => {
          if ((e as Error).name === 'AbortError' || seq < pl.shown) return;
          setError((e as Error).message);
        })
        .finally(() => {
          if (seq === pl.seq) pl.busy = false;
        });
    },
    [api],
  );

  const refreshProduct = useCallback(
    (force = false) => {
      if (api === null) return;
      const pl = productPoll.current;
      if (pl.busy && !force) return;
      pl.busy = true;
      const seq = ++pl.seq;
      api
        .product(poll.current.abort.signal)
        .then((p) => {
          if (seq < pl.shown) return;
          pl.shown = seq;
          setProduct(p);
          setProductError(null);
        })
        .catch((e: unknown) => {
          if ((e as Error).name === 'AbortError' || seq < pl.shown) return;
          // The pages still work from decisions and approvals; say the settings may be stale.
          setProductError((e as Error).message);
        })
        .finally(() => {
          if (seq === pl.seq) pl.busy = false;
        });
    },
    [api],
  );

  useEffect(() => {
    const pl = poll.current;
    refresh();
    refreshProduct();
    const t = setInterval(refresh, POLL_MS);
    const p = setInterval(refreshProduct, PRODUCT_POLL_MS);
    return () => {
      clearInterval(t);
      clearInterval(p);
      pl.abort.abort();
      pl.abort = new AbortController();
    };
  }, [refresh, refreshProduct]);

  if (api === null) {
    return (
      <main className="empty">
        <h1>SudoWall</h1>
        <p>
          Open the address printed by <code>sudowall ui</code>; it contains the access token.
        </p>
      </main>
    );
  }

  const go = (r: string) => {
    window.location.hash = r === '' ? '' : `/${r}`;
    if (r === '') {
      // An empty fragment leaves "#" behind; keep the address clean.
      history.replaceState(null, '', window.location.pathname);
      setRoute('');
    }
  };
  const props: PageProps = {
    api,
    state,
    product,
    refresh: () => {
      refresh(true);
      refreshProduct(true);
    },
    go,
  };
  const pending = state?.pending.length ?? 0;
  const top = route.split('/')[0] ?? '';
  const incident = /^incident\/([0-9a-f-]{36})$/.exec(route);

  let page;
  if (incident !== null) page = <IncidentPage {...props} id={incident[1] ?? ''} />;
  else if (top === 'activity') page = <Activity {...props} />;
  else if (top === 'approvals') page = <Approvals {...props} />;
  else if (top === 'agents') page = <Agents {...props} />;
  else if (top === 'policy') page = <Policy {...props} />;
  else if (top === 'ledger') page = <Ledger {...props} />;
  else if (top === 'integrations') page = <Integrations {...props} />;
  else page = <Overview {...props} />;

  return (
    <div className="shell">
      <nav className="side" aria-label="SudoWall">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go('');
          }}
        >
          <Mark />
          <span>
            <img
              src="brand/wordmark-white.png"
              alt="SudoWall"
              className="wordmark"
              width="118"
              height="20"
            />
            <small>Nothing moves until it&rsquo;s checked.</small>
          </span>
        </a>
        <ul>
          {NAV.map(([r, label]) => {
            const active =
              r === '' ? top === '' : top === r || (r === 'activity' && incident !== null);
            return (
              <li key={r}>
                <a
                  href={r === '' ? '#' : `#/${r}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    go(r);
                  }}
                >
                  {label}
                  {r === 'approvals' && pending > 0 && <span className="count">{pending}</span>}
                </a>
              </li>
            );
          })}
        </ul>
        {product !== null && (
          <p className={`side-mode ${product.config.mode === 'enforce' ? 'on' : 'off'}`}>
            {product.config.mode === 'enforce' ? 'Protecting' : 'Watching only'}
            <small>v{product.version}</small>
          </p>
        )}
      </nav>
      <main>
        {error !== null && <p className="error banner">{error}</p>}
        {productError !== null && product !== null && (
          <p className="error banner">
            Settings could not be refreshed ({productError}); what is shown may be out of date.
          </p>
        )}
        {pending > 0 && top !== 'approvals' && top !== '' && (
          <button
            type="button"
            className="pending-strip"
            onClick={() => {
              go('approvals');
            }}
          >
            {pending === 1 ? '1 action is' : `${String(pending)} actions are`} waiting for your
            decision
          </button>
        )}
        {page}
      </main>
    </div>
  );
}

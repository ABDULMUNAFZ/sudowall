/**
 * One polled resource. Ticks never overlap: a tick is skipped while a request is in flight,
 * unless it is forced (a manual refresh). An answer, or an error, from a request older than the
 * newest answer already shown is dropped, so a slow old response can never overwrite a newer one.
 */
export interface Poller {
  /** Starts a request, unless one is in flight and `force` is false. */
  tick(force?: boolean): void;
}

export interface PollerOptions<T> {
  fetch: () => Promise<T>;
  onValue: (value: T) => void;
  onError: (error: Error) => void;
}

export function createPoller<T>(o: PollerOptions<T>): Poller {
  let started = 0;
  let shown = 0;
  let busy = false;
  return {
    tick(force = false) {
      if (busy && !force) return;
      busy = true;
      const seq = ++started;
      o.fetch()
        .then((v) => {
          if (seq < shown) return;
          shown = seq;
          o.onValue(v);
        })
        .catch((e: unknown) => {
          if ((e as Error).name === 'AbortError' || seq < shown) return;
          o.onError(e as Error);
        })
        .finally(() => {
          if (seq === started) busy = false;
        });
    },
  };
}

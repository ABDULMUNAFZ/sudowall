import { describe, expect, it } from 'vitest';
import { createPoller } from './poll.js';

/** A request the test resolves or rejects by hand, in any order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets the poller's promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function harness() {
  const requests: ReturnType<typeof deferred<string>>[] = [];
  const shown: string[] = [];
  const errors: string[] = [];
  const poller = createPoller({
    fetch: () => {
      const d = deferred<string>();
      requests.push(d);
      return d.promise;
    },
    onValue: (v) => shown.push(v),
    onError: (e) => errors.push(e.message),
  });
  return { poller, requests, shown, errors };
}

describe('poll ordering', () => {
  it('a slow older response cannot overwrite a newer one', async () => {
    const h = harness();
    h.poller.tick(); // a timer tick: request 1, slow
    h.poller.tick(true); // a manual refresh while it is in flight: request 2
    expect(h.requests).toHaveLength(2);
    h.requests[1]?.resolve('new');
    await settle();
    h.requests[0]?.resolve('old');
    await settle();
    expect(h.shown).toEqual(['new']);
  });

  it('a slow older failure does not replace a newer answer with an error', async () => {
    const h = harness();
    h.poller.tick();
    h.poller.tick(true);
    h.requests[1]?.resolve('new');
    await settle();
    h.requests[0]?.reject(new Error('timed out'));
    await settle();
    expect(h.shown).toEqual(['new']);
    expect(h.errors).toEqual([]);
  });

  it('answers that arrive in order are all shown', async () => {
    const h = harness();
    h.poller.tick();
    h.poller.tick(true);
    h.requests[0]?.resolve('first');
    await settle();
    h.requests[1]?.resolve('second');
    await settle();
    expect(h.shown).toEqual(['first', 'second']);
  });

  it('skips timer ticks while a request is in flight, then polls again', async () => {
    const h = harness();
    h.poller.tick();
    h.poller.tick();
    h.poller.tick();
    expect(h.requests).toHaveLength(1);
    h.requests[0]?.resolve('a');
    await settle();
    h.poller.tick();
    expect(h.requests).toHaveLength(2);
  });

  it('an aborted request is not reported as an error', async () => {
    const h = harness();
    h.poller.tick();
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    h.requests[0]?.reject(abort);
    await settle();
    expect(h.errors).toEqual([]);
  });

  it('a newer error is shown, and a later answer still replaces it', async () => {
    const h = harness();
    h.poller.tick();
    h.requests[0]?.reject(new Error('gateway down'));
    await settle();
    h.poller.tick();
    h.requests[1]?.resolve('back');
    await settle();
    expect(h.errors).toEqual(['gateway down']);
    expect(h.shown).toEqual(['back']);
  });
});

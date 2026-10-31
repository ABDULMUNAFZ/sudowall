import type { FeedItem } from './api.js';

type Call = Extract<FeedItem, { type: 'tool.call' }>;

const words = (tool: string) => tool.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

/**
 * One plain sentence for what the agent tried to do. Values are shown in full (never shortened):
 * a shortened address is exactly what address poisoning relies on.
 */
export function sentence(f: Call): string {
  const t = f.tool.toLowerCase();
  const s = Object.fromEntries(f.summary.map((x) => [x.name, x.value]));
  const to = s['to'] ?? s['recipient'] ?? s['email'] ?? s['address'];
  const amount = s['amount'] ?? s['value'];
  const target = s['path'] ?? s['url'] ?? s['query'] ?? s['repoName'] ?? s['channel'];
  if (
    /send_funds|transfer|^pay|payment|refund/.test(t) &&
    (to !== undefined || amount !== undefined)
  ) {
    return `Send ${amount ?? 'money'}${to === undefined ? '' : ` to ${to}`}`;
  }
  if (/send|mail|message|post|reply|forward|invite|share/.test(t)) {
    const dest = to ?? s['channel'];
    return `${words(f.tool).replace(/^\w/, (c) => c.toUpperCase())}${dest === undefined ? '' : ` to ${dest}`}`;
  }
  if (/exec|command|shell|terminal/.test(t) && s['command'] !== undefined) {
    return `Run the command ${s['command']}`;
  }
  if (t === 'execute') return 'Run code the agent wrote';
  if (/^(read|get|list|search|fetch|find|view|query|describe|ask)/.test(t)) {
    return `${words(f.tool).replace(/^\w/, (c) => c.toUpperCase())}${target === undefined ? '' : `: ${target}`}`;
  }
  const first = f.summary[0];
  return `${words(f.tool).replace(/^\w/, (c) => c.toUpperCase())}${first === undefined ? '' : `: ${first.value}`}`;
}

export type Tone = 'allow' | 'ask' | 'block';

/** How an allowed (or approved) call actually ended, from its `tool.result`. */
function ran(result: string | null): string {
  switch (result) {
    case null:
      return 'still running';
    case 'ok':
      return 'it ran';
    case 'tool-error':
      return 'it ran but the tool reported an error';
    case 'protocol-error':
      return 'it failed (the server returned an error)';
    case 'timeout':
      return 'it timed out';
    case 'cancelled':
      return 'it was cancelled';
    case 'denied':
      return 'you denied it';
    default:
      return 'it did not run';
  }
}

/**
 * What happened to the call, in words a person uses: the policy's verdict and, for calls that
 * were let through, whether they actually ran (a verdict is not an execution).
 */
export function outcome(f: Call): { label: string; tone: Tone } {
  const watching = f.mode === 'observe';
  const result = f.result ?? null;
  if (f.verdict === 'block')
    return {
      label: watching ? `Would block (watching only; ${ran(result)})` : 'Blocked',
      tone: 'block',
    };
  if (f.verdict === 'ask') {
    if (watching) return { label: `Would ask you (watching only; ${ran(result)})`, tone: 'ask' };
    if (result === null) return { label: 'Paused for you', tone: 'ask' };
    return { label: `Paused for you; ${ran(result)}`, tone: 'ask' };
  }
  return {
    label: result === 'ok' ? 'Allowed' : `Allowed; ${ran(result)}`,
    // Tone follows the policy verdict (the Activity filters use it); the label says how it ran.
    tone: 'allow',
  };
}

/** The policy's reason without rule ids ("ask-first-seen: First payment..." -> "First payment..."). */
export function plainReason(reason: string): string {
  if (/^No rule matched; default for other calls is allow\.?$/.test(reason)) {
    return 'Nothing risky here.';
  }
  return reason.replace(/(^|\.\s+)[a-z0-9]+(?:-[a-z0-9]+)+:\s/g, '$1');
}

/** "approved" / "denied" / "expired" -> a short sentence about the person's decision. */
export function approvalWords(outcomeText: string, resultingAction: string): string {
  if (outcomeText === 'approved') return 'You approved it, so it ran.';
  if (outcomeText === 'denied') return 'You denied it, so it never ran.';
  return resultingAction === 'allow'
    ? `${outcomeText}: it ran.`
    : `${outcomeText}: nobody decided in time, so it never ran.`;
}

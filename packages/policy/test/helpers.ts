import type {
  ArgumentMatch,
  JsonObject,
  NearKind,
  ProvenanceReport,
  TrustLabel,
} from '@tortoisegate/core';
import { compilePolicy, type CompiledPolicy, type PolicyStateView } from '../src/index.js';

export const SRC = '0e7b5b2a-3f7e-4c1a-9b8e-2d5c6a7f8e91';

// EIP-55 test vectors (checksummed mixed case).
export const ADDR = {
  trusted: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  other: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  blocked: '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
} as const;

export const BASE = {
  schema: 'tortoise-gate/policy@1',
  name: 'test',
  version: 1,
  lists: {
    trusted: { kind: 'evm-address', values: [ADDR.trusted] },
    staff: { kind: 'email', values: ['Ops@Example.com'] },
  },
  sinks: [
    {
      id: 'pay',
      tool: 'send_funds',
      args: {
        to: { path: '/to', kind: 'evm-address' },
        amount: { path: '/amount', kind: 'amount', unit: { value: 'ETH' } },
      },
    },
    { id: 'mail', tool: 'send_email', args: { rcpt: { path: '/to', kind: 'email' } } },
  ],
};

export function policy(rules: unknown[], extra: Record<string, unknown> = {}): CompiledPolicy {
  return compilePolicy({ ...BASE, ...extra, rules });
}

export const pay = (args: JsonObject) => ({ serverId: 'evm', tool: 'send_funds', arguments: args });
export const mail = (args: JsonObject) => ({
  serverId: 'mail',
  tool: 'send_email',
  arguments: args,
});
export const other = (args: JsonObject = {}) => ({
  serverId: 'files',
  tool: 'fetch',
  arguments: args,
});

export const EMPTY: ProvenanceReport = { sessionTainted: false, values: [], matches: [] };

export function hit(
  argPath: string,
  label: TrustLabel,
  matchType: 'exact' | 'normalized' | NearKind,
): ArgumentMatch {
  const base = {
    argPath,
    valueKind: 'evm-address' as const,
    sourceLabel: label,
    evidence: [{ sourceId: SRC, start: 10, end: 52 }],
  };
  return matchType === 'exact' || matchType === 'normalized'
    ? { ...base, matchType }
    : { ...base, matchType: 'near', nearKind: matchType };
}

export function report(matches: ArgumentMatch[], sessionTainted = false): ProvenanceReport {
  return { sessionTainted, values: [], matches };
}

export class MemoryState implements PolicyStateView {
  readonly seen = new Set<string>();
  hasExecuted(policyName: string, sinkId: string, arg: string, value: string): boolean {
    return this.seen.has(`${policyName}\0${sinkId}\0${arg}\0${value}`);
  }
  add(policyName: string, sinkId: string, arg: string, value: string): this {
    this.seen.add(`${policyName}\0${sinkId}\0${arg}\0${value}`);
    return this;
  }
}

export const describe_ = (id: string) => (id === SRC ? '`mail/read_email`' : undefined);

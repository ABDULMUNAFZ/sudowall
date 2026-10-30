import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseLossless, tgjson, type JsonObject } from '@sudowall/core';
import { Redactor, isSecretKey, prepareForStorage, redactString } from '../src/index.js';
import { toolCall } from './helpers.js';

const key = randomBytes(32);
const redactor = (rules: ConstructorParameters<typeof Redactor>[0]['rules'] = []) =>
  new Redactor({ rules, userVersion: 1, hmacKey: key });

const SECRETS = [
  'ghp_' + 'A'.repeat(36),
  'github_pat_' + 'b'.repeat(60),
  'sk-ant-' + 'c'.repeat(40),
  'xoxb-1234567890-abcdefghij',
  'AKIA' + 'Q'.repeat(16),
  'AIza' + 'd'.repeat(35),
  'sk_live_' + 'e'.repeat(24),
  // A JWT-shaped fixture, assembled at runtime so secret scanners do not flag the source.
  ['eyJ' + 'hbGciOiJub25lIn0', 'eyJ' + 'zdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJl'].join('.'),
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
  'Bearer abcdefghijklmnopqrstuvwxyz0123',
];

describe('redaction', () => {
  it('recognises secret-looking keys but not a currency "token"', () => {
    for (const k of [
      'password',
      'db_password',
      'clientSecret',
      'X-Api-Key',
      'privateKey',
      'access_token',
      'Authorization',
      'mnemonic',
      'Cookie',
    ])
      expect(isSecretKey(k), k).toBe(true);
    for (const k of ['token', 'to', 'amount', 'secretary', 'tokenId', 'keyword'])
      expect(isSecretKey(k), k).toBe(false);
  });

  it('removes secret-looking substrings anywhere in a string', () => {
    for (const s of SECRETS) {
      const out = redactString(`before ${s} after`);
      expect(out).toBe('before [redacted] after');
    }
    expect(redactString('send 0.1 ETH to 0x52908400098527886E0F7030069857D2E4169EE7')).toBe(
      'send 0.1 ETH to 0x52908400098527886E0F7030069857D2E4169EE7',
    );
  });

  it('HMACs values under secret keys (equal secrets give equal tags) and records paths', () => {
    const r = redactor();
    const ev = r.redactEvent(
      toolCall({
        password: 'hunter2',
        nested: { apiKey: 'hunter2' },
        note: `x ${SECRETS[0]}`,
        to: '0xabc',
      }),
    );
    expect(ev.type).toBe('tool.call');
    if (ev.type !== 'tool.call') return;
    const a = ev.arguments as Record<string, unknown>;
    expect(a['password']).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect((a['nested'] as Record<string, unknown>)['apiKey']).toBe(a['password']);
    expect(a['note']).toBe('x [redacted]');
    expect(a['to']).toBe('0xabc');
    expect(ev.redaction).toEqual({
      ruleVersion: 1001,
      applied: [
        { path: '/password', method: 'hmac-sha256' },
        { path: '/nested/apiKey', method: 'hmac-sha256' },
        { path: '/note', method: 'removed' },
      ],
    });
    expect(JSON.stringify(ev)).not.toContain('hunter2');
  });

  it('applies configured rules by server, tool and JSON Pointer', () => {
    const r = redactor([
      { server: 'evm', tool: 'send_*', target: 'arguments', path: '/memo', method: 'removed' },
    ]);
    const ev = r.redactEvent(toolCall({ memo: 'private note', to: '0x1' }));
    if (ev.type !== 'tool.call') throw new Error('type');
    expect(ev.arguments['memo']).toBe('[redacted]');
    expect(ev.redaction.applied).toEqual([{ path: '/memo', method: 'removed' }]);
  });

  it('never leaves a planted secret in the canonical output (property)', () => {
    const secret = fc.constantFrom(...SECRETS);
    const doc = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: 'small' },
        fc.string(),
        fc.integer(),
        fc.array(tie('node'), { maxLength: 3 }),
        fc.dictionary(fc.string({ maxLength: 6 }), tie('node'), { maxKeys: 3 }),
      ),
    })).node;
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 6 }), doc, { maxKeys: 4 }),
        secret,
        fc.string({ maxLength: 8 }),
        (base, s, pad) => {
          const args = {
            ...(base as JsonObject),
            planted: `${pad} ${s} ${pad}`,
            list: [{ password: s }],
          };
          const out = tgjson(r0.redactEvent(toolCall(args)));
          expect(out).not.toContain((s.split('\n')[0] ?? s).slice(4, 30));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('keeps lossless numbers and own __proto__ keys intact', () => {
    const args = parseLossless('{"__proto__":{"a":1},"amount":1.0}') as JsonObject;
    const ev = redactor().redactEvent(toolCall(args));
    expect(tgjson(ev)).toContain('"__proto__":{"a":1},"amount":1.0');
  });

  it('hashes the full redacted result and drops results over the storage limit', () => {
    const r = redactor();
    const call = toolCall({});
    const result = {
      schemaVersion: 1 as const,
      id: '00000000-0000-4000-8000-000000000009',
      ts: call.ts,
      sessionId: call.sessionId,
      type: 'tool.result' as const,
      callEventId: call.id,
      server: (call as unknown as { server: never }).server,
      tool: 'read',
      outcome: 'ok' as const,
      rawSha256: null,
      error: null,
      result: { content: [{ type: 'text', text: `token ${SECRETS[0]} ${'x'.repeat(2000)}` }] },
      redaction: { ruleVersion: 0, applied: [] },
      truncated: false,
      resultSha256: null,
      source: null,
      durationMs: 1,
    };
    const small = prepareForStorage(result, r, 4096);
    const big = prepareForStorage(result, r, 1024);
    if (small.type !== 'tool.result' || big.type !== 'tool.result') throw new Error('type');
    expect(JSON.stringify(small.result)).not.toContain(SECRETS[0]);
    expect(small.resultSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(big).toMatchObject({ result: null, truncated: true, resultSha256: small.resultSha256 });
    expect(small.redaction.applied).toEqual([{ path: '/content/0/text', method: 'removed' }]);
  });
});

const r0 = redactor();

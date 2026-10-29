#!/usr/bin/env node
// Minimal MCP stdio server for gateway tests. It writes raw protocol lines itself, so tests can
// check the exact bytes the gateway delivers. Speaks both the 2025-11-25 (initialize) and the
// 2026-07-28 (envelope + server/discover) eras.
//
// Env:
//   RECORD_FILE   append every received line, verbatim, to this file
//   TOOLS_PREFIX  prefix for tool names (to create or avoid collisions between instances)
//   CRASH_ON_START=1  exit immediately (restart backoff tests)
import { appendFileSync } from 'node:fs';

if (process.env.CRASH_ON_START === '1') process.exit(3);

const prefix = process.env.TOOLS_PREFIX ?? '';
const record = process.env.RECORD_FILE;
const tools = ['echo', 'slow', 'crash', 'huge', 'notify', 'sample'].map((n) => ({
  name: `${prefix}${n}`,
  description: `test tool ${n}`,
  inputSchema: { type: 'object' },
}));

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const modernFields = (msg) =>
  msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'] ? { resultType: 'complete' } : {};

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (record) appendFileSync(record, `${line}\n`);
    handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));

const waiting = new Map();

function handle(line) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notifications
  if (msg.method === undefined) {
    // A response to one of our own requests (sampling test).
    const done = waiting.get(msg.id);
    waiting.delete(msg.id);
    done?.(msg);
    return;
  }
  const reply = (result) =>
    send({ jsonrpc: '2.0', id: msg.id, result: { ...result, ...modernFields(msg) } });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: { listChanged: true }, tasks: {} },
        serverInfo: { name: 'raw-test-server', version: '1.0.0' },
      });
    case 'server/discover':
      return reply({
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: { listChanged: true } },
        ttlMs: 0,
        cacheScope: 'private',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '').slice(prefix.length);
      const args = msg.params?.arguments ?? {};
      if (name === 'echo')
        return reply({ content: [{ type: 'text', text: JSON.stringify(args) }] });
      if (name === 'slow') {
        setTimeout(
          () => reply({ content: [{ type: 'text', text: 'done' }] }),
          Number(args.ms ?? 200),
        );
        return;
      }
      if (name === 'crash') process.exit(7);
      if (name === 'huge')
        return reply({ content: [{ type: 'text', text: 'x'.repeat(Number(args.bytes ?? 1)) }] });
      if (name === 'sample') {
        // Ask the client to sample; report whatever answer came back.
        const sid = `s-${msg.id}`;
        waiting.set(sid, (answer) =>
          reply({ content: [{ type: 'text', text: JSON.stringify(answer) }] }),
        );
        send({
          jsonrpc: '2.0',
          id: sid,
          method: 'sampling/createMessage',
          params: { messages: [], maxTokens: 1 },
        });
        return;
      }
      if (name === 'notify') {
        const token = msg.params?._meta?.progressToken;
        if (token !== undefined) {
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: token, progress: 1, total: 2 },
          });
        }
        return reply({ content: [{ type: 'text', text: 'notified' }] });
      }
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: `unknown tool ${name}` },
      });
    }
    default:
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      });
  }
}

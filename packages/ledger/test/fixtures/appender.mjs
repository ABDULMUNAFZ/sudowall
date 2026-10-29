// Appends events to a shared ledger from a separate process (concurrency and crash tests).
//   node appender.mjs <dir> <count|forever> <tag>
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Ledger, loadOrCreateKeys } from '../../dist/index.js';

const [dir, countArg, tag] = process.argv.slice(2);
const ledger = Ledger.open({
  path: join(dir, 'ledger.db'),
  keys: loadOrCreateKeys(join(dir, 'keys')),
  checkpointEveryEntries: 16,
  busyTimeoutMs: 20000,
});
const count = countArg === 'forever' ? Infinity : Number(countArg);
let i = 0;
process.stdout.write('ready\n');
while (i < count) {
  ledger.append({
    schemaVersion: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    type: 'session.ended',
    reason: 'client-closed',
  });
  i++;
  if (i % 50 === 0) process.stdout.write(`${tag} ${i}\n`);
  if (i % 25 === 0) await new Promise((r) => setImmediate(r));
}
ledger.close();
process.stdout.write(`done ${tag}\n`);

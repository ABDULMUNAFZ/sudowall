// Records content in a shared provenance index from a separate process.
//   node observe.mjs <db path> <key hex> <iso time> <text>
import { openStateDb } from '@tortoisegate/ledger';
import { ProvenanceEngine } from '../../dist/index.js';

const [path, keyHex, at, text] = process.argv.slice(2);
const db = openStateDb(path);
const e = new ProvenanceEngine({
  db,
  key: Buffer.from(keyHex, 'hex'),
  trusted: [],
  windowSeconds: 86400,
});
e.observe({
  eventId: null,
  kind: 'tool-result',
  serverId: 'files',
  origin: 'read_text_file',
  content: { content: [{ type: 'text', text }] },
  observedAt: new Date(new Date(at).getTime() - 60_000),
});
db.close();

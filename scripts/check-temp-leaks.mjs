// Fails when a test run leaves SudoWall test directories in the OS temp folder.
//
//   node scripts/check-temp-leaks.mjs snapshot <file>   record what is there now
//   node scripts/check-temp-leaks.mjs compare <file>    fail if anything new appeared since
//
// Matches the prefixes tests and the CLI use for temporary directories: tg-, sw-, sudowall-
// (and the "tg smoke …" style names with spaces).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const OURS = /^(tg|sw|sudowall)[- ]/;
const [mode, file] = process.argv.slice(2);
if ((mode !== 'snapshot' && mode !== 'compare') || file === undefined) {
  console.error('usage: check-temp-leaks.mjs snapshot|compare <file>');
  process.exit(2);
}

const now = readdirSync(tmpdir()).filter((n) => OURS.test(n));
if (mode === 'snapshot') {
  writeFileSync(file, JSON.stringify(now));
  console.log(`check-temp-leaks: ${String(now.length)} matching entries in ${tmpdir()} before`);
  process.exit(0);
}
const before = new Set(JSON.parse(readFileSync(file, 'utf8')));
const added = now.filter((n) => !before.has(n)).sort();
if (added.length > 0) {
  console.error(
    `check-temp-leaks: ${String(added.length)} new entries left in ${tmpdir()}:\n` +
      added.map((n) => `  ${n}`).join('\n'),
  );
  process.exit(1);
}
console.log(`check-temp-leaks: nothing new in ${tmpdir()}`);

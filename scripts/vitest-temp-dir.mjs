// Vitest global setup shared by every package: the run gets its own temporary directory, and
// TMPDIR, TMP and TEMP point at it, so every `mkdtemp(join(tmpdir(), ...))` in a test (and in
// processes the tests start with the inherited environment) lands inside it. It is removed when
// the run ends, so test runs no longer fill the OS temp folder (`scripts/check-temp-leaks.mjs`
// checks this in CI). A process started with an explicit environment that leaves these out
// still uses the OS temp folder; such tests remove what they create themselves.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sudowall-test-run-'));
  const previous = { ...process.env };
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
  return () => {
    restore('TMPDIR', previous.TMPDIR);
    restore('TMP', previous.TMP);
    restore('TEMP', previous.TEMP);
    // Retries for Windows, where a just-closed SQLite file can stay locked for a moment.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
}

function restore(name, value) {
  if (value !== undefined) process.env[name] = value;
  else if (name === 'TMPDIR') delete process.env.TMPDIR;
  else if (name === 'TMP') delete process.env.TMP;
  else delete process.env.TEMP;
}

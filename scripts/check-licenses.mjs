// Fails if any installed dependency uses a licence outside the allowlist.
// Shipped (production) dependencies: permissive licences compatible with Apache-2.0 only.
// Dev-only tooling may also use MPL-2.0 (file-level copyleft); it is never distributed.
import { execFileSync } from 'node:child_process';

const ALLOWED = new Set([
  'Apache-2.0',
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Python-2.0',
  'Unlicense',
  'Zlib',
]);

// Packages whose package.json does not name an SPDX licence, reviewed by hand. Keyed by exact
// version, so an upgrade fails the check until someone reviews it again.
const REVIEWED = new Map([
  // package.json says "SEE LICENSE IN LICENSE" but ships no LICENSE file; README "License"
  // section: "This MCP server is licensed under the MIT License." Test-only dev dependencies.
  ['@modelcontextprotocol/server-everything@2.1.0', 'MIT'],
  ['@modelcontextprotocol/server-filesystem@2.1.0', 'MIT'],
  ['@modelcontextprotocol/server-memory@2.0.1', 'MIT'],
]);

const DEV_ONLY_EXTRA = new Set(['MPL-2.0']);

const isAllowed = (expr, allowed) =>
  expr
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/)
    .some((alt) => alt.split(/\s+AND\s+/).every((id) => allowed.has(id.trim())));

function check(scopeFlag, allowed) {
  const out = execFileSync('pnpm', ['licenses', 'list', '--json', '--recursive', scopeFlag], {
    encoding: 'utf8',
  });
  const byLicense = out.trim() === '' ? {} : JSON.parse(out);
  const bad = [];
  for (const [license, pkgs] of Object.entries(byLicense)) {
    if (isAllowed(license, allowed)) continue;
    for (const p of pkgs) {
      for (const v of p.versions ?? [p.version]) {
        const reviewed = REVIEWED.get(`${p.name}@${v}`);
        if (reviewed !== undefined && isAllowed(reviewed, allowed)) continue;
        bad.push(`${p.name}@${v}: ${license}`);
      }
    }
  }
  return { bad, types: Object.keys(byLicense).length };
}

const prod = check('--prod', ALLOWED);
const dev = check('--dev', new Set([...ALLOWED, ...DEV_ONLY_EXTRA]));
const bad = [...prod.bad.map((b) => `prod ${b}`), ...dev.bad.map((b) => `dev  ${b}`)];
if (bad.length > 0) {
  console.error(`Disallowed licences:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`Licence check passed (prod: ${prod.types} licence types, dev: ${dev.types}).`);

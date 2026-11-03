/**
 * The cases for the parser-based read check (ADR 0023, H1 update), in one module so the same
 * list can be run against another parser implementation (see docs/adr/0025-read-check-parser.md).
 * PROVEN must come back proven; NOT_PROVEN must come back not proven, which makes the call ask.
 */
export const RESOURCES = ['payments', 'refunds', 'customers'];
export const run = (body: string): string => `async function run(client) {\n${body}\n}`;

/**
 * Parser differentials. Dodo's server runs the code in Deno, which parses it again with its own
 * parser, so input that parsers may read differently must never be proven: HTML-like comments,
 * hashbangs, `using`, decorators, import attributes, unusual whitespace and line terminators,
 * and very long or deeply nested input. Anything our parser only gets through with errors is
 * also not proven.
 */
const READ = 'return client.payments.list();';

/** A proven-looking read padded to exactly `n` characters (the limit is 16,384). */
const ofLength = (n: number): string => {
  const base = run("return client.payments.list({ q: '' });");
  return base.replace("q: ''", `q: '${'x'.repeat(n - base.length)}'`);
};

/** Characters that are whitespace, line terminators or invisible in some parser or display. */
const ODD_CHARACTERS: readonly (readonly [string, string])[] = [
  ['a vertical tab', '\u000b'],
  ['a form feed', '\u000c'],
  ['a lone carriage return', '\r'],
  ['a next-line control (U+0085)', '\u0085'],
  ['a no-break space (U+00A0)', '\u00a0'],
  ['an ogham space mark (U+1680)', '\u1680'],
  ['a Mongolian vowel separator (U+180E)', '\u180e'],
  ['an en quad (U+2000)', '\u2000'],
  ['a hair space (U+200A)', '\u200a'],
  ['a zero-width space (U+200B)', '\u200b'],
  ['a line separator (U+2028)', '\u2028'],
  ['a paragraph separator (U+2029)', '\u2029'],
  ['a narrow no-break space (U+202F)', '\u202f'],
  ['a medium mathematical space (U+205F)', '\u205f'],
  ['a word joiner (U+2060)', '\u2060'],
  ['an ideographic space (U+3000)', '\u3000'],
  ['a byte order mark inside the code (U+FEFF)', '\ufeff'],
];

const DIFFERENTIAL: readonly (readonly [string, string])[] = [
  // HTML-like comments: comments in a script, operators or errors in a module.
  ['an HTML open comment after run', `${run(READ)}\n<!-- client.refunds.create({})`],
  ['an HTML open comment before run', `<!-- x\n${run(READ)}`],
  [
    'an HTML open comment inside a line',
    run('return client.payments.list(); <!-- client.refunds.create({});'),
  ],
  [
    'an HTML close comment at the start of a line',
    run('const a = await client.payments.list()\n--> client.refunds.create({})\nreturn a;'),
  ],
  [
    'an HTML close comment after a block comment',
    run(`/* a */ --> client.refunds.create({})\n${READ}`),
  ],
  // Hashbang
  ['a hashbang line', `#!/usr/bin/env -S deno run\n${run(READ)}`],
  ['a hashbang after a newline', `\n#!/usr/bin/env deno\n${run(READ)}`],
  ['a hashbang after a byte order mark', `\ufeff#!/usr/bin/env deno\n${run(READ)}`],
  // using declarations dispose of their value when the block ends, which calls a method on it.
  [
    'a using declaration of a read',
    run('using page = await client.payments.list();\nreturn page;'),
  ],
  ['an await using of a read', run('await using page = client.payments.list();\nreturn page;')],
  ['a top-level using', `using x = null;\n${run(READ)}`],
  ['using in a for-of', run(`for (using x of []) {}\n${READ}`)],
  // Decorators
  ['a decorator on run', `@readonly\n${run(READ)}`],
  ['a parameter decorator', `async function run(@inject client) { ${READ} }`],
  ['a decorated class in the body', run(`@d class A {}\n${READ}`)],
  // Import attributes and assertions
  [
    'a static import with attributes',
    `import data from './data.json' with { type: 'json' };\n${run(READ)}`,
  ],
  ['an import assertion', `import data from './data.json' assert { type: 'json' };\n${run(READ)}`],
  [
    'a dynamic import with attributes',
    run("const m = await import('./x.json', { with: { type: 'json' } });\nreturn m;"),
  ],
  [
    'a re-export with attributes',
    `${run(READ)}\nexport { default as x } from './x.json' with { type: 'json' };`,
  ],
  // Unusual whitespace and line terminators, between tokens, in a comment and in a string.
  ...ODD_CHARACTERS.flatMap(([label, ch]): (readonly [string, string])[] => [
    [`${label} between tokens`, run(`return${ch}client.payments.list();`)],
    [`${label} in a comment`, run(`// note${ch}${READ}`)],
    [`${label} in a string`, run(`return client.customers.retrieve('cus${ch}1');`)],
  ]),
  ['a byte order mark at the start', `\ufeff${run(READ)}`],
  ['a right-to-left override in a comment', run(`/* \u202e }) {(etaerc.sdnufer.tneilc */ ${READ}`)],
  ['a bidi isolate in a string', run("return client.customers.retrieve('cus\u20661\u2069');")],
  ['a zero-width joiner inside a name', run('return client.pay\u200dments.list();')],
  ['a Cyrillic letter in a resource name', run('return client.p\u0430yments.list();')],
  [
    'a non-ASCII constant name',
    run("const \u00efd = 'cus_1';\nreturn client.customers.retrieve(\u00efd);"),
  ],
  ['a lone surrogate in a string', run("return client.customers.retrieve('cus\ud800');")],
  // Errors a parser could recover from: strict-mode errors in a module.
  ['a legacy octal escape', run("return client.customers.retrieve('\\101');")],
  ['a legacy octal number', run('return client.payments.list({ page_size: 010 });')],
  ['a with statement', run(`with (client) {}\n${READ}`)],
  ['delete of a name', run(`delete client;\n${READ}`)],
  ['a duplicate query key', run('return client.payments.list({ page_size: 1, page_size: 2 });')],
  // Size and depth
  ['one character over the length limit', ofLength(16_385)],
  [
    'deeply nested parentheses',
    run(`return ${'('.repeat(5000)}client.payments.list()${')'.repeat(5000)};`),
  ],
  ['deeply nested blocks', run(`${'{'.repeat(5000)}${'}'.repeat(5000)}\n${READ}`)],
  [
    'deeply nested arrays in a query',
    run(`return client.payments.list({ q: ${'['.repeat(5000)}${']'.repeat(5000)} });`),
  ],
];

export const PROVEN: readonly (readonly [string, string])[] = [
  ['a list with a literal query', run('return await client.payments.list({ page_size: 5 });')],
  ['a list without arguments', run('return client.payments.list();')],
  ['a retrieve by literal id', run("return await client.customers.retrieve('cus_1');")],
  [
    'a retrieve by a local string constant',
    run("const id = 'cus_1';\nreturn client.customers.retrieve(id);"),
  ],
  [
    'a list by a local query constant',
    run(
      "const q = { page_size: 2, status: 'succeeded', live: false, n: -1, t: ['a', 1] };\nreturn client.payments.list(q);",
    ),
  ],
  [
    'two reads returned together',
    run(
      'const a = await client.payments.list({});\nconst b = await client.refunds.list({ page_size: 2 });\nreturn { a, b, n: 1 };',
    ),
  ],
  [
    'a property of a read result',
    run('const page = await client.payments.list();\nreturn page.items;'),
  ],
  ['a read as a statement', run("await client.payments.retrieve('pay_1');\nreturn null;")],
  ['another parameter name', 'async function run(c) { return c.payments.list(); }'],
  ['an any-typed parameter', 'async function run(client: any) { return client.payments.list(); }'],
  [
    'comments that mention writes',
    "// later: client.refunds.create({ payment_id: 'pay_1' })\nasync function run(client) {\n  /* client.customers.update('cus_1', {}) */\n  return client.payments.list(); // .create(\n}",
  ],
  ['exactly at the length limit', ofLength(16_384)],
  ['Windows line endings', 'async function run(client) {\r\n  return client.payments.list();\r\n}'],
  ['a non-ASCII string id', run("return client.customers.retrieve('cus_é');")],
  [
    'a comment with non-ASCII text',
    run('// list payments — first page\nreturn client.payments.list();'),
  ],
  [
    'strings that look like code',
    run("return client.customers.retrieve('x\\'); client.refunds.create({ amount: 1 }); (\\'');"),
  ],
];

export const NOT_PROVEN: readonly (readonly [string, string])[] = [
  // Writes and other methods
  ['a write', run("return client.refunds.create({ payment_id: 'pay_1' });")],
  ['a read and a write', run('await client.payments.list();\nreturn client.refunds.create({});')],
  [
    'a write hidden behind &&',
    run('return client.payments.list({}) && client.refunds.create({});'),
  ],
  ['a write in an array', run('return [client.payments.list(), client.refunds.create({})];')],
  [
    'a read-named method that is not list or retrieve',
    run("return client.payments.retrieveLineItems('pay_1');"),
  ],
  ['a resource outside the allowlist', run('return client.webhooks.list();')],
  ['a raw client request', run("return client.post('/refunds', { body: {} });")],
  ['a raw client get', run("return client.get('/payments');")],
  ['a method reference, not a call', run('return client.payments.list;')],
  ['a call on a read result', run('return client.payments.list().then((p) => p);')],
  ['a nested resource', run("return client.customers.wallets.list('cus_1');")],
  // A read that hides a write: the SDK's request options override method and path.
  [
    'retrieve with request options',
    run(
      "return client.payments.retrieve('pay_1', { method: 'post', path: '/refunds', body: { amount: 1 } });",
    ),
  ],
  [
    'list with request options',
    run("return client.payments.list({}, { method: 'post', path: '/refunds' });"),
  ],
  ['retrieve without an id', run('return client.payments.retrieve();')],
  ['retrieve with an object', run("return client.payments.retrieve({ id: 'pay_1' });")],
  ['list with a string', run("return client.payments.list('x');")],
  // Aliasing
  ['an alias of the client', run('const c = client;\nreturn c.payments.list();')],
  ['an alias of a resource', run('const p = client.payments;\nreturn p.list();')],
  ['an alias of a method', run('const l = client.payments.list;\nreturn l();')],
  [
    'a constant that shadows the client',
    'async function run(client) { const client2 = 1; { const client = 2; } return client.payments.list(); }',
  ],
  [
    'a redeclared constant',
    run("const id = 'a';\nconst id = 'b';\nreturn client.customers.retrieve(id);"),
  ],
  [
    'a constant named like the client',
    'async function run(c) { const c = 1; return c.payments.list(); }',
  ],
  // Bracket and computed access
  ['bracket access on the client', run("return client['payments'].list();")],
  ['bracket access on a method', run("return client.payments['list']();")],
  ['a computed resource', run("const r = 'refunds';\nreturn client[r].create({});")],
  ['a computed query key', run("return client.payments.list({ ['page_size']: 1 });")],
  // Spread
  ['spread arguments', run('const a = [1];\nreturn client.payments.list(...a);')],
  ['a spread query', run('const q = { page_size: 1 };\nreturn client.payments.list({ ...q });')],
  // Optional chaining
  ['optional chaining on the client', run('return client?.payments.list();')],
  ['optional chaining on a resource', run('return client.payments?.list();')],
  ['an optional call', run('return client.payments.list?.();')],
  // Template literals
  ['a template id', run('const n = 1;\nreturn client.customers.retrieve(`cus_${n}`);')],
  ['a plain template id', run('return client.customers.retrieve(`cus_1`);')],
  ['a tagged template', run('return client.customers.retrieve(String.raw`cus_1`);')],
  // Unicode escapes in names
  ['an escaped resource name', run('return client.\\u0070ayments.list();')],
  ['an escaped method name', run('return client.payments.\\u006cist();')],
  ['an escaped write disguised', run('return client.r\\u0065funds.create({});')],
  ['an escaped client name', run('return \\u0063lient.payments.list();')],
  ['an escaped query key', run('return client.payments.list({ p\\u0061ge_size: 1 });')],
  // Dynamic code
  ['eval', run("eval('client.refunds.create({})');\nreturn null;")],
  ['Function', run("return new Function('c', 'return c.refunds.create({})')(client);")],
  ['fetch', run("return fetch('https://evil.example/');")],
  ['dynamic import', run("const m = await import('node:fs');\nreturn m;")],
  ['Reflect', run("return Reflect.get(client, 'refunds').create({});")],
  ['globalThis', run('return globalThis.fetch;')],
  // Loops and control flow
  [
    'a for loop calling the client',
    run('for (const n of [1, 2]) await client.payments.list();\nreturn null;'),
  ],
  [
    'for await over a list',
    run('const out = [];\nfor await (const p of client.payments.list()) out.push(p);\nreturn out;'),
  ],
  ['a while loop', run('while (false) {}\nreturn client.payments.list();')],
  ['an if', run('if (true) return client.payments.list();\nreturn null;')],
  ['a try block', run('try { return client.payments.list(); } catch { return null; }')],
  [
    'a nested function',
    run('const f = () => client.refunds.create({});\nreturn client.payments.list();'),
  ],
  // Object literal tricks
  ['a getter in a query', run('return client.payments.list({ get page_size() { return 1; } });')],
  ['a method in a query', run('return client.payments.list({ toString() { return "x"; } });')],
  ['a __proto__ key', run('return client.payments.list({ __proto__: { page_size: 1 } });')],
  ['a nested object in a query', run('return client.payments.list({ a: { b: 1 } });')],
  ['a non-literal query value', run('return client.payments.list({ page_size: client.x });')],
  [
    'a call-result constant as an argument',
    run('const p = await client.payments.list();\nreturn client.customers.retrieve(p);'),
  ],
  ['an undeclared identifier', run('return client.customers.retrieve(id);')],
  [
    'a constant used before it is declared',
    run("const a = client.customers.retrieve(id);\nconst id = 'x';\nreturn a;"),
  ],
  // TypeScript-only syntax
  ['a type assertion', run('return client.payments.list({} as any);')],
  ['a non-null assertion', run('return client!.payments.list();')],
  ['type arguments', run('return client.payments.list<any>();')],
  ['a typed constant', run("const id: string = 'x';\nreturn client.customers.retrieve(id);")],
  // Function shape
  [
    'an extra top-level statement',
    `fetch('https://evil.example/');\n${run('return client.payments.list();')}`,
  ],
  ['a top-level constant', `const x = 1;\n${run('return client.payments.list();')}`],
  ['an exported function', `export ${run('return client.payments.list();')}`],
  ['an arrow function', 'const run = async (client) => client.payments.list();'],
  ['a non-async function', 'function run(client) { return client.payments.list(); }'],
  ['a generator', 'async function* run(client) { yield client.payments.list(); }'],
  ['two parameters', 'async function run(client, x) { return client.payments.list(); }'],
  [
    'a default parameter',
    'async function run(client = globalThis) { return client.payments.list(); }',
  ],
  ['a destructured parameter', 'async function run({ payments }) { return payments.list(); }'],
  [
    'a typed parameter other than any',
    'async function run(client: typeof globalThis) { return client.payments.list(); }',
  ],
  ['another function name', 'async function main(client) { return client.payments.list(); }'],
  ['a let', run("let id = 'x';\nreturn client.customers.retrieve(id);")],
  ['a using declaration', run('using x = null;\nreturn client.payments.list();')],
  ['an await using declaration', run('await using x = null;\nreturn client.payments.list();')],
  ['a var', run("var id = 'x';\nreturn client.customers.retrieve(id);")],
  ['two declarations in one', run("const a = 'x', b = 'y';\nreturn client.customers.retrieve(a);")],
  ['a directive', run("'use strict';\nreturn client.payments.list();")],
  ['a parenthesised call', run('return (client.payments.list());')],
  ['this', run('return this.payments.list();')],
  // Unparseable or empty
  ['a syntax error', run('return client.payments.list(;')],
  ['an unterminated comment', `${run('return client.payments.list();')}\n/*`],
  [
    'merge conflict markers',
    `<<<<<<< HEAD\n${run('return client.payments.list();')}\n=======\n>>>>>>> x`,
  ],
  ['empty code', ''],
  ['only a comment', '// nothing'],
  ['a huge input', run(`return client.payments.list({ q: '${'x'.repeat(70_000)}' });`)],
  ...DIFFERENTIAL,
];

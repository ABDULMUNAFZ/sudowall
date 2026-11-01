/**
 * The cases for the parser-based read check (ADR 0023, H1 update), in one module so the same
 * list can be run against another parser implementation (see docs/adr/0025-read-check-parser.md).
 * PROVEN must come back proven; NOT_PROVEN must come back not proven, which makes the call ask.
 */
export const RESOURCES = ['payments', 'refunds', 'customers'];
export const run = (body: string): string => `async function run(client) {\n${body}\n}`;

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
];

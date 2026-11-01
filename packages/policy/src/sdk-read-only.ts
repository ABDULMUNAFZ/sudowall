import { createRequire } from 'node:module';
import type * as Babel from '@babel/parser';
import type * as B from '@babel/types';

/**
 * Parser-based check for code an agent sends to an SDK "code mode" tool, such as the `execute`
 * tool of the Dodo Payments MCP server (ADR 0023, H1 update; parser choice: ADR 0025). It
 * proves one narrow shape and nothing else:
 *
 *     async function run(client) {
 *       const id = 'cus_1';                                  // literal constants
 *       const page = await client.payments.list({ page_size: 5 });
 *       return { page, one: await client.customers.retrieve(id) };
 *     }
 *
 * Every call is `<client>.<resource>.list(query?)` or `<client>.<resource>.retrieve(id)` with a
 * resource on the allowlist. In Stainless-generated SDKs (Dodo's included) both are HTTP GETs.
 * `list` takes at most a flat query object and `retrieve` exactly one string id: a second
 * argument is request options, and options can override the HTTP method and path
 * (`{ method, path, ...opts }`), so `retrieve(id, { method: 'post', path: '/refunds' })` would
 * be a write. Arguments are literals or local constants holding literals.
 *
 * Anything else is "not proven": other statements, other calls, aliases, bracket or optional
 * access, parentheses, spread, templates, escaped identifiers, directives, TypeScript-only
 * syntax (except `client: any`), and any code with a syntax error. The answer may only relax a
 * decision from ask to allow, so every doubt means "not proven".
 *
 * The code is parsed with @babel/parser (typescript plugin) as an ES module, without error
 * recovery: any syntax error throws, and a throw is "not proven".
 */
export type SdkReadOnlyResult = { ok: true } | { ok: false; reason: string };

export interface SdkReadOnlyProfile {
  /** Resource names on the client (`client.<resource>`) whose list and retrieve may run. */
  resources: readonly string[];
}

/** Larger code is not analysed. Reads are short; a limit keeps parsing cheap. */
export const MAX_CODE_LENGTH = 16_384;

const METHODS = new Set(['list', 'retrieve']);

let babelModule: typeof Babel | undefined;
/** Loaded on first use: most policies never need a parser. */
function babel(): typeof Babel {
  babelModule ??= createRequire(import.meta.url)('@babel/parser') as typeof Babel;
  return babelModule;
}

class NotProven extends Error {}
const no = (reason: string): never => {
  throw new NotProven(reason);
};

/** What a local constant holds. */
type Local = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'query' | 'result';

interface Ctx {
  /** The parsed text: the agent's code plus the appended `export default run;`. */
  text: string;
  client: string;
  resources: ReadonlySet<string>;
  locals: Map<string, Local>;
}

type Expr = B.Expression | B.SpreadElement | B.ArgumentPlaceholder | B.PrivateName | null;

/** Parentheses change nothing at run time, but the check accepts only the plain form. */
function plain(e: B.Node): void {
  if (e.extra?.['parenthesized'] === true) no('a parenthesised expression');
}

/**
 * The identifier's name, refusing escapes (`payments` must not pass as `payments`) and
 * annotations. The source text must start with the name itself: at the first escape the source
 * has a backslash where the name has an identifier character.
 */
function name(node: B.Node, c: Ctx): string {
  if (node.type !== 'Identifier') return no(`not an identifier: ${node.type}`);
  const start = node.start ?? -1;
  if (c.text.slice(start, start + node.name.length) !== node.name) {
    no(`escaped identifier "${c.text.slice(start, node.end ?? start)}"`);
  }
  if (node.typeAnnotation != null || node.optional === true || (node.decorators ?? []).length > 0) {
    no(`annotated identifier "${node.name}"`);
  }
  return node.name;
}

/** A literal value (string, finite number, -number, true, false, null) and its kind. */
function literal(e: Expr): Local | undefined {
  if (e === null) return undefined;
  switch (e.type) {
    case 'StringLiteral':
      return 'string';
    case 'NumericLiteral':
      return 'number';
    case 'BooleanLiteral':
      return 'boolean';
    case 'NullLiteral':
      return 'null';
    case 'UnaryExpression':
      if (e.operator === '-' && e.prefix && e.argument.type === 'NumericLiteral') {
        plain(e.argument);
        return 'number';
      }
      return undefined;
    default:
      return undefined;
  }
}

/** A literal, a literal constant, or an array of those. */
function scalar(e: Expr, c: Ctx): Local {
  if (e === null) return no('an array hole');
  plain(e);
  const lit = literal(e);
  if (lit !== undefined) return lit;
  if (e.type === 'ArrayExpression') {
    for (const x of e.elements) {
      const k = scalar(x, c);
      if (k === 'array' || k === 'query' || k === 'result') no('nested value in a query');
    }
    return 'array';
  }
  if (e.type === 'Identifier') {
    const n = name(e, c);
    const k = c.locals.get(n);
    if (k === undefined) no(`"${n}" is not a local constant declared before`);
    if (k === 'query' || k === 'result') no(`"${n}" is not a literal`);
    return k as Local;
  }
  return no(`not a literal: ${e.type}`);
}

/** A plain object key: an identifier or a string, never computed, numeric or `__proto__`. */
function key(p: B.ObjectProperty, c: Ctx): string {
  if (p.computed) no('a computed key');
  let k: string;
  if (p.key.type === 'Identifier') k = name(p.key, c);
  else if (p.key.type === 'StringLiteral') k = p.key.value;
  else return no(`a ${p.key.type} key`);
  if (k === '__proto__') no('a __proto__ key');
  return k;
}

/** A flat object literal with plain keys and literal values. */
function query(e: Expr, c: Ctx): void {
  if (e === null) return no('no query');
  plain(e);
  if (e.type === 'Identifier') {
    const n = name(e, c);
    if (c.locals.get(n) !== 'query') no(`"${n}" is not a local query constant`);
    return;
  }
  if (e.type !== 'ObjectExpression') return no('the list query is not an object literal');
  const keys = new Set<string>();
  for (const p of e.properties) {
    if (p.type !== 'ObjectProperty') return no(`query member is a ${p.type}`);
    if (p.shorthand) no('a shorthand query member');
    unique(keys, key(p, c));
    scalar(p.value as B.Expression, c);
  }
}

/** Duplicate keys are valid JavaScript (the last wins), but TypeScript reports them; refuse. */
function unique(keys: Set<string>, k: string): void {
  if (keys.has(k)) no(`the key "${k}" appears twice`);
  keys.add(k);
}

/** `<object>.<name>` with a plain identifier name: no brackets, `?.` or parentheses. */
function dot(e: B.Node): B.MemberExpression & { property: B.Identifier } {
  if (e.type !== 'MemberExpression' || e.computed || e.property.type !== 'Identifier') {
    return no('the callee is not client.<resource>.<method>');
  }
  plain(e);
  return e as B.MemberExpression & { property: B.Identifier };
}

/** `<client>.<resource>.list(query?)` or `.retrieve(id)`, nothing else. Returns its label. */
function readCall(e: Expr, c: Ctx): string {
  if (e === null) return no('no call');
  plain(e);
  // `a?.b()` and `a.b?.()` parse as OptionalCallExpression, so they stop here.
  if (e.type !== 'CallExpression') return no(`not a call: ${e.type}`);
  if (e.typeArguments != null) no('type arguments');
  const callee = dot(e.callee);
  const res = dot(callee.object);
  if (res.object.type !== 'Identifier') return no('the call is not on the client parameter');
  plain(res.object);
  if (name(res.object, c) !== c.client) no('the call is not on the client parameter');
  const resource = name(res.property, c);
  const method = name(callee.property, c);
  const label = `${resource}.${method}`;
  if (!c.resources.has(resource)) no(`${label}: resource not on the allowlist`);
  if (!METHODS.has(method)) no(`${label}: not list or retrieve`);
  for (const a of e.arguments) {
    if (a.type === 'SpreadElement') no(`${label}: spread argument`);
    if (a.type === 'ArgumentPlaceholder') no(`${label}: placeholder argument`);
  }
  if (method === 'retrieve') {
    if (e.arguments.length !== 1) no(`${label}: needs exactly one id argument`);
    if (scalar(e.arguments[0] as B.Expression, c) !== 'string') {
      no(`${label}: the id is not a string`);
    }
  } else {
    if (e.arguments.length > 1) no(`${label}: a second argument (request options)`);
    if (e.arguments[0] !== undefined) query(e.arguments[0], c);
  }
  return label;
}

/** A read call, optionally awaited. */
function read(e: Expr, c: Ctx): void {
  if (e === null) return no('no call');
  plain(e);
  readCall(e.type === 'AwaitExpression' ? e.argument : e, c);
}

/** What `return` may give back: reads, constants, their properties, objects and arrays of those. */
function returned(e: Expr, c: Ctx): void {
  if (e === null) return no('an array hole');
  plain(e);
  if (literal(e) !== undefined) return;
  if (e.type === 'Identifier') {
    const n = name(e, c);
    if (!c.locals.has(n)) no(`"${n}" is not a local constant declared before`);
    return;
  }
  if (e.type === 'MemberExpression') {
    let base: B.Expression = e;
    while (base.type === 'MemberExpression') {
      const m = dot(base);
      name(m.property, c);
      base = m.object as B.Expression;
    }
    plain(base);
    if (base.type !== 'Identifier' || c.locals.get(name(base, c)) !== 'result') {
      no('a property of something other than a read result');
    }
    return;
  }
  if (e.type === 'ArrayExpression') {
    for (const x of e.elements) returned(x, c);
    return;
  }
  if (e.type === 'ObjectExpression') {
    const keys = new Set<string>();
    for (const p of e.properties) {
      if (p.type !== 'ObjectProperty') return no(`returned object member is a ${p.type}`);
      if (p.shorthand) {
        // `{ a = 1 }` is a pattern, not an object; the parser rejects it here, but be explicit.
        if (p.value.type !== 'Identifier') no('shorthand initializer');
        unique(keys, name(p.value, c));
        returned(p.value as B.Identifier, c);
        continue;
      }
      unique(keys, key(p, c));
      returned(p.value as B.Expression, c);
    }
    return;
  }
  read(e, c);
}

function declare(id: B.Node, kind: Local, c: Ctx): void {
  if (id.type !== 'Identifier') no('destructuring');
  const n = name(id, c);
  if (n === c.client || n === 'run' || c.locals.has(n)) no(`"${n}" is declared twice`);
  c.locals.set(n, kind);
}

function statement(s: B.Statement, c: Ctx): void {
  if (s.type === 'VariableDeclaration') {
    if (s.declare === true) no('a declare statement');
    // Exactly `const`: not let, var, using or await using.
    if (s.kind !== 'const') no('only const is allowed');
    if (s.declarations.length !== 1) no('one constant per declaration');
    const d = s.declarations[0] as B.VariableDeclarator;
    if (d.definite === true) no('a typed constant');
    if (d.id.type === 'Identifier' && d.id.typeAnnotation != null) no('a typed constant');
    const init = d.init;
    if (init == null) return no('a constant without a value');
    plain(init);
    const lit = literal(init);
    if (lit !== undefined) {
      declare(d.id, lit, c);
      return;
    }
    if (init.type === 'ArrayExpression') {
      declare(d.id, scalar(init, c), c);
      return;
    }
    if (init.type === 'ObjectExpression') {
      query(init, c);
      declare(d.id, 'query', c);
      return;
    }
    read(init, c);
    declare(d.id, 'result', c);
    return;
  }
  if (s.type === 'ReturnStatement') {
    if (s.argument != null) returned(s.argument, c);
    return;
  }
  if (s.type === 'ExpressionStatement') {
    if (s.expression.type !== 'AwaitExpression') {
      no('an expression statement that is not an awaited read');
    }
    read(s.expression, c);
    return;
  }
  no(`statement ${s.type}`);
}

/**
 * Characters that some parser or engine may read as whitespace or a line terminator, or that
 * are invisible: controls other than tab, LF and CRLF (a lone CR too), C1 controls (NEL),
 * Unicode spaces, U+180E (whitespace before Unicode 6.3), zero-width and bidi controls, line
 * and paragraph separators, byte order marks, invisible fillers, tag characters and unpaired
 * surrogates. Deno parses the code again, so any of them anywhere means "not proven".
 */
function oddCharacter(code: string): string | undefined {
  for (let i = 0; i < code.length; i++) {
    const u = code.charCodeAt(i);
    if (u >= 0x20 && u <= 0x7e) continue;
    if (u === 0x09 || u === 0x0a) continue;
    if (u === 0x0d && code.charCodeAt(i + 1) === 0x0a) continue;
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = code.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return `U+${hex(u)}`;
      const cp = code.codePointAt(i) as number;
      if (cp >= 0xe0000 && cp <= 0xe0fff) return `U+${hex(cp)}`;
      i++;
      continue;
    }
    if (
      u < 0x20 ||
      (u >= 0x7f && u <= 0xa0) ||
      u === 0xad ||
      u === 0x034f ||
      u === 0x115f ||
      u === 0x1160 ||
      u === 0x1680 ||
      u === 0x180e ||
      (u >= 0x2000 && u <= 0x200f) ||
      (u >= 0x2028 && u <= 0x202f) ||
      (u >= 0x205f && u <= 0x206f) ||
      u === 0x3000 ||
      u === 0x3164 ||
      (u >= 0xdc00 && u <= 0xdfff) ||
      u === 0xfeff ||
      u === 0xffa0 ||
      (u >= 0xfff0 && u <= 0xfffb)
    ) {
      return `U+${hex(u)}`;
    }
  }
  return undefined;
}

const hex = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');

/**
 * Other non-ASCII characters may appear only inside string literals and comments. In names and
 * between tokens, parsers built on different Unicode versions may disagree about them.
 */
function nonAsciiOutsideStrings(file: B.File, text: string): void {
  const allowed = new Uint8Array(text.length);
  const mark = (n: { start?: number | null; end?: number | null }) => {
    allowed.fill(1, n.start ?? 0, n.end ?? 0);
  };
  for (const comment of file.comments ?? []) mark(comment);
  // Iterative walk: the tree may be deep, and only its StringLiteral nodes matter here.
  const stack: unknown[] = [file.program];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    if (v === null || typeof v !== 'object') continue;
    const node = v as Record<string, unknown> & { type?: unknown };
    if (typeof node.type !== 'string') continue;
    if (node.type === 'StringLiteral') mark(node as unknown as B.StringLiteral);
    for (const [k, x] of Object.entries(node)) {
      if (k === 'loc' || k === 'extra' || k.endsWith('Comments')) continue;
      if (typeof x === 'object' && x !== null) stack.push(x);
    }
  }
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7e && allowed[i] !== 1) {
      no(`a non-ASCII character outside a string or comment (U+${hex(text.charCodeAt(i))})`);
    }
  }
}

/** Parse exactly what dodopayments-mcp evaluates: a TypeScript module. Throws on any error. */
function parse(text: string): B.File {
  try {
    const file = babel().parse(text, {
      sourceType: 'module',
      plugins: ['typescript'],
      errorRecovery: false,
    });
    if (file.errors.length > 0) no('the code does not parse');
    return file;
  } catch (e) {
    if (e instanceof NotProven) throw e;
    return no('the code does not parse');
  }
}

export function checkSdkReadOnly(code: string, profile: SdkReadOnlyProfile): SdkReadOnlyResult {
  try {
    if (code.length > MAX_CODE_LENGTH) no(`code longer than ${String(MAX_CODE_LENGTH)} characters`);
    const odd = oddCharacter(code);
    if (odd !== undefined)
      no(`an unusual whitespace, line terminator or invisible character (${odd})`);
    const text = `${code}\nexport default run;`;
    const file = parse(text);
    nonAsciiOutsideStrings(file, text);
    const program = file.program;
    if (program.interpreter != null) no('a hashbang line');
    if (program.directives.length > 0) no('a directive');
    const [fn, exp, ...rest] = program.body;
    if (rest.length > 0 || fn === undefined || exp === undefined) {
      no('the code must be a single run function');
    }
    // The second statement must be the appended `export default run;`, not the agent's own.
    if (exp?.type !== 'ExportDefaultDeclaration' || exp.start !== code.length + 1) {
      no('the code must be a single run function');
    }
    if (fn?.type !== 'FunctionDeclaration') return no('the code must be a single run function');
    if (!fn.async || fn.declare === true) no('run must be async and not exported');
    if (fn.generator || fn.typeParameters != null || fn.returnType != null) {
      no('run must be a plain async function');
    }
    if (fn.id == null) return no('run has no name');
    if (fn.body.directives.length > 0) no('a directive');
    const c: Ctx = { text, client: '', resources: new Set(profile.resources), locals: new Map() };
    if (name(fn.id, c) !== 'run') no('the function is not named run');
    if (fn.params.length !== 1) no('run must take exactly one parameter');
    const p = fn.params[0] as B.FunctionParameter;
    if (p.type !== 'Identifier') return no('the parameter must be a plain identifier');
    const annotation = p.typeAnnotation;
    if (
      annotation != null &&
      (annotation.type !== 'TSTypeAnnotation' || annotation.typeAnnotation.type !== 'TSAnyKeyword')
    ) {
      no('the parameter must be a plain identifier');
    }
    // `name` refuses annotations, so check the bare identifier without its `: any`.
    c.client = name({ ...p, typeAnnotation: null }, c);
    if (c.client === 'run') no('the parameter is named run');
    for (const s of fn.body.body) statement(s, c);
    return { ok: true };
  } catch (e) {
    if (e instanceof NotProven) return { ok: false, reason: e.message };
    // An analyser bug must never relax a decision.
    return { ok: false, reason: `analysis failed: ${(e as Error).message}` };
  }
}

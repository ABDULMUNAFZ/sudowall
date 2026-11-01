import { createRequire } from 'node:module';
import type * as TS from 'typescript';

/**
 * Parser-based check for code an agent sends to an SDK "code mode" tool, such as the `execute`
 * tool of the Dodo Payments MCP server (ADR 0023, H1 update). It proves one narrow shape and
 * nothing else:
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
 * access, spread, templates, escaped identifiers, TypeScript-only syntax (except `client: any`),
 * and any code with a syntax error. The answer may only relax a decision from ask to allow, so
 * every doubt means "not proven".
 */
export type SdkReadOnlyResult = { ok: true } | { ok: false; reason: string };

export interface SdkReadOnlyProfile {
  /** Resource names on the client (`client.<resource>`) whose list and retrieve may run. */
  resources: readonly string[];
}

/** Larger code is not analysed. Reads are short; a limit keeps parsing cheap. */
export const MAX_CODE_LENGTH = 16_384;

const METHODS = new Set(['list', 'retrieve']);

let tsModule: typeof TS | undefined;
/** Loaded on first use: TypeScript is large, and most policies never need it. */
function ts(): typeof TS {
  tsModule ??= createRequire(import.meta.url)('typescript') as typeof TS;
  return tsModule;
}

class NotProven extends Error {}
const no = (reason: string): never => {
  throw new NotProven(reason);
};

/** What a local constant holds. */
type Local = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'query' | 'result';

interface Ctx {
  sf: TS.SourceFile;
  client: string;
  resources: ReadonlySet<string>;
  locals: Map<string, Local>;
}

/** The identifier's name, refusing escapes: `payments` must not pass as `payments`. */
function name(node: TS.Identifier, c: Ctx): string {
  if (node.getText(c.sf) !== node.text) no(`escaped identifier "${node.getText(c.sf)}"`);
  return node.text;
}

/** A literal value (string, finite number, -number, true, false, null) and its kind. */
function literal(e: TS.Expression): Local | undefined {
  const t = ts();
  if (t.isStringLiteral(e)) return 'string';
  if (t.isNumericLiteral(e)) return 'number';
  if (
    t.isPrefixUnaryExpression(e) &&
    e.operator === t.SyntaxKind.MinusToken &&
    t.isNumericLiteral(e.operand)
  ) {
    return 'number';
  }
  if (e.kind === t.SyntaxKind.TrueKeyword || e.kind === t.SyntaxKind.FalseKeyword) {
    return 'boolean';
  }
  if (e.kind === t.SyntaxKind.NullKeyword) return 'null';
  return undefined;
}

/** A literal, a literal constant, or an array of those. */
function scalar(e: TS.Expression, c: Ctx): Local {
  const t = ts();
  const lit = literal(e);
  if (lit !== undefined) return lit;
  if (t.isArrayLiteralExpression(e)) {
    for (const x of e.elements) {
      const k = scalar(x, c);
      if (k === 'array' || k === 'query' || k === 'result') no('nested value in a query');
    }
    return 'array';
  }
  if (t.isIdentifier(e)) {
    const k = c.locals.get(name(e, c));
    if (k === undefined) no(`"${e.text}" is not a local constant declared before`);
    if (k === 'query' || k === 'result') no(`"${e.text}" is not a literal`);
    return k as Local;
  }
  return no(`not a literal: ${t.SyntaxKind[e.kind]}`);
}

/** A flat object literal with plain keys and literal values. */
function query(e: TS.Expression, c: Ctx): void {
  const t = ts();
  if (t.isIdentifier(e)) {
    if (c.locals.get(name(e, c)) !== 'query') no(`"${e.text}" is not a local query constant`);
    return;
  }
  if (!t.isObjectLiteralExpression(e)) no('the list query is not an object literal');
  for (const p of (e as TS.ObjectLiteralExpression).properties) {
    if (!t.isPropertyAssignment(p)) no(`query member is a ${t.SyntaxKind[p.kind]}`);
    const a = p as TS.PropertyAssignment;
    let key: string;
    if (t.isIdentifier(a.name)) key = name(a.name, c);
    else if (t.isStringLiteral(a.name)) key = a.name.text;
    else return no('computed or numeric query key');
    if (key === '__proto__') no('a __proto__ key');
    scalar(a.initializer, c);
  }
}

/** `<client>.<resource>.list(query?)` or `.retrieve(id)`, nothing else. Returns its label. */
function readCall(e: TS.Expression, c: Ctx): string {
  const t = ts();
  if (!t.isCallExpression(e)) return no(`not a call: ${t.SyntaxKind[e.kind]}`);
  if (e.questionDotToken !== undefined || e.typeArguments !== undefined) {
    no('optional call or type arguments');
  }
  const callee = e.expression;
  if (!t.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) {
    return no('the callee is not client.<resource>.<method>');
  }
  const res = callee.expression;
  if (!t.isPropertyAccessExpression(res) || res.questionDotToken !== undefined) {
    return no('the callee is not client.<resource>.<method>');
  }
  if (!t.isIdentifier(res.expression) || name(res.expression, c) !== c.client) {
    return no('the call is not on the client parameter');
  }
  if (!t.isIdentifier(callee.name) || !t.isIdentifier(res.name)) no('private name');
  const resource = name(res.name as TS.Identifier, c);
  const method = name(callee.name as TS.Identifier, c);
  const label = `${resource}.${method}`;
  if (!c.resources.has(resource)) no(`${label}: resource not on the allowlist`);
  if (!METHODS.has(method)) no(`${label}: not list or retrieve`);
  for (const a of e.arguments) if (t.isSpreadElement(a)) no(`${label}: spread argument`);
  if (method === 'retrieve') {
    if (e.arguments.length !== 1) no(`${label}: needs exactly one id argument`);
    if (scalar(e.arguments[0] as TS.Expression, c) !== 'string')
      no(`${label}: the id is not a string`);
  } else {
    if (e.arguments.length > 1) no(`${label}: a second argument (request options)`);
    if (e.arguments[0] !== undefined) query(e.arguments[0], c);
  }
  return label;
}

/** A read call, optionally awaited. */
function read(e: TS.Expression, c: Ctx): void {
  readCall(ts().isAwaitExpression(e) ? e.expression : e, c);
}

/** What `return` may give back: reads, constants, their properties, objects and arrays of those. */
function returned(e: TS.Expression, c: Ctx): void {
  const t = ts();
  if (literal(e) !== undefined) return;
  if (t.isIdentifier(e)) {
    if (!c.locals.has(name(e, c))) no(`"${e.text}" is not a local constant declared before`);
    return;
  }
  if (t.isPropertyAccessExpression(e)) {
    if (e.questionDotToken !== undefined) no('optional chaining');
    if (!t.isIdentifier(e.name)) no('private name');
    name(e.name as TS.Identifier, c);
    let base: TS.Expression = e.expression;
    while (t.isPropertyAccessExpression(base)) {
      if (base.questionDotToken !== undefined || !t.isIdentifier(base.name))
        no('optional chaining');
      name(base.name as TS.Identifier, c);
      base = base.expression;
    }
    if (!t.isIdentifier(base) || c.locals.get(name(base, c)) !== 'result') {
      no('a property of something other than a read result');
    }
    return;
  }
  if (t.isArrayLiteralExpression(e)) {
    for (const x of e.elements) returned(x, c);
    return;
  }
  if (t.isObjectLiteralExpression(e)) {
    for (const p of e.properties) {
      if (t.isShorthandPropertyAssignment(p)) {
        if (p.objectAssignmentInitializer !== undefined) no('shorthand initializer');
        returned(p.name, c);
      } else if (
        t.isPropertyAssignment(p) &&
        (t.isIdentifier(p.name) || t.isStringLiteral(p.name))
      ) {
        if (t.isIdentifier(p.name)) name(p.name, c);
        if (p.name.text === '__proto__') no('a __proto__ key');
        returned(p.initializer, c);
      } else {
        no(`returned object member is a ${t.SyntaxKind[p.kind]}`);
      }
    }
    return;
  }
  read(e, c);
}

function declare(id: TS.BindingName, kind: Local, c: Ctx): void {
  if (!ts().isIdentifier(id)) no('destructuring');
  const n = name(id as TS.Identifier, c);
  if (n === c.client || n === 'run' || c.locals.has(n)) no(`"${n}" is declared twice`);
  c.locals.set(n, kind);
}

function statement(s: TS.Statement, c: Ctx): void {
  const t = ts();
  if (t.isVariableStatement(s)) {
    if (s.modifiers !== undefined) no('modifiers on a declaration');
    const list = s.declarationList;
    // Exactly `const`: not let, var, using or await using.
    const scope: number = list.flags & t.NodeFlags.BlockScoped;
    const constFlag: number = t.NodeFlags.Const;
    if (scope !== constFlag) no('only const is allowed');
    if (list.declarations.length !== 1) no('one constant per declaration');
    const d = list.declarations[0] as TS.VariableDeclaration;
    if (d.type !== undefined || d.exclamationToken !== undefined) no('a typed constant');
    const init = d.initializer;
    if (init === undefined) return no('a constant without a value');
    const lit = literal(init);
    if (lit !== undefined) {
      declare(d.name, lit, c);
      return;
    }
    if (t.isArrayLiteralExpression(init)) {
      declare(d.name, scalar(init, c), c);
      return;
    }
    if (t.isObjectLiteralExpression(init)) {
      query(init, c);
      declare(d.name, 'query', c);
      return;
    }
    read(init, c);
    declare(d.name, 'result', c);
    return;
  }
  if (t.isReturnStatement(s)) {
    if (s.expression !== undefined) returned(s.expression, c);
    return;
  }
  if (t.isExpressionStatement(s)) {
    if (!t.isAwaitExpression(s.expression))
      no('an expression statement that is not an awaited read');
    read(s.expression, c);
    return;
  }
  no(`statement ${t.SyntaxKind[s.kind]}`);
}

/** Syntax errors in the text the server actually runs (it appends `export default run;`). */
function hasSyntaxErrors(text: string): boolean {
  const r = ts().transpileModule(text, {
    fileName: 'code.ts',
    reportDiagnostics: true,
    compilerOptions: { target: ts().ScriptTarget.ESNext, module: ts().ModuleKind.ESNext },
  });
  return (r.diagnostics ?? []).length > 0;
}

export function checkSdkReadOnly(code: string, profile: SdkReadOnlyProfile): SdkReadOnlyResult {
  try {
    if (code.length > MAX_CODE_LENGTH) no(`code longer than ${String(MAX_CODE_LENGTH)} characters`);
    const t = ts();
    // Parse exactly what dodopayments-mcp evaluates as a TypeScript module.
    const text = `${code}\nexport default run;`;
    if (hasSyntaxErrors(text)) no('the code does not parse');
    const sf = t.createSourceFile('code.ts', text, t.ScriptTarget.ESNext, true, t.ScriptKind.TS);
    const [fn, exp, ...rest] = sf.statements;
    if (rest.length > 0 || fn === undefined || exp === undefined) {
      no('the code must be a single run function');
    }
    // The second statement must be the appended `export default run;`, not the agent's own.
    if (!t.isExportAssignment(exp as TS.Statement) || exp?.getStart(sf) !== code.length + 1) {
      no('the code must be a single run function');
    }
    if (!t.isFunctionDeclaration(fn as TS.Statement)) no('the code must be a single run function');
    const f = fn as TS.FunctionDeclaration;
    const mods = (f.modifiers ?? []).map((m) => m.kind);
    if (mods.length !== 1 || mods[0] !== t.SyntaxKind.AsyncKeyword)
      no('run must be async and not exported');
    if (f.asteriskToken !== undefined || f.typeParameters !== undefined || f.type !== undefined) {
      no('run must be a plain async function');
    }
    if (f.name === undefined || f.body === undefined) return no('run has no name or body');
    const c: Ctx = { sf, client: '', resources: new Set(profile.resources), locals: new Map() };
    if (name(f.name, c) !== 'run') no('the function is not named run');
    if (f.parameters.length !== 1) no('run must take exactly one parameter');
    const p = f.parameters[0] as TS.ParameterDeclaration;
    if (
      !t.isIdentifier(p.name) ||
      p.dotDotDotToken !== undefined ||
      p.initializer !== undefined ||
      p.questionToken !== undefined ||
      (p.modifiers ?? []).length > 0 ||
      (p.type !== undefined && p.type.kind !== t.SyntaxKind.AnyKeyword)
    ) {
      no('the parameter must be a plain identifier');
    }
    c.client = name(p.name as TS.Identifier, c);
    if (c.client === 'run') no('the parameter is named run');
    for (const s of f.body.statements) statement(s, c);
    return { ok: true };
  } catch (e) {
    if (e instanceof NotProven) return { ok: false, reason: e.message };
    // An analyser bug must never relax a decision.
    return { ok: false, reason: `analysis failed: ${(e as Error).message}` };
  }
}

/**
 * Structured logs as JSON lines on stderr. stdout is reserved for the MCP protocol in stdio mode,
 * so nothing in the gateway may ever write to it except the client channel.
 *
 * Callers must never pass secret values or raw tool arguments as fields.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  options: {
    level?: LogLevel;
    write?: (line: string) => void;
    base?: Record<string, unknown>;
  } = {},
): Logger {
  const min = ORDER[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const base = options.base ?? {};
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < min) return;
    write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields })}\n`);
  };
  return {
    debug: (m, f) => {
      emit('debug', m, f);
    },
    info: (m, f) => {
      emit('info', m, f);
    },
    warn: (m, f) => {
      emit('warn', m, f);
    },
    error: (m, f) => {
      emit('error', m, f);
    },
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = createLogger({ write: () => undefined });

const SECRET_NAME =
  '(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|' +
  'key|token|secret|password|passwd|pwd|pass|auth|authorization|credential|credentials|session|sig|signature|cookie)';
const REDACTIONS: [RegExp, string][] = [
  // Credentials in URLs: https://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, '$1***@'],
  // Authorization schemes.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***'],
  // name=value, name: value and "name":"value" for secret-looking names.
  [
    new RegExp(`(["']?\\b[\\w.-]*${SECRET_NAME}[\\w.-]*["']?\\s*[:=]\\s*["']?)[^\\s"'&,;]+`, 'gi'),
    '$1***',
  ],
  // Well-known key formats.
  [
    /\b(?:sk|pk|rk)[-_](?:live|test)?[-_]?[A-Za-z0-9]{16,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36})\b/g,
    '***',
  ],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '***'],
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Masks credential-shaped text in a free-form line (upstream stderr): URL user info, auth
 * headers, secret-named parameters, well-known key formats, JWTs and long random strings.
 * Best effort: it lowers the chance a server's diagnostics put a secret in the log, it cannot
 * recognise every secret.
 */
export function redactSecrets(line: string): string {
  let out = line;
  for (const [re, by] of REDACTIONS) out = out.replace(re, by);
  return out.replace(/[A-Za-z0-9_+/=-]{40,}/g, (m) =>
    /\d/.test(m) && /[A-Za-z]/.test(m) && !UUID.test(m) ? '***' : m,
  );
}

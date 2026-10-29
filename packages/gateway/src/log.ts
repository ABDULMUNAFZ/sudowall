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

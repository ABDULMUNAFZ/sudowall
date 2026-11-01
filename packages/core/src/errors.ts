export const ERROR_CODES = [
  'INVALID_CONFIG',
  'INVALID_EVENT',
  'UNSUPPORTED_SCHEMA_VERSION',
  'MIGRATION_FAILED',
  'NEWER_VERSION',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Base error for every failure SudoWall reports. Messages must never contain secret values. */
export class SudoWallError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SudoWallError';
    this.code = code;
  }
}

/** What a newer SudoWall wrote that this build cannot read. */
export interface NewerVersionInfo {
  /** The versioned thing, e.g. "event schema", "state database provenance schema", "ledger spec". */
  what: string;
  found: number | string;
  supported: number | string;
  /** Product version of the SudoWall that last wrote the data, when it recorded one. */
  writtenBy?: string | undefined;
}

/** "written by a newer SudoWall (v0.8.0; provenance schema 3, this build reads up to 2), upgrade to …" */
export function newerVersionMessage(info: NewerVersionInfo, action = 'read it'): string {
  const by = info.writtenBy === undefined ? '' : `v${info.writtenBy}; `;
  return `written by a newer SudoWall (${by}${info.what} ${String(info.found)}, this build reads up to ${String(info.supported)}), upgrade to ${action}`;
}

/**
 * Data written by a newer SudoWall. Not damage and not tampering: this build cannot read it.
 * Upgrading reads it; downgrading is not supported.
 */
export class NewerVersionError extends SudoWallError {
  constructor(
    readonly info: NewerVersionInfo,
    action?: string,
  ) {
    super('NEWER_VERSION', newerVersionMessage(info, action));
    this.name = 'NewerVersionError';
  }
}

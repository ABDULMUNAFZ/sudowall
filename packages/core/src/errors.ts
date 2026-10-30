export const ERROR_CODES = [
  'INVALID_CONFIG',
  'INVALID_EVENT',
  'UNSUPPORTED_SCHEMA_VERSION',
  'MIGRATION_FAILED',
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

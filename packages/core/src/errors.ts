export const ERROR_CODES = [
  'INVALID_CONFIG',
  'INVALID_EVENT',
  'UNSUPPORTED_SCHEMA_VERSION',
  'MIGRATION_FAILED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Base error for every failure Tortoise Gate reports. Messages must never contain secret values. */
export class TortoiseGateError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TortoiseGateError';
    this.code = code;
  }
}

import { z } from 'zod';
import { ConfigSchema, type Config } from './config.js';
import { TortoiseGateError, type ErrorCode } from './errors.js';
import { EventSchema, type Event } from './events.js';
import { SCHEMA_VERSION } from './primitives.js';

/** Upgrades a raw document from version `from` to `from + 1`. Must be pure. */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Migrations keyed by the version they upgrade from. */
export type MigrationTable = ReadonlyMap<number, Migration>;

/** No versions before 1 exist yet, so there is nothing to migrate. */
export const EVENT_MIGRATIONS: MigrationTable = new Map();
export const CONFIG_MIGRATIONS: MigrationTable = new Map();

const VersionedSchema = z.looseObject({ schemaVersion: z.int().positive() });

/**
 * Brings a raw document up to `targetVersion` by applying migrations in order.
 * Rejects documents from a newer version: they may carry meaning this build cannot honour.
 */
export function migrate(
  raw: unknown,
  migrations: MigrationTable,
  targetVersion: number = SCHEMA_VERSION,
): Record<string, unknown> {
  const head = VersionedSchema.safeParse(raw);
  if (!head.success) {
    throw new TortoiseGateError(
      'UNSUPPORTED_SCHEMA_VERSION',
      'document has no valid "schemaVersion" (expected a positive integer)',
    );
  }
  let doc: Record<string, unknown> = head.data;
  let version = head.data.schemaVersion;
  if (version > targetVersion) {
    throw new TortoiseGateError(
      'UNSUPPORTED_SCHEMA_VERSION',
      `schemaVersion ${version} is newer than this build supports (${targetVersion}); upgrade Tortoise Gate`,
    );
  }
  while (version < targetVersion) {
    const step = migrations.get(version);
    if (step === undefined) {
      throw new TortoiseGateError(
        'UNSUPPORTED_SCHEMA_VERSION',
        `no migration from schemaVersion ${version}`,
      );
    }
    try {
      doc = { ...step(doc), schemaVersion: version + 1 };
    } catch (cause) {
      throw new TortoiseGateError(
        'MIGRATION_FAILED',
        `migration from schemaVersion ${version} failed`,
        { cause },
      );
    }
    version += 1;
  }
  return doc;
}

function parseWith<T>(
  schema: z.ZodType<T>,
  migrations: MigrationTable,
  code: ErrorCode,
  what: string,
  raw: unknown,
): T {
  const result = schema.safeParse(migrate(raw, migrations));
  if (!result.success) {
    throw new TortoiseGateError(code, `invalid ${what}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Validates (and if needed migrates) a stored event. */
export function parseEvent(raw: unknown): Event {
  return parseWith(EventSchema, EVENT_MIGRATIONS, 'INVALID_EVENT', 'event', raw);
}

/** Validates (and if needed migrates) a gateway config document, applying defaults. */
export function parseConfig(raw: unknown): Config {
  return parseWith(ConfigSchema, CONFIG_MIGRATIONS, 'INVALID_CONFIG', 'config', raw);
}

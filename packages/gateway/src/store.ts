import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@sudowall/core';
import {
  Ledger,
  Redactor,
  deriveKey,
  loadOrCreateKeys,
  type InstallationKeys,
} from '@sudowall/ledger';
import { PolicyStateStore } from '@sudowall/policy';
import { ProvenanceEngine } from '@sudowall/provenance';
import { ApprovalStore } from './approvals.js';
import type { Logger } from './log.js';

/** The product's former name. Its directories are still used if they exist and the new ones do not. */
const LEGACY_NAME = 'tortoisegate';

/** `<base>/sudowall`, or `<base>/tortoisegate` when only that one exists (data from before the rename). */
function productDir(base: string): string {
  const dir = join(base, 'sudowall');
  const legacy = join(base, LEGACY_NAME);
  return !existsSync(dir) && existsSync(legacy) ? legacy : dir;
}

/**
 * Per-user state directory (XDG on Linux; macOS and Windows equivalents).
 * An explicitly set XDG_STATE_HOME wins on every non-Windows platform, so
 * users and tests can relocate state on macOS too.
 */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    return productDir(env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'));
  }
  if (env['XDG_STATE_HOME']) return productDir(env['XDG_STATE_HOME']);
  if (process.platform === 'darwin') {
    return productDir(join(homedir(), 'Library', 'Application Support'));
  }
  return productDir(join(homedir(), '.local', 'state'));
}

/** Per-user config directory, which holds the installation keys. Same XDG rule as above. */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    return productDir(env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'));
  }
  if (env['XDG_CONFIG_HOME']) return productDir(env['XDG_CONFIG_HOME']);
  if (process.platform === 'darwin') {
    return productDir(join(homedir(), 'Library', 'Application Support'));
  }
  return productDir(join(homedir(), '.config'));
}

export interface StorePaths {
  /** The shared state database (ledger, provenance index, approvals, policy state). */
  dbPath: string;
  /** Directory with the signing key and HMAC secret. */
  keyDir: string;
}

export function storePaths(
  config: Pick<Config, 'ledger'>,
  env: NodeJS.ProcessEnv = process.env,
  stateDir = defaultStateDir(env),
): StorePaths {
  return {
    dbPath: config.ledger.path ?? join(stateDir, 'ledger.db'),
    keyDir: config.ledger.keyDir ?? defaultConfigDir(env),
  };
}

/**
 * Lazily opened installation keys and ledger for one gateway process. A failure is not cached:
 * the next use tries again, so a fixed problem (for example restored key permissions) recovers
 * without a restart, and until then every write reports it.
 */
export class GatewayStore {
  private keysCache: InstallationKeys | undefined;
  private ledgerCache: Ledger | undefined;
  private redactorCache: Redactor | undefined;
  private provenanceCache: ProvenanceEngine | undefined;
  private policyStateCache: PolicyStateStore | undefined;
  private approvalsCache: ApprovalStore | undefined;
  private closed = false;

  constructor(
    readonly paths: StorePaths,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  keys(): InstallationKeys {
    this.keysCache ??= loadOrCreateKeys(this.paths.keyDir);
    return this.keysCache;
  }

  redactor(): Redactor {
    this.redactorCache ??= new Redactor({
      rules: this.config.redaction.rules,
      userVersion: this.config.redaction.ruleVersion,
      hmacKey: deriveKey(this.keys().hmacSecret, 'redaction'),
    });
    return this.redactorCache;
  }

  ledger(): Ledger {
    if (this.closed) throw new Error('the ledger is closed');
    if (this.ledgerCache === undefined) {
      const l = this.config.ledger;
      this.ledgerCache = Ledger.open({
        path: this.paths.dbPath,
        keys: this.keys(),
        checkpointEveryEntries: l.checkpoint.everyEntries,
        checkpointEverySeconds: l.checkpoint.everySeconds,
        durability: l.durability,
        busyTimeoutMs: l.busyTimeoutMs,
        onError: (e) => {
          this.log.error('LEDGER CHECKPOINT FAILED', { error: e.message });
        },
      });
    }
    return this.ledgerCache;
  }

  /** The provenance index, in the shared state database. */
  provenance(): ProvenanceEngine {
    this.provenanceCache ??= new ProvenanceEngine({
      db: this.ledger().db,
      key: deriveKey(this.keys().hmacSecret, 'provenance-index'),
      trusted: this.config.trust.trustedTools,
      windowSeconds: this.config.provenance.windowSeconds,
    });
    return this.provenanceCache;
  }

  /** Policy state (`first_seen`), in the shared state database. */
  policyState(): PolicyStateStore {
    this.policyStateCache ??= new PolicyStateStore(
      this.ledger().db,
      deriveKey(this.keys().hmacSecret, 'policy-state'),
    );
    return this.policyStateCache;
  }

  /** Approvals, in the shared state database (decided in `sudowall ui`). */
  approvals(): ApprovalStore {
    this.approvalsCache ??= new ApprovalStore(this.ledger().db);
    return this.approvalsCache;
  }

  /** Signs pending entries and closes the database. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ledgerCache?.close();
    } catch (e) {
      this.log.error('LEDGER CLOSE FAILED', { error: (e as Error).message });
    }
  }
}

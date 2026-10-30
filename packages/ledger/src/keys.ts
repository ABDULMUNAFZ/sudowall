import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SIGNING_KEY_FILE = 'ledger-signing-key.pem';
export const HMAC_SECRET_FILE = 'hmac-secret.key';

export class KeyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyFileError';
  }
}

/** Per-installation key material. Never logged; only `keyId` and `publicKey` may be shown. */
export interface InstallationKeys {
  dir: string;
  privateKey: KeyObject;
  /** Raw 32-byte Ed25519 public key. */
  publicKey: Buffer;
  /** `hex(SHA-256(publicKey))[0..32]` (ledger-spec §3). */
  keyId: string;
  /** 32-byte secret; redaction and provenance-index keys are derived from it with HKDF. */
  hmacSecret: Buffer;
}

export function keyIdFor(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
}

export function rawPublicKey(key: KeyObject): Buffer {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new KeyFileError('signing key is not an Ed25519 key');
  }
  return Buffer.from(jwk.x, 'base64url');
}

export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new KeyFileError('an Ed25519 public key is 32 bytes');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
}

/**
 * Derives a 32-byte purpose-specific key from the installation secret. The `tortoisegate/` prefix
 * is the product's former name and is fixed: changing it would change every derived key.
 */
export function deriveKey(secret: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `tortoisegate/${purpose}`, 32));
}

/**
 * Creates `path` with `data` only if it does not exist, atomically across processes: write a
 * private temp file, then hard-link it into place (link fails if the target exists).
 */
function createExclusive(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(tmp, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  } finally {
    unlinkSync(tmp);
  }
}

function readPrivateFile(path: string): string {
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new KeyFileError(
        `${path} is accessible by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}`,
      );
    }
  }
  return readFileSync(path, 'utf8');
}

/**
 * Loads this installation's keys from `dir`, creating them on first use. Safe to call from
 * several processes at once: exactly one key pair and one secret are ever created.
 */
export function loadOrCreateKeys(dir: string): InstallationKeys {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, SIGNING_KEY_FILE);
  const secretPath = join(dir, HMAC_SECRET_FILE);
  try {
    statSync(keyPath);
  } catch {
    const { privateKey } = generateKeyPairSync('ed25519');
    createExclusive(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  }
  try {
    statSync(secretPath);
  } catch {
    createExclusive(secretPath, `${randomBytes(32).toString('hex')}\n`);
  }
  const privateKey = createPrivateKey(readPrivateFile(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new KeyFileError(`${keyPath} does not hold an Ed25519 private key`);
  }
  const secretHex = readPrivateFile(secretPath).trim();
  if (!/^[0-9a-f]{64}$/.test(secretHex)) {
    throw new KeyFileError(`${secretPath} is not a 32-byte hex secret`);
  }
  const publicKey = rawPublicKey(privateKey);
  return {
    dir,
    privateKey,
    publicKey,
    keyId: keyIdFor(publicKey),
    hmacSecret: Buffer.from(secretHex, 'hex'),
  };
}

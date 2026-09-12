import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Seals provider credentials (subaccount auth tokens, API key secrets, OAuth tokens) before they touch the
 * database. Only the worker holds the key; the database and its backups see ciphertext.
 */
export interface Sealer {
  /** Short id of the key new values are sealed with (recorded next to the ciphertext). */
  readonly keyId: string;
  seal(plain: string): string;
  open(sealed: string): string;
}

const b64 = (b: Buffer): string => b.toString('base64url');

export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

export function parseKey(value: string): Buffer {
  const key = Buffer.from(value.trim(), 'base64');
  if (key.length !== 32)
    throw new Error(
      'WORKER_ENCRYPTION_KEY must be 32 random bytes, base64 encoded (openssl rand -base64 32)',
    );
  return key;
}

/**
 * AES-256-GCM. Sealed values read `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url), so a rotated key can
 * still open what it sealed: pass the old keys as `previous` until every value is sealed again.
 */
export function createSealer(current: string, previous: readonly string[] = []): Sealer {
  const key = parseKey(current);
  const keyId = keyIdOf(key);
  const keys = new Map<string, Buffer>([[keyId, key]]);
  for (const p of previous) {
    const k = parseKey(p);
    keys.set(keyIdOf(k), k);
  }
  return {
    keyId,
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', keyId, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.');
    },
    open(sealed) {
      const [version, id, iv, tag, ct] = sealed.split('.');
      if (version !== 'v1' || !id || !iv || !tag || ct === undefined)
        throw new Error('This value was not sealed by the worker.');
      const k = keys.get(id);
      if (!k)
        throw new Error(
          `No key ${id} to open this value. Add the old key to WORKER_ENCRYPTION_KEYS_PREVIOUS.`,
        );
      const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ct, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

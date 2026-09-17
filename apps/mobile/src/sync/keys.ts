/**
 * Each person's key for their copy of the business on this phone: 256 random bits, kept in the iOS Keychain or the
 * Android Keystore (readable once the phone has been unlocked after starting, and never copied to another phone or a
 * backup). SQLCipher takes it in its raw form, `x'…'`, which skips the passphrase form's key derivation: that cost
 * 150–230 ms on every connection, and PowerSync opens six (spike 1a).
 *
 * The key never leaves this module except to open the database, and is never shown or logged.
 */

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** The Keychain entry for a person's key. */
export const keyName = (userId: string) => `hfos.copy-key.${userId}`;

const HEX_KEY = /^[0-9a-f]{64}$/;

/** A new key: 32 random bytes as 64 hex characters. */
export function newKey(randomBytes: (count: number) => Uint8Array): string {
  const bytes = randomBytes(32);
  if (bytes.length !== 32) throw new Error('Expected 32 random bytes for a key.');
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SQLCipher's raw-key form: the 256-bit key itself, so no key derivation runs when a connection opens. */
export function rawKeyForm(key: string): string {
  return `x'${key}'`;
}

export class CopyKeys {
  constructor(
    private readonly store: SecretStore,
    private readonly randomBytes: (count: number) => Uint8Array,
  ) {}

  /** The person's key, or null when there isn't one (or what's stored isn't a key). */
  async read(userId: string): Promise<string | null> {
    const value = await this.store.get(keyName(userId));
    return value && HEX_KEY.test(value) ? value : null;
  }

  /**
   * A new key in place of whatever was there. Used whenever there's no copy for the key to open: the Keychain outlives
   * deleting the app, so a key found without its file is stale and never reused.
   */
  async replace(userId: string): Promise<string> {
    const key = newKey(this.randomBytes);
    await this.store.set(keyName(userId), key);
    return key;
  }

  /** Deletes the person's key: after signing out with nothing waiting, their copy is gone too. */
  async remove(userId: string): Promise<void> {
    await this.store.delete(keyName(userId));
  }
}

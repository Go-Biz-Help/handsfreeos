const CREDENTIAL_SEGMENTS = new Set([
  'token',
  'secret',
  'hash',
  'password',
  'passcode',
  'passphrase',
  'authorization',
  'credential',
  'credentials',
]);
const KEY_QUALIFIERS = new Set([
  'api',
  'private',
  'access',
  'secret',
  'signing',
  'session',
  'refresh',
  'encryption',
]);

function segments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True for keys that name a credential: token, secret, password, *_hash, api_key, private_key, ... */
export function isDenylistedKey(key: string): boolean {
  const segs = segments(key);
  if (segs.some((s) => CREDENTIAL_SEGMENTS.has(s))) return true;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] === 'key' && KEY_QUALIFIERS.has(segs[i - 1]!)) return true;
  }
  return false;
}

/** Drops any credential-looking key at any depth before a value is stored in events or audit rows. */
export function redact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (isDenylistedKey(key)) continue;
    out[key] =
      v instanceof Date
        ? v.toISOString()
        : v && typeof v === 'object' && !Array.isArray(v)
          ? redact(v as Record<string, unknown>)
          : v;
  }
  return out;
}

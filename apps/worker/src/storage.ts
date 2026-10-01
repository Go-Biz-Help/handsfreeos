import { createClient } from '@supabase/supabase-js';

/**
 * The worker's access to Supabase Storage with its own key. Every caller asserts the object path
 * lies inside the job's workspace prefix before touching an object (see handlers/file-removed.ts).
 */
export interface ObjectStore {
  /** Removes an object; a missing object is not an error (handlers are at-least-once). */
  remove(bucket: string, path: string): Promise<void>;
  download(bucket: string, path: string): Promise<Buffer>;
  exists(bucket: string, path: string): Promise<boolean>;
  /** Server-side copies (MMS photos, recordings, the seed); people upload from the browser with their own session. */
  upload(
    bucket: string,
    path: string,
    data: Buffer,
    contentType: string,
    opts?: { upsert?: boolean },
  ): Promise<void>;
  /** A short-lived link a provider can fetch (outbound picture messages). */
  signedUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string>;
  /**
   * A one-time link to put one new object at `path` (a customer's upload from their portal, who has no session of
   * their own with Storage). It works for two hours, once, and never replaces an object already there.
   */
  signedUploadUrl(bucket: string, path: string): Promise<string>;
  /**
   * Whether Storage answers this key at all, for the line the worker logs as it starts. A key that is set but
   * not accepted looked exactly like a working one until a customer left a voicemail.
   */
  check(bucket: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * New-format Supabase API keys (`sb_publishable_…`, `sb_secret_…`) are not JWTs, and Storage reads the
 * `Authorization` header as one. supabase-js sends the key there anyway whenever nobody is signed in — which,
 * for the worker, is always — so every call with a `sb_secret_…` key came back `Invalid Compact JWS`. That is
 * what swallowed every voicemail recording this business ever took: the upload failed, so the call was never
 * marked a voicemail, so there was nothing to play, nothing to transcribe and nothing for the AI to read.
 *
 * The key belongs in `apikey` alone. supabase-js already does exactly that for Edge Functions (its internal
 * `omitApiKeyAsBearer`), and it leaves an `Authorization` header alone once something has set one, but neither
 * is reachable from `createClient`. So the header comes off here, on the way out. A legacy `service_role` JWT
 * is a JWT and keeps the bearer it has always had.
 */
const NEW_API_KEY = /^sb_(?:publishable|secret)_/;

export const keyIsNewFormat = (key: string): boolean => NEW_API_KEY.test(key);

/** Sends the key as `apikey` only, for a key that is not a JWT. Any other key is passed through untouched. */
export function apiKeyOnlyFetch(key: string, base: typeof fetch = fetch): typeof fetch {
  if (!keyIsNewFormat(key)) return base;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('apikey', key);
    headers.delete('authorization');
    return base(input, { ...init, headers });
  };
}

/**
 * What a rejected key looks like, in words somebody can act on. Storage answers a non-JWT bearer with jose's
 * own "Invalid Compact JWS", which says nothing about which key is wrong or where it is set.
 */
function credentialError(message: string): string {
  return /compact jws|invalid jwt|jwt|signature verification/i.test(message)
    ? `${message} — Supabase would not take SUPABASE_SECRET_KEY. Check the worker's key is the ` +
        `sb_secret_… key from Project Settings → API Keys (not the publishable key and not the JWT secret).`
    : message;
}

export function createSupabaseStore(url: string, secretKey: string): ObjectStore {
  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: apiKeyOnlyFetch(secretKey) },
  });
  return {
    async remove(bucket, path) {
      const { error } = await client.storage.from(bucket).remove([path]);
      if (error && !/not found/i.test(error.message))
        throw new Error(`storage remove failed: ${credentialError(error.message)}`);
    },
    async download(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error || !data)
        throw new Error(`storage download failed: ${credentialError(error?.message ?? 'no data')}`);
      return Buffer.from(await data.arrayBuffer());
    },
    async upload(bucket, path, data, contentType, opts) {
      const { error } = await client.storage
        .from(bucket)
        .upload(path, data, { contentType, upsert: opts?.upsert ?? false });
      if (error) throw new Error(`storage upload failed: ${credentialError(error.message)}`);
    },
    async exists(bucket, path) {
      const dir = path.split('/').slice(0, -1).join('/');
      const name = path.split('/').pop()!;
      const { data, error } = await client.storage
        .from(bucket)
        .list(dir, { search: name, limit: 100 });
      if (error) throw new Error(`storage list failed: ${credentialError(error.message)}`);
      return (data ?? []).some((o) => o.name === name);
    },
    async signedUrl(bucket, path, expiresInSeconds) {
      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUrl(path, expiresInSeconds);
      if (error || !data?.signedUrl)
        throw new Error(
          `storage signed url failed: ${credentialError(error?.message ?? 'no url')}`,
        );
      return data.signedUrl;
    },
    async signedUploadUrl(bucket, path) {
      const { data, error } = await client.storage.from(bucket).createSignedUploadUrl(path);
      if (error || !data?.signedUrl)
        throw new Error(
          `storage signed upload url failed: ${credentialError(error?.message ?? 'no url')}`,
        );
      return data.signedUrl;
    },
    async check(bucket) {
      // Listing an empty prefix touches the bucket and its rules without writing anything. An empty answer is
      // a pass: the question is whether Storage takes the key, not whether anything is in there yet.
      const { error } = await client.storage.from(bucket).list('', { limit: 1 });
      return error ? { ok: false, error: credentialError(error.message) } : { ok: true };
    },
  };
}

const notConfigured = async (): Promise<never> => {
  throw new Error(
    'Storage is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY for the worker',
  );
};

/** Used when SUPABASE_URL / SUPABASE_SECRET_KEY are not set: storage jobs fail loudly and retry. */
export const unconfiguredStore: ObjectStore = {
  remove: notConfigured,
  download: notConfigured,
  exists: notConfigured,
  upload: notConfigured,
  signedUrl: notConfigured,
  signedUploadUrl: notConfigured,
  check: async () => ({ ok: false, error: 'SUPABASE_URL and SUPABASE_SECRET_KEY are not set' }),
};

/**
 * The worker's Supabase credential, and the two places it used to go wrong quietly.
 *
 * A business left a voicemail on its own number and could not listen to it. The recording reached us, the webhook
 * was signed and accepted, and then the upload answered `Invalid Compact JWS` five times and gave up. The cause
 * was here: supabase-js sends the project key as `Authorization: Bearer …` whenever nobody is signed in, Storage
 * reads that header as a JWT, and a new-format `sb_secret_…` key is not one. Nothing in the app said so — the
 * call simply stopped being a voicemail.
 */
import { describe, expect, it } from 'vitest';
import { supabaseKeyLooksRight } from '../src/env';
import { apiKeyOnlyFetch, keyIsNewFormat } from '../src/storage';

const SECRET = 'sb_secret_abcdefghijklmnop';
const LEGACY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl';

/** What a request came out as: the headers supabase-js set, after our fetch has had them. */
async function headersOf(key: string, sent: Record<string, string>) {
  let seen: Headers | null = null;
  const base: typeof fetch = async (_input, init) => {
    seen = new Headers(init?.headers);
    return new Response('{}', { status: 200 });
  };
  await apiKeyOnlyFetch(key, base)(
    'https://project.supabase.co/storage/v1/object/telephony/a.mp3',
    {
      method: 'POST',
      headers: sent,
    },
  );
  return seen as unknown as Headers;
}

describe('the key the worker sends Storage', () => {
  it('sends a new-format secret key as apikey only, never as a bearer token', async () => {
    // What supabase-js builds when there is no session: the key in both headers.
    const headers = await headersOf(SECRET, { apikey: SECRET, Authorization: `Bearer ${SECRET}` });
    expect(headers.get('apikey')).toBe(SECRET);
    expect(headers.get('authorization')).toBeNull();
  });

  it('leaves a legacy service_role JWT exactly as it was', async () => {
    const headers = await headersOf(LEGACY_JWT, {
      apikey: LEGACY_JWT,
      Authorization: `Bearer ${LEGACY_JWT}`,
    });
    expect(headers.get('authorization')).toBe(`Bearer ${LEGACY_JWT}`);
  });

  it('keeps a signed-in person’s own token, which is a JWT and is meant to be there', async () => {
    // The browser signs its own uploads; only the worker has no session to speak of.
    const userJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2ln';
    const headers = await headersOf(LEGACY_JWT, {
      apikey: LEGACY_JWT,
      Authorization: `Bearer ${userJwt}`,
    });
    expect(headers.get('authorization')).toBe(`Bearer ${userJwt}`);
  });

  it('knows which keys are the new format', () => {
    expect(keyIsNewFormat(SECRET)).toBe(true);
    expect(keyIsNewFormat('sb_publishable_xyz')).toBe(true);
    expect(keyIsNewFormat(LEGACY_JWT)).toBe(false);
  });
});

describe('what the worker refuses to start with', () => {
  it('takes a secret key or a legacy service_role JWT', () => {
    expect(supabaseKeyLooksRight(SECRET)).toBe(true);
    expect(supabaseKeyLooksRight(LEGACY_JWT)).toBe(true);
  });

  it('refuses the values people paste in by mistake', () => {
    // The publishable key sits above the secret one on the same page, and cannot write.
    expect(supabaseKeyLooksRight('sb_publishable_abcdefghijklmnop')).toBe(false);
    // The JWT *secret* is on the API page too, and is not a JWT itself.
    expect(supabaseKeyLooksRight('super-secret-jwt-token-with-at-least-32-characters')).toBe(false);
    expect(supabaseKeyLooksRight('')).toBe(false);
    // A key that arrived with the newline the terminal put on the end of it.
    expect(supabaseKeyLooksRight(`${LEGACY_JWT}\n`)).toBe(false);
  });
});

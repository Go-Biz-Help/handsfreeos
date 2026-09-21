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

/**
 * A legacy `service_role` key's *shape*, built here rather than written out. The whole subject of this file is a
 * value that looks exactly like a Supabase key, which is precisely what the repo's secret scan exists to keep out
 * of the source — and it is right to: a reader skimming a diff cannot tell a fixture from the real thing either.
 * Nothing below is or ever was a key.
 */
const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const LEGACY_JWT = [
  part({ alg: 'HS256', typ: 'JWT' }),
  part({ role: 'service_role', note: 'a fixture, never a key' }),
  'not-a-signature',
].join('.');
/** A signed-in person's own token, which is a JWT and is meant to be in the header. Built the same way. */
const USER_JWT = [
  part({ alg: 'HS256', typ: 'JWT' }),
  part({ sub: 'a-person' }),
  'not-a-signature',
].join('.');

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
    const headers = await headersOf(LEGACY_JWT, {
      apikey: LEGACY_JWT,
      Authorization: `Bearer ${USER_JWT}`,
    });
    expect(headers.get('authorization')).toBe(`Bearer ${USER_JWT}`);
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

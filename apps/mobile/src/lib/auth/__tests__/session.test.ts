/// <reference types="node" />
import { createClient, type AuthChangeEvent, type Session } from '@supabase/supabase-js';

import { withRefreshGuard } from '../refresh-fetch';
import { SessionStore, nextState, readSaved, refreshIsDue, type SessionState } from '../session';

/**
 * The offline sign-in rules, against a real supabase-js client with its network and storage replaced: a saved sign-in
 * counts while offline even after its access token runs out, it refreshes when signal returns, and only a real
 * refusal from Supabase Auth signs the person out.
 */

const KEY = 'hfos.session';
const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  aud: 'authenticated',
  email: 'dale@lonestarhvac.test',
  user_metadata: { full_name: 'Dale Ramsey' },
  app_metadata: {},
  created_at: '2026-09-01T00:00:00Z',
};

function jwt(expSeconds: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'ES256', typ: 'JWT' })}.${part({ sub: USER.id, exp: expSeconds, role: 'authenticated' })}.sig`;
}

function savedSession(expiresAt: number, refreshToken = 'refresh-1') {
  return {
    access_token: jwt(expiresAt),
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    user: USER,
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

type Responder = (url: string) => Promise<Response> | Response;

function setup(respond: Responder, stored: object | null) {
  const values = new Map<string, string>();
  if (stored) values.set(KEY, JSON.stringify(stored));
  const storage = {
    getItem: async (k: string) => values.get(k) ?? null,
    setItem: async (k: string, v: string) => void values.set(k, v),
    removeItem: async (k: string) => void values.delete(k),
  };
  const requests: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    return respond(url);
  }) as typeof fetch;
  const client = createClient('http://auth.test', 'sb_publishable_test', {
    auth: {
      storage,
      storageKey: KEY,
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: { fetch: withRefreshGuard(fakeFetch) },
  });
  const store = new SessionStore(client, {
    read: () => storage.getItem(KEY),
    clear: async () => {
      await storage.removeItem(KEY);
      await storage.removeItem(`${KEY}-user`);
    },
  });
  return { client, store, values, requests };
}

const json = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const noSignal: Responder = () => Promise.reject(new TypeError('Network request failed'));

/** Lets supabase-js's retries and our deferred event handling run on fake timers. */
async function settle(promise?: Promise<unknown>) {
  await jest.advanceTimersByTimeAsync(45_000);
  return promise;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('offline, with the access token run out', () => {
  it('stays signed in although supabase-js reports no session', async () => {
    const { client, store, values } = setup(noSignal, savedSession(nowSeconds() - 3600));
    await store.start();
    const { data } = (await settle(client.auth.getSession())) as Awaited<
      ReturnType<typeof client.auth.getSession>
    >;
    // The trap: supabase-js says nobody is signed in an hour into a dead zone.
    expect(data.session).toBeNull();
    // The app still counts the saved sign-in, and it's still on the phone.
    await store.handle('INITIAL_SESSION', null);
    expect(store.getState()).toMatchObject({ status: 'signedIn', person: { userId: USER.id } });
    expect(values.has(KEY)).toBe(true);
    await expect(store.accessToken()).resolves.toBeNull();
  });

  it.each([
    ['a Wi-Fi login page', () => new Response('<html>Log in to the Wi-Fi</html>', { status: 511 })],
    ['a proxy’s error page', () => new Response('Bad gateway', { status: 403 })],
    ['a rate limit', () => json(429, { code: 'over_request_rate_limit', message: 'Too many' })],
    ['a timeout', () => json(408, { message: 'Request timeout' })],
    ['a server error', () => json(500, { code: 'unexpected_failure', message: 'Oops' })],
  ])('keeps the sign-in when the refresh gets %s', async (_what, response) => {
    const { client, store, values, requests } = setup(response, savedSession(nowSeconds() - 3600));
    await store.start();
    await settle(client.auth.refreshSession());
    await settle();
    expect(requests.some((u) => u.includes('grant_type=refresh_token'))).toBe(true);
    expect(values.has(KEY)).toBe(true);
    expect(store.getState().status).toBe('signedIn');
  });

  it('would sign out on a Wi-Fi login page without the refresh guard (why the guard exists)', async () => {
    const values = new Map([[KEY, JSON.stringify(savedSession(nowSeconds() - 3600))]]);
    const client = createClient('http://auth.test', 'sb_publishable_test', {
      auth: {
        storage: {
          getItem: async (k: string) => values.get(k) ?? null,
          setItem: async (k: string, v: string) => void values.set(k, v),
          removeItem: async (k: string) => void values.delete(k),
        },
        storageKey: KEY,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (async () =>
          new Response('<html>Log in to the Wi-Fi</html>', { status: 511 })) as typeof fetch,
      },
    });
    await settle(client.auth.refreshSession());
    expect(values.has(KEY)).toBe(false);
  });
});

describe('signal returns', () => {
  it('refreshes the run-out token and stays signed in', async () => {
    let online = false;
    const fresh = savedSession(nowSeconds() + 3600, 'refresh-2');
    const { store, values, requests } = setup(
      (url) =>
        online && url.includes('grant_type=refresh_token') ? json(200, fresh) : noSignal(url),
      savedSession(nowSeconds() - 3600),
    );
    await store.start();
    online = true;
    await settle(store.refreshIfDue());
    await settle();
    expect(requests.some((u) => u.includes('grant_type=refresh_token'))).toBe(true);
    expect(JSON.parse(values.get(KEY)!).refresh_token).toBe('refresh-2');
    expect(store.getState()).toMatchObject({ status: 'signedIn', expiresAt: fresh.expires_at });
    await expect(store.accessToken()).resolves.toBe(fresh.access_token);
  });
});

describe('a real refusal', () => {
  it.each([
    [
      'the refresh token was revoked',
      400,
      { code: 'refresh_token_not_found', message: 'Invalid Refresh Token' },
    ],
    [
      'the refresh token was already used',
      400,
      { code: 'refresh_token_already_used', message: 'Already used' },
    ],
    ['the session ended', 403, { code: 'session_expired', message: 'Session expired' }],
    ['the person was banned', 403, { code: 'user_banned', message: 'User is banned' }],
    [
      'the token is not valid (legacy body)',
      400,
      { code: 400, error_code: 'validation_failed', msg: 'Refresh token is not valid' },
    ],
  ])('signs out when %s, and says the sign-in ended', async (_what, status, body) => {
    const { client, store, values } = setup(
      () => json(status, body),
      savedSession(nowSeconds() - 3600),
    );
    await store.start();
    await settle(client.auth.refreshSession());
    await settle();
    expect(values.has(KEY)).toBe(false);
    expect(store.getState()).toEqual({ status: 'signedOut', ended: true });
  });
});

describe('signing out', () => {
  it('works with no signal and an old token, and isn’t shown as an ended sign-in', async () => {
    const { store, values } = setup(noSignal, savedSession(nowSeconds() - 3600));
    await store.start();
    await settle(store.signOut());
    await settle();
    expect(values.has(KEY)).toBe(false);
    expect(store.getState()).toEqual({ status: 'signedOut', ended: false });
  });
});

describe('rules', () => {
  const person = { userId: USER.id, email: USER.email, name: 'Dale Ramsey' };
  const signedIn: SessionState = { status: 'signedIn', person, expiresAt: 100 };

  it('reads a saved sign-in, however old its token', () => {
    expect(readSaved(JSON.stringify(savedSession(1)))).toEqual({ person, expiresAt: 1 });
    expect(readSaved(null)).toBeNull();
    expect(readSaved('not json')).toBeNull();
    expect(readSaved(JSON.stringify({ ...savedSession(1), refresh_token: '' }))).toBeNull();
    expect(readSaved(JSON.stringify({ ...savedSession(1), user: null }))).toBeNull();
  });

  it('follows the events supabase-js sends', () => {
    const session = savedSession(200) as unknown as Session;
    const saved = { person, expiresAt: 100 };
    const next = (
      event: AuthChangeEvent,
      s: Session | null,
      stillSaved: boolean,
      signingOut = false,
    ) => nextState(signedIn, event, s, stillSaved ? saved : null, signingOut);
    expect(next('TOKEN_REFRESHED', session, true)).toEqual({ ...signedIn, expiresAt: 200 });
    expect(next('INITIAL_SESSION', null, true)).toEqual(signedIn);
    expect(next('INITIAL_SESSION', null, false)).toEqual({ status: 'signedOut', ended: true });
    expect(next('SIGNED_OUT', null, false)).toEqual({ status: 'signedOut', ended: true });
    expect(next('SIGNED_OUT', null, false, true)).toEqual({ status: 'signedOut', ended: false });
    expect(
      nextState({ status: 'signedOut', ended: false }, 'INITIAL_SESSION', null, null, false),
    ).toEqual({
      status: 'signedOut',
      ended: false,
    });
  });

  it('refreshes within 90 seconds of the token running out', () => {
    expect(refreshIsDue({ ...signedIn, expiresAt: 1000 }, 950_000)).toBe(true);
    expect(refreshIsDue({ ...signedIn, expiresAt: 1000 }, 5_000_000)).toBe(true);
    expect(refreshIsDue({ ...signedIn, expiresAt: 1000 }, 800_000)).toBe(false);
    expect(refreshIsDue({ status: 'signedOut', ended: false }, 0)).toBe(false);
  });
});

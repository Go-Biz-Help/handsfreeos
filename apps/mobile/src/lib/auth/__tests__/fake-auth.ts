/// <reference types="node" />
import { createClient } from '@supabase/supabase-js';

import { withRefreshGuard } from '../refresh-fetch';
import { SessionStore } from '../session';

/**
 * A real supabase-js client and SessionStore with the network and the phone's storage replaced, for tests of the
 * offline sign-in rules and of what depends on them (the phone copy's connector).
 */

export const KEY = 'hfos.session';
export const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  aud: 'authenticated',
  email: 'dale@lonestarhvac.test',
  user_metadata: { full_name: 'Dale Ramsey' },
  app_metadata: {},
  created_at: '2026-09-01T00:00:00Z',
};

export function jwt(expSeconds: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'ES256', typ: 'JWT' })}.${part({ sub: USER.id, exp: expSeconds, role: 'authenticated' })}.sig`;
}

export function savedSession(expiresAt: number, refreshToken = 'refresh-1') {
  return {
    access_token: jwt(expiresAt),
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    user: USER,
  };
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export type Responder = (url: string) => Promise<Response> | Response;

export function setup(respond: Responder, stored: object | null) {
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

export const json = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const noSignal: Responder = () => Promise.reject(new TypeError('Network request failed'));

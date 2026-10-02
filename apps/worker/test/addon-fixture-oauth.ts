/**
 * The made-up feed add-on's sign-in service (packages/core/test/addons/connection-fixture.ts, `signin`), as a
 * scripted service: what each sign-in test needs it to say. Nothing leaves the worker.
 */
import { ConnectionRefused } from '../src/addons/connections';
import type { AddonOAuthProvider } from '../src/addons/sign-ins';

export const signinCalls: string[] = [];
let refuseRefresh = false;
export const refuseNextRefresh = (on = true) => {
  refuseRefresh = on;
};

export const signinStub: AddonOAuthProvider = {
  authorizeUrl: ({ app, state, codeChallenge, redirectUri }) =>
    `https://signin.example/authorize?${new URLSearchParams({
      client_id: app['clientId'] ?? '',
      state,
      code_challenge: codeChallenge,
      redirect_uri: redirectUri,
    }).toString()}`,
  exchange: async ({ code, codeVerifier }) => {
    signinCalls.push(`exchange ${code} ${codeVerifier.length}`);
    if (code === 'refused') throw new ConnectionRefused('Sign-in Feed turned that sign-in down.');
    return {
      tokens: { accessToken: 'real-access', refreshToken: 'real-refresh' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      label: 'feed@signin.example',
      accountRef: 'acct-1',
    };
  },
  refresh: async ({ tokens }) => {
    signinCalls.push(`refresh ${tokens['refreshToken']}`);
    if (refuseRefresh)
      throw new ConnectionRefused('Sign-in Feed turned the renewal down. Sign in again.');
    return {
      tokens: { accessToken: 'renewed-access' },
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  },
};

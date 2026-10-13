/**
 * Zoom, through a Zoom Marketplace OAuth app (user-managed). Sign-in uses PKCE; the token endpoint takes the
 * client id and secret as Basic auth, and Zoom hands out a new refresh token on every refresh. The scopes are
 * the ones set on the app in the Marketplace, so the authorize link doesn't list them; what comes back is
 * checked instead.
 */
import { oauthFailure, providerJson } from '../mailbox/provider';
import { MeetingError, type MeetingAccount, type MeetingProvider, type TokenSet } from './provider';

const AUTH = 'https://zoom.us/oauth/authorize';
const TOKEN = 'https://zoom.us/oauth/token';
const API = 'https://api.zoom.us/v2';

/**
 * What a connection needs, as the start of a scope name: Zoom's granular scopes (`meeting:write:meeting`,
 * `user:read:user`) and its classic ones (`meeting:write`, `user:read`) both count.
 */
export const ZOOM_NEEDED_SCOPES = ['meeting:write', 'user:read'] as const;

export function createZoom(opts: {
  clientId: string | null;
  clientSecret: string | null;
  fetch?: typeof fetch;
}): MeetingProvider {
  const f = opts.fetch ?? fetch;

  async function token(params: Record<string, string>): Promise<TokenSet> {
    if (!opts.clientId || !opts.clientSecret)
      throw new MeetingError('Zoom isn’t set up on this server yet.', null, true);
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    const res = await f(TOKEN, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
    });
    if (!res.ok) return oauthFailure('Zoom', res);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      // A minute early, so a refresh never starts with a token about to lapse.
      expiresAt: new Date(Date.now() + Math.max(60, body.expires_in - 60) * 1000).toISOString(),
      scopes: (body.scope ?? '').split(/[ ,]+/).filter(Boolean),
    };
  }

  return {
    name: 'zoom',
    configured: !!(opts.clientId && opts.clientSecret),
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: opts.clientId ?? '',
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${AUTH}?${q}`;
    },
    exchangeCode: ({ code, codeVerifier, redirectUri }) =>
      token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    async refresh(current) {
      if (!current.refreshToken)
        throw new MeetingError('There is no refresh token to renew the Zoom sign-in.', 401, true);
      const next = await token({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      });
      return { ...next, refreshToken: next.refreshToken ?? current.refreshToken };
    },
    async account(accessToken): Promise<MeetingAccount> {
      const me = await providerJson<{ id?: string; email?: string }>(
        'Zoom',
        await f(`${API}/users/me`, { headers: { authorization: `Bearer ${accessToken}` } }),
      );
      const email = (me.email ?? '').trim().toLowerCase();
      if (!email.includes('@') || !me.id)
        throw new MeetingError('Zoom didn’t say which account signed in.', null, true);
      return { email, id: me.id };
    },
    missingScopes: (granted) =>
      ZOOM_NEEDED_SCOPES.filter(
        (need) => !granted.some((s) => s === need || s.startsWith(`${need}:`)),
      ),
  };
}

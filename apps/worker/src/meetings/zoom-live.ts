/**
 * The coaching Zoom app (AI Sales Coach in meetings): a second Zoom Marketplace app, apart from the one that makes
 * meeting links (./zoom.ts), so a slow Zoom review of one never holds up the other (Chris, 2026-10-14).
 *
 * It needs to know only who a Zoom user is. Signing in exchanges Zoom's code for a token, reads `/users/me` once
 * for the user's id and email, and keeps neither token: nothing here calls Zoom again. Its client id and secret also
 * sign a meeting's live stream (./live.ts), and its webhook's secret token signs Zoom's events to
 * `/webhooks/zoom-live` (./live-routes.ts).
 *
 * The sign-in starts either from HandsFreeOS (Connect Zoom, with PKCE) or from Zoom's Marketplace (Add, which
 * reaches the callback with no state of ours, and so no PKCE).
 */
import { oauthFailure, providerJson } from '../mailbox/provider';
import { MeetingError } from './provider';

const AUTH = 'https://zoom.us/oauth/authorize';
const TOKEN = 'https://zoom.us/oauth/token';
const API = 'https://api.zoom.us/v2';

export interface ZoomIdentity {
  /** Zoom's id for the user, which its webhooks name. */
  readonly id: string;
  readonly email: string | null;
}

export interface ZoomLiveApp {
  readonly clientId: string;
  readonly clientSecret: string;
  /** What Zoom signs this app's webhooks with. */
  readonly webhookSecret: string;
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** Who signed in, from Zoom's code; `codeVerifier` is null when the sign-in began in Zoom's Marketplace. */
  identify(input: {
    code: string;
    codeVerifier: string | null;
    redirectUri: string;
  }): Promise<ZoomIdentity>;
}

export function createZoomLive(opts: {
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
  fetch?: typeof fetch;
}): ZoomLiveApp | null {
  const { clientId, clientSecret, webhookSecret } = opts;
  if (!clientId || !clientSecret || !webhookSecret) return null;
  const f = opts.fetch ?? fetch;
  return {
    clientId,
    clientSecret,
    webhookSecret,
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${AUTH}?${q}`;
    },
    async identify({ code, codeVerifier, redirectUri }) {
      const res = await f(TOKEN, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        }),
      });
      if (!res.ok) return oauthFailure('Zoom', res);
      const { access_token: token } = (await res.json()) as { access_token?: string };
      if (!token) throw new MeetingError('Zoom didn’t finish the sign-in.', null, true);
      const me = await providerJson<{ id?: string; email?: string }>(
        'Zoom',
        await f(`${API}/users/me`, { headers: { authorization: `Bearer ${token}` } }),
      );
      if (!me.id) throw new MeetingError('Zoom didn’t say which account signed in.', null, true);
      const email = (me.email ?? '').trim().toLowerCase();
      return { id: String(me.id).slice(0, 200), email: email.includes('@') ? email : null };
    },
  };
}

/** What the stand-in coaching app signs with, locally and in tests. */
export const FAKE_ZOOM_LIVE = {
  clientId: 'fake-zoom-live-client',
  clientSecret: 'fake-zoom-live-client-secret',
  webhookSecret: 'fake-zoom-live-webhook-secret',
} as const;

const enc = (s: string) => Buffer.from(s).toString('base64url');
const dec = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

/** A stand-in Zoom code for this user (tests make their own). */
export const fakeZoomLiveCode = (email: string) => `fakelive.${enc(email)}`;

/**
 * Locally and in tests: signing in to "Zoom" goes straight back with a code for `owner@zoom.fake`, and the code says
 * who it is. Its Zoom user id is made from the email.
 */
export function createFakeZoomLive(): ZoomLiveApp {
  return {
    ...FAKE_ZOOM_LIVE,
    authorizeUrl({ state, redirectUri }) {
      const q = new URLSearchParams({ code: fakeZoomLiveCode('owner@zoom.fake'), state });
      return `${redirectUri}?${q}`;
    },
    async identify({ code }) {
      const [prefix, body] = code.split('.');
      if (prefix !== 'fakelive' || !body)
        throw new MeetingError('Zoom didn’t accept that sign-in.', 400, false);
      const email = dec(body).toLowerCase();
      return { id: `fake-zoom-live-${enc(email).slice(0, 16)}`, email };
    },
  };
}

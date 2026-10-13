/**
 * Zoom, through a Zoom Marketplace OAuth app (user-managed). Sign-in uses PKCE; the token endpoint takes the
 * client id and secret as Basic auth, and Zoom hands out a new refresh token on every refresh. The scopes are
 * the ones set on the app in the Marketplace, so the authorize link doesn't list them; what comes back is
 * checked instead.
 */
import { oauthFailure, providerJson } from '../mailbox/provider';
import {
  MeetingError,
  type MadeMeeting,
  type MeetingAccount,
  type MeetingInput,
  type MeetingProvider,
  type TokenSet,
} from './provider';

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

  async function api<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await f(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    return providerJson<T>('Zoom', res);
  }
  const gone = (e: unknown) => e instanceof MeetingError && e.status === 404;
  // A scheduled meeting in UTC, with a waiting room; its join link carries the passcode Zoom makes.
  const body = (m: MeetingInput) => ({
    topic: m.topic.slice(0, 200),
    type: 2,
    start_time: m.start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration: Math.max(1, Math.round((m.end.getTime() - m.start.getTime()) / 60_000)),
    timezone: 'UTC',
    agenda: `HandsFreeOS appointment ${m.appointmentId}`,
    settings: { waiting_room: true, join_before_host: false },
  });

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
    async createMeeting(accessToken, m): Promise<MadeMeeting> {
      const made = await api<{ id?: number | string; join_url?: string }>(
        accessToken,
        '/users/me/meetings',
        { method: 'POST', body: JSON.stringify(body(m)) },
      );
      if (made.id === undefined || !made.join_url?.startsWith('https://'))
        throw new MeetingError('Zoom didn’t send back the new meeting’s link.', null);
      return { id: String(made.id), joinUrl: made.join_url };
    },
    async updateMeeting(accessToken, id, m) {
      try {
        await api(accessToken, `/meetings/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body(m)),
        });
        return 'updated';
      } catch (e) {
        if (gone(e)) return null;
        throw e;
      }
    },
    async deleteMeeting(accessToken, id) {
      try {
        await api(accessToken, `/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (e) {
        if (!gone(e)) throw e;
      }
    },
    async readSettings(accessToken) {
      const me = await api<{ type?: number }>(accessToken, '/users/me');
      const settings = await api<{
        recording?: { cloud_recording?: boolean; recording_audio_transcript?: boolean };
      }>(accessToken, '/users/me/settings');
      const flag = (v: unknown) => (typeof v === 'boolean' ? v : null);
      return {
        planType: typeof me.type === 'number' ? me.type : null,
        cloudRecording: flag(settings.recording?.cloud_recording),
        audioTranscript: flag(settings.recording?.recording_audio_transcript),
      };
    },
    missingScopes: (granted) =>
      ZOOM_NEEDED_SCOPES.filter(
        (need) => !granted.some((s) => s === need || s.startsWith(`${need}:`)),
      ),
  };
}

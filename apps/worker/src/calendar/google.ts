/**
 * Google Calendar through the Calendar API, on its own Google Cloud project (so calendars can pass Google's
 * review without waiting for Gmail's restricted-scope one). Busy times come from free/busy on the primary
 * calendar, which counts our own events too (the refresh takes them back out). Events use our own id, so a
 * retry lands on the same event, and `sendUpdates=none` with no attendees means nobody gets an email.
 */
import { oauthFailure, providerJson } from '../mailbox/provider';
import {
  CalendarAuthError,
  CalendarError,
  googleEventId,
  type BusyInterval,
  type CalendarEvent,
  type CalendarProvider,
  type TokenSet,
} from './provider';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
/** The two permissions a calendar connection needs. */
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events.owned',
];
/** `openid email` only tells us which account signed in (both are non-sensitive). */
const SCOPES = ['openid', 'email', ...GOOGLE_CALENDAR_SCOPES];
/** Free/busy is asked in stretches of 30 days or less. */
const WINDOW_MS = 30 * 86_400_000;

interface FreeBusy {
  calendars?: Record<
    string,
    { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }
  >;
}

interface GoogleEvent {
  id?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

/**
 * The Meet link Google made, once it's ready. A new one can come back still pending (no link yet); the next write
 * asks again with the same request id and picks it up.
 */
export function meetLinkOf(e: GoogleEvent): string | null {
  const link =
    e.hangoutLink ??
    e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ??
    null;
  return link && link.startsWith('https://') ? link : null;
}

export function createGoogleCalendar(opts: {
  clientId: string | null;
  clientSecret: string | null;
  fetch?: typeof fetch;
}): CalendarProvider {
  const f = opts.fetch ?? fetch;

  async function token(params: Record<string, string>): Promise<TokenSet> {
    if (!opts.clientId || !opts.clientSecret)
      throw new CalendarError('Google Calendar isn’t set up on this server yet.', null, true);
    const res = await f(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        ...params,
      }),
    });
    if (!res.ok) return oauthFailure('Google Calendar', res);
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
      scopes: (body.scope ?? '').split(' ').filter(Boolean),
    };
  }

  async function api<T>(accessToken: string, url: string, init: RequestInit = {}): Promise<T> {
    const res = await f(url.startsWith('https://') ? url : `${API}${url}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    return providerJson<T>('Google Calendar', res);
  }

  const gone = (e: unknown) => e instanceof CalendarError && (e.status === 404 || e.status === 410);
  // `conferenceDataVersion=1` lets a write make a Meet link; without it Google ignores `conferenceData`.
  const eventUrl = (id: string) =>
    `/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none&conferenceDataVersion=1`;
  // Never attendees: the event is for the person's own calendar, and nobody else hears about it. `confirmed`
  // also brings back an event the person deleted (Google keeps it as cancelled).
  const fields = (e: CalendarEvent) => ({
    summary: e.title,
    description: e.description,
    location: e.location ?? '',
    start: { dateTime: e.start.toISOString(), timeZone: 'UTC' },
    end: { dateTime: e.end.toISOString(), timeZone: 'UTC' },
    transparency: 'opaque',
    status: 'confirmed',
    extendedProperties: { private: { hfosAppointmentId: e.appointmentId } },
    // The request id is the appointment's, so a retry never makes a second Meet link.
    ...(e.addMeet
      ? {
          conferenceData: {
            createRequest: {
              requestId: `hfos-${e.appointmentId}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        }
      : {}),
  });
  const written = (made: GoogleEvent, fallbackId: string) => ({
    providerEventId: made.id ?? fallbackId,
    meetingUrl: meetLinkOf(made),
  });
  const patch = async (accessToken: string, id: string, e: CalendarEvent) =>
    written(
      await api<GoogleEvent>(accessToken, eventUrl(id), {
        method: 'PATCH',
        body: JSON.stringify(fields(e)),
      }),
      id,
    );

  return {
    name: 'google',
    configured: !!(opts.clientId && opts.clientSecret),
    busyIncludesOwnEvents: true,
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({
        client_id: opts.clientId ?? '',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        // Offline access and the consent screen every time, so a reconnect always brings a refresh token.
        access_type: 'offline',
        prompt: 'consent',
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
        throw new CalendarAuthError(
          'There is no refresh token to renew the sign-in.',
          'invalid_grant',
        );
      const next = await token({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      });
      // Google keeps the first refresh token unless it sends a new one.
      return { ...next, refreshToken: next.refreshToken ?? current.refreshToken };
    },
    async account(accessToken) {
      const me = await api<{ email?: string }>(accessToken, USERINFO);
      const email = (me.email ?? '').trim().toLowerCase();
      if (!email.includes('@'))
        throw new CalendarError('Google didn’t say which account this calendar is.', null, true);
      return { email };
    },
    missingScopes: (granted) => GOOGLE_CALENDAR_SCOPES.filter((s) => !granted.includes(s)),
    async busy(accessToken, from, to) {
      const out: BusyInterval[] = [];
      for (let start = from.getTime(); start < to.getTime(); start += WINDOW_MS) {
        const end = Math.min(start + WINDOW_MS, to.getTime());
        const answer = await api<FreeBusy>(accessToken, '/freeBusy', {
          method: 'POST',
          body: JSON.stringify({
            timeMin: new Date(start).toISOString(),
            timeMax: new Date(end).toISOString(),
            timeZone: 'UTC',
            items: [{ id: 'primary' }],
          }),
        });
        const primary = answer.calendars?.['primary'];
        if (!primary || (primary.errors?.length ?? 0) > 0)
          throw new CalendarError(
            `Google Calendar couldn’t read busy times (${primary?.errors?.[0]?.reason ?? 'no answer'}).`,
            null,
          );
        for (const b of primary.busy ?? [])
          out.push({ start: new Date(b.start), end: new Date(b.end) });
      }
      return out;
    },
    async upsertEvent(accessToken, e, existingId) {
      const id = googleEventId(e.appointmentId);
      if (existingId) {
        try {
          return await patch(accessToken, existingId, e);
        } catch (err) {
          if (!gone(err)) throw err;
        }
      }
      try {
        const made = await api<GoogleEvent>(
          accessToken,
          '/calendars/primary/events?sendUpdates=none&conferenceDataVersion=1',
          { method: 'POST', body: JSON.stringify({ id, ...fields(e) }) },
        );
        return written(made, id);
      } catch (err) {
        // Our id is taken, so the event is already there (a retry after a lost answer, or one the person
        // deleted): update it instead.
        if (!(err instanceof CalendarError && err.status === 409)) throw err;
        return await patch(accessToken, id, e);
      }
    },
    async deleteEvent(accessToken, providerEventId) {
      try {
        await api(accessToken, eventUrl(providerEventId), { method: 'DELETE' });
      } catch (err) {
        if (!gone(err)) throw err;
      }
    },
  };
}

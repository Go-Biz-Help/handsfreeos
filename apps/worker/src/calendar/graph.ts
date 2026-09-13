/**
 * Outlook and Microsoft 365 calendars through Microsoft Graph, on the same Entra app as Outlook mailboxes (with
 * Calendars.ReadWrite added). Busy times come from /me/calendarView, because getSchedule doesn't work for
 * personal accounts: free and cancelled events are skipped, and so are ours (they carry our extended property).
 * New events carry a transactionId and that property, so a retry finds the event it already made. Times are
 * always sent in UTC: Graph accepts only some IANA zone names.
 */
import { startOfLocalDay } from '@hfos/core/server';
import { oauthFailure, providerJson } from '../mailbox/provider';
import {
  CalendarAuthError,
  CalendarError,
  type BusyInterval,
  type CalendarEvent,
  type CalendarProvider,
  type TokenSet,
} from './provider';

const LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Calendars.ReadWrite',
];
const REQUIRED = ['Calendars.ReadWrite'];
/** HandsFreeOS's own property on the events it writes: a fixed GUID namespace and a name. */
export const HFOS_EVENT_PROPERTY =
  'String {8c2f4a61-3b7e-4d95-a0c8-6e1f9b2d7a43} Name hfosAppointmentId';
const PAGE = 250;
/** 10,000 events in 60 days is more than any calendar we serve; past that, what was read is used. */
const MAX_PAGES = 40;

interface GraphTime {
  dateTime?: string;
  timeZone?: string;
}
interface GraphEvent {
  id: string;
  showAs?: string;
  isCancelled?: boolean;
  isAllDay?: boolean;
  start?: GraphTime;
  end?: GraphTime;
  singleValueExtendedProperties?: { id?: string; value?: string }[];
}

/** Graph's wall-clock time in UTC ("2026-10-06T15:00:00.0000000") as an instant. */
function instant(t?: GraphTime): Date | null {
  if (!t?.dateTime) return null;
  const s = t.dateTime.replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(/(z|[+-]\d\d:\d\d)$/i.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * All-day events are dates, not instants: the day runs midnight to midnight in the business's time zone.
 * Graph gives them as UTC dates, and in the Americas the UTC date is the event's date either way.
 */
function allDay(e: GraphEvent, timeZone: string): BusyInterval | null {
  const from = e.start?.dateTime?.slice(0, 10) ?? '';
  const to = e.end?.dateTime?.slice(0, 10) ?? '';
  if (!LOCAL_DATE.test(from) || !LOCAL_DATE.test(to)) return null;
  return {
    start: new Date(startOfLocalDay(from, timeZone)),
    end: new Date(startOfLocalDay(to, timeZone)),
  };
}

const ours = (e: GraphEvent) =>
  (e.singleValueExtendedProperties ?? []).some(
    (p) => (p.id ?? '').toLowerCase() === HFOS_EVENT_PROPERTY.toLowerCase() && !!p.value,
  );

/** What Graph wants alongside timeZone "UTC": the wall clock, without an offset. */
const wall = (d: Date) => d.toISOString().slice(0, 19);

export function createGraphCalendar(opts: {
  clientId: string | null;
  clientSecret: string | null;
  fetch?: typeof fetch;
}): CalendarProvider {
  const f = opts.fetch ?? fetch;

  async function token(params: Record<string, string>): Promise<TokenSet> {
    if (!opts.clientId || !opts.clientSecret)
      throw new CalendarError('Outlook isn’t set up on this server yet.', null, true);
    const res = await f(`${LOGIN}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        scope: SCOPES.join(' '),
        ...params,
      }),
    });
    if (!res.ok) return oauthFailure('Microsoft', res);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: new Date(Date.now() + Math.max(60, body.expires_in - 60) * 1000).toISOString(),
      scopes: (body.scope ?? '').split(' ').filter(Boolean),
    };
  }

  // Immutable ids survive an event moving between calendars; times come back in UTC.
  async function api<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await f(path.startsWith('https://') ? path : `${GRAPH}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        prefer: `IdType="ImmutableId", outlook.timezone="UTC", odata.maxpagesize=${PAGE}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    return providerJson<T>('Outlook', res);
  }

  /** Our event for an appointment, found by our property (a retry after a lost answer, or a reconnect). */
  async function findOurs(accessToken: string, appointmentId: string): Promise<string | null> {
    const filter = encodeURIComponent(
      `singleValueExtendedProperties/Any(ep: ep/id eq '${HFOS_EVENT_PROPERTY}' and ep/value eq '${appointmentId}')`,
    );
    const found = await api<{ value?: { id: string }[] }>(
      accessToken,
      `/me/events?$filter=${filter}&$select=id&$top=1`,
    );
    return found.value?.[0]?.id ?? null;
  }

  // Never attendees: the event is for the person's own calendar, and nobody else hears about it.
  const fields = (e: CalendarEvent) => ({
    subject: e.title,
    body: { contentType: 'text', content: e.description },
    start: { dateTime: wall(e.start), timeZone: 'UTC' },
    end: { dateTime: wall(e.end), timeZone: 'UTC' },
    location: { displayName: e.location ?? '' },
    showAs: 'busy',
  });

  return {
    name: 'microsoft',
    configured: !!(opts.clientId && opts.clientSecret),
    busyIncludesOwnEvents: false,
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({
        client_id: opts.clientId ?? '',
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: SCOPES.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `${LOGIN}/authorize?${q}`;
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
      // Microsoft hands back a new refresh token every time; the old one goes with the old seal.
      const next = await token({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      });
      return { ...next, refreshToken: next.refreshToken ?? current.refreshToken };
    },
    async account(accessToken) {
      const me = await api<{ mail?: string | null; userPrincipalName?: string }>(
        accessToken,
        '/me?$select=mail,userPrincipalName',
      );
      const email = (me.mail || me.userPrincipalName || '').trim().toLowerCase();
      if (!email.includes('@'))
        throw new CalendarError('Microsoft didn’t say which account this calendar is.', null, true);
      return { email };
    },
    missingScopes: (granted) =>
      REQUIRED.filter((s) => !granted.some((g) => g.toLowerCase().endsWith(s.toLowerCase()))),
    async busy(accessToken, from, to, timeZone) {
      const expand = encodeURIComponent(
        `singleValueExtendedProperties($filter=id eq '${HFOS_EVENT_PROPERTY}')`,
      );
      let url =
        `/me/calendarView?startDateTime=${encodeURIComponent(from.toISOString())}` +
        `&endDateTime=${encodeURIComponent(to.toISOString())}` +
        `&$select=showAs,isCancelled,isAllDay,start,end&$expand=${expand}&$top=${PAGE}`;
      const out: BusyInterval[] = [];
      for (let pages = 0; url && pages < MAX_PAGES; pages++) {
        const page = await api<{ value?: GraphEvent[]; '@odata.nextLink'?: string }>(
          accessToken,
          url,
        );
        for (const e of page.value ?? []) {
          if (e.isCancelled || e.showAs === 'free' || ours(e)) continue;
          const span = e.isAllDay
            ? allDay(e, timeZone)
            : { start: instant(e.start), end: instant(e.end) };
          if (span?.start && span.end && span.end > span.start)
            out.push({ start: span.start, end: span.end });
        }
        url = page['@odata.nextLink'] ?? '';
      }
      return out;
    },
    async upsertEvent(accessToken, e, existingId) {
      const update = (id: string) =>
        api(accessToken, `/me/events/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(fields(e)),
        });
      if (existingId) {
        try {
          await update(existingId);
          return { providerEventId: existingId };
        } catch (err) {
          if (!(err instanceof CalendarError && err.status === 404)) throw err;
        }
      }
      const found = await findOurs(accessToken, e.appointmentId);
      if (found) {
        await update(found);
        return { providerEventId: found };
      }
      const made = await api<{ id: string }>(accessToken, '/me/events', {
        method: 'POST',
        body: JSON.stringify({
          ...fields(e),
          // The first write only: Graph drops a repeated create with the same transactionId. Making it again
          // after the person deleted it goes without, so Graph can't answer with the deleted one.
          ...(existingId ? {} : { transactionId: e.appointmentId }),
          singleValueExtendedProperties: [{ id: HFOS_EVENT_PROPERTY, value: e.appointmentId }],
        }),
      });
      return { providerEventId: made.id };
    },
    async deleteEvent(accessToken, providerEventId) {
      try {
        await api(accessToken, `/me/events/${encodeURIComponent(providerEventId)}`, {
          method: 'DELETE',
        });
      } catch (err) {
        if (!(err instanceof CalendarError && err.status === 404)) throw err;
      }
    },
  };
}

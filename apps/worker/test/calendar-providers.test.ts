/**
 * The real Google Calendar and Outlook calendar providers against recorded responses: no network, no accounts.
 * What they send (URLs, scopes, bodies, headers) and how they read what comes back is what's checked.
 */
import { describe, expect, it } from 'vitest';
import { createGoogleCalendar } from '../src/calendar/google';
import { createGraphCalendar, HFOS_EVENT_PROPERTY } from '../src/calendar/graph';
import {
  CalendarAuthError,
  CalendarError,
  type CalendarEvent,
  type TokenSet,
} from '../src/calendar/provider';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
type Route = (call: Call) => Response | undefined;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recorded(routes: Route[]) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const b = init.body;
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body:
        typeof b === 'string'
          ? b
          : b instanceof URLSearchParams
            ? b.toString()
            : b
              ? String(b)
              : '',
    };
    calls.push(call);
    for (const r of routes) {
      const res = r(call);
      if (res) return res;
    }
    return json({ error: { code: 'NotRecorded' } }, 404);
  }) as typeof fetch;
  return { f, calls };
}

const DAY = 86_400_000;
const APPOINTMENT = '0b6f3c1e-2d4a-4f8b-9c7e-1a2b3c4d5e6f';
const event: CalendarEvent = {
  appointmentId: APPOINTMENT,
  title: 'AC tune-up · Mike Johnson',
  description: 'With Mike Johnson',
  location: '12 Elm St, Austin, TX',
  start: new Date('2026-10-06T15:00:00Z'),
  end: new Date('2026-10-06T16:00:00Z'),
};
const parsed = (c: Call) => JSON.parse(c.body) as Record<string, unknown>;

describe('Google Calendar', () => {
  const google = (routes: Route[]) => {
    const r = recorded(routes);
    return {
      ...r,
      p: createGoogleCalendar({
        clientId: 'client-example',
        clientSecret: 'secret-example',
        fetch: r.f,
      }),
    };
  };

  it('asks for free/busy and its own events, offline, with consent and PKCE', () => {
    const { p } = google([]);
    const url = new URL(
      p.authorizeUrl({
        state: 'st',
        codeChallenge: 'ch',
        redirectUri: 'https://hooks.example/oauth/google/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/calendar.events.owned',
    ]);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // Google lets people untick a permission; both calendar ones are needed.
    expect(
      p.missingScopes(['openid', 'email', 'https://www.googleapis.com/auth/calendar.freebusy']),
    ).toEqual(['https://www.googleapis.com/auth/calendar.events.owned']);
  });

  it('reads 60 days of busy times in stretches of 30 days or less', async () => {
    const { p, calls } = google([
      (c) => {
        if (c.url !== 'https://www.googleapis.com/calendar/v3/freeBusy') return undefined;
        const min = Date.parse(String(parsed(c).timeMin));
        return json({
          calendars: {
            primary: {
              busy: [
                {
                  start: new Date(min + 3_600_000).toISOString(),
                  end: new Date(min + 7_200_000).toISOString(),
                },
              ],
            },
          },
        });
      },
    ]);
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date(from.getTime() + 60 * DAY);
    const busy = await p.busy('access-example', from, to, 'America/Chicago');
    expect(calls).toHaveLength(2);
    const windows = calls.map(parsed);
    for (const w of windows) {
      expect(Date.parse(String(w.timeMax)) - Date.parse(String(w.timeMin))).toBeLessThanOrEqual(
        30 * DAY,
      );
      expect(w.items).toEqual([{ id: 'primary' }]);
    }
    expect(windows[0]!.timeMin).toBe(from.toISOString());
    expect(windows[1]!.timeMin).toBe(windows[0]!.timeMax);
    expect(windows[1]!.timeMax).toBe(to.toISOString());
    expect(calls[0]!.headers.authorization).toBe('Bearer access-example');
    expect(busy.map((b) => b.start.toISOString())).toEqual([
      '2026-10-01T01:00:00.000Z',
      '2026-10-31T01:00:00.000Z',
    ]);
  });

  it('a calendar Google could not read is an error, not an empty calendar', async () => {
    const { p } = google([
      () =>
        json({ calendars: { primary: { errors: [{ domain: 'global', reason: 'notFound' }] } } }),
    ]);
    await expect(
      p.busy('a', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z'), 'UTC'),
    ).rejects.toBeInstanceOf(CalendarError);
  });

  it('writes events with our own id, no attendees and no emails; a taken id becomes an update', async () => {
    const id = APPOINTMENT.replace(/-/g, '');
    const { p, calls } = google([
      (c) =>
        c.method === 'POST' &&
        c.url === 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none'
          ? json({ error: { code: 409, message: 'The requested identifier already exists.' } }, 409)
          : undefined,
      (c) =>
        c.method === 'PATCH' &&
        c.url ===
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}?sendUpdates=none`
          ? json({ id })
          : undefined,
    ]);
    expect(await p.upsertEvent('a', event, null)).toEqual({ providerEventId: id });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(id).toMatch(/^[0-9a-v]{32}$/);
    const made = parsed(calls[0]!);
    expect(made).toMatchObject({
      id,
      summary: 'AC tune-up · Mike Johnson',
      location: '12 Elm St, Austin, TX',
      start: { dateTime: '2026-10-06T15:00:00.000Z' },
      end: { dateTime: '2026-10-06T16:00:00.000Z' },
      extendedProperties: { private: { hfosAppointmentId: APPOINTMENT } },
    });
    expect(made).not.toHaveProperty('attendees');
    // The update also brings back an event the person deleted (Google keeps it as cancelled).
    expect(parsed(calls[1]!)).toMatchObject({ status: 'confirmed' });
  });

  it('an event already gone counts as deleted; anything else is an error', async () => {
    const gone = google([() => json({ error: { code: 410 } }, 410)]);
    await expect(gone.p.deleteEvent('a', 'abc')).resolves.toBeUndefined();
    expect(gone.calls[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events/abc?sendUpdates=none',
    });
    const down = google([() => json({ error: { code: 500 } }, 500)]);
    await expect(down.p.deleteEvent('a', 'abc')).rejects.toBeInstanceOf(CalendarError);
  });

  it('a refused refresh token means reconnect', async () => {
    const { p } = google([() => json({ error: 'invalid_grant' }, 400)]);
    const tokens: TokenSet = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date().toISOString(),
      scopes: [],
    };
    await expect(p.refresh(tokens)).rejects.toBeInstanceOf(CalendarAuthError);
  });
});

describe('Outlook calendar (Microsoft Graph)', () => {
  const graph = (routes: Route[]) => {
    const r = recorded(routes);
    return {
      ...r,
      p: createGraphCalendar({
        clientId: 'client-example',
        clientSecret: 'secret-example',
        fetch: r.f,
      }),
    };
  };
  const utc = (t: string) => ({ dateTime: t, timeZone: 'UTC' });

  it('asks for Calendars.ReadWrite with offline access on the common endpoint', () => {
    const { p } = graph([]);
    const url = new URL(
      p.authorizeUrl({
        state: 'st',
        codeChallenge: 'ch',
        redirectUri: 'https://hooks.example/oauth/microsoft/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('scope')!.split(' ')).toEqual([
      'offline_access',
      'https://graph.microsoft.com/User.Read',
      'https://graph.microsoft.com/Calendars.ReadWrite',
    ]);
    expect(p.missingScopes(['https://graph.microsoft.com/User.Read'])).toEqual([
      'Calendars.ReadWrite',
    ]);
    expect(p.missingScopes(['https://graph.microsoft.com/Calendars.ReadWrite'])).toEqual([]);
  });

  it('pages calendarView in UTC, skipping free, cancelled and our own events; all-day events are the business’s days', async () => {
    const next = 'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=page2';
    const { p, calls } = graph([
      (c) =>
        c.url === next
          ? json({
              value: [
                {
                  id: 'e5',
                  showAs: 'oof',
                  isAllDay: true,
                  start: utc('2026-10-07T00:00:00.0000000'),
                  end: utc('2026-10-08T00:00:00.0000000'),
                },
              ],
            })
          : undefined,
      (c) =>
        c.url.startsWith('https://graph.microsoft.com/v1.0/me/calendarView?')
          ? json({
              value: [
                {
                  id: 'e1',
                  showAs: 'busy',
                  start: utc('2026-10-06T15:00:00.0000000'),
                  end: utc('2026-10-06T16:00:00.0000000'),
                },
                {
                  id: 'e2',
                  showAs: 'free',
                  start: utc('2026-10-06T17:00:00.0000000'),
                  end: utc('2026-10-06T18:00:00.0000000'),
                },
                {
                  id: 'e3',
                  showAs: 'busy',
                  isCancelled: true,
                  start: utc('2026-10-06T19:00:00.0000000'),
                  end: utc('2026-10-06T20:00:00.0000000'),
                },
                {
                  id: 'e4',
                  showAs: 'busy',
                  singleValueExtendedProperties: [{ id: HFOS_EVENT_PROPERTY, value: APPOINTMENT }],
                  start: utc('2026-10-06T21:00:00.0000000'),
                  end: utc('2026-10-06T22:00:00.0000000'),
                },
              ],
              '@odata.nextLink': next,
            })
          : undefined,
    ]);
    const busy = await p.busy(
      'access-example',
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-11-30T00:00:00Z'),
      'America/Chicago',
    );
    expect(busy.map((b) => [b.start.toISOString(), b.end.toISOString()])).toEqual([
      ['2026-10-06T15:00:00.000Z', '2026-10-06T16:00:00.000Z'],
      // Midnight to midnight in Chicago (daylight time).
      ['2026-10-07T05:00:00.000Z', '2026-10-08T05:00:00.000Z'],
    ]);
    expect(calls).toHaveLength(2);
    const first = new URL(calls[0]!.url);
    expect(first.pathname).toBe('/v1.0/me/calendarView');
    expect(first.searchParams.get('startDateTime')).toBe('2026-10-01T00:00:00.000Z');
    expect(first.searchParams.get('endDateTime')).toBe('2026-11-30T00:00:00.000Z');
    expect(first.searchParams.get('$expand')).toContain(HFOS_EVENT_PROPERTY);
    expect(calls[0]!.headers.prefer).toContain('outlook.timezone="UTC"');
    expect(calls[1]!.url).toBe(next);
  });

  it('makes a new event with a transactionId and our property, in UTC, never with attendees', async () => {
    const { p, calls } = graph([
      (c) =>
        c.method === 'GET' && c.url.includes('/me/events?$filter=')
          ? json({ value: [] })
          : undefined,
      (c) =>
        c.method === 'POST' && c.url === 'https://graph.microsoft.com/v1.0/me/events'
          ? json({ id: 'AAMk-1' }, 201)
          : undefined,
    ]);
    expect(await p.upsertEvent('a', event, null)).toEqual({ providerEventId: 'AAMk-1' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(decodeURIComponent(calls[0]!.url)).toContain(`ep/value eq '${APPOINTMENT}'`);
    const made = parsed(calls[1]!);
    expect(made).toMatchObject({
      subject: 'AC tune-up · Mike Johnson',
      transactionId: APPOINTMENT,
      start: { dateTime: '2026-10-06T15:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-10-06T16:00:00', timeZone: 'UTC' },
      location: { displayName: '12 Elm St, Austin, TX' },
      singleValueExtendedProperties: [{ id: HFOS_EVENT_PROPERTY, value: APPOINTMENT }],
    });
    expect(made).not.toHaveProperty('attendees');
  });

  it('a retry finds the event it already made and updates it instead', async () => {
    const { p, calls } = graph([
      (c) => (c.method === 'GET' ? json({ value: [{ id: 'AAMk-1' }] }) : undefined),
      (c) =>
        c.method === 'PATCH' && c.url === 'https://graph.microsoft.com/v1.0/me/events/AAMk-1'
          ? json({ id: 'AAMk-1' })
          : undefined,
    ]);
    expect(await p.upsertEvent('a', event, null)).toEqual({ providerEventId: 'AAMk-1' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
  });

  it('moves the stored event; one the person deleted is made again, without the old transactionId', async () => {
    const moved = graph([(c) => (c.method === 'PATCH' ? json({ id: 'AAMk-1' }) : undefined)]);
    expect(await moved.p.upsertEvent('a', event, 'AAMk-1')).toEqual({ providerEventId: 'AAMk-1' });
    expect(moved.calls.map((c) => c.method)).toEqual(['PATCH']);
    const deleted = graph([
      (c) =>
        c.method === 'PATCH' ? json({ error: { code: 'ErrorItemNotFound' } }, 404) : undefined,
      (c) => (c.method === 'GET' ? json({ value: [] }) : undefined),
      (c) => (c.method === 'POST' ? json({ id: 'AAMk-2' }, 201) : undefined),
    ]);
    expect(await deleted.p.upsertEvent('a', event, 'AAMk-1')).toEqual({
      providerEventId: 'AAMk-2',
    });
    expect(deleted.calls.map((c) => c.method)).toEqual(['PATCH', 'GET', 'POST']);
    expect(parsed(deleted.calls[2]!)).not.toHaveProperty('transactionId');
  });

  it('an event already gone counts as deleted', async () => {
    const { p, calls } = graph([() => json({ error: { code: 'ErrorItemNotFound' } }, 404)]);
    await expect(p.deleteEvent('a', 'AAMk-1')).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://graph.microsoft.com/v1.0/me/events/AAMk-1',
    });
  });
});

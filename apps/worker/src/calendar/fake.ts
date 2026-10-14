/**
 * Local and test calendars. Signing in is the worker's own stand-in page (the one connected mailboxes use,
 * with PKCE checked like the real thing), and each account's busy times and events live in memory: tests and
 * the browser specs add busy time, and what HandsFreeOS writes lands in the account's events. The Google
 * stand-in counts our own events as busy, like Google's free/busy; the Outlook one skips them, like Graph with
 * our property. Nothing here looks like a secret: the tokens name the account and say they're fake.
 */
import { randomBytes } from 'node:crypto';
import { intervals } from '@hfos/core/server';
import { pkceChallenge } from '../mailbox/provider';
import { GOOGLE_CALENDAR_SCOPES } from './google';
import {
  CalendarAuthError,
  CalendarError,
  googleEventId,
  type BusyInterval,
  type CalendarProvider,
  type CalendarProviderName,
  type TokenSet,
} from './provider';

export interface FakeCalendarEvent {
  readonly id: string;
  readonly appointmentId: string;
  readonly title: string;
  readonly description: string;
  readonly location: string | null;
  readonly start: string;
  readonly end: string;
  /** Always empty: HandsFreeOS never invites anyone. */
  readonly attendees: readonly string[];
  /** The Meet link the Google stand-in made, kept across later writes like Google keeps it. */
  readonly meetingUrl: string | null;
}

export interface FakeCalendars {
  readonly providers: Record<CalendarProviderName, CalendarProvider>;
  /** Something else in the account's calendar (a dentist appointment): busy, never shown. */
  addBusy(account: string, start: Date, end: Date): void;
  /** What HandsFreeOS wrote into the account's calendar. */
  events(account: string): readonly FakeCalendarEvent[];
  /** The account's sign-in stops working (until it signs in again), the way a revoked one does. */
  revoke(account: string): void;
}

const enc = (s: string) => Buffer.from(s).toString('base64url');
const dec = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
const HOUR = 3_600_000;
const SCOPES: Record<CalendarProviderName, readonly string[]> = {
  google: ['openid', 'email', ...GOOGLE_CALENDAR_SCOPES],
  microsoft: ['offline_access', 'User.Read', 'Calendars.ReadWrite'],
};

export function createFakeCalendars(opts: { publicUrl: string }): FakeCalendars {
  const busyTimes = new Map<string, BusyInterval[]>();
  const written = new Map<string, Map<string, FakeCalendarEvent>>();
  const revoked = new Set<string>();
  let seq = 0;
  const key = (account: string) => account.trim().toLowerCase();
  const eventsOf = (account: string) => {
    let list = written.get(key(account));
    if (!list) written.set(key(account), (list = new Map()));
    return list;
  };
  const tokens = (name: CalendarProviderName, email: string): TokenSet => ({
    accessToken: `fake-cal-access.${enc(email)}.${randomBytes(6).toString('hex')}`,
    refreshToken: `fake-cal-refresh.${enc(email)}`,
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
    scopes: [...SCOPES[name]],
  });
  const emailOf = (token: string) => {
    const [kind, who] = token.split('.');
    if (!kind?.startsWith('fake-cal-') || !who)
      throw new CalendarError('Not a fake calendar token.', 401);
    return dec(who);
  };

  // Extra permissions a sign-in asked for (Meet transcripts), by its PKCE challenge: granted on Allow.
  const extraByChallenge = new Map<string, readonly string[]>();
  const provider = (name: CalendarProviderName): CalendarProvider => ({
    name,
    configured: true,
    busyIncludesOwnEvents: name === 'google',
    authorizeUrl({ state, codeChallenge, redirectUri, extraScopes = [] }) {
      if (extraScopes.length) extraByChallenge.set(codeChallenge, extraScopes);
      const q = new URLSearchParams({
        state,
        code_challenge: codeChallenge,
        redirect_uri: redirectUri,
      });
      return `${opts.publicUrl}/oauth/fake/${name}/authorize?${q}`;
    },
    async exchangeCode({ code, codeVerifier }) {
      // The stand-in page's code (mailbox/fake.ts fakeCode): who signed in, and the PKCE challenge to check.
      const [prefix, body] = code.split('.');
      if (prefix !== 'fakecode' || !body) throw new CalendarAuthError('Bad code.', 'invalid_grant');
      const c = JSON.parse(dec(body)) as { email: string; challenge: string; provider: string };
      if (c.provider !== name || c.challenge !== pkceChallenge(codeVerifier))
        throw new CalendarAuthError('The code verifier does not match.', 'invalid_grant');
      revoked.delete(key(c.email));
      const t = tokens(name, c.email);
      const extra = extraByChallenge.get(c.challenge) ?? [];
      extraByChallenge.delete(c.challenge);
      return { ...t, scopes: [...t.scopes, ...extra] };
    },
    async refresh(current) {
      const email = emailOf(current.refreshToken ?? '');
      if (revoked.has(key(email)))
        throw new CalendarAuthError('The sign-in was revoked.', 'invalid_grant');
      return tokens(name, email);
    },
    async account(accessToken) {
      return { email: emailOf(accessToken) };
    },
    missingScopes: () => [],
    async busy(accessToken, from, to) {
      const account = emailOf(accessToken);
      const theirs = (busyTimes.get(key(account)) ?? []).map((b) => ({
        start: b.start.getTime(),
        end: b.end.getTime(),
      }));
      // Google's free/busy can't tell our events from theirs (and merges them); Graph skips ours.
      const ours =
        name === 'google'
          ? [...eventsOf(account).values()].map((e) => ({
              start: Date.parse(e.start),
              end: Date.parse(e.end),
            }))
          : [];
      return intervals
        .clip([...theirs, ...ours], from.getTime(), to.getTime())
        .map((i) => ({ start: new Date(i.start), end: new Date(i.end) }));
    },
    async upsertEvent(accessToken, e, existingId) {
      const list = eventsOf(emailOf(accessToken));
      // Google: our own id. Outlook: the stored id, else the event carrying our property, else a new one.
      const id =
        name === 'google'
          ? googleEventId(e.appointmentId)
          : ((existingId && list.has(existingId) ? existingId : null) ??
            [...list.values()].find((x) => x.appointmentId === e.appointmentId)?.id ??
            `fake-outlook-event-${++seq}`);
      // Google keeps a Meet link once made; the stand-in makes one from the appointment, so a retry gets the same.
      const meetingUrl =
        list.get(id)?.meetingUrl ??
        (name === 'google' && e.addMeet
          ? `https://meet.google.com/fake-${e.appointmentId.slice(0, 8)}`
          : null);
      list.set(id, {
        id,
        appointmentId: e.appointmentId,
        title: e.title,
        description: e.description,
        location: e.location,
        start: e.start.toISOString(),
        end: e.end.toISOString(),
        attendees: [],
        meetingUrl,
      });
      return { providerEventId: id, meetingUrl };
    },
    async deleteEvent(accessToken, providerEventId) {
      eventsOf(emailOf(accessToken)).delete(providerEventId);
    },
  });

  return {
    providers: { google: provider('google'), microsoft: provider('microsoft') },
    addBusy(account, start, end) {
      const list = busyTimes.get(key(account)) ?? [];
      list.push({ start, end });
      busyTimes.set(key(account), list);
    },
    events: (account) => [...eventsOf(account).values()],
    revoke(account) {
      revoked.add(key(account));
    },
  };
}

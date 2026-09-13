import type { WorkerEnv } from '../env';
import { createFakeCalendars, type FakeCalendars } from './fake';
import { createGoogleCalendar } from './google';
import { createGraphCalendar } from './graph';
import type { CalendarProvider, CalendarProviderName } from './provider';

/** People's own calendars: the providers, and how often each connected calendar's busy times are read again. */
export interface CalendarServices {
  readonly providers: Readonly<Record<CalendarProviderName, CalendarProvider>>;
  /** Local and tests: in-memory calendars, and a sign-in page on the worker. Null with the real providers. */
  readonly fake: FakeCalendars | null;
  readonly refreshEveryMs: number;
}

/** In-memory calendars (local development, tests and the seed). */
export function fakeCalendarServices(
  publicUrl: string,
  refreshEveryMs: number,
): CalendarServices & { readonly fake: FakeCalendars } {
  const fake = createFakeCalendars({ publicUrl });
  return { providers: fake.providers, fake, refreshEveryMs };
}

export function createCalendars(env: WorkerEnv): CalendarServices {
  if (env.calendarProvider === 'fake')
    return fakeCalendarServices(env.publicUrl, env.calendarRefreshMs);
  return {
    providers: {
      // Its own Google Cloud project, so calendars can pass Google's review apart from Gmail's.
      google: createGoogleCalendar({
        clientId: env.googleCalendarClientId,
        clientSecret: env.googleCalendarClientSecret,
      }),
      // The same Entra app as Outlook mailboxes, with Calendars.ReadWrite added.
      microsoft: createGraphCalendar({
        clientId: env.microsoftClientId,
        clientSecret: env.microsoftClientSecret,
      }),
    },
    fake: null,
    refreshEveryMs: env.calendarRefreshMs,
  };
}

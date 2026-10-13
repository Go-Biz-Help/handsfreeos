import type { WorkerEnv } from '../env';
import { createFakeCalendars, type FakeCalendars } from './fake';
import { createGoogleCalendar } from './google';
import { createGraphCalendar } from './graph';
import type { CalendarProvider, CalendarProviderName } from './provider';
import { createFakeZoom } from '../meetings/fake';
import type { MeetingProvider, MeetingProviderName } from '../meetings/provider';
import { createZoom } from '../meetings/zoom';

/** People's own calendars: the providers, and how often each connected calendar's busy times are read again. */
export interface CalendarServices {
  readonly providers: Readonly<Record<CalendarProviderName, CalendarProvider>>;
  /** Local and tests: in-memory calendars, and a sign-in page on the worker. Null with the real providers. */
  readonly fake: FakeCalendars | null;
  readonly refreshEveryMs: number;
  /** People's own video-meeting accounts (Zoom), signed in to beside their calendar. */
  readonly meetings: Readonly<Record<MeetingProviderName, MeetingProvider>>;
}

/** In-memory calendars (local development, tests and the seed). */
export function fakeCalendarServices(
  publicUrl: string,
  refreshEveryMs: number,
): CalendarServices & { readonly fake: FakeCalendars } {
  const fake = createFakeCalendars({ publicUrl });
  return {
    providers: fake.providers,
    fake,
    refreshEveryMs,
    meetings: { zoom: createFakeZoom({ publicUrl }) },
  };
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
    // A Zoom Marketplace OAuth app; without its keys the Zoom button says it isn't set up yet.
    meetings: {
      zoom: createZoom({ clientId: env.zoomClientId, clientSecret: env.zoomClientSecret }),
    },
  };
}

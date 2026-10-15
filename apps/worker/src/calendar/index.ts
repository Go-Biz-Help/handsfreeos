import type { WorkerEnv } from '../env';
import { createFakeCalendars, type FakeCalendars } from './fake';
import { createGoogleCalendar } from './google';
import { createGraphCalendar } from './graph';
import type { CalendarProvider, CalendarProviderName } from './provider';
import { createFakeZoom, FAKE_ZOOM_WEBHOOK_SECRET, type FakeZoom } from '../meetings/fake';
import { createFakeZoomLive, createZoomLive, type ZoomLiveApp } from '../meetings/zoom-live';
import {
  createFakeMeet,
  createGoogleMeet,
  type FakeMeet,
  type MeetTranscripts,
} from '../meetings/google-meet';
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
  /** Local and tests: the stand-in Zoom, to look at what was made. Null with the real one. */
  readonly fakeZoom: FakeZoom | null;
  /** What Zoom's webhooks are signed with; null leaves the webhook refusing everything. */
  readonly zoomWebhookSecret: string | null;
  /**
   * The coaching Zoom app (meetings/zoom-live.ts), apart from the meeting-link one: who a Zoom user is, and what signs
   * a meeting's live stream and the app's webhooks. Null without its keys, and no meeting is heard.
   */
  readonly zoomLive: ZoomLiveApp | null;
  /** Google Meet transcripts, read with the host's Google calendar sign-in. */
  readonly meet: MeetTranscripts;
  /** Local and tests: the stand-in Meet. Null with the real one. */
  readonly fakeMeet: FakeMeet | null;
}

/** In-memory calendars (local development, tests and the seed). */
export function fakeCalendarServices(
  publicUrl: string,
  refreshEveryMs: number,
): CalendarServices & { readonly fake: FakeCalendars } {
  const fake = createFakeCalendars({ publicUrl });
  const fakeZoom = createFakeZoom({ publicUrl });
  const fakeMeet = createFakeMeet();
  return {
    providers: fake.providers,
    fake,
    refreshEveryMs,
    meetings: { zoom: fakeZoom },
    fakeZoom,
    zoomWebhookSecret: FAKE_ZOOM_WEBHOOK_SECRET,
    zoomLive: createFakeZoomLive(),
    meet: fakeMeet,
    fakeMeet,
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
    fakeZoom: null,
    zoomWebhookSecret: env.zoomWebhookSecret,
    zoomLive: createZoomLive({
      clientId: env.zoomLiveClientId,
      clientSecret: env.zoomLiveClientSecret,
      webhookSecret: env.zoomLiveWebhookSecret,
    }),
    meet: createGoogleMeet(),
    fakeMeet: null,
  };
}

/**
 * People's own Google and Outlook calendars behind one seam, so the sign-in routes, the busy-time refresh and
 * the write-through never name a provider. Signing in is the same OAuth dance as connected mailboxes, so the
 * helpers (PKCE, token errors, the sealed TokenSet JSON) and the error classes are the mailbox's. A fake stands
 * in locally and in tests.
 */
import type { TokenSet } from '../mailbox/provider';

export type { TokenSet };
/** The same classes the mailbox sign-in throws: an auth error means "reconnect"; the other says whether to retry. */
export {
  MailboxAuthError as CalendarAuthError,
  MailboxError as CalendarError,
} from '../mailbox/provider';

export type CalendarProviderName = 'google' | 'microsoft';

export const CALENDAR_NAME: Record<CalendarProviderName, string> = {
  google: 'Google Calendar',
  microsoft: 'Outlook',
};

/** A stretch of busy time, as instants. Only times: never titles or anything else about the event. */
export interface BusyInterval {
  readonly start: Date;
  readonly end: Date;
}

/** One HandsFreeOS appointment as it shows in someone's calendar. Never attendees: nobody gets an invitation. */
export interface CalendarEvent {
  readonly appointmentId: string;
  readonly title: string;
  readonly description: string;
  readonly location: string | null;
  readonly start: Date;
  readonly end: Date;
  /**
   * Make a Google Meet link for it (Google only; Outlook ignores it). Asked once: the link comes back from the
   * write and goes on the appointment, and later writes carry it as the location instead.
   */
  readonly addMeet?: boolean;
}

/** What a write did: the event's id, and the Meet link Google made when `addMeet` asked for one. */
export interface WrittenEvent {
  readonly providerEventId: string;
  readonly meetingUrl?: string | null;
}

export interface CalendarAccount {
  readonly email: string;
}

export interface CalendarProvider {
  readonly name: CalendarProviderName;
  /** This server has the provider's OAuth app (client id and secret). */
  readonly configured: boolean;
  /**
   * Busy times include HandsFreeOS's own events. Google's free/busy can't tell them apart, so the refresh
   * takes them back out; Outlook's are skipped by their extended property.
   */
  readonly busyIncludesOwnEvents: boolean;
  authorizeUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    /** Permissions beyond the calendar's, asked for on top of what was already granted (Meet transcripts). */
    extraScopes?: readonly string[];
  }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  account(accessToken: string): Promise<CalendarAccount>;
  /** Permissions the person left out (Google lets people untick some); the connection needs them all. */
  missingScopes(granted: readonly string[]): string[];
  /** Busy times between two instants. All-day events are placed on the business's days (`timeZone`). */
  busy(accessToken: string, from: Date, to: Date, timeZone: string): Promise<BusyInterval[]>;
  /**
   * Writes the appointment's event, or updates the one already there (`existingId`, when we have it). Safe to
   * repeat: a retry never makes a second event.
   */
  upsertEvent(
    accessToken: string,
    event: CalendarEvent,
    existingId: string | null,
  ): Promise<WrittenEvent>;
  /** Removes an event; one that is already gone counts as removed. */
  deleteEvent(accessToken: string, providerEventId: string): Promise<void>;
}

/** Our event id in Google: the appointment's uuid without hyphens, which is valid base32hex (0-9, a-v). */
export const googleEventId = (appointmentId: string): string =>
  appointmentId.replace(/-/g, '').toLowerCase();

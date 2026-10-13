/**
 * People's own video-meeting accounts (Zoom) behind one seam, so the sign-in routes never name a provider.
 * Signing in is the same OAuth dance as calendars and connected mailboxes, so the helpers (PKCE, token errors,
 * the sealed TokenSet JSON) and the error classes are the mailbox's. A fake stands in locally and in tests.
 * Meetings follow their appointments (meetings/sync.ts).
 */
import type { TokenSet } from '../mailbox/provider';

export type { TokenSet };
/** The same classes the mailbox sign-in throws: an auth error means "reconnect"; the other says whether to retry. */
export {
  MailboxAuthError as MeetingAuthError,
  MailboxError as MeetingError,
} from '../mailbox/provider';

export type MeetingProviderName = 'zoom';

export const MEETING_NAME: Record<MeetingProviderName, string> = { zoom: 'Zoom' };

export const isMeetingProvider = (p: string): p is MeetingProviderName => p === 'zoom';

export interface MeetingAccount {
  readonly email: string;
  /** The provider's own id for the account (Zoom's user id). */
  readonly id: string;
}

/** One appointment's meeting, as the provider is asked to hold it. */
export interface MeetingInput {
  readonly appointmentId: string;
  readonly topic: string;
  readonly start: Date;
  readonly end: Date;
}

/** A meeting the provider made: its id there, and the link people join with (passcode included). */
export interface MadeMeeting {
  readonly id: string;
  readonly joinUrl: string;
}

export interface MeetingProvider {
  readonly name: MeetingProviderName;
  /** This server has the provider's OAuth app (client id and secret). */
  readonly configured: boolean;
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  account(accessToken: string): Promise<MeetingAccount>;
  /** Permissions the sign-in came back without; the connection needs them all. */
  missingScopes(granted: readonly string[]): string[];
  createMeeting(accessToken: string, m: MeetingInput): Promise<MadeMeeting>;
  /** Moves a meeting. One that's gone (deleted in Zoom) answers null, so a new one is made. */
  updateMeeting(accessToken: string, id: string, m: MeetingInput): Promise<'updated' | null>;
  /** Removes a meeting; one that's already gone counts as removed. */
  deleteMeeting(accessToken: string, id: string): Promise<void>;
}

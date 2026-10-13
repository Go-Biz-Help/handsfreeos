/**
 * People's own video-meeting accounts (Zoom) behind one seam, so the sign-in routes never name a provider.
 * Signing in is the same OAuth dance as calendars and connected mailboxes, so the helpers (PKCE, token errors,
 * the sealed TokenSet JSON) and the error classes are the mailbox's. A fake stands in locally and in tests.
 * Making meetings comes next (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md, step 3).
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
}

/**
 * Where a business's public reviews actually live, behind one seam.
 *
 * The reviews a CRM shows are never the CRM's: they belong to Google and to Facebook, and a business that
 * leaves one CRM for another loses none of them. What it loses is the one place it looked. So this connects
 * to the source instead of copying from anybody: the Google Business Profile and the Facebook Page.
 *
 * The sign-in is the same OAuth dance as connected mailboxes and calendars, so the helpers and the error
 * classes are the mailbox's. A fake stands in locally and in tests.
 */
import type { TokenSet } from '../mailbox/provider';

export type { TokenSet };
/** An auth error means "connect it again"; the other says whether it is worth retrying. */
export {
  MailboxAuthError as ReviewAuthError,
  MailboxError as ReviewError,
} from '../mailbox/provider';

export type ReviewProviderName = 'google' | 'facebook';

export const REVIEW_NAME: Record<ReviewProviderName, string> = {
  google: 'Google',
  facebook: 'Facebook',
};

/** What the business is called where people read the reviews. */
export interface ReviewPlace {
  /** The provider's own id: a Google location name, a Facebook page id. */
  readonly externalId: string;
  readonly displayName: string;
  /** Where the public reads it. */
  readonly publicUrl: string | null;
}

/**
 * One review as it stands over there.
 *
 * Exactly one of `rating` and `sentiment` is set, and that is the point: Google has stars, Facebook has a
 * thumb up or down, and inventing a number for the thumb would put a made-up figure beside a real one.
 */
export interface SourceReview {
  readonly externalId: string;
  readonly authorName: string | null;
  readonly authorPhotoUrl: string | null;
  readonly rating: 1 | 2 | 3 | 4 | 5 | null;
  readonly sentiment: 'positive' | 'negative' | null;
  readonly body: string | null;
  readonly postedAt: Date;
  readonly updatedAt: Date | null;
  readonly url: string | null;
  /** The reply as it stands over there, whoever wrote it — somebody may have answered on the phone. */
  readonly reply: { readonly body: string; readonly postedAt: Date | null } | null;
}

export interface ReviewPage {
  readonly reviews: readonly SourceReview[];
  /** Where to carry on from; null when there is no more to read. */
  readonly cursor: string | null;
}

export interface ReviewProvider {
  readonly name: ReviewProviderName;
  /** This server has the provider's OAuth app (client id and secret). */
  readonly configured: boolean;
  /** What the sign-in asks for, so a person can be told what they are agreeing to. */
  readonly scopes: readonly string[];
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<TokenSet>;
  refresh(tokens: TokenSet): Promise<TokenSet>;
  /** Every place this sign-in can read: one van, or nine branches. */
  places(accessToken: string): Promise<readonly ReviewPlace[]>;
  /** A page of reviews, newest first. */
  list(input: {
    readonly accessToken: string;
    readonly place: string;
    readonly cursor: string | null;
  }): Promise<ReviewPage>;
  /**
   * Answer one, where people will read it.
   *
   * Not every provider allows it — Facebook's recommendations are answered as a comment on a story, which
   * its API will not reliably let an app post. A provider that cannot says so, and the screen offers a link
   * out instead of a box that fails.
   */
  readonly canReply: boolean;
  reply?(input: {
    readonly accessToken: string;
    readonly place: string;
    readonly reviewId: string;
    readonly body: string;
  }): Promise<void>;
}

export interface ReviewServices {
  readonly providers: Readonly<Record<ReviewProviderName, ReviewProvider>>;
  /** How often a connected place is asked for new reviews. */
  readonly pollMs: number;
}

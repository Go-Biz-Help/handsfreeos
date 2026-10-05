/**
 * A listing feed, whoever supplies it (round five, step 3): what each adapter (./repliers.ts, ./reso.ts,
 * ./anyprop.ts, ./standin.ts) answers, in core's one shape (`@hfos/core/addons/realestate/feed`).
 *
 * An adapter only asks and translates. Which account to use, whether it worked and what to keep are the caller's
 * (./index.ts): a key turned down throws ConnectionRefused, a supplier that didn't answer throws FeedUnreachable,
 * and a question the supplier can't answer throws FeedUnsupported.
 */
import type { FeedListing, FeedSearchQuery } from '@hfos/core/addons/realestate/feed';

export interface FeedPage {
  readonly listings: readonly FeedListing[];
  /** How many match in all, when the supplier says. */
  readonly total: number | null;
}

export interface ListingFeed {
  /** The supplier (repliers, anyprop, reso, standin). */
  readonly provider: string;
  search(query: FeedSearchQuery, signal: AbortSignal): Promise<FeedPage>;
}

/** The supplier didn't answer, or answered with an error of its own: try again later. */
export class FeedUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedUnreachable';
  }
}

/** The supplier can't answer that question (an MLS Grid feed asked to search, say): the words say so. */
export class FeedUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedUnsupported';
  }
}

/** How an adapter calls a supplier: `fetch`, or a test's own. */
export type FeedFetch = (url: string, init: RequestInit) => Promise<Response>;

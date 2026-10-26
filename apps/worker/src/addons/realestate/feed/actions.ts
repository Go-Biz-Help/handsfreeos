/**
 * The listing feed, asked while a person types (round five, step 10): the worker action `realestate.feed.search`,
 * for "Add a home → From the MLS". Only the worker holds the feed's keys, so the app asks here; what's found is shown
 * to choose from, never kept. Choosing one adds the home with its MLS number (`realestate.home.add`), and the usual
 * look-up fills its facts.
 *
 * An MLS number ("ACT-6612408", "4821937") is asked for as one; anything else as the start of an address
 * ("418 Maple"). Each result carries its MLS's notice, as every listing shown does.
 */
import {
  FEED_STATUSES,
  feedAddressWords,
  type FeedListing,
  type FeedSearch,
} from '@hfos/core/addons/realestate/feed';
import { HfosError } from '@hfos/core/server';
import { z } from 'zod';
import { ConnectionRefused } from '../../connections';
import type { AddonWorkerAction } from '../../types';
import { askFeed, FeedUnreachable, FeedUnsupported } from './index';

const SearchInput = z.object({
  text: z
    .string()
    .trim()
    .min(3, 'Type at least the house number and street, or an MLS number.')
    .max(120),
});

const ALL = ['coming_soon', 'active', 'pending', 'sold', 'off_market'] as const;
/** Whether what was typed is an MLS number rather than an address: one word with five digits or more. */
export const looksLikeMlsNumber = (text: string) => /^[a-z]{0,6}-?\d{5,}$/i.test(text.trim());

const result = (l: FeedListing) => ({
  listingKey: l.listingKey,
  mlsNumber: l.mlsNumber,
  address: feedAddressWords(l.address),
  status: l.status,
  statusWords: FEED_STATUSES[l.status],
  priceCents: l.status === 'sold' ? (l.soldPriceCents ?? l.listPriceCents) : l.listPriceCents,
  soldOn: l.soldOn,
  beds: l.facts.beds ?? null,
  baths: l.facts.baths ?? null,
  sqft: l.facts.sqft ?? null,
  photo: l.photos[0]?.url ?? null,
  mls: l.mls.name,
  notice: l.display.notice,
  courtesy: l.display.courtesy,
});

export const FEED_ACTIONS: Readonly<Record<string, AddonWorkerAction>> = {
  'realestate.feed.search': {
    permission: 'realestate.use',
    ai: {
      tool: 'realestate_search_listing_feed',
      description:
        "Look a home up in the business's connected listing feed (its MLS) by address or MLS number: up to 8 homes with price, status, beds, baths, square feet and a photo.",
      autonomy: 'auto',
      keywords: ['mls search', 'look up a listing', 'find a home'],
    },
    input: SearchInput,
    async run(ctx, input: z.infer<typeof SearchInput>) {
      const query: FeedSearch = looksLikeMlsNumber(input.text)
        ? { statuses: [...ALL], mlsNumbers: [input.text.trim()], limit: 8 }
        : { statuses: [...ALL], address: input.text, limit: 8 };
      try {
        const answer = await askFeed(ctx, query, { signal: AbortSignal.timeout(15_000) });
        if (!answer) return { connected: false, homes: [] };
        return {
          connected: true,
          supplier: answer.connection.label,
          homes: answer.listings.slice(0, 8).map(result),
        };
      } catch (e) {
        if (e instanceof FeedUnsupported)
          throw HfosError.rule('realestate_feed_unsupported', 409, e.message);
        if (e instanceof ConnectionRefused || e instanceof FeedUnreachable)
          throw HfosError.rule(
            'realestate_feed_unreachable',
            503,
            `${e.message} Paste the listing’s words instead, or try again in a minute.`.slice(
              0,
              500,
            ),
          );
        throw e;
      }
    },
  },
};

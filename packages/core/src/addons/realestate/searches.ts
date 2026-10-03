/**
 * A buyer's saved search (round five, step 5): their profile asked of the business's listing feed, and the words for
 * what it asks. Browser-safe and pure: the worker asks with it, the screens say it, the Assistant reads it.
 *
 * Chris decided (2026-10-02): new matches go to the agent first, at most one Home card a day per buyer, and the
 * client sees only the homes the agent sends.
 */
import { money } from '../../money/format';
import type { FeedSearch, FeedStatus } from './feed';
import { HOME_TYPES, type FitProfile, type HomeType } from './homes';

/** What a saved search looks for: homes for sale and coming soon. */
export const SEARCH_STATUSES: readonly FeedStatus[] = ['active', 'coming_soon'];
/** The most matches one check brings. */
export const SEARCH_LIMIT = 50;

/** A buyer's profile as a feed question, or why it can't be asked yet (an area is the least it needs). */
export function profileSearch(
  p: FitProfile,
):
  | { readonly search: FeedSearch; readonly missing: null }
  | { readonly search: null; readonly missing: string } {
  const areas = p.areas.map((a) => a.trim()).filter(Boolean);
  if (!areas.length)
    return {
      search: null,
      missing:
        'Add the areas the buyer wants (towns or ZIP codes) to their profile, and their search starts.',
    };
  const zips = areas.filter((a) => /^\d{5}$/.test(a));
  const cities = areas.filter((a) => !/^\d{5}$/.test(a)).map((a) => a.split(',')[0]!.trim());
  const types = p.homeTypes.filter((t): t is HomeType => t in HOME_TYPES);
  return {
    search: {
      statuses: [...SEARCH_STATUSES],
      ...(p.budgetMinCents ? { priceMinCents: p.budgetMinCents } : {}),
      ...(p.budgetMaxCents ? { priceMaxCents: p.budgetMaxCents } : {}),
      ...(p.bedsMin !== null ? { bedsMin: p.bedsMin } : {}),
      ...(p.bathsMin !== null ? { bathsMin: p.bathsMin } : {}),
      ...(p.sqftMin !== null ? { sqftMin: p.sqftMin } : {}),
      ...(types.length ? { types } : {}),
      ...(zips.length ? { zips } : {}),
      ...(cities.length ? { cities } : {}),
      limit: SEARCH_LIMIT,
    },
    missing: null,
  };
}

/** What a buyer's search still needs before it can be asked: a profile, then an area. Null once it can be. */
export function searchMissing(profile: FitProfile | null): string | null {
  return profile
    ? profileSearch(profile).missing
    : 'Fill in what the buyer wants, and their search can start.';
}

/** "3+ beds, 2+ baths, $450,000 to $600,000, townhouse or condo, in 78704 or Austin" */
export function searchWords(p: FitProfile): string {
  const parts: string[] = [];
  if (p.bedsMin !== null) parts.push(`${p.bedsMin}+ beds`);
  if (p.bathsMin !== null) parts.push(`${p.bathsMin}+ baths`);
  if (p.sqftMin !== null) parts.push(`${p.sqftMin.toLocaleString('en-US')}+ sq ft`);
  if (p.budgetMinCents && p.budgetMaxCents)
    parts.push(`${money(p.budgetMinCents)} to ${money(p.budgetMaxCents)}`);
  else if (p.budgetMaxCents) parts.push(`up to ${money(p.budgetMaxCents)}`);
  else if (p.budgetMinCents) parts.push(`from ${money(p.budgetMinCents)}`);
  const types = p.homeTypes
    .filter((t): t is HomeType => t in HOME_TYPES)
    .map((t) => HOME_TYPES[t].toLowerCase());
  if (types.length) parts.push(types.join(' or '));
  const areas = p.areas.filter(Boolean);
  const where = areas.length ? `in ${areas.join(' or ')}` : null;
  return [parts.join(', '), where].filter(Boolean).join(', ') || 'Anything';
}

/** "2 new homes for Nguyen purchase" */
export const newMatchesWords = (count: number, dealName: string): string =>
  `${count} new ${count === 1 ? 'home' : 'homes'} for ${dealName}`;

/** The Home card's key for a buyer's new matches: one per deal, put up at most once a day. */
export const matchesAlertKey = (dealId: string) => `matches:${dealId}`;

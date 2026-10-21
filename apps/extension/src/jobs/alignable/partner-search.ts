/**
 * Alignable's searches for partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 6; ../partner-search.ts), the
 * start of Find partners there each day (../partners.ts), as LinkedIn's are (../linkedin/partner-search.ts): its
 * search for businesses (/biz/search, as Check Alignable opens it), a few screens of it, keeping each business it
 * shows by Alignable's id for it, with its owner's name and the lines under it (its name, what kind, where). Its
 * members are all businesses, so HandsFreeOS asks it for businesses alone, never creators: it has none. Nothing is
 * pressed but a list's own Show more; it stops on any Alignable warning.
 */
import type { PartnerSearchKind } from '@hfos/core/addons/outreach/partners';
import type { Found } from '../../hfos/saves';
import { counted } from '../../words';
import type { Job, JobEnd } from '../job';
import { businessSearchUrl, ended, gather, type AlignablePage } from './read';

/** Screens of its search it reads. */
export const SEARCH_SCREENS = 3;

/** Each business a search's page shows, with the lines under it: never a follower count, as it shows none. */
export function alignableFound(page: AlignablePage): Found[] {
  return page.found.businesses.map((b) => ({
    name: b.name,
    profile: b.profile,
    lines: [b.business, ...b.details].filter((line): line is string => !!line),
    followers: null,
  }));
}

const keyOf = (f: Found) => (f.profile.id ?? f.profile.username ?? f.profile.url).toLowerCase();

/** One of Alignable's searches: every business it showed, once; none for creators, as it has none. */
export async function searchAlignable(
  job: Job,
  kind: PartnerSearchKind,
  words: string,
): Promise<readonly Found[] | JobEnd> {
  if (kind !== 'business') return [];
  await job.tab.open(businessSearchUrl(words));
  const got = await gather(
    job,
    SEARCH_SCREENS - 1,
    alignableFound,
    keyOf,
    (n) =>
      `Reading Alignable’s businesses for “${words}”… ${counted(n, 'business', 'businesses')} so far.`,
  );
  return ended(got) ? got : got.items;
}

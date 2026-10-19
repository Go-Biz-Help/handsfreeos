/**
 * LinkedIn's searches for partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 4; ../partner-search.ts): for
 * creators, its post search, the latest first, keeping whoever wrote the posts (never a company's page, as Find posts
 * has it) with the headline under their name; for businesses with the same customers, its people search, a page at a
 * time by its address, keeping each person with their headline and where they are. LinkedIn limits how much a free
 * account searches for people, so it reads two pages. Nothing is pressed; it stops on any LinkedIn warning.
 */
import type { PartnerSearchKind } from '@hfos/core/addons/outreach/partners';
import type { Found } from '../../hfos/saves';
import type { LinkedInRead } from '../../networks';
import { profileKey } from '../../networks/linkedin/urls';
import { counted } from '../../words';
import { pause, paced, type Job, type JobEnd } from '../job';
import { SEARCH_SCREENS } from './posts';
import { ended, gather, LINKEDIN, postSearchUrl, SCROLL_PACE_MS } from './read';

/** Pages of people search it reads: ten people a page. */
export const PEOPLE_SEARCH_PAGES = 2;
/** Screens it scrolls on a page of people search, for LinkedIn to draw all ten. */
const PEOPLE_PAGE_SCROLLS = 1;

/** LinkedIn's people search for some words, a page of it. */
export const peopleSearchUrl = (words: string, page = 1) =>
  `${LINKEDIN}/search/results/people/?keywords=${encodeURIComponent(words)}${page > 1 ? `&page=${page}` : ''}`;

/** Who a LinkedIn search's page shows: people search's people, or whoever wrote post search's posts. */
export function linkedInFound(page: LinkedInRead, kind: PartnerSearchKind): Found[] {
  if (kind === 'business')
    return (page.people ?? []).map((person) => ({
      name: person.name,
      profile: person.profile,
      lines: [person.headline, person.location].filter((l): l is string => !!l),
      followers: null,
    }));
  return (page.posts ?? []).flatMap((post) =>
    post.company || !post.author?.profile
      ? []
      : [
          {
            name: post.author.name,
            profile: post.author.profile,
            lines: post.headline ? [post.headline] : [],
            followers: null,
          },
        ],
  );
}

/** One of LinkedIn's searches: everyone it showed, once. */
export async function searchLinkedIn(
  job: Job,
  kind: PartnerSearchKind,
  words: string,
): Promise<readonly Found[] | JobEnd> {
  const key = (f: Found) => profileKey(f.profile);
  if (kind === 'creator') {
    await job.tab.open(postSearchUrl(words));
    const got = await gather(
      job,
      SEARCH_SCREENS - 1,
      (page) => linkedInFound(page, kind),
      key,
      (n) => `Reading LinkedIn’s posts about “${words}”… ${counted(n, 'writer')} so far.`,
    );
    return ended(got) ? got : got.items;
  }
  const found = new Map<string, Found>();
  for (let page = 1; page <= PEOPLE_SEARCH_PAGES && !job.stopped(); page++) {
    await job.tab.open(peopleSearchUrl(words, page));
    const got = await gather(
      job,
      PEOPLE_PAGE_SCROLLS,
      (read) => linkedInFound(read, kind),
      key,
      (n) =>
        `Reading LinkedIn’s people for “${words}”… ${counted(found.size + n, 'person', 'people')} so far.`,
    );
    if (ended(got)) return got;
    for (const f of got.items) if (!found.has(key(f))) found.set(key(f), f);
    // A page with nobody on it is the end of the results.
    if (!got.items.length) break;
    if (page < PEOPLE_SEARCH_PAGES) await pause(paced(SCROLL_PACE_MS));
  }
  return [...found.values()];
}

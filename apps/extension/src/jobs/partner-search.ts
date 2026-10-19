/**
 * Finding partners by search (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 4), the start of Find partners each
 * day (./partners.ts). HandsFreeOS says which searches today has room for, each with a Find partners playbook's words.
 * For creators it reads the network's post search and keeps whoever wrote the posts; for businesses with the same
 * customers, its people search and the people it shows. Who it found goes to HandsFreeOS, which keeps them to read for
 * the AI's partner check. Nothing is pressed: it opens each search in its window, reads it a screen at a time at a
 * person's pace, and stops for the day on any warning. Facebook's searches are here; LinkedIn's are in
 * ./linkedin/partner-search.ts.
 */
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import type { PartnerSearchKind } from '@hfos/core/addons/outreach/partners';
import { partnerLeadsSave, type Found } from '../hfos/saves';
import type { ReadResult } from '../networks/facebook/types';
import { profileKey } from '../networks/facebook/urls';
import { parseCount } from '../networks/facebook/vocabulary';
import { counted } from '../words';
import { pause, paced, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';

/** Between searches: a person typing the next. */
const SEARCH_PACE_MS = [15_000, 30_000] as const;
/** Screens of each of Facebook's searches it reads, at the people lists' pace. */
export const FACEBOOK_SEARCH_SCREENS = 3;
const SCROLL_PACE_MS = [4_000, 9_000] as const;

/** Facebook's people search and post search for some words. */
export const facebookPeopleSearch = (words: string) =>
  `https://www.facebook.com/search/people/?q=${encodeURIComponent(words)}`;
export const facebookPostSearch = (words: string) =>
  `https://www.facebook.com/search/posts/?q=${encodeURIComponent(words)}`;

/** How a network's searches are done: everyone one shows, or the day's end on a warning. */
export type PartnerSearch = (
  job: Job,
  kind: PartnerSearchKind,
  words: string,
) => Promise<readonly Found[] | JobEnd>;

const isEnd = (got: readonly Found[] | JobEnd): got is JobEnd => 'warned' in got;

/** "12K followers" among the lines under someone's name, when one says. */
export function followersIn(lines: readonly string[]): number | null {
  for (const line of lines) {
    const following = /([\d.,]+\s*[km]?)\s+followers\b/i.exec(line);
    if (following?.[1]) return parseCount(following[1]);
  }
  return null;
}

/**
 * Who a Facebook search's page shows: for businesses, the people search's people with the lines under their names; for
 * creators, whoever wrote the post search's posts, people and Pages.
 */
export function facebookFound(page: ReadResult, kind: PartnerSearchKind): Found[] {
  if (kind === 'business')
    return (page.people ?? []).flatMap((person) =>
      person.profile
        ? [
            {
              name: person.name,
              profile: person.profile,
              lines: person.details,
              followers: followersIn(person.details),
            },
          ]
        : [],
    );
  return (page.posts ?? []).flatMap((post) =>
    post.author?.profile
      ? [{ name: post.author.name, profile: post.author.profile, lines: [], followers: null }]
      : [],
  );
}

/** One of Facebook's searches, read a screen at a time as it scrolls: everyone it showed, once. */
export async function searchFacebook(
  job: Job,
  kind: PartnerSearchKind,
  words: string,
): Promise<readonly Found[] | JobEnd> {
  await job.tab.open(kind === 'creator' ? facebookPostSearch(words) : facebookPeopleSearch(words));
  const found = new Map<string, Found>();
  let page = await readIn(job.tab);
  for (let screen = 0; ; screen++) {
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    for (const f of facebookFound(page, kind))
      if (!found.has(profileKey(f.profile))) found.set(profileKey(f.profile), f);
    job.progress(
      `Searching Facebook for “${words}”… ${counted(found.size, 'person', 'people')} so far.`,
    );
    if (screen >= FACEBOOK_SEARCH_SCREENS - 1 || job.stopped()) break;
    if (!(await job.tab.ask({ type: 'hfos-scroll-page' })).ok) break;
    await pause(paced(SCROLL_PACE_MS));
    page = await readIn(job.tab);
  }
  return [...found.values()];
}

/** What a search looks through, in words for the person. */
const LOOKS: Readonly<Record<PartnerSearchKind, string>> = {
  creator: 'posts',
  business: 'people',
};

/**
 * Today's searches for partners on a network, each sent to HandsFreeOS as it's done: how many it did and how many new
 * people they found, or the day's end on a warning. A search whose page didn't load isn't counted, so it's tried again.
 */
export async function searchPartners(
  job: Job,
  platform: Platform,
  search: PartnerSearch,
): Promise<{ readonly searched: number; readonly kept: number } | JobEnd> {
  const network = NETWORKS[platform].name;
  job.progress(`Asking HandsFreeOS what to search ${network} for, to find partners…`);
  const today = valueOf(
    await job.hfos({
      type: 'hfos-partner-searches',
      input: { workspaceId: job.businessId, platform },
    }),
  );
  let searched = 0;
  let kept = 0;
  for (const [i, s] of today.searches.entries()) {
    if (job.stopped()) break;
    job.progress(`Searching ${network}’s ${LOOKS[s.kind]} for “${s.words}”…`);
    let found: readonly Found[] | JobEnd;
    try {
      found = await search(job, s.kind, s.words);
    } catch {
      // The network went elsewhere: not counted, so it's searched another day.
      continue;
    }
    if (isEnd(found)) return found;
    kept += valueOf(
      await job.hfos({
        type: 'hfos-partner-leads',
        input: partnerLeadsSave(found, platform, s.kind, s.words, job.businessId),
      }),
    ).kept;
    searched++;
    if (i < today.searches.length - 1 && !job.stopped()) await pause(paced(SEARCH_PACE_MS));
  }
  return { searched, kept };
}

/** How today's searches went, in words for the person: nothing when there were none. */
export function searchedLine(searched: number, kept: number, platform: Platform): string | null {
  if (!searched) return null;
  return `Searched ${NETWORKS[platform].name} ${counted(searched, 'time')} and found ${counted(kept, 'new person', 'new people')} who could partner.`;
}

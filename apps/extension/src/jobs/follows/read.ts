/**
 * What Threads' and X's jobs share (decision 163): reading the page in the job's window as that network's, going
 * through one of its lists a screen at a time at a person's pace, and reading someone's profile for the AI's check.
 * Their rules hold for every one, as Instagram's do: a person's pace, a window of its own, a stop on any warning there,
 * and nothing to get around a network's limits or checks. The extension reads only what the person lets it, in their
 * own browser, never from a server.
 */
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import {
  NOTHING_FOLLOW_FOUND,
  type FollowAccount,
  type FollowFound,
  type FollowPlatform,
  type FollowProfile,
} from '../../networks/follows/types';
import type { LookingRead } from '../../networks/looking/site';
import { THREADS } from '../../networks/threads/kit';
import { X } from '../../networks/x/kit';
import type { Who, ReadThem } from '../checks';
import { pause, paced, warnedOn, type Job, type JobEnd, type JobTab } from '../job';
import { readOn } from '../looking';

/** Between screens of a list: a person reading as they go. */
export const SCROLL_PACE_MS = [6_000, 12_000] as const;

/** A page of Threads' or X's, with what its own readers found there. */
export type FollowPage = LookingRead & { readonly found: FollowFound };

/** Reads the page in the job's window as the network's: anything else means it sent the tab elsewhere. */
export async function readFollowIn(tab: JobTab, platform: FollowPlatform): Promise<FollowPage> {
  const page = await readOn(platform)(tab);
  return {
    ...page,
    found: { ...NOTHING_FOLLOW_FOUND, ...(page.found as FollowFound | undefined) },
  };
}

export const ended = (got: object): got is JobEnd => 'warned' in got;

/** What the person can do when the network didn't show what was asked. */
export const signedInWords = (platform: FollowPlatform) =>
  `Check you’re signed in to ${NETWORKS[platform].name} in this browser, then ask again.`;

/** A page that asks the person to sign in ends the job, saying so. */
export const signedOutEnd = (platform: FollowPlatform): JobEnd => ({
  line: `${NETWORKS[platform].name} asked you to sign in. ${signedInWords(platform)}`,
  warned: false,
  failed: true,
});

/** The network's site, as its kit was built from it. */
const siteOf = (platform: FollowPlatform) => (platform === 'x' ? X : THREADS);

/** An account as kept, by the name in its address; null for any other link. */
export function accountIn(platform: FollowPlatform, url: string | null): FollowAccount | null {
  const site = siteOf(platform);
  const at = url ? site.url(url) : null;
  return at ? site.profileOf(at) : null;
}

/** Whether the profile shown is the account wanted, by the name in its address. */
export const isTheirs = (shown: Pick<FollowProfile, 'username'>, want: FollowAccount): boolean =>
  shown.username.toLowerCase() === want.username.toLowerCase();

/** What someone's profile says, as lines for the AI: their name, bio, links and latest posts. */
export function profileLines(profile: FollowProfile): string[] {
  return [
    profile.name ? `Name: ${profile.name}` : null,
    `Username: @${profile.username}`,
    profile.bio ? `Bio: ${profile.bio.replace(/\s+/g, ' ')}` : null,
    ...profile.links,
    profile.followers !== null ? `Followers: ${profile.followers.toLocaleString()}` : null,
    ...profile.posts.slice(0, 4).map((p) => `Post: ${p.text.replace(/\s+/g, ' ').slice(0, 300)}`),
  ].filter((line): line is string => !!line && line.trim().length > 0);
}

/**
 * Someone's profile read for the AI's check (found checks, decision 92): their page opened in the job's window, checked
 * as theirs, read as lines; `missing` when the network showed someone else or nobody. A warning ends it.
 */
export const readThemOn =
  (platform: FollowPlatform) =>
  async (job: Job, who: Who): Promise<ReadThem> => {
    const want = accountIn(platform, who.url);
    if (!want) return { lines: [], missing: true, followers: null };
    await job.tab.open(want.url);
    let page = await readFollowIn(job.tab, platform);
    // Their posts draw a moment after their header: read once more when none showed yet.
    if (page.found.profile && !page.found.profile.posts.length) {
      await pause(2_000);
      page = await readFollowIn(job.tab, platform);
    }
    const warned = await warnedOn(job, page);
    if (warned) return { end: warned };
    if (page.signedOut) return { end: signedOutEnd(platform) };
    const shown = page.found.profile;
    if (!shown || !isTheirs(shown, want)) return { lines: [], missing: true, followers: null };
    return {
      lines: profileLines(shown).slice(0, LOOKUP_LINES),
      missing: false,
      followers: shown.followers,
    };
  };

/**
 * Goes through a list on the page, a screen at a time, up to `scrolls`: everything each read showed that `pick` says
 * counts, each once by `key`, in page order, and whether it got to the end. `enough` stops it sooner. A warning ends
 * it, and so does a page asking them to sign in.
 */
export async function gather<T>(
  job: Job,
  platform: FollowPlatform,
  scrolls: number,
  pick: (page: FollowPage) => readonly T[],
  key: (item: T) => string,
  progress: (count: number) => string,
  enough: (items: readonly T[]) => boolean | Promise<boolean> = () => false,
): Promise<{ page: FollowPage; items: T[]; whole: boolean } | JobEnd> {
  const items = new Map<string, T>();
  let page = await readFollowIn(job.tab, platform);
  let whole = false;
  for (let screen = 0; ; screen++) {
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    if (page.signedOut) return signedOutEnd(platform);
    for (const item of pick(page)) if (!items.has(key(item))) items.set(key(item), item);
    job.progress(progress(items.size));
    if (screen >= scrolls || job.stopped() || (await enough([...items.values()]))) break;
    if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) {
      whole = true;
      break;
    }
    await pause(paced(SCROLL_PACE_MS));
    page = await readFollowIn(job.tab, platform);
  }
  return { page, items: [...items.values()], whole };
}

/** Whether two usernames are the same account, whatever their case. */
export const sameAs = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

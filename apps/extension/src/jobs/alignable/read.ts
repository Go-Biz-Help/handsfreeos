/**
 * What Alignable's jobs (./index.ts) share: its addresses, reading the page in the job's window as Alignable's, and
 * going through one of its lists a screen at a time at a person's pace. Alignable's rules (the Instagram and Alignable
 * plan's "The risk, said plainly": LinkedIn's) hold for every one: a person's pace, a window of its own, a stop on
 * any Alignable warning, and nothing to get around Alignable's limits or checks.
 */
import type { AlignableFound } from '../../networks/alignable/read';
import { businessOf, townOf } from '../../networks/alignable/site';
import type { LookingRead } from '../../networks/looking/site';
import { pause, paced, warnedOn, type Job, type JobEnd, type JobTab } from '../job';
import { readOn } from '../looking';

export const ALIGNABLE = 'https://www.alignable.com';
/** My Network: the person's connections, and its Requests tab, the requests they've got. */
export const MY_NETWORK = `${ALIGNABLE}/biz/my_network`;
export const REQUESTS = `${ALIGNABLE}/biz/my_network/connection_requests`;
/**
 * Its search for businesses, as Check Alignable opens it: Find partners' (./partner-search.ts), and from 0.95.0 the
 * search for businesses like the person's clients (./customer-search.ts), whose town goes in its words.
 */
export const businessSearchUrl = (words: string) =>
  `${ALIGNABLE}/biz/search?q=${encodeURIComponent(words)}`;
/**
 * The person's own groups (decision 92), at each of the addresses they may be at, in turn: guesses till the owner's
 * next Check Alignable reads the real one.
 */
export const MY_GROUPS = [`${ALIGNABLE}/biz/groups`, `${ALIGNABLE}/groups`] as const;
/**
 * Its search for groups, in turn: its groups' own search (/groups/search, which its addresses name), then its search
 * asked for groups by its kind of search (`doc_type`, which its addresses carry). Guesses too.
 */
export const GROUP_SEARCHES = [
  (words: string) => `${ALIGNABLE}/groups/search?q=${encodeURIComponent(words)}`,
  (words: string) => `${ALIGNABLE}/biz/search?q=${encodeURIComponent(words)}&doc_type=group`,
] as const;

/** Between screens of a list: a person reading as they go, as on LinkedIn. */
export const SCROLL_PACE_MS = [6_000, 12_000] as const;
/** Between the pages a job opens one after another (decision 92): a person's pace, 8 to 40 seconds. */
export const PAGE_PACE_MS = [8_000, 40_000] as const;
/** Their own profile, at their business's address: its town is the first part. */
export const MINE = `${ALIGNABLE}/biz/businesses/my_profile`;

/** What the person can do when Alignable didn't show what was asked. */
export const SIGNED_IN = 'Check you’re signed in to Alignable in this browser, then ask again.';

/** A page of Alignable's, with what its own readers found there. */
export type AlignablePage = LookingRead & { readonly found: AlignableFound };

const NOTHING: AlignableFound = {
  businesses: [],
  engaged: [],
  requests: [],
  threads: [],
  answers: [],
  chats: [],
  business: null,
  chat: null,
  answerBox: false,
  codeBox: false,
  groups: [],
  members: [],
};

/** Reads the page in the job's window as Alignable's: anything else means Alignable sent it elsewhere. */
export async function readAlignableIn(tab: JobTab): Promise<AlignablePage> {
  const page = await readOn('alignable')(tab);
  return { ...page, found: (page.found as AlignableFound | undefined) ?? NOTHING };
}

export const ended = (got: object): got is JobEnd => 'warned' in got;

/** A page that asks the person to sign in ends the job, saying so. */
export const signedOutEnd = (): JobEnd => ({
  line: `Alignable asked you to sign in. ${SIGNED_IN}`,
  warned: false,
  failed: true,
});

/**
 * Goes through a list on the page, a screen at a time, up to `scrolls`: everything each read showed that `pick` says
 * counts, each once by `key`, and whether it got to the end of the list. An Alignable warning ends it, and so does a
 * page asking them to sign in.
 */
export async function gather<T>(
  job: Job,
  scrolls: number,
  pick: (page: AlignablePage) => readonly T[],
  key: (item: T) => string,
  progress: (count: number) => string,
): Promise<{ page: AlignablePage; items: T[]; whole: boolean } | JobEnd> {
  const items = new Map<string, T>();
  let page = await readAlignableIn(job.tab);
  let whole = false;
  for (let screen = 0; ; screen++) {
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    if (page.signedOut) return signedOutEnd();
    for (const item of pick(page)) if (!items.has(key(item))) items.set(key(item), item);
    job.progress(progress(items.size));
    if (screen >= scrolls || job.stopped()) break;
    if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) {
      whole = true;
      break;
    }
    await pause(paced(SCROLL_PACE_MS));
    page = await readAlignableIn(job.tab);
  }
  return { page, items: [...items.values()], whole };
}

/** The person's own on Alignable, as their own profile opens at it: their town ("austin-tx") and their business. */
export interface Mine {
  readonly town: string | null;
  /** Their business ("austin-tx/acme-plumbing", `businessOf`): never one to find, nor whose posts to check. */
  readonly business: string | null;
}

/**
 * The person's own town and business on Alignable (decision 92's "town"): the ones their business page's address
 * names, as their own profile opens at it, else the menu's link to it. Each null when it names none; the job's end on
 * a warning, or a page asking them to sign in.
 */
export async function mine(job: Job): Promise<Mine | JobEnd> {
  job.progress('Opening your profile to see your town…');
  await job.tab.open(MINE);
  const page = await readAlignableIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd();
  return {
    town: townOf(page.url) ?? townOf(page.own ?? ''),
    business: businessOf(page.url) ?? businessOf(page.own ?? ''),
  };
}

/** The person's own town on Alignable (`mine`): null when it names none, or the job's end. */
export async function myTown(job: Job): Promise<string | null | JobEnd> {
  const got = await mine(job);
  return ended(got) ? got : got.town;
}

/**
 * Whether someone on a list isn't the person themself (decision 92: the readers leave them out), by their profile's
 * business. With no business of theirs known, everyone is someone else.
 */
export const notMine =
  (business: string | null) =>
  (profile: { readonly url: string } | null | undefined): boolean =>
    business === null || !profile || businessOf(profile.url) !== business;

/** What a town in an address is called: "austin-tx" is "Austin TX" in a search's words. */
export function townWords(town: string): string {
  const parts = town.split('-');
  const state = parts.pop() ?? '';
  return [...parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)), state.toUpperCase()].join(
    ' ',
  );
}

/** And as a place: "Austin, TX". */
export function townPlace(town: string): string {
  const words = townWords(town);
  const at = words.lastIndexOf(' ');
  return at > 0 ? `${words.slice(0, at)}, ${words.slice(at + 1)}` : words;
}

/**
 * What Alignable's jobs (./index.ts) share: its addresses, reading the page in the job's window as Alignable's, and
 * going through one of its lists a screen at a time at a person's pace. Alignable's rules (the Instagram and Alignable
 * plan's "The risk, said plainly": LinkedIn's) hold for every one: a person's pace, a window of its own, a stop on
 * any Alignable warning, and nothing to get around Alignable's limits or checks.
 */
import type { AlignableFound } from '../../networks/alignable/read';
import type { LookingRead } from '../../networks/looking/site';
import { pause, paced, warnedOn, type Job, type JobEnd, type JobTab } from '../job';
import { readOn } from '../looking';

export const ALIGNABLE = 'https://www.alignable.com';
/** My Network: the person's connections, and its Requests tab, the requests they've got. */
export const MY_NETWORK = `${ALIGNABLE}/biz/my_network`;
export const REQUESTS = `${ALIGNABLE}/biz/my_network/connection_requests`;
/** Its search for businesses, as Check Alignable opens it: Find partners' (./partner-search.ts). */
export const businessSearchUrl = (words: string) =>
  `${ALIGNABLE}/biz/search?q=${encodeURIComponent(words)}`;

/** Between screens of a list: a person reading as they go, as on LinkedIn. */
export const SCROLL_PACE_MS = [6_000, 12_000] as const;

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

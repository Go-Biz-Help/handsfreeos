/**
 * What Instagram's jobs (./index.ts) share: its addresses, reading the page in the job's window as Instagram's, and
 * going through one of its lists a screen at a time at a person's pace. Instagram's rules (the Instagram and Alignable
 * plan's "The risk, said plainly": LinkedIn's) hold for every one: a person's pace, a window of its own, a stop on any
 * Instagram warning, and nothing to get around Instagram's limits or checks. Its terms forbid automated collection, so
 * the extension reads only what the person asks, in their own browser, never from a server.
 */
import { NOTHING_FOUND, type InstagramFound } from '../../networks/instagram/read';
import type { LookingRead } from '../../networks/looking/site';
import { pause, paced, warnedOn, type Job, type JobEnd, type JobTab } from '../job';
import { readOn } from '../looking';

export const INSTAGRAM = 'https://www.instagram.com';

/** Between screens of a list: a person reading as they go, slower than on LinkedIn, as Instagram blocks fast. */
export const SCROLL_PACE_MS = [8_000, 15_000] as const;

/** What the person can do when Instagram didn't show what was asked. */
export const SIGNED_IN = 'Check you’re signed in to Instagram in this browser, then ask again.';

/** A page of Instagram's, with what its own readers found there. */
export type InstagramPage = LookingRead & { readonly found: InstagramFound };

/** Reads the page in the job's window as Instagram's: anything else means Instagram sent it elsewhere. */
export async function readInstagramIn(tab: JobTab): Promise<InstagramPage> {
  const page = await readOn('instagram')(tab);
  return { ...page, found: { ...NOTHING_FOUND, ...(page.found as InstagramFound | undefined) } };
}

export const ended = (got: object): got is JobEnd => 'warned' in got;

/** A page that asks the person to sign in ends the job, saying so. */
export const signedOutEnd = (): JobEnd => ({
  line: `Instagram asked you to sign in. ${SIGNED_IN}`,
  warned: false,
  failed: true,
});

/**
 * Goes through a list on the page, a screen at a time, up to `scrolls`: everything each read showed that `pick` says
 * counts, each once by `key`, in page order, and whether it got to the end of the list. `enough` stops it sooner, once
 * what it has read is enough (the newest followers, ./people.ts). An Instagram warning ends it, and so does a page
 * asking them to sign in.
 */
export async function gather<T>(
  job: Job,
  scrolls: number,
  pick: (page: InstagramPage) => readonly T[],
  key: (item: T) => string,
  progress: (count: number) => string,
  enough: (items: readonly T[]) => boolean = () => false,
): Promise<{ page: InstagramPage; items: T[]; whole: boolean } | JobEnd> {
  const items = new Map<string, T>();
  let page = await readInstagramIn(job.tab);
  let whole = false;
  for (let screen = 0; ; screen++) {
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    if (page.signedOut) return signedOutEnd();
    for (const item of pick(page)) if (!items.has(key(item))) items.set(key(item), item);
    job.progress(progress(items.size));
    if (screen >= scrolls || job.stopped() || enough([...items.values()])) break;
    if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) {
      whole = true;
      break;
    }
    await pause(paced(SCROLL_PACE_MS));
    page = await readInstagramIn(job.tab);
  }
  return { page, items: [...items.values()], whole };
}

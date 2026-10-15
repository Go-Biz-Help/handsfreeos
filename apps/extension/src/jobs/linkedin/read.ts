/**
 * What LinkedIn's jobs (./index.ts) share: the addresses they open, reading the page in the job's window as
 * LinkedIn's, and going through a list a screen at a time at a person's pace. LinkedIn's rules
 * (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "The risk, said plainly") hold for every one: a person's pace,
 * a window of its own, a stop on any LinkedIn warning, and nothing to get around LinkedIn's limits or checks.
 */
import { isLinkedInRead, type LinkedInRead } from '../../networks';
import { pause, paced, readPageIn, warnedOn, type Job, type JobEnd, type JobTab } from '../job';

export const LINKEDIN = 'https://www.linkedin.com';
/** The person's connections, their invitations both ways, their own profile and messaging. */
export const CONNECTIONS = `${LINKEDIN}/mynetwork/invite-connect/connections/`;
export const INVITATIONS_RECEIVED = `${LINKEDIN}/mynetwork/invitation-manager/received/`;
export const INVITATIONS_SENT = `${LINKEDIN}/mynetwork/invitation-manager/sent/`;
export const OWN_PROFILE = `${LINKEDIN}/in/me/`;

/** LinkedIn's post search for some words, the latest posts first. */
export const postSearchUrl = (words: string) =>
  `${LINKEDIN}/search/results/content/?keywords=${encodeURIComponent(words)}&sortBy=%22date_posted%22`;

/** Between screens of a list: slower than Facebook's, a person reading as they go. */
export const SCROLL_PACE_MS = [6_000, 12_000] as const;

/** What the person can do when LinkedIn didn't show what was asked. */
export const SIGNED_IN = 'Check you’re signed in to LinkedIn in this browser, then ask again.';

/** Reads the page in the job's window, as LinkedIn's: anything else means LinkedIn sent it elsewhere. */
export async function readLinkedIn(tab: JobTab): Promise<LinkedInRead> {
  const page = await readPageIn(tab);
  if (!isLinkedInRead(page))
    throw new Error(`LinkedIn didn’t open in the extension’s window. ${SIGNED_IN}`);
  return page;
}

export const ended = (got: object): got is JobEnd => 'warned' in got;

/**
 * Goes through a list on the page, a screen at a time, up to `scrolls`: everything each read showed that `pick` says
 * counts, each once by `key`, and whether it got to the end of the list. A LinkedIn warning ends it.
 */
export async function gather<T>(
  job: Job,
  scrolls: number,
  pick: (page: LinkedInRead) => readonly T[],
  key: (item: T) => string,
  progress: (count: number) => string,
): Promise<{ page: LinkedInRead; items: T[]; whole: boolean } | JobEnd> {
  const items = new Map<string, T>();
  let page = await readLinkedIn(job.tab);
  let whole = false;
  for (let screen = 0; ; screen++) {
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    for (const item of pick(page)) if (!items.has(key(item))) items.set(key(item), item);
    job.progress(progress(items.size));
    if (screen >= scrolls || job.stopped()) break;
    if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) {
      whole = true;
      break;
    }
    await pause(paced(SCROLL_PACE_MS));
    page = await readLinkedIn(job.tab);
  }
  return { page, items: [...items.values()], whole };
}

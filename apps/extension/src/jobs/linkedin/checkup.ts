/**
 * Check LinkedIn (`checkup`, docs/outreach.md decision 74): one press when something on LinkedIn isn't read right. It
 * opens the person's main LinkedIn pages one at a time (their profile, their feed, their connections, a people search,
 * a posts search, their messages and one connection's profile), reads each as the other jobs do, presses nothing,
 * and notes each in HandsFreeOS with its outline (../report.ts): what a person wrote is never in it. Its window stays
 * in front while it reads, as Chrome draws nothing in a window hidden behind another, and then the person's own comes
 * back. It stops on any LinkedIn warning.
 */
import { REPORT_WORDS } from '@hfos/core/addons/outreach/reports';
import type { LinkedInRead } from '../../networks';
import { pause, paced, warnedOn, type Job, type JobEnd } from '../job';
import { ownProfileNote } from '../report';
import { CONNECTIONS, LINKEDIN, OWN_PROFILE, postSearchUrl, readLinkedIn } from './read';

/** What the searches look for: everyday words, to see how LinkedIn draws its results. */
const SEARCH_WORDS = 'small business';
/** Between pages: a person going from one to the next. */
const BETWEEN_MS = [2_500, 5_000] as const;

/** A page it looks at, and how much the readers found there (nothing read is worth saying). */
interface Look {
  readonly url: string;
  readonly name: string;
  readonly count: (page: LinkedInRead) => number;
}

const LOOKS: readonly Look[] = [
  { url: `${LINKEDIN}/feed/`, name: 'your feed', count: (p) => p.posts?.length ?? 0 },
  { url: CONNECTIONS, name: 'your connections', count: (p) => p.people?.length ?? 0 },
  {
    url: `${LINKEDIN}/search/results/people/?keywords=${encodeURIComponent(SEARCH_WORDS)}`,
    name: 'the people search',
    count: (p) => p.people?.length ?? 0,
  },
  {
    url: postSearchUrl(SEARCH_WORDS),
    name: 'the posts search',
    count: (p) => p.posts?.length ?? 0,
  },
  { url: `${LINKEDIN}/messaging/`, name: 'your messages', count: (p) => p.chats?.length ?? 0 },
];

/** Opens a page and reads it; a LinkedIn warning there ends the job. */
async function open(job: Job, url: string, name: string): Promise<LinkedInRead | JobEnd> {
  job.progress(`Checking ${name}…`);
  await job.tab.open(url);
  const page = await readLinkedIn(job.tab);
  return (await warnedOn(job, page)) ?? page;
}

const isEnd = (got: LinkedInRead | JobEnd): got is JobEnd => 'warned' in got;

/**
 * A profile, every part drawn: LinkedIn draws Experience and what's below only as it comes into view, so the tab's
 * script scrolls it to its foot and back first (the own profile's read, which does that on any profile), and what it
 * read is noted.
 */
async function wholeProfile(job: Job, own: boolean): Promise<void> {
  const read = await job.tab.ask({ type: 'hfos-own-profile' });
  const note = own && read.ok && 'read' in read ? ownProfileNote(read.read) : {};
  await job.report?.({ ...note, outline: true });
}

async function checkup(job: Job): Promise<JobEnd> {
  const nothingOn: string[] = [];
  let pages = 0;
  const own = await open(job, OWN_PROFILE, 'your profile');
  if (isEnd(own)) return own;
  await wholeProfile(job, true);
  pages++;
  let connection: string | null = null;
  for (const look of LOOKS) {
    if (job.stopped()) return { line: 'Stopped.', warned: false };
    await pause(paced(BETWEEN_MS));
    const page = await open(job, look.url, look.name);
    if (isEnd(page)) return page;
    await job.report?.({ outline: true });
    pages++;
    if (look.count(page) === 0) nothingOn.push(look.name);
    if (look.url === CONNECTIONS) connection = page.people?.[0]?.profile.url ?? null;
  }
  if (connection && !job.stopped()) {
    await pause(paced(BETWEEN_MS));
    const theirs = await open(job, connection, 'one connection’s profile');
    if (isEnd(theirs)) return theirs;
    await wholeProfile(job, false);
    pages++;
  }
  return { line: REPORT_WORDS.checkupDone('LinkedIn', pages, nothingOn), warned: false };
}

/** Check LinkedIn: with its window in front the whole time, then the person's own back. */
export async function checkLinkedIn(job: Job): Promise<JobEnd> {
  return job.tab.inFront ? job.tab.inFront(() => checkup(job)) : checkup(job);
}

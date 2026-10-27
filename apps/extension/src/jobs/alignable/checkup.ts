/**
 * Check Alignable's stops for its groups (docs/outreach.md decision 92), after the pages its steps and Find partners
 * were built from (../looking.ts): the person's own groups, a search for groups, a group that isn't their town's with
 * its own Join looked at and never pressed, its About and its members. Every group page's reader, their groups' page
 * and the search's address are guesses till this Check reads the real ones: each stop is noted with its outline and
 * how many its readers found, so they can be tuned from it. Nothing is pressed but the link that opens each page, and
 * nothing is written.
 */
import type { LookingRead } from '../../networks/looking/site';
import { isEnd, SEARCH_WORDS, type Checkup } from '../checkup';
import type { Job, JobEnd } from '../job';
import { GROUP_SEARCHES, MY_GROUPS } from './read';

/** How many of one of Alignable's readers' lists a page had (`LookingRead.found`). */
const countOf = (page: LookingRead, list: string): number => {
  const rows = page.found?.[list];
  return Array.isArray(rows) ? rows.length : 0;
};

/** A group a page listed: by the name in its address, its page, and whether its card said they're in it. */
interface Listed {
  readonly id: string;
  readonly url: string;
  readonly joined: boolean;
}

/** The groups a page listed. */
const groupsOn = (page: LookingRead): Listed[] => {
  const rows = page.found?.['groups'];
  return Array.isArray(rows)
    ? rows.flatMap((row: { id?: unknown; url?: unknown; joined?: unknown }) =>
        typeof row.id === 'string' && typeof row.url === 'string'
          ? [{ id: row.id, url: row.url, joined: row.joined === true }]
          : [],
      )
    : [];
};

/** The group page's own read: how many lines its About had. */
const aboutOf = (page: LookingRead): number => {
  const group = page.found?.['group'] as { about?: unknown } | undefined;
  return Array.isArray(group?.about) ? group.about.length : 0;
};

const stoppedEnd = (job: Job): JobEnd | null =>
  job.stopped() ? { line: 'Stopped.', warned: false } : null;

/**
 * Opens a page of the groups' stops and notes it, once what its readers look for has had a moment to draw: the page
 * read, or the job's end.
 */
async function stop(
  c: Checkup<LookingRead>,
  job: Job,
  url: string,
  name: string,
  count: (page: LookingRead) => number,
): Promise<LookingRead | JobEnd> {
  const stopped = stoppedEnd(job);
  if (stopped) return stopped;
  const opened = await c.open(url, name);
  if (isEnd(opened)) return opened;
  const page = await c.readTill(opened, (p) => count(p) > 0, 3);
  if (isEnd(page)) return page;
  await c.note(name, count(page));
  return page;
}

/** Check Alignable's group stops; null when they're done, else the job's end. */
export async function groupStops(
  c: Checkup<LookingRead>,
  job: Job,
  town: string | null,
): Promise<JobEnd | null> {
  const groups: Listed[] = [];
  // Their own groups, at each of the addresses they may be at, till one lists any.
  for (const [i, url] of MY_GROUPS.entries()) {
    const page = await stop(c, job, url, i ? 'Alignable’s groups' : 'your groups', (p) =>
      countOf(p, 'groups'),
    );
    if (isEnd(page)) return page;
    groups.push(...groupsOn(page));
    if (groups.length) break;
  }
  // A search for groups, at each of the addresses it may be at, till one lists any.
  for (const [i, search] of GROUP_SEARCHES.entries()) {
    const page = await stop(
      c,
      job,
      search(SEARCH_WORDS),
      i ? 'a search for groups by kind' : 'a search for groups',
      (p) => countOf(p, 'groups'),
    );
    if (isEnd(page)) return page;
    const found = groupsOn(page);
    groups.push(...found);
    if (found.length) break;
  }
  // A group that isn't their town's, one they aren't in first so its Join is there: its page with its own Join looked
  // at, never pressed, its About and its members.
  const others = groups.filter((g) => g.id.toLowerCase() !== town);
  const group = others.find((g) => !g.joined) ?? others[0];
  if (!group) {
    c.nothingOn.push('a group');
    return null;
  }
  const page = await stop(c, job, group.url, 'a group', (p) => countOf(p, 'threads'));
  if (isEnd(page)) return page;
  await c.look('join');
  const base = group.url.replace(/\/+$/, '');
  const about = await stop(c, job, `${base}/about`, 'a group’s About', aboutOf);
  if (isEnd(about)) return about;
  const members = await stop(c, job, `${base}/members`, 'a group’s members', (p) =>
    countOf(p, 'members'),
  );
  return isEnd(members) ? members : null;
}

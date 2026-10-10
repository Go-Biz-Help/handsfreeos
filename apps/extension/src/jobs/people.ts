/**
 * The once-a-day jobs that save people (docs/outreach.md, decision 32), from pages the person could save by hand in
 * the panel (src/panel/hfos.ts): **checking friend requests** saves the requests they've got, which Today confirms the
 * ones that fit from (decision 30); **saving group members** saves each good group's admins and moderators, then its
 * members, which Today suggests friend requests from (decision 8). It loads a few screens of each list, a screen at a
 * time, and saves what loaded. Nothing is pressed on Facebook.
 */
import type { Person, ReadResult } from '../facebook/types';
import { profileKey } from '../facebook/urls';
import { friendsSave, groupSave, isAdminsPage, listOnPage } from '../hfos/saves';
import { counted } from '../panel/dom';
import { pause, paced, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';
import type { WorkGroup } from './posts';

/** Where Facebook lists the friend requests the person has got. */
export const FRIEND_REQUESTS = 'https://www.facebook.com/friends/requests';
/** Screens of each list it loads. */
export const REQUEST_SCROLLS = 6;
export const MEMBER_SCROLLS = 10;
/** A group's admins and moderators are read to the end, up to this many screens. */
export const ADMIN_SCROLLS = 20;
/** The most groups whose members it saves in a day. */
export const MEMBER_GROUPS = 3;
const PACE_MS = [4_000, 9_000] as const;
const GROUP_PACE_MS = [15_000, 30_000] as const;

/**
 * Reads a list of people, scrolling it for more up to `scrolls` times: the last page read, with everyone each read
 * showed, each once, and whether it got to the end of the list. `pick` says who on a page counts. A warning ends it.
 */
async function gather(
  job: Job,
  scrolls: number,
  pick: (page: ReadResult) => readonly Person[],
  progress: (count: number) => string,
): Promise<{ page: ReadResult; people: Person[]; whole: boolean } | JobEnd> {
  const people = new Map<string, Person>();
  let page = await readIn(job.tab);
  let whole = false;
  for (let screen = 0; ; screen++) {
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    for (const person of pick(page))
      if (person.profile) people.set(profileKey(person.profile), person);
    job.progress(progress(people.size));
    if (screen >= scrolls || job.stopped()) break;
    if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) {
      whole = true;
      break;
    }
    await pause(paced(PACE_MS));
    page = await readIn(job.tab);
  }
  return { page, people: [...people.values()], whole };
}

const ended = (got: object): got is JobEnd => 'warned' in got;

/** Opens the person's friend requests and saves the ones they've got. */
export async function checkRequests(job: Job): Promise<JobEnd> {
  job.progress('Opening your friend requests…');
  await job.tab.open(FRIEND_REQUESTS);
  const got = await gather(
    job,
    REQUEST_SCROLLS,
    (page) => {
      const mine = listOnPage(page);
      return mine?.list === 'requests' ? mine.people : [];
    },
    (count) => `Reading your friend requests… ${counted(count, 'request')} so far.`,
  );
  if (ended(got)) return got;
  if (!got.people.length) return { line: 'No friend requests waiting.', warned: false };
  const built = friendsSave(got.people, 'requests', job.businessId);
  if (!built.ok) return { line: built.why, warned: false };
  let added = 0;
  for (const input of built.input)
    added += valueOf(await job.hfos({ type: 'hfos-save-friends', input })).added;
  return {
    line: `Saved ${counted(got.people.length, 'friend request')}${added ? `, ${added.toLocaleString()} new` : ''}.`,
    warned: false,
  };
}

/** Saves the group's list on the page, in parts: how many people were saved. */
async function saveGroupPage(job: Job, page: ReadResult, people: Person[]): Promise<number> {
  const built = groupSave({ ...page, people }, job.businessId);
  if (!built.ok) throw new Error(built.why);
  let saved = 0;
  for (const input of built.input)
    saved += valueOf(await job.hfos({ type: 'hfos-save-group', input })).people;
  return saved;
}

const groupPage = (url: string, part: string) => `${url.replace(/\/?$/, '/')}members/${part}`;

/**
 * For each group, the ones with fewest saved first: its admins and moderators, until their full list is saved, so
 * nobody who runs it is ever approached; then its members.
 */
export async function saveMembers(
  job: Job,
  groups: readonly Pick<WorkGroup, 'name' | 'url' | 'people' | 'adminsRead'>[],
): Promise<JobEnd> {
  const these = [...groups].sort((a, b) => a.people - b.people).slice(0, MEMBER_GROUPS);
  let saved = 0;
  let looked = 0;
  for (const [g, group] of these.entries()) {
    if (job.stopped()) break;
    const name = group.name ?? 'your group';
    const parts = group.adminsRead ? [''] : ['admins', ''];
    for (const part of parts) {
      if (job.stopped()) break;
      job.progress(`Opening ${name}’s ${part ? 'admins and moderators' : 'members'}…`);
      await job.tab.open(groupPage(group.url, part));
      const got = await gather(
        job,
        part ? ADMIN_SCROLLS : MEMBER_SCROLLS,
        (page) => (page.group ? (page.people ?? []) : []),
        (count) =>
          `Reading ${name}’s ${part ? 'admins' : 'members'}… ${counted(count, 'person', 'people')} so far.`,
      );
      if (ended(got)) return got;
      // Its admins are saved only once read to the end, so nobody who runs it is suggested; till then its members wait.
      if (part && (!got.whole || !isAdminsPage(got.page.url) || job.stopped())) break;
      if (got.people.length) saved += await saveGroupPage(job, got.page, got.people);
    }
    looked++;
    if (!job.stopped() && g < these.length - 1) await pause(paced(GROUP_PACE_MS));
  }
  return {
    line: `Saved ${counted(saved, 'person', 'people')} from ${counted(looked, 'group')}. Today suggests the ones who fit.`,
    warned: false,
  };
}

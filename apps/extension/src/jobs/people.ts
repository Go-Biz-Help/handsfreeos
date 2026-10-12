/**
 * The jobs that save people (docs/outreach.md, decisions 32 and 43), once a day on their own or when the person asks
 * from HandsFreeOS: **checking friend requests** saves the requests they've got, which Today confirms the ones that
 * fit from (decision 30); **saving group members** saves each good group's admins and moderators, then its members,
 * which Today suggests friend requests from (decision 8). Asked for only: **saving the friends list**, to its end,
 * which Tidy up your friends and the Friends tab work from. It loads each list a screen at a time, and saves what
 * loaded. Nothing is pressed on Facebook.
 */
import type { Person, ReadResult } from '../facebook/types';
import { listBeside } from '../facebook/friends';
import { profileKey } from '../facebook/urls';
import { friendsSave, groupSave, isAdminsPage, listOnPage } from '../hfos/saves';
import { counted } from '../words';
import { pause, paced, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';
import type { WorkGroup } from './posts';

/** Where Facebook lists the friend requests the person has got, and their friends. */
export const FRIEND_REQUESTS = 'https://www.facebook.com/friends/requests';
export const YOUR_FRIENDS = 'https://www.facebook.com/me/friends';
/** Screens of each list it loads. */
export const REQUEST_SCROLLS = 6;
export const MEMBER_SCROLLS = 10;
/** The friends list is read to its end, up to this many screens. */
export const FRIENDS_SCROLLS = 150;
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
  if (!built.ok) return { line: built.why, warned: false, failed: true };
  let added = 0;
  for (const input of built.input)
    added += valueOf(await job.hfos({ type: 'hfos-save-friends', input })).added;
  return {
    line: `Saved ${counted(got.people.length, 'friend request')}${added ? `, ${added.toLocaleString()} new` : ''}.`,
    warned: false,
  };
}

/** Opens the person's friends list, reads it to the end, and saves it. */
export async function saveFriends(job: Job): Promise<JobEnd> {
  job.progress('Opening your friends list…');
  await job.tab.open(YOUR_FRIENDS);
  const got = await gather(
    job,
    FRIENDS_SCROLLS,
    (page) => {
      const mine = listOnPage(page);
      if (mine?.list === 'friends') return mine.people;
      // Facebook sends /me/friends on to /<username>/friends, which the page alone can't always tell is yours, but
      // this job opened your own list: any friends tab it lands on that isn't /friends/… is it.
      return page.kind === 'friends' && !page.friendList && !listBeside(page.url)
        ? (page.people ?? [])
        : [];
    },
    (count) => `Reading your friends… ${counted(count, 'friend')} so far.`,
  );
  if (ended(got)) return got;
  if (!got.people.length)
    return {
      line: 'Facebook showed no friends. Check you’re signed in to Facebook in this browser, then ask again.',
      warned: false,
      failed: true,
    };
  const built = friendsSave(got.people, 'friends', job.businessId);
  if (!built.ok) return { line: built.why, warned: false, failed: true };
  let added = 0;
  for (const input of built.input)
    added += valueOf(await job.hfos({ type: 'hfos-save-friends', input })).added;
  const tail = got.whole ? '' : ' It stopped before the end of the list: ask again for the rest.';
  return {
    line: `Saved ${counted(got.people.length, 'friend')}${added ? `, ${added.toLocaleString()} new` : ''}.${tail}`,
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

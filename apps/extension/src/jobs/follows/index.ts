/**
 * What the person asks of their computer on Threads and X from HandsFreeOS (decision 163; core's
 * `ASK_KINDS_ON.threads` and `.x`), each kind with the job that does it, in a window of its own at a person's pace:
 *
 * - `friends`: their newest followers saved, then the accounts they followed looked at for who follows them back
 *   (./people.ts). On a follow network, a follow-back is the accepting.
 * - `cancel`: those they ticked who didn't follow back, unfollowed in a tab they can see, 20 a day at most
 *   (./unfollow.ts).
 * - `posts`: Find posts, the network's posts searched with the playbooks' words for it, newest first, and the fresh
 *   ones sent for the AI's check (./search.ts).
 * - `profile_read`: their own profile read and sent for the AI's check.
 * - `checkup`: Check Threads or Check X: its main pages opened one at a time and noted with their outlines, and Follow,
 *   Like and the box to reply in looked for, pressing none of them.
 *
 * Nothing is ever written in anyone's messages there (decision 163).
 */
import type { AskResult, AskTaken } from '@hfos/core/addons/outreach/asks';
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import {
  PROFILE_CHECK_WORDS as P,
  type ProfileRead,
} from '@hfos/core/addons/outreach/profile-check';
import { FOLLOW_SPECS } from '../../networks/follows/specs';
import type { FollowAccount, FollowPlatform, FollowPost } from '../../networks/follows/types';
import { Checkup, isEnd, SEARCH_WORDS, wholeProfile } from '../checkup';
import { onScreen, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { ownProfileNote } from '../report';
import { saveMyFollowers } from './people';
import {
  accountIn,
  readFollowIn,
  sameAs,
  signedInWords,
  signedOutEnd,
  type FollowPage,
} from './read';
import { findPostsOn, hourlySearch } from './search';
import { unfollowTicked } from './unfollow';

type Ended = JobEnd & { readonly result?: AskResult | null };

/** How many people from the search are opened for someone to look for Follow on. */
const FOLLOW_LOOKS = 3;

const stopped = (job: Job): JobEnd | null =>
  job.stopped() ? { line: 'Stopped.', warned: false } : null;

/** Check Threads or Check X: its pages read and its steps looked for, nothing pressed. */
async function checkup(job: Job, platform: FollowPlatform): Promise<JobEnd> {
  const spec = FOLLOW_SPECS[platform];
  const c = new Checkup<FollowPage>(job, platform, (tab) => readFollowIn(tab, platform));

  // Your feed, and your own profile from its menu.
  const home = await c.open(spec.pages.home, 'your feed');
  if (isEnd(home)) return home;
  if (home.signedOut) return signedOutEnd(platform);
  await c.note('your feed', home.found.posts.length);
  const me = home.found.me;
  const own = accountIn(platform, home.own);
  if (own) {
    if (stopped(job)) return stopped(job)!;
    const mine = await c.open(own.url, 'your profile');
    if (isEnd(mine)) return mine;
    await c.note('your profile', null);
    // Read as the AI's check reads it (decision 80): what was found is noted, never what it says.
    await wholeProfile(job, true);
  } else c.nothingOn.push('your profile');

  // A search, newest first, as the hourly search reads it.
  if (stopped(job)) return stopped(job)!;
  const search = await c.open(spec.pages.search(SEARCH_WORDS), 'a search');
  if (isEnd(search)) return search;
  await c.note('a search', search.found.posts.length);

  const others = (posts: readonly FollowPost[]) =>
    posts.filter((p) => !sameAs(p.author.username, me));
  const posts = [...others(search.found.posts), ...others(home.found.posts)];

  // Someone from the search or your feed: Follow looked for on their profile, on one you don't follow yet.
  const tried = new Set<string>();
  const people: FollowAccount[] = [];
  for (const post of posts) {
    const key = post.author.username.toLowerCase();
    if (tried.has(key)) continue;
    tried.add(key);
    people.push(post.author);
  }
  for (const person of people.slice(0, FOLLOW_LOOKS)) {
    if (stopped(job)) return stopped(job)!;
    const theirs = await c.open(person.url, 'someone’s profile');
    if (isEnd(theirs)) return theirs;
    await c.note('someone’s profile', null);
    if ((await c.tryHere('follow')).tried) break;
  }
  if (!c.has('follow')) await c.nothingFor('follow', 'nobody on your feed or the search to open');

  // One of their posts on its own page: Like and the box to reply in looked for, its replies read.
  const post = posts[0]?.url ?? null;
  if (post) {
    if (stopped(job)) return stopped(job)!;
    const page = await c.open(post, 'a post');
    if (isEnd(page)) return page;
    await c.note('a post', page.found.post ? null : 0);
    await c.tryHere('like');
    await c.tryHere('comment');
  } else {
    for (const step of ['like', 'comment'] as const)
      await c.nothingFor(step, 'no post on your feed or the search');
  }

  // Your notifications, where replies to your comments show.
  if (stopped(job)) return stopped(job)!;
  const notes = await c.open(spec.pages.notifications, 'your notifications');
  if (isEnd(notes)) return notes;
  await c.note('your notifications', null);

  // Your followers: X's own page of them, Threads' box over your profile opened by your count of them.
  if (own) {
    if (stopped(job)) return stopped(job)!;
    const list = spec.pages.followers(own);
    const opened = await c.open(list ?? own.url, 'your followers');
    if (isEnd(opened)) return opened;
    let page = await c.readTill(opened, (p) => p.found.people.length > 0, 2);
    if (isEnd(page)) return page;
    if (!list && !page.found.people.length && (await job.tab.ask({ type: 'hfos-show-all' })).ok) {
      const shown = await c.readHere();
      if (isEnd(shown)) return shown;
      page = await c.readTill(shown, (p) => p.found.people.length > 0, 3);
      if (isEnd(page)) return page;
    }
    await c.note('your followers', page.found.people.length);
    if (!list) await job.tab.ask({ type: 'hfos-close-dialog' });
  } else c.nothingOn.push('your followers');

  return c.end();
}

/** Read my profile on Threads or X: their own profile from the menu, read, noted and sent for the AI's check. */
async function profileRead(job: Job, platform: FollowPlatform): Promise<JobEnd> {
  const spec = FOLLOW_SPECS[platform];
  job.progress(`Opening your ${spec.name} profile…`);
  await job.tab.open(spec.pages.home);
  const home = await readFollowIn(job.tab, platform);
  const warned = await warnedOn(job, home);
  if (warned) return warned;
  if (home.signedOut) return signedOutEnd(platform);
  const own = accountIn(platform, home.own);
  if (!own)
    return {
      line: `${spec.name} didn’t show your own profile. ${signedInWords(platform)}`,
      warned: false,
      failed: true,
    };
  await job.tab.open(own.url);
  const page = await readFollowIn(job.tab, platform);
  const warnedThere = await warnedOn(job, page);
  if (warnedThere) return warnedThere;
  job.progress('Reading your profile…');
  const answer = await job.tab.ask({ type: 'hfos-own-profile' });
  if (!answer.ok) return { line: answer.error, warned: false, failed: true };
  if (!('read' in answer))
    return { line: `${spec.name} didn’t show your profile.`, warned: false, failed: true };
  const read: ProfileRead = answer.read;
  await job.report?.({ ...ownProfileNote(read), outline: true });
  if (job.stopped()) return { line: 'Stopped.', warned: false };
  job.progress('Checking it with the AI…');
  valueOf(await job.hfos({ type: 'hfos-profile-check', workspaceId: job.businessId, input: read }));
  return { line: P.readDone, warned: false };
}

/** Does an ask on Threads or X with the job that does it. */
export function followAsk(platform: FollowPlatform) {
  return async (task: AskTaken['task'], job: Job): Promise<Ended> => {
    switch (task.kind) {
      case 'friends':
        return saveMyFollowers(job, platform);
      case 'cancel':
        return unfollowTicked(job, platform, task.profileIds);
      case 'posts':
        return task.words.length
          ? findPostsOn(job, platform, task.words)
          : hourlySearch(job, platform);
      case 'profile_read':
        return onScreen(job, () => profileRead(job, platform));
      case 'checkup':
        // Its window in front the whole time, as Chrome draws nothing in a window hidden behind another.
        return onScreen(job, () => checkup(job, platform));
      default:
        return {
          line: `This build of HandsFreeOS Social can’t do that on ${NETWORKS[platform].name} yet. Download the newest one, unzip it over the old folder, press Reload on Chrome’s Extensions page, and ask again.`,
          warned: false,
          failed: true,
        };
    }
  };
}

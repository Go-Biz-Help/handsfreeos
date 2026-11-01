/**
 * The once-a-day jobs (docs/outreach.md, decision 32), which the runner that works on its own (./run.ts) does at the
 * start of the person's working day, or after **Start my day**, before going down their list: it checks their friend
 * requests, tidies up old ones as the person chose (decision 98), checks their groups for their people and joins good ones when people left to reach run low (decision 48),
 * saves the members of their good groups, finds posts in those groups, reads their chats, and checks their friends for
 * good fits (decision 46), each in the window it works in, at a person's pace (src/jobs/). Those fill the list it
 * then works from: requests to confirm, people to send friend requests to, posts to comment on, chats for the AI, and
 * friends to reconnect with. Then it searches for people who could partner with the business and reads them for the
 * AI's partner check (decision 81). Last, it asks for today's helpful post and reads who engaged with those up lately
 * (decision 50); and on the 1st of each month it reads their profile for the AI's check (decision 99). From 0.100.0 it
 * reads their friends' birthdays after tidying, for a note on Today that waits for their OK (decision 108); and from
 * 0.105.0, once a week before the day's checks, their followers, whose good fits among those who aren't friends go on
 * Today for a friend request (decision 113); and from 0.106.0, after finding posts, it likes a few recent posts in their
 * groups and keeps a question there for the day's reply, which the AI writes and waits for their OK at first
 * (decision 114). From 0.121.0 Find posts also searches Facebook's posts with the playbooks' own phrases after the
 * groups, or without any (decision 141). Nothing is pressed or sent on Facebook but Join group and its questions'
 * answers, and only while the person lets it join on its own; the likes in their groups; and on the person's own
 * posts, See who reacted to this.
 * They run while the person lets it work on its own and leaves **Once a day** ticked.
 */
import type { ReadResult } from '../networks/facebook/types';
import { CHECKS_PER_DAY } from '@hfos/core/addons/outreach/checks';
import { GROUP_CHECKS_DAILY } from '@hfos/core/addons/outreach/group-checks';
import { stayActive } from '../jobs/active';
import { chatMemory, readChats } from '../jobs/chats';
import { checkFriends } from '../jobs/checks';
import { readFollowers } from '../jobs/followers';
import { checkPartners } from '../jobs/partners';
import { PARTNER_CHECKS_PER_DAY } from '@hfos/core/addons/outreach/partners';
import { checkGroups } from '../jobs/groups-check';
import { helpfulDaily } from '../jobs/helpful';
import { joinGroups } from '../jobs/join';
import type { Job, JobEnd } from '../jobs/job';
import { checkRequests, saveMembers } from '../jobs/people';
import { findPosts, groupsToWork, RUN_GROUPS, searchPosts, type WorkGroup } from '../jobs/posts';
import { facebookOccasions } from '../jobs/occasions';
import { readProfileOnItsOwn } from '../jobs/own-read';
import { profileRead } from '../jobs/profile';
import { tidyOnItsOwn } from '../jobs/tidy';
import { takeNote } from '../hfos/noting';
import { facebookSearchPostsSave, postsSave } from '../hfos/saves';
import { counted } from '../words';
import type { DailyJob } from './plan';

/** The most chats it reads for the AI in a day; the rest wait for tomorrow, or Read my chats. */
export const DAILY_CHATS = 60;

/** What it's doing, in words for the person. */
export const DAILY_DOING: Readonly<Record<DailyJob, string>> = {
  requests: 'Checking your friend requests…',
  tidy: 'Tidying up your old friend requests…',
  occasions: 'Reading your friends’ birthdays…',
  group_checks: 'Checking your groups for your people…',
  join: 'Looking for good groups to join…',
  members: 'Saving your groups’ members…',
  posts: 'Finding posts in your groups and Facebook’s search…',
  active: 'Liking a few recent posts in your groups…',
  chats: 'Reading your chats for the AI…',
  followers: 'Reading your followers, as it does once a week…',
  checks: 'Checking your friends for good fits…',
  partners: 'Searching for people who could partner with you, then reading them…',
  helpful: 'Asking for today’s helpful post, and reading who engaged…',
  profile: 'Reading your profile, as it does on the 1st of each month…',
};

/** The job's name, for the panel's list of what it did today. */
export const DAILY_NAMES: Readonly<Record<DailyJob, string>> = {
  requests: 'Friend requests',
  tidy: 'Tidy up',
  occasions: 'Birthdays',
  group_checks: 'Check my groups',
  join: 'Join groups',
  members: 'Group members',
  posts: 'Find posts',
  active: 'Active in your groups',
  chats: 'Read my chats',
  followers: 'Your followers',
  checks: 'Check my friends',
  partners: 'Find partners',
  helpful: 'Helpful posts',
  profile: 'Read my profile',
};

/**
 * Find posts' sends, each post once a run: also for Find posts asked from HandsFreeOS (../asks/run.ts), and the look
 * at the newest posts (`watch`, decision 49).
 */
export function postSender(
  job: Job,
  found: 'find' | 'watch' = 'find',
): (page: ReadResult) => Promise<number> {
  const sent = new Set<string>();
  return async (page) => {
    const built = postsSave(page, job.businessId, found);
    if (!built.ok) return 0;
    const posts = built.input.posts.filter((post) => !sent.has(post.url));
    if (!posts.length) return 0;
    const answer = await job.hfos({ type: 'hfos-save-posts', input: { ...built.input, posts } });
    if (!answer.ok) throw new Error(answer.problem.message);
    for (const post of posts) sent.add(post.url);
    return answer.value.checking;
  };
}

/** Facebook's post search's sends (decision 141): each post once a run, with the phrase that found it. */
function searchSender(job: Job): (page: ReadResult, words: string) => Promise<number> {
  const sent = new Set<string>();
  return async (page, words) => {
    const built = facebookSearchPostsSave(page, job.businessId, words);
    if (!built.ok) return 0;
    const posts = built.input.posts.filter((post) => !sent.has(post.url));
    if (!posts.length) return 0;
    const answer = await job.hfos({ type: 'hfos-save-posts', input: { ...built.input, posts } });
    if (!answer.ok) throw new Error(answer.problem.message);
    for (const post of posts) sent.add(post.url);
    return answer.value.checking;
  };
}

/** Why Find posts went through no group. */
const NO_GROUPS = 'You’re not in any group marked Work these or Maybe yet.';

/**
 * The once-a-day Find posts: the posts in the person's groups, then Facebook's post search with the day's phrases
 * from the playbooks (decision 141), even with no group to go through, in one line. A server that sends no phrases
 * leaves the search out.
 */
async function findPostsDaily(job: Job, groups: readonly WorkGroup[] | string): Promise<JobEnd> {
  const inGroups =
    typeof groups === 'string' ? null : await findPosts(job, groups, postSender(job));
  if (inGroups?.warned || job.stopped()) return inGroups ?? { line: NO_GROUPS, warned: false };
  job.progress('Asking HandsFreeOS what to search Facebook’s posts for…');
  const asked = await job.hfos({
    type: 'hfos-post-words',
    workspaceId: job.businessId,
    platform: 'facebook',
    ...(job.round ? { round: job.round } : {}),
  });
  const words = asked.ok ? asked.value.words : [];
  const searched = words.length ? await searchPosts(job, words, searchSender(job)) : null;
  if (searched && 'warned' in searched) return searched;
  const line = [
    inGroups?.line ?? NO_GROUPS,
    searched?.searched
      ? `${job.stopped() ? 'Stopped. ' : ''}Searched Facebook’s posts for ${counted(searched.searched, 'phrase')}: ${counted(searched.checking, 'post')} sent for the AI to check.`
      : null,
  ];
  return { line: line.filter(Boolean).join(' '), warned: false };
}

/** Does one of the once-a-day jobs. */
export async function runDaily(kind: DailyJob, job: Job): Promise<JobEnd> {
  switch (kind) {
    case 'requests':
      return checkRequests(job);
    case 'occasions':
      return facebookOccasions(job);
    case 'tidy':
      return tidyOnItsOwn(job);
    case 'group_checks':
      return checkGroups(job, GROUP_CHECKS_DAILY);
    case 'join':
      return joinGroups(job, null, true);
    case 'members':
    case 'posts': {
      const groups = await groupsToWork(job, RUN_GROUPS);
      if (kind === 'posts') return findPostsDaily(job, groups);
      if (typeof groups === 'string') return { line: NO_GROUPS, warned: false };
      return saveMembers(job, groups);
    }
    case 'active':
      return stayActive(job, (step) =>
        takeNote({ type: 'hfos-noted', step, at: new Date().toISOString() }),
      );
    case 'chats':
      return readChats(job, {
        most: DAILY_CHATS,
        memory: chatMemory,
        again: 'The rest wait for tomorrow.',
      });
    case 'followers':
      return readFollowers(job);
    case 'checks':
      return checkFriends(job, CHECKS_PER_DAY);
    case 'partners':
      return checkPartners(job, PARTNER_CHECKS_PER_DAY);
    case 'helpful':
      return helpfulDaily(job);
    case 'profile':
      return readProfileOnItsOwn(job, 'facebook', profileRead);
  }
}

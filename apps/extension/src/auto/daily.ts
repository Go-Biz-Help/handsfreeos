/**
 * The once-a-day jobs (docs/outreach.md, decision 32), which the runner that works on its own (./run.ts) does at the
 * start of the person's working day, or after **Start my day**, before going down their list: it checks their friend
 * requests, checks their groups for their people and joins good ones when people left to reach run low (decision 48),
 * saves the members of their good groups, finds posts in those groups, reads their chats, and checks their friends for
 * good fits (decision 46), each in the window it works in, at a person's pace (src/jobs/). Those fill the list it
 * then works from: requests to confirm, people to send friend requests to, posts to comment on, chats for the AI, and
 * friends to reconnect with. Then it searches for people who could partner with the business and reads them for the
 * AI's partner check (decision 81). Last, it asks for today's helpful post and reads who engaged with those up lately
 * (decision 50). Nothing is pressed or sent on Facebook but Join group and its questions' answers, and
 * only while the person lets it join on its own; and on the person's own posts, See who reacted to this. They run while the person lets it work on its own and leaves **Once
 * a day** ticked.
 */
import type { ReadResult } from '../networks/facebook/types';
import { CHECKS_PER_DAY } from '@hfos/core/addons/outreach/checks';
import { GROUP_CHECKS_DAILY } from '@hfos/core/addons/outreach/group-checks';
import { chatMemory, readChats } from '../jobs/chats';
import { checkFriends } from '../jobs/checks';
import { checkPartners } from '../jobs/partners';
import { PARTNER_CHECKS_PER_DAY } from '@hfos/core/addons/outreach/partners';
import { checkGroups } from '../jobs/groups-check';
import { helpfulDaily } from '../jobs/helpful';
import { joinGroups } from '../jobs/join';
import type { Job, JobEnd } from '../jobs/job';
import { checkRequests, saveMembers } from '../jobs/people';
import { findPosts, groupsToWork, RUN_GROUPS } from '../jobs/posts';
import { postsSave } from '../hfos/saves';
import type { DailyJob } from './plan';

/** The most chats it reads for the AI in a day; the rest wait for tomorrow, or Read my chats. */
export const DAILY_CHATS = 60;

/** What it's doing, in words for the person. */
export const DAILY_DOING: Readonly<Record<DailyJob, string>> = {
  requests: 'Checking your friend requests…',
  group_checks: 'Checking your groups for your people…',
  join: 'Looking for good groups to join…',
  members: 'Saving your groups’ members…',
  posts: 'Finding posts in your groups…',
  chats: 'Reading your chats for the AI…',
  checks: 'Checking your friends for good fits…',
  partners: 'Searching for people who could partner with you, then reading them…',
  helpful: 'Asking for today’s helpful post, and reading who engaged…',
};

/** The job's name, for the panel's list of what it did today. */
export const DAILY_NAMES: Readonly<Record<DailyJob, string>> = {
  requests: 'Friend requests',
  group_checks: 'Check my groups',
  join: 'Join groups',
  members: 'Group members',
  posts: 'Find posts',
  chats: 'Read my chats',
  checks: 'Check my friends',
  partners: 'Find partners',
  helpful: 'Helpful posts',
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

/** Does one of the once-a-day jobs. */
export async function runDaily(kind: DailyJob, job: Job): Promise<JobEnd> {
  switch (kind) {
    case 'requests':
      return checkRequests(job);
    case 'group_checks':
      return checkGroups(job, GROUP_CHECKS_DAILY);
    case 'join':
      return joinGroups(job, null, true);
    case 'members':
    case 'posts': {
      const groups = await groupsToWork(job, RUN_GROUPS);
      if (typeof groups === 'string')
        return { line: 'You’re not in any group marked Work these or Maybe yet.', warned: false };
      return kind === 'members'
        ? saveMembers(job, groups)
        : findPosts(job, groups, postSender(job));
    }
    case 'chats':
      return readChats(job, {
        most: DAILY_CHATS,
        memory: chatMemory,
        again: 'The rest wait for tomorrow.',
      });
    case 'checks':
      return checkFriends(job, CHECKS_PER_DAY);
    case 'partners':
      return checkPartners(job, PARTNER_CHECKS_PER_DAY);
    case 'helpful':
      return helpfulDaily(job);
  }
}

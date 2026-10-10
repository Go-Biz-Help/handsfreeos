/**
 * The once-a-day jobs (docs/outreach.md, decision 32), which the runner that works on its own (./run.ts) does at the
 * start of the person's working day, or after **Start my day**, before going down their list: it checks their friend
 * requests, saves the members of their good groups, finds posts in those groups, and reads their chats, each in the
 * window it works in, at a person's pace (src/jobs/). Those fill the list it then works from: requests to confirm,
 * people to send friend requests to, posts to comment on, and chats for the AI. Nothing is pressed or sent on
 * Facebook. They run while the person lets it work on its own and leaves **Once a day** ticked.
 */
import type { ReadResult } from '../facebook/types';
import { chatMemory, readChats } from '../jobs/chats';
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
  members: 'Saving your groups’ members…',
  posts: 'Finding posts in your groups…',
  chats: 'Reading your chats for the AI…',
};

/** The job's name, for the panel's list of what it did today. */
export const DAILY_NAMES: Readonly<Record<DailyJob, string>> = {
  requests: 'Friend requests',
  members: 'Group members',
  posts: 'Find posts',
  chats: 'Read my chats',
};

/** Find posts' sends, each post once a day. */
function postSender(job: Job): (page: ReadResult) => Promise<number> {
  const sent = new Set<string>();
  return async (page) => {
    const built = postsSave(page, job.businessId, 'find');
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
  }
}

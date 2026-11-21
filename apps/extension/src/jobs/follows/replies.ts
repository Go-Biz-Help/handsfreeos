/**
 * **Replies to your comments** on Threads and X (decision 163, answer 8a): each hourly look also reads the person's
 * notifications (X's Mentions, Threads' Activity), where a reply to one of their comments shows as a post of its own.
 * Each one there that says it answers the person (X's "Replying to @you", Threads' "replied"), or that comes from
 * someone they commented to, goes to HandsFreeOS (`outreach.comment_replies.save`), which keeps each new one once: it
 * waits on Today for an answer the AI drafts, and the answer waits for their OK on Needs you. A reply that says yes to
 * a demo pushes to their phone.
 *
 * Nothing is pressed or written here. It reads one screen, and stops on any warning.
 */
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import { commentRepliesSave } from '../../hfos/saves';
import { FOLLOW_SPECS } from '../../networks/follows/specs';
import type { FollowPlatform } from '../../networks/follows/types';
import { counted } from '../../words';
import { pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { readFollowIn, signedOutEnd } from './read';

/** For the notifications to draw. */
const DRAWN_MS = 3_000;

/** Reads the person's notifications for replies to their comments, and sends them to HandsFreeOS. */
export async function readCommentReplies(job: Job, platform: FollowPlatform): Promise<JobEnd> {
  const spec = FOLLOW_SPECS[platform];
  const name = NETWORKS[platform].name;
  job.progress(`Reading your ${name} notifications for replies to your comments…`);
  await job.tab.open(spec.pages.notifications);
  await pause(DRAWN_MS);
  const page = await readFollowIn(job.tab, platform);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd(platform);
  const me = page.found.me;
  // Whether each says it answers the person is read in the tab (`replyingTo`): X's "Replying to @you", Threads' row.
  const replies = page.found.posts.map((post) => ({
    ...post,
    toComment: !!me && post.replyingTo.some((u) => u.toLowerCase() === me.toLowerCase()),
  }));
  const built = commentRepliesSave(platform, replies, job.businessId, me);
  if (!built.ok) return { line: `No new replies to your comments on ${name}.`, warned: false };
  const saved = valueOf(await job.hfos({ type: 'hfos-comment-replies', input: built.input }));
  return {
    line: saved.kept
      ? `${counted(saved.kept, 'new reply', 'new replies')} to your comments on ${name}: each waits on Today for an answer.`
      : `No new replies to your comments on ${name}.`,
    warned: false,
  };
}

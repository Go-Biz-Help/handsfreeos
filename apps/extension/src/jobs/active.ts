/**
 * **Staying active in your groups** on Facebook (docs/outreach.md decision 114; `active`, once a day while the
 * extension works on its own there, after Find posts). The owner's pick: "Each day it likes 3 to 5 recent posts in
 * your groups and replies to 1. The AI writes the reply, and replies wait for your OK at first."
 *
 * HandsFreeOS says how many to like today, and in which of the person's groups (`outreach.active.next`): up to 3 that
 * fit and that no teammate works, a different few each day. Each group's newest posts are read, and the likes go on
 * recent ones there, spread over the groups, at a person's pace: never one of the person's own, one liked already, or
 * one about sad news (`neverLike`). Each is noted as a like of theirs, so it counts against the day's likes. The
 * recent posts there that ask something are offered to HandsFreeOS for the day's reply (`outreach.active.reply`),
 * which keeps the first it can: Today lists it, the AI writes the reply, and the runner posts it under the question
 * once it's OK'd, or on its own once replies there have stopped waiting (../auto/comments.ts). Nothing else is
 * pressed. It stops on any Facebook warning.
 */
import { asksSomething, recentPost } from '@hfos/core/addons/outreach/active';
import { likedText, neverLike } from '@hfos/core/addons/outreach/like-pick';
import { activeReplySave, type AskedInGroup } from '../hfos/saves';
import type { ActiveNext } from '../hfos/messages';
import type { Step, StepGroup } from '../networks/facebook/actions';
import { sameByKey, type GroupFeedPost } from '../networks/facebook/auto';
import type { ProfileRef } from '../networks/facebook/types';
import { facebookUrl, profileFromUrl } from '../networks/facebook/urls';
import { counted } from '../words';
import { pause, paced, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';
import { newestUrl } from './posts';

/** The newest posts read in each group. */
export const ACTIVE_READ = 10;
/** Between two likes, and between groups: a person reading as they go. */
const LIKE_PACE_MS = [20_000, 60_000] as const;
const GROUP_PACE_MS = [15_000, 30_000] as const;

/** The person's own profile there, as HandsFreeOS has it from the check of their profile: null till it's been read. */
function ownRef(own: ActiveNext['own']): ProfileRef | null {
  if (!own) return null;
  const link = own.url ? facebookUrl(own.url) : null;
  const byLink = link ? profileFromUrl(link) : null;
  if (byLink)
    return own.username ? { ...byLink, username: byLink.username ?? own.username } : byLink;
  return own.username
    ? { id: null, username: own.username, url: `https://www.facebook.com/${own.username}` }
    : null;
}

/** Whether a post in the feed is someone else's, recent, and named: one the day's likes or question may go to. */
const othersRecent = (post: GroupFeedPost, own: ProfileRef | null): boolean =>
  post.author?.profile !== null &&
  post.author?.profile !== undefined &&
  sameByKey(post.author.profile, own) !== true &&
  recentPost(post.when);

/** Today's likes in the person's groups, and a question kept there for the day's reply. */
export async function stayActive(
  job: Job,
  noteLike: (step: Step) => Promise<void>,
): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS what today’s likes in your groups are…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-active-next',
      input: { workspaceId: job.businessId, platform: 'facebook' },
    }),
  );
  if (!next.groups.length || (!next.likes && !next.reply))
    return { line: 'Nothing to like or answer in your groups today.', warned: false };
  const own = ownRef(next.own);
  let likesLeft = next.likes;
  let liked = 0;
  let looked = 0;
  const asked: AskedInGroup[] = [];
  for (const [g, group] of next.groups.entries()) {
    if (job.stopped()) break;
    const name = group.name ?? 'your group';
    job.progress(`Opening ${name}…`);
    await job.tab.open(newestUrl(group.url));
    const page = await readIn(job.tab);
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    const ref = page.kind === 'group' ? page.group?.group : null;
    if (!ref) continue;
    const there: StepGroup = { ...ref, name: page.group?.name ?? group.name };
    const read = await job.tab.ask({ type: 'hfos-group-feed', most: ACTIVE_READ });
    if (!read.ok) continue;
    looked++;
    // This group's share of the likes left, spread over the groups left.
    let here = Math.ceil(likesLeft / (next.groups.length - g));
    for (const [index, post] of read.posts.entries()) {
      if (!here || job.stopped()) break;
      if (post.liked || !othersRecent(post, own) || neverLike(post)) continue;
      const went = await job.tab.ask({ type: 'hfos-like-group-post', index, url: post.url });
      if (!went.ok || went.result !== 'done') continue;
      here--;
      likesLeft--;
      liked++;
      await noteLike({
        kind: 'like',
        to: { name: post.author!.name, profile: post.author!.profile! },
        group: there,
        postUrl: went.postUrl ?? post.url,
        thread: null,
        replying: null,
        auto: true,
        postText: likedText(post),
        why: null,
      });
      job.progress(`Liked ${counted(liked, 'post')} in your groups so far…`);
      await pause(paced(LIKE_PACE_MS));
      const after = await warnedOn(job, await readIn(job.tab));
      if (after) return after;
    }
    if (next.reply)
      for (const post of read.posts)
        if (othersRecent(post, own) && asksSomething(post.text))
          asked.push({
            group: there,
            url: post.url,
            author: post.author,
            when: post.when,
            text: post.text,
            comments: post.comments,
            reactions: post.reactions,
          });
    if (!job.stopped() && g < next.groups.length - 1) await pause(paced(GROUP_PACE_MS));
  }
  let kept = false;
  if (next.reply && asked.length && !job.stopped()) {
    const built = activeReplySave(asked, job.businessId);
    if (built.ok)
      kept =
        valueOf(await job.hfos({ type: 'hfos-active-reply', input: built.input })).postId !== null;
  }
  const parts = [
    `${job.stopped() ? 'Stopped. ' : ''}Liked ${counted(liked, 'recent post')} in ${counted(looked, 'group')}.`,
    kept ? 'A question there is on Today for a reply the AI writes.' : null,
  ];
  return { line: parts.filter(Boolean).join(' '), warned: false };
}

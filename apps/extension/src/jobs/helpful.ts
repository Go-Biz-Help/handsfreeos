/**
 * Helpful posts in the groups, and the people who engage (docs/outreach.md, decision 50):
 *
 * - **Putting one up:** the one the person OK'd (an ask from HandsFreeOS, `post`), or, when they let it post on its
 *   own, today's draft (the runner, ../auto/run.ts). It opens the group, types the post into Facebook's box and
 *   presses Post (../facebook/compose.ts), then finds it at the top of the group's newest posts for its link, and
 *   notes how it went: up, waiting for the admins, or couldn't, with why. It stops on any Facebook warning.
 * - **Who engaged:** once a day, each post up in the last fortnight: it opens it (found by its first words when its
 *   link isn't known), reads who commented and who reacted, and sends them; each is a warm lead on Today.
 */
import { HELPFUL_TEXT_MOST } from '@hfos/core/addons/outreach/helpful';
import { line } from '../facebook/lookup';
import type { ReadResult } from '../facebook/types';
import type { HelpfulNext } from '../hfos/messages';
import { counted } from '../words';
import { paced, pause, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';
import { newestUrl } from './posts';

/** While Facebook puts the post at the top of the group, and between posts read. */
const SETTLE_MS = 4_000;
const PACE_MS = [8_000, 16_000] as const;
/** The most posts read for who engaged in one run. */
const READ_MOST = 5;

/** Words compared as Facebook shows them: no line breaks or doubled spaces, in lower case. */
const plain = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The post among those the page shows that starts the way this one does (Facebook may cut a long one short with See
 * more): its link.
 */
export function foundPost(page: ReadResult, text: string): string | null {
  const mine = plain(text).slice(0, 60);
  if (!mine) return null;
  return (
    page.posts?.find((p) => {
      const theirs = plain(p.text).slice(0, 60);
      return (
        p.url !== null &&
        theirs.length >= Math.min(20, mine.length) &&
        (theirs.startsWith(mine) || mine.startsWith(theirs))
      );
    })?.url ?? null
  );
}

async function next(job: Job, helpfulId: string | null): Promise<HelpfulNext> {
  return valueOf(
    await job.hfos({
      type: 'hfos-helpful-next',
      input: { workspaceId: job.businessId, ...(helpfulId ? { helpfulId } : {}) },
    }),
  );
}

async function noted(
  job: Job,
  helpfulId: string,
  went: { posted: boolean; url?: string | null; why?: string | null },
): Promise<void> {
  valueOf(
    await job.hfos({
      type: 'hfos-helpful-posted',
      input: {
        workspaceId: job.businessId,
        helpfulId,
        posted: went.posted,
        url: went.url ?? null,
        why: went.why ?? null,
      },
    }),
  );
}

/** How putting one up went: `posted` once it's up or with the admins. */
export type HelpfulEnd = JobEnd & { readonly posted?: boolean };

/** Puts up the helpful post OK'd (`helpfulId`), or today's draft when the person lets it post on its own. */
export async function postHelpful(job: Job, helpfulId: string | null): Promise<HelpfulEnd> {
  job.progress('Asking HandsFreeOS for your helpful post…');
  const { post } = await next(job, helpfulId);
  if (!post)
    return {
      line: helpfulId
        ? 'That helpful post isn’t OK’d any more, or it’s up already.'
        : 'No helpful post to put up on its own today.',
      warned: false,
    };
  const group = post.groupName ?? 'the group';
  // Facebook's are each in a group; one on a feed of its own is its network's to post.
  const groupUrl = post.groupUrl;
  if (!groupUrl)
    return { line: 'That helpful post goes on your own feed, not in a group.', warned: false };
  job.progress(`Putting your helpful post up in ${group}…`);
  await job.tab.open(groupUrl);
  const page = await readIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  const fail = async (why: string): Promise<JobEnd> => {
    await noted(job, post.helpfulId, { posted: false, why });
    return { line: `Couldn’t post in ${group}: ${why}`, warned: false, failed: true };
  };
  if (page.group?.joined === false)
    return fail('You’re not in the group any more. Join it again, or skip this post.');
  const answer = await job.tab.ask({
    type: 'hfos-group-post',
    text: post.text.slice(0, HELPFUL_TEXT_MOST),
  });
  if (!answer.ok) return fail(answer.error);
  const result = 'result' in answer ? answer.result : 'not_sent';
  if (result === 'none')
    return fail(
      'Facebook didn’t show the box to write a post. Copy it and post it yourself, or skip it.',
    );
  if (result === 'not_sent')
    return fail('Facebook didn’t take the post. Copy it and post it yourself, or skip it.');
  // Its link, from the top of the newest posts; one waiting for the admins isn't there yet.
  let url: string | null = null;
  if (result === 'done') {
    await pause(SETTLE_MS);
    await job.tab.open(newestUrl(groupUrl));
    const after = await readIn(job.tab);
    const warnedAfter = await warnedOn(job, after);
    if (warnedAfter) {
      await noted(job, post.helpfulId, { posted: true });
      return { ...warnedAfter, posted: true };
    }
    url = foundPost(after, post.text);
  }
  await noted(job, post.helpfulId, { posted: true, url });
  return {
    line:
      result === 'pending'
        ? `Sent your helpful post to ${group}: it goes up once its admins OK it.`
        : `Put your helpful post up in ${group}.`,
    warned: false,
    posted: true,
  };
}

/** Reads who commented on and reacted to the person's helpful posts lately, and sends them as warm leads. */
export async function readEngaged(job: Job): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS which of your posts to read…');
  const { read } = await next(job, null);
  if (!read.length) return { line: 'No helpful posts up lately to read.', warned: false };
  let added = 0;
  let looked = 0;
  for (const [i, p] of read.slice(0, READ_MOST).entries()) {
    if (job.stopped()) break;
    job.progress(`Reading who engaged with your post in ${p.groupName ?? 'a group'}…`);
    let url = p.postUrl;
    if (!url) {
      if (!p.groupUrl) continue;
      await job.tab.open(newestUrl(p.groupUrl));
      const feed = await readIn(job.tab);
      const warned = await warnedOn(job, feed);
      if (warned) return warned;
      url = foundPost(feed, p.text);
      if (!url) continue;
    }
    await job.tab.open(url);
    const page = await readIn(job.tab);
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    const answer = await job.tab.ask({ type: 'hfos-engaged' });
    if (!answer.ok || !('comments' in answer)) continue;
    const saved = valueOf(
      await job.hfos({
        type: 'hfos-helpful-engaged',
        input: {
          workspaceId: job.businessId,
          helpfulId: p.helpfulId,
          url,
          comments: answer.comments.map((c) => ({
            profile: c.profile,
            name: line(c.name, 200),
            comment: c.comment ? line(c.comment, 1000) : null,
          })),
          reactions: answer.reactions.map((r) => ({ profile: r.profile, name: line(r.name, 200) })),
        },
      }),
    );
    added += saved.added;
    looked++;
    if (i < read.length - 1 && !job.stopped()) await pause(paced(PACE_MS));
  }
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}Read ${counted(looked, 'post')}: ${counted(added, 'new person', 'new people')} engaged.${added ? ' They’re on your list for today.' : ''}`,
    warned: false,
  };
}

/**
 * The once-a-day part (../auto/daily.ts): asks for today's helpful post, which the AI writes for the person to OK,
 * copy, or let go on its own; then reads who engaged with those up lately.
 */
export async function helpfulDaily(job: Job): Promise<JobEnd> {
  job.progress('Asking for today’s helpful post…');
  const asked = await job.hfos({
    type: 'hfos-helpful-ask',
    input: { workspaceId: job.businessId },
  });
  // Today's is up already, or no group fits yet: that's the line, and the reading goes on.
  const first = asked.ok
    ? asked.value.fresh
      ? `The AI is writing today’s helpful post for ${asked.value.groupName ?? 'one of your groups'}.`
      : 'Today’s helpful post is asked for already.'
    : asked.problem.message;
  if (job.stopped()) return { line: first, warned: false };
  const read = await readEngaged(job);
  return { line: `${first} ${read.line}`, warned: read.warned };
}

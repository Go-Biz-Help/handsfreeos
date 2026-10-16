/**
 * The helpful post on LinkedIn (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by part", 6; as
 * Facebook's, ../helpful.ts, decision 50), on the person's own feed rather than in a group:
 *
 * - **Putting one up:** the one the person OK'd (an ask from HandsFreeOS, `post`), or, when their LinkedIn posting
 *   choice lets it post on its own, today's draft (LinkedIn's runner, ../../auto/linkedin.ts). It opens their feed,
 *   presses Start a post, types the post into LinkedIn's box and presses Post (../../networks/linkedin/compose.ts),
 *   takes its link from LinkedIn's View post (else finds it among their own posts by its first words), and notes how
 *   it went with `outreach.helpful.posted`: up, or couldn't, with why.
 * - **Who engaged:** once a day, each of their LinkedIn posts up in the last fortnight: it opens it, reads who
 *   commented (and what) and who reacted, and sends them (`outreach.helpful.engaged`); each is a warm lead on
 *   LinkedIn's Today.
 *
 * Every call says LinkedIn (`platform: 'linkedin'`), so Facebook's helpful posts are never touched. It stops on any
 * LinkedIn warning.
 */
import { HELPFUL_TEXT_MOST } from '@hfos/core/addons/outreach/helpful';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import type { HelpfulNext } from '../../hfos/messages';
import { line } from '../../networks/facebook/lookup';
import { counted } from '../../words';
import { foundPost, type HelpfulEnd } from '../helpful';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { LINKEDIN, readLinkedIn } from './read';

const PLATFORM: Platform = 'linkedin';

/** The person's feed, where a post starts; and their own posts, the latest first, where a new one is found. */
export const FEED = `${LINKEDIN}/feed/`;
export const OWN_POSTS = `${LINKEDIN}/in/me/recent-activity/all/`;

/** While LinkedIn puts the post among the person's own, and between posts read. */
const SETTLE_MS = 4_000;
const PACE_MS = [8_000, 16_000] as const;
/** The most posts read for who engaged in one run. */
const READ_MOST = 5;

export const LINKEDIN_POST_NONE =
  'LinkedIn didn’t show Start a post on your feed. Copy the post from Today and post it on your LinkedIn feed yourself, or skip it.';
export const LINKEDIN_POST_NOT_TAKEN =
  'LinkedIn didn’t take the post. Copy it from Today and post it on your LinkedIn feed yourself, or skip it.';

async function next(job: Job, helpfulId: string | null): Promise<HelpfulNext> {
  return valueOf(
    await job.hfos({
      type: 'hfos-helpful-next',
      input: {
        workspaceId: job.businessId,
        platform: PLATFORM,
        ...(helpfulId ? { helpfulId } : {}),
      },
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

/** Puts up the LinkedIn helpful post OK'd (`helpfulId`), or today's draft when the person lets it post on its own. */
export async function postOnLinkedIn(job: Job, helpfulId: string | null): Promise<HelpfulEnd> {
  job.progress('Asking HandsFreeOS for your helpful post…');
  const { post } = await next(job, helpfulId);
  if (!post)
    return {
      line: helpfulId
        ? 'That helpful post isn’t OK’d any more, or it’s up already.'
        : 'No helpful post to put up on its own today.',
      warned: false,
    };
  job.progress('Putting your helpful post up on your LinkedIn feed…');
  await job.tab.open(FEED);
  const page = await readLinkedIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  const fail = async (why: string): Promise<JobEnd> => {
    await noted(job, post.helpfulId, { posted: false, why });
    return { line: `Couldn’t post on your LinkedIn feed: ${why}`, warned: false, failed: true };
  };
  const answer = await job.tab.ask({
    type: 'hfos-feed-post',
    text: post.text.slice(0, HELPFUL_TEXT_MOST),
  });
  if (!answer.ok) return fail(answer.error);
  if (answer.result === 'none') return fail(LINKEDIN_POST_NONE);
  if (answer.result !== 'done') return fail(LINKEDIN_POST_NOT_TAKEN);
  let url = answer.url;
  if (!url) {
    // Its link from among their own posts, where it's the latest.
    await pause(SETTLE_MS);
    await job.tab.open(OWN_POSTS);
    const after = await readLinkedIn(job.tab);
    const warnedAfter = await warnedOn(job, after);
    if (warnedAfter) {
      await noted(job, post.helpfulId, { posted: true });
      return { ...warnedAfter, posted: true };
    }
    url = foundPost(after, post.text);
  }
  await noted(job, post.helpfulId, { posted: true, url });
  return { line: 'Put your helpful post up on your LinkedIn feed.', warned: false, posted: true };
}

/** Reads who commented on and reacted to the person's LinkedIn posts lately, and sends them as warm leads. */
export async function readLinkedInEngaged(job: Job): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS which of your LinkedIn posts to read…');
  const { read } = await next(job, null);
  if (!read.length)
    return { line: 'No helpful posts up on LinkedIn lately to read.', warned: false };
  let added = 0;
  let looked = 0;
  for (const [i, p] of read.slice(0, READ_MOST).entries()) {
    if (job.stopped()) break;
    job.progress('Reading who engaged with your post on LinkedIn…');
    let url = p.postUrl;
    if (!url) {
      await job.tab.open(OWN_POSTS);
      const own = await readLinkedIn(job.tab);
      const warned = await warnedOn(job, own);
      if (warned) return warned;
      url = foundPost(own, p.text);
      if (!url) continue;
    }
    await job.tab.open(url);
    const page = await readLinkedIn(job.tab);
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
    line: `${job.stopped() ? 'Stopped. ' : ''}Read ${counted(looked, 'post')}: ${counted(added, 'new person', 'new people')} engaged.${added ? ' They’re on your LinkedIn list for today.' : ''}`,
    warned: false,
  };
}

/**
 * LinkedIn's once-a-day part (../../auto/linkedin.ts): asks for today's helpful post for the person's feed, which the
 * AI writes for them to OK, copy, or let go on its own; then reads who engaged with those up lately.
 */
export async function linkedInHelpfulDaily(job: Job): Promise<JobEnd> {
  job.progress('Asking for today’s helpful post for your LinkedIn feed…');
  const asked = await job.hfos({
    type: 'hfos-helpful-ask',
    input: { workspaceId: job.businessId, platform: PLATFORM },
  });
  const first = asked.ok
    ? asked.value.fresh
      ? 'The AI is writing today’s helpful post for your LinkedIn feed.'
      : 'Today’s helpful post for LinkedIn is asked for already.'
    : asked.problem.message;
  if (job.stopped()) return { line: first, warned: false };
  const read = await readLinkedInEngaged(job);
  return { line: `${first} ${read.line}`, warned: read.warned };
}

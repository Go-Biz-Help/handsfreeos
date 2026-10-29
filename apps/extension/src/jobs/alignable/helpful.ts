/**
 * The week's helpful post on Alignable (docs/outreach.md, decision 109), on the person's own Alignable as LinkedIn's
 * goes on their feed (../linkedin/helpful.ts): only the one they OK'd (an ask from HandsFreeOS, `post`), never one on
 * its own. It opens their signed-in home page, writes the post in Alignable's box and presses its own Post
 * (../../networks/alignable/compose.ts), and notes how it went with `outreach.helpful.posted`: up, with its link when
 * the page shows it, or couldn't, with why. Who engaged with it comes from their notifications, as before
 * (./engaged.ts). It stops on any Alignable warning.
 */
import { HELPFUL_TEXT_MOST } from '@hfos/core/addons/outreach/helpful';
import type { HelpfulNext } from '../../hfos/messages';
import type { HelpfulEnd } from '../helpful';
import { valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { ALIGNABLE, readAlignableIn, signedOutEnd } from './read';

/** Their signed-in home page, where a post starts. */
export const HOME = `${ALIGNABLE}/biz`;

export const ALIGNABLE_POST_NONE =
  'Alignable didn’t show a box to start a post on your home page. Copy the post from Today and post it on Alignable yourself, or skip it.';
export const ALIGNABLE_POST_NOT_TAKEN =
  'Alignable didn’t take the post. Copy it from Today and post it on Alignable yourself, or skip it.';

async function next(job: Job, helpfulId: string): Promise<HelpfulNext> {
  return valueOf(
    await job.hfos({
      type: 'hfos-helpful-next',
      input: { workspaceId: job.businessId, platform: 'alignable', helpfulId },
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

/** Puts up the Alignable helpful post the person OK'd. */
export async function postOnAlignable(job: Job, helpfulId: string): Promise<HelpfulEnd> {
  job.progress('Asking HandsFreeOS for your helpful post…');
  const { post } = await next(job, helpfulId);
  if (!post)
    return { line: 'That helpful post isn’t OK’d any more, or it’s up already.', warned: false };
  job.progress('Putting your helpful post up on Alignable…');
  await job.tab.open(HOME);
  const page = await readAlignableIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd();
  const fail = async (why: string): Promise<JobEnd> => {
    await noted(job, post.helpfulId, { posted: false, why });
    return { line: `Couldn’t post on Alignable: ${why}`, warned: false, failed: true };
  };
  const answer = await job.tab.ask({
    type: 'hfos-feed-post',
    text: post.text.slice(0, HELPFUL_TEXT_MOST),
  });
  if (!answer.ok) return fail(answer.error);
  if (answer.result === 'none') return fail(ALIGNABLE_POST_NONE);
  if (answer.result !== 'done') return fail(ALIGNABLE_POST_NOT_TAKEN);
  await noted(job, post.helpfulId, { posted: true, url: answer.url });
  return { line: 'Put your helpful post up on Alignable.', warned: false, posted: true };
}

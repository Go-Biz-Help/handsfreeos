/**
 * Comments on good posts where they go through `sends` (docs/outreach.md, decision 92: a network whose kit's
 * `commentsWait` is `hold`, Instagram's and Alignable's), as those runners (./instagram.ts, ./alignable.ts) draft and
 * send them: what's the same on both. LinkedIn's comments go on their own as its own step, and Facebook's are the
 * person's, so neither comes here.
 *
 * - **Drafted from the post** (`draftComment`): the AI writes it for that post (`hfos-draft` with its `postId`), and
 *   HandsFreeOS queues it with its post (`outreach.send.queue`). It waits for the person's OK while that network's
 *   comment hold or training wheels are on, then goes on its own; an answer to a post asking for exactly what the
 *   business offers always waits for an OK of its own (decision 79).
 * - **Sent once OK'd** (`sendComment`): on the post's own page, by the link kept, its warnings looked at first; written
 *   only in the post's own box (the site's `auto.comment`, ../networks/looking/kit.ts, told whose post and which), then
 *   HandsFreeOS hears how it went (`outreach.send.done`) and the comment is noted as the extension's own, with what the
 *   post said and the comment. One that couldn't go HandsFreeOS hands to the person with its words, and sets its post
 *   aside so it isn't drafted again.
 */
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import type { Drafts, TodayListItem } from '../hfos/messages';
import { takeNote } from '../hfos/noting';
import { answer, api, call, Refused } from '../hfos/session';
import { pause } from '../jobs/job';
import type { AutoAnswer, AutoAsk } from '../messages';
import type { ProfileRef } from '../networks/facebook/types';
import type { Work } from './plan';

/** While the network draws what a press sent. */
const SETTLE_MS = 2_000;

/**
 * What a comment's draft or send came to, as the runners' own outcomes say it: done, not done (the line says why), a
 * stop for the day on a warning, or (`again`) a stop for now with nothing tried, when the network asked them to sign in.
 */
export type CommentOutcome =
  | { readonly done: true; readonly line: string }
  | { readonly done: false; readonly line: string }
  | { readonly stop: string }
  | { readonly again: string };

/** What a runner lends a comment's send: its network, its window's tab, and its look at the page it opened. */
export interface CommentRunner {
  readonly platform: Platform;
  readonly tab: {
    open(url: string): Promise<unknown>;
    ask(message: AutoAsk): Promise<AutoAnswer>;
  };
  /**
   * The page the tab shows, looked at: its network's warning there, noted and a stop for the day; its sign-in page, a
   * stop for now; else null. Called once the post opens, and again once the comment went.
   */
  readonly onPage: (
    businessId: string,
  ) => Promise<{ readonly stop: string } | { readonly again: string } | null>;
}

/** Whether a piece of work on the list is a comment through `sends`: drafted, or sent once OK'd. */
export const isCommentWork = (work: Work): boolean =>
  work.do !== 'step' && work.item.kind === 'comment';

/** What the runner says it's doing for a comment's draft or send; null for anything else. */
export function commentDoing(work: Work): string | null {
  if (!isCommentWork(work)) return null;
  return work.do === 'draft'
    ? `Writing a comment on ${work.item.name}’s post…`
    : `Commenting on ${work.item.name}’s post…`;
}

/**
 * Drafts a comment on a good post with the AI, from the post, and hands it to HandsFreeOS with its post to wait for an
 * OK or go (decision 92).
 */
export async function draftComment(
  item: TodayListItem,
  businessId: string,
): Promise<CommentOutcome> {
  const lead = `${item.name}’s post`;
  if (!item.profileId || !item.postId) return { done: false, line: `${lead}: no post kept` };
  const drafted = await answer({
    type: 'hfos-draft',
    workspaceId: businessId,
    input: { kind: 'comment', profileId: item.profileId, postId: item.postId },
  });
  if (!drafted.ok) return { done: false, line: `${lead}: ${drafted.problem.message}` };
  const text = (drafted.value as Drafts).drafts[0];
  if (!text) return { done: false, line: `${lead}: the AI had nothing to say on it` };
  const queued = await call(
    api().POST('/v1/commands/outreach.send.queue', {
      body: {
        workspaceId: businessId,
        profileId: item.profileId,
        kind: 'comment',
        chatId: null,
        threadKey: null,
        text,
        opener: null,
        simple: false,
        postId: item.postId,
      },
    }),
    businessId,
  );
  return {
    done: true,
    line:
      queued.state === 'approved'
        ? `Wrote a comment on ${item.name}’s post: it goes soon`
        : `Wrote a comment on ${item.name}’s post: it waits for your OK`,
  };
}

/** Says how a comment's send went in HandsFreeOS. One the person skipped meanwhile went anyway: nothing more to say. */
async function sendDone(sendId: string, businessId: string, sent: boolean, why: string | null) {
  try {
    await call(
      api().POST('/v1/commands/outreach.send.done', {
        body: { workspaceId: businessId, sendId, sent, why },
      }),
      businessId,
    );
  } catch (error) {
    if (!(error instanceof Refused) || error.problem.status !== 404) throw error;
  }
}

/**
 * Posts a comment OK'd (or past the hold) under their post, on the post's own page, and notes it as the extension's
 * own. `them` is whose post it is, as the runner keeps them (their account, their business). Anything that stops it
 * short, but a warning or a sign-in, is told to HandsFreeOS as not sent, with why, and it hands the comment to the
 * person.
 */
export async function sendComment(
  item: TodayListItem,
  them: ProfileRef | null,
  businessId: string,
  runner: CommentRunner,
): Promise<CommentOutcome> {
  const send = item.send!;
  const lead = `${item.name}’s post: `;
  const failed = async (why: string): Promise<CommentOutcome> => {
    await sendDone(send.sendId, businessId, false, why);
    return { done: false, line: `${lead}${why}` };
  };
  if (!them || !item.postUrl) return failed('no link to it kept');
  await runner.tab.open(item.postUrl);
  const before = await runner.onPage(businessId);
  if (before) return before;
  const name = NETWORKS[runner.platform].name;
  const wrote = await runner.tab.ask({
    type: 'hfos-comment',
    text: send.text,
    profile: them,
    postUrl: item.postUrl,
  });
  if (!wrote.ok) return failed(wrote.error);
  if (wrote.result === 'none') return failed('couldn’t find the post’s own box to comment in');
  if (wrote.result !== 'done') return failed(`${name} didn’t take the comment`);
  await takeNote(
    {
      type: 'hfos-noted',
      step: {
        kind: 'comment',
        to: { name: item.name, profile: them },
        group: null,
        postUrl: item.postUrl,
        thread: null,
        replying: null,
        auto: true,
        postText: item.post,
        commentText: send.text,
      },
      at: new Date().toISOString(),
    },
    runner.platform,
  );
  await sendDone(send.sendId, businessId, true, null);
  await pause(SETTLE_MS);
  const after = await runner.onPage(businessId);
  if (after && 'stop' in after) return after;
  return { done: true, line: `Commented on ${item.name}’s post` };
}

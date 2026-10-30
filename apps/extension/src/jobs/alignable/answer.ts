/**
 * Answering the connection requests the person got on Alignable (docs/outreach.md, decision 136), from 0.118.0: Accept
 * for those HandsFreeOS puts on Today to confirm (src/auto/alignable.ts), and Decline for those its tidy picks to delete,
 * with the day's withdrawing on its own (./withdraw.ts): the ones they pressed Confirm or Delete on first, then as they
 * chose and the AI said (packages/core/src/addons/outreach/ops/tidy.ts), at most 30 deleted a day.
 *
 * It opens My Network's Requests in the job's window (decision 17), finds the row about that business by Alignable's id
 * for it, scrolling the list slowly for it, presses that row's own button (src/networks/alignable/answer.ts), and
 * checks it went. One no longer on the list, read to its end, was answered already. It stops on any Alignable warning,
 * and a page it can't work is noted with its outline (decision 74), for the next Check to show the real buttons.
 * Nobody is handed to the person: one it can't answer, it passes over.
 */
import { TIDY_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import type { Tidy, TidyCandidate } from '../../hfos/messages';
import { requestsPage } from '../../networks/alignable/answer';
import { businessRef, idIn, urlOf } from '../../networks/alignable/read';
import type { ProfileRef } from '../../networks/facebook/types';
import { counted } from '../../words';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { ALIGNABLE, readAlignableIn, REQUESTS, SCROLL_PACE_MS, signedOutEnd } from './read';

/** Between businesses, a steady pace like a person's: never the same twice. */
const PACE_MS = [TIDY_PACE_SECONDS[0] * 1000, TIDY_PACE_SECONDS[1] * 1000] as const;
/** The most screens of the list it scrolls looking for one business. */
const LOOK_SCROLLS = 20;
/** While Alignable draws what a press opened. */
const SETTLE_MS = 2_000;

/** What became of a request: answered, answered already, passed over, or the job's end (a warning, a stop). */
export type Answered = 'done' | 'already' | 'skipped' | 'stopped' | JobEnd;

/** Whether a business on the list is this one: by Alignable's id when both carry it, else its address in its town. */
const same = (row: ProfileRef, them: ProfileRef): boolean =>
  row.id && them.id ? row.id === them.id : !!row.username && row.username === them.username;

/** Their business as kept: by Alignable's id for it when the link carries one or HandsFreeOS keeps it beside the link. */
export function requesterOf(who: {
  readonly url: string | null;
  readonly platformId: string | null;
}): ProfileRef | null {
  const url = urlOf(who.url, ALIGNABLE);
  return url ? businessRef(url, idIn(url) ?? who.platformId) : null;
}

/**
 * Finds their row on Requests, opened afresh, scrolling for it: `found`; `gone` when the list ended without them;
 * `lost` when it scrolled as far as it goes without getting to the end, or read no request at all (a page it can't
 * read is never taken for one without them). A warning, or a page asking to sign in, ends it.
 */
async function find(job: Job, want: ProfileRef): Promise<'found' | 'gone' | 'lost' | JobEnd> {
  await job.tab.open(REQUESTS);
  let seen = false;
  for (let screen = 0; ; screen++) {
    const page = await readAlignableIn(job.tab);
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    if (page.signedOut) return signedOutEnd();
    if (!requestsPage(page.url)) return 'lost';
    if (page.found.requests.some((r) => same(r.profile, want))) return 'found';
    seen ||= page.found.requests.length > 0;
    if (screen >= LOOK_SCROLLS || job.stopped()) return 'lost';
    if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) return seen ? 'gone' : 'lost';
    await pause(paced(SCROLL_PACE_MS));
  }
}

/**
 * Answers one request: Accept for `confirm`, Decline for `delete`, on its row of Requests. `done` once their row is
 * answered or gone from the list; `already` when the list, read to its end, doesn't have them.
 */
export async function answerOne(
  job: Job,
  who: { readonly name: string; readonly url: string | null; readonly platformId: string | null },
  answer: 'confirm' | 'delete',
): Promise<Answered> {
  const want = requesterOf(who);
  if (!want) return 'skipped';
  const found = await find(job, want);
  if (typeof found === 'object') return found;
  if (job.stopped()) return 'stopped';
  if (found === 'gone') return 'already';
  if (found === 'lost') {
    job.progress(`Skipped ${who.name}: couldn’t find their request on your Requests.`);
    return 'skipped';
  }
  const pressed = await job.tab.ask({ type: 'hfos-answer-request', answer, profile: want });
  if (!pressed.ok) throw new Error(pressed.error);
  if (pressed.result !== 'done') {
    await job.report?.({
      job: `requests.${answer}.${pressed.result}`,
      note: `Couldn’t ${answer === 'confirm' ? 'accept' : 'decline'} a connection request on My Network’s Requests: ${pressed.result}.`,
      found: { accepting: answer === 'confirm' },
      outline: true,
    });
    return 'skipped';
  }
  // The press may have opened another page: Requests again shows whether it went.
  await pause(SETTLE_MS);
  if (job.stopped()) return 'stopped';
  const after = await find(job, want);
  if (typeof after === 'object') return after;
  if (after === 'found') {
    await job.report?.({
      job: `requests.${answer}.not_gone`,
      note: 'Pressed a connection request’s button on My Network’s Requests, but its row still shows.',
      found: { accepting: answer === 'confirm' },
      outline: true,
    });
    return 'skipped';
  }
  return 'done';
}

/** How the declining went, in words for the person. */
function summary(done: number, skipped: number, already: number): string {
  const parts = [`Connection requests declined: ${counted(done, 'business', 'businesses')}.`];
  if (already) parts.push(`Answered already: ${already.toLocaleString()}.`);
  if (skipped) parts.push(`Skipped: ${skipped.toLocaleString()}.`);
  return parts.join(' ');
}

/**
 * Declines those picked, a business at a time, up to today's limit on Alignable, each noted in HandsFreeOS as their
 * answer (one answered already too), so it isn't picked again.
 */
export async function declineThese(
  job: Job,
  picks: readonly TidyCandidate[],
  lists: Tidy,
): Promise<JobEnd> {
  const limit = lists.limits.decline;
  let room = Math.max(0, limit.most - limit.done);
  let done = 0;
  let skipped = 0;
  let already = 0;
  const said = () => summary(done, skipped, already);
  if (!picks.length) return { line: '', warned: false };
  for (const [i, who] of picks.entries()) {
    if (job.stopped()) return { line: `Stopped. ${said()}`, warned: false };
    if (room <= 0)
      return {
        line: `That’s today’s limit of ${limit.most} on Alignable. ${said()}`,
        warned: false,
      };
    job.progress(`${i + 1} of ${picks.length}: declining the request from ${who.name}…`);
    const outcome = await answerOne(job, who, 'delete');
    if (outcome === 'stopped') return { line: `Stopped. ${said()}`, warned: false };
    if (typeof outcome === 'object') return { ...outcome, line: `${outcome.line} ${said()}` };
    if (outcome === 'done' || outcome === 'already') {
      valueOf(
        await job.hfos({
          type: 'hfos-friend-note',
          input: {
            workspaceId: job.businessId,
            platform: 'alignable',
            answer: 'delete',
            profile: { id: who.platformId, username: who.username, url: who.url },
            name: who.name,
            mutualFriends: null,
          },
        }),
      );
    }
    if (outcome === 'done') {
      done++;
      room--;
    } else if (outcome === 'already') already++;
    else skipped++;
    if (i < picks.length - 1 && !job.stopped() && outcome === 'done') {
      job.progress(
        `Connection requests declined: ${counted(done, 'business', 'businesses')}. Waiting a moment before the next…`,
      );
      await pause(paced(PACE_MS));
    }
  }
  return { line: said(), warned: false };
}

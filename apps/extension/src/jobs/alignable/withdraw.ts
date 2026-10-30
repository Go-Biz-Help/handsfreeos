/**
 * Withdrawing old connection requests on Alignable (docs/outreach.md, decisions 12 and 98; core's tidy
 * `cancel_request` there), from 0.97.0: asked from the Friends tab in HandsFreeOS once the person ticks who, and on its
 * own once a day as they chose, the oldest HandsFreeOS picks. Those are the requests they sent nobody answered in the
 * business's wait (3 weeks to start, packages/core/src/addons/outreach/ops/tidy.ts), at most 20 a day.
 *
 * It opens each one's business page in the job's window (decision 17: what's pressed on their network is pressed where
 * they see it), checks it's theirs by Alignable's id, presses the way to take the request back
 * (src/networks/alignable/withdraw.ts), opens their page again to see it went, and notes it in HandsFreeOS. One whose
 * page shows it went already is noted as done already, and not counted; one connected now is passed over. It goes
 * slowly, stops at today's limit, and stops on any Alignable warning. Alignable's markup for a request that waits isn't
 * known yet, so a page it can't work is noted with its outline (decision 74), for the next Check to show the real
 * controls; then a person ticking hands it to them (Carry on, or Skip), and on its own it's passed over.
 */
import { TIDY_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import type { Tidy, TidyCandidate } from '../../hfos/messages';
import { businessRef, idIn, urlOf } from '../../networks/alignable/read';
import type { ProfileRef } from '../../networks/facebook/types';
import { counted } from '../../words';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { ownTidy } from '../own-tidy';
import { declineThese } from './answer';
import { isTheirs } from './checks';
import { ALIGNABLE, readAlignableIn, signedOutEnd, type AlignablePage } from './read';

/** Between people, a steady pace like a person's: never the same twice. */
const PACE_MS = [TIDY_PACE_SECONDS[0] * 1000, TIDY_PACE_SECONDS[1] * 1000] as const;
/** While Alignable draws what a press opened. */
const SETTLE_MS = 2_000;

/** What became of someone: done, done already, skipped, or the job's end (a warning, a stop). */
type Outcome = 'done' | 'already' | 'skipped' | 'stopped' | JobEnd;

/** Hands a step to the person, with what to press. */
function handOver(job: Job, name: string): Promise<'carry_on' | 'skip' | 'stop'> {
  if (!job.handOver) return Promise.resolve('skip');
  return job.handOver(
    `Couldn’t withdraw the connection request to ${name}. On their Alignable page, press Request Sent or Pending, then the way to cancel it. Then press Carry on, or Skip.`,
  );
}

/** Their page, opened and read: theirs by Alignable's id, or the job's end, or skipped. */
async function open(
  job: Job,
  want: ProfileRef,
): Promise<{ readonly page: AlignablePage } | { readonly outcome: Outcome }> {
  await job.tab.open(want.url);
  await pause(SETTLE_MS);
  const page = await readAlignableIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return { outcome: warned };
  if (page.signedOut) return { outcome: signedOutEnd() };
  const shown = page.found.business;
  if (!shown || !isTheirs(shown, want)) return { outcome: 'skipped' };
  return { page };
}

/** One business: open, check it's theirs, press, open again, note. */
async function one(job: Job, who: TidyCandidate): Promise<Outcome> {
  const url = urlOf(who.url, ALIGNABLE);
  const want = url ? businessRef(url, idIn(url) ?? who.platformId) : null;
  if (!want) return 'skipped';
  const end = async (already: boolean) => {
    valueOf(
      await job.hfos({
        type: 'hfos-friend-end',
        input: {
          workspaceId: job.businessId,
          platform: 'alignable',
          kind: 'cancel_request',
          profile: { id: who.platformId, username: who.username, url: who.url },
          name: who.name,
          already,
        },
      }),
    );
  };
  const before = await open(job, want);
  if ('outcome' in before) {
    if (before.outcome === 'skipped')
      job.progress(`Skipped ${who.name}: Alignable didn’t open their business’s page.`);
    return before.outcome;
  }
  const shown = before.page.found.business!;
  if (shown.connected) {
    job.progress(`Skipped ${who.name}: you’re connected now.`);
    return 'skipped';
  }
  const profile = { id: shown.profile?.id ?? want.id, username: want.username, url: want.url };
  if (job.stopped()) return 'stopped';
  const pressed = await job.tab.ask({ type: 'hfos-withdraw', profile });
  if (!pressed.ok) throw new Error(pressed.error);
  if (pressed.result === 'already') {
    await end(true);
    return 'already';
  }
  if (pressed.result === 'connected') {
    job.progress(`Skipped ${who.name}: you’re connected now.`);
    return 'skipped';
  }
  if (job.stopped()) return 'stopped';
  if (pressed.result !== 'done') {
    await job.report?.({
      job: `tidy.${pressed.result}`,
      note: `Couldn’t withdraw a connection request on a business’s page: ${pressed.result}.`,
      found: { asked: shown.asked, connect: shown.connect },
      outline: true,
    });
    const reply = await handOver(job, who.name);
    if (reply === 'stop' || job.stopped()) return 'stopped';
    if (reply === 'skip') return 'skipped';
  }
  // The press may have opened another page: their page again shows whether the request went.
  const after = await open(job, want);
  if ('outcome' in after) return after.outcome;
  const now = after.page.found.business!;
  if (now.connected) return 'skipped';
  if (now.asked || !now.connect) {
    await job.report?.({
      job: 'tidy.not_gone',
      note: 'Pressed the way to take back a connection request, but the business’s page still shows it waiting.',
      found: { asked: now.asked, connect: now.connect },
      outline: true,
    });
    return 'skipped';
  }
  await end(false);
  return 'done';
}

/** How it went, in words for the person. */
function summary(done: number, skipped: number, gone: number, already: number): string {
  const parts = [`Connection requests withdrawn: ${counted(done, 'business', 'businesses')}.`];
  if (already) parts.push(`Answered or withdrawn already: ${already.toLocaleString()}.`);
  if (skipped) parts.push(`Skipped: ${skipped.toLocaleString()}.`);
  if (gone) parts.push(`No longer on the list: ${gone.toLocaleString()}.`);
  return parts.join(' ');
}

const listsOf = async (job: Job): Promise<Tidy> =>
  valueOf(
    await job.hfos({ type: 'hfos-tidy', workspaceId: job.businessId, platform: 'alignable' }),
  );

/** Goes through those picked, a business at a time, up to today's limit on Alignable. */
async function withdrawThese(
  job: Job,
  picks: readonly TidyCandidate[],
  lists: Tidy,
  gone = 0,
): Promise<JobEnd> {
  const limit = lists.limits.cancel_request;
  let room = Math.max(0, limit.most - limit.done);
  let done = 0;
  let skipped = 0;
  let already = 0;
  const said = () => summary(done, skipped, gone, already);
  if (!picks.length) return { line: said(), warned: false };
  for (const [i, who] of picks.entries()) {
    if (job.stopped()) return { line: `Stopped. ${said()}`, warned: false };
    if (room <= 0)
      return {
        line: `That’s today’s limit of ${limit.most} on Alignable. ${said()} Ask again tomorrow for the rest.`,
        warned: false,
      };
    job.progress(`${i + 1} of ${picks.length}: withdrawing the request to ${who.name}…`);
    const outcome = await one(job, who);
    if (outcome === 'stopped') return { line: `Stopped. ${said()}`, warned: false };
    if (typeof outcome === 'object') return { ...outcome, line: `${outcome.line} ${said()}` };
    if (outcome === 'done') {
      done++;
      room--;
    } else if (outcome === 'already') already++;
    else skipped++;
    if (i < picks.length - 1 && !job.stopped()) {
      job.progress(
        `Connection requests withdrawn: ${counted(done, 'business', 'businesses')}. Waiting a moment before the next…`,
      );
      await pause(paced(PACE_MS));
    }
  }
  return { line: `Done. ${said()}`, warned: false };
}

/**
 * Withdraws the old connection requests the person ticked: those still on HandsFreeOS's list for Alignable, a business
 * at a time, up to today's limit there.
 */
export async function withdrawTicked(job: Job, profileIds: readonly string[]): Promise<JobEnd> {
  job.progress('Getting the list from HandsFreeOS…');
  const lists = await listsOf(job);
  const byId = new Map(lists.cancel.map((c) => [c.profileId, c]));
  const picks = profileIds.map((id) => byId.get(id)).filter((c): c is TidyCandidate => !!c);
  return withdrawThese(job, picks, lists, profileIds.length - picks.length);
}

/**
 * Withdrawing on its own, once a day (decision 98): the oldest requests HandsFreeOS picked for today, as the person
 * chose for Alignable; then, from 0.118.0, the requests they got that it picked to decline (decision 136, ./answer.ts).
 * Nobody is handed to the person: one it can't withdraw or decline, it passes over.
 */
export async function withdrawOnItsOwn(job: Job): Promise<JobEnd> {
  const lists = await listsOf(job);
  return ownTidy(
    job,
    lists,
    (which, picks) =>
      which === 'cancel_request'
        ? withdrawThese(job, picks, lists)
        : Promise.resolve({ line: '', warned: false }),
    (picks) => declineThese(job, picks, lists),
  );
}

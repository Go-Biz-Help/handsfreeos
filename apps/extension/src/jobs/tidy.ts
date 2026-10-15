/**
 * Tidying the person's friends (docs/outreach.md, decisions 10, 12, 15, 17 and 43), asked from the Friends tab in
 * HandsFreeOS: the old requests they ticked to cancel, or the friends they ticked to unfriend
 * (packages/core/src/addons/outreach/tidy.ts). The extension opens each one's profile in a tab they can see, checks
 * it's them and where things stand, presses Cancel request or Unfriend (src/networks/facebook/tidy.ts), checks it worked, and
 * notes it in HandsFreeOS. It goes slowly, stops at today's limit, and stops for the day on any Facebook warning. A
 * step it can't find, it hands to the person: Carry on once they've done it, or Skip that person.
 */
import { TIDY_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import { FRIENDSHIP_WORDS, TIDY_PLANS, sameProfile, type TidyJob } from '../networks/facebook/tidy';
import type { FetchStep } from '../networks/facebook/fetch';
import { facebook } from '../networks/facebook/kit';
import type { TidyCandidate } from '../hfos/messages';
import { counted } from '../words';
import { paced, pause, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';

/** Between people, a steady pace like a person's: never the same twice. */
const PACE_MS = [TIDY_PACE_SECONDS[0] * 1000, TIDY_PACE_SECONDS[1] * 1000] as const;
/** While Facebook draws what a press opened. */
const SETTLE_MS = 1_500;
/** How long a step is looked for before it's handed to the person; the box asking to be sure, less. */
const WAIT_MS = 8_000;
const WAIT_OPTIONAL_MS = 3_000;

const WORDS: Record<TidyJob, { doing: string; done: string }> = {
  cancel_request: { doing: 'Cancelling the request to', done: 'Requests cancelled' },
  unfriend: { doing: 'Unfriending', done: 'Unfriended' },
};

/** What became of someone ticked: done, done already, skipped, or the job's end (a warning, a stop). */
type Outcome = 'done' | 'already' | 'skipped' | JobEnd | 'stopped';

/** Hands a step to the person; brings their tab to the front first (the runner of asks does). */
async function handOver(
  job: Job,
  who: string,
  says: string,
): Promise<'carry_on' | 'skip' | 'stop'> {
  if (!job.handOver) return 'skip';
  return job.handOver(
    `Couldn’t find that on ${who}’s profile. ${says} Then press Carry on, or Skip.`,
  );
}

/** Presses the way along a path: the furthest step on the page each time. */
async function byPath(
  job: Job,
  who: string,
  steps: readonly FetchStep[],
): Promise<'done' | 'skip' | 'stop'> {
  let from = 0;
  while (from < steps.length) {
    if (job.stopped()) return 'stop';
    const answer = await job.tab.ask({
      type: 'hfos-fetch-path',
      steps,
      from,
      waitMs: WAIT_MS,
      tidy: true,
    });
    if (!answer.ok) throw new Error(answer.error);
    if (answer.at !== undefined) {
      from = answer.at + 1;
      await pause(SETTLE_MS);
      continue;
    }
    const reply = await handOver(job, who, steps[from]!.says);
    // The person pressed it, or a step past it: the box asking to be sure is all that's left.
    return reply === 'carry_on' ? 'done' : reply;
  }
  return 'done';
}

/** The box asking to be sure, when Facebook shows one. */
async function sure(job: Job, steps: readonly FetchStep[]): Promise<void> {
  for (const step of steps) {
    if (job.stopped()) return;
    const answer = await job.tab.ask({
      type: 'hfos-fetch-step',
      step,
      waitMs: step.optional ? WAIT_OPTIONAL_MS : WAIT_MS,
      tidy: true,
    });
    if (!answer.ok) throw new Error(answer.error);
    if (answer.result === 'done') await pause(SETTLE_MS);
  }
}

/** One person: open, check, press, check again, note. */
async function one(job: Job, which: TidyJob, who: TidyCandidate): Promise<Outcome> {
  const plan = TIDY_PLANS[which];
  await job.tab.open(who.url);
  let page = await readIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (!page.profile || !sameProfile(page.profile.profile, who)) return 'skipped';
  const end = async (already: boolean) => {
    valueOf(
      await job.hfos({
        type: 'hfos-friend-end',
        input: {
          workspaceId: job.businessId,
          platform: facebook.platform,
          kind: which,
          profile: { id: who.platformId, username: who.username, url: who.url },
          name: who.name,
          already,
        },
      }),
    );
  };
  if (page.profile.friendship === 'not_friends') {
    await end(true);
    return 'already';
  }
  if (page.profile.friendship !== plan.before) {
    job.progress(
      `Skipped ${who.name}: Facebook says ${FRIENDSHIP_WORDS[page.profile.friendship]}.`,
    );
    return 'skipped';
  }

  const went = await byPath(job, who.name, plan.path);
  if (went === 'stop' || job.stopped()) return 'stopped';
  if (went === 'skip') return 'skipped';
  await sure(job, plan.then);
  if (job.stopped()) return 'stopped';
  await pause(SETTLE_MS);
  page = await readIn(job.tab);
  const warnedAfter = await warnedOn(job, page);
  if (warnedAfter) return warnedAfter;
  if (page.profile?.friendship !== 'not_friends') {
    // Not gone yet: the person finishes it, or skips them.
    const says =
      which === 'cancel_request'
        ? 'Press “Cancel request” yourself.'
        : 'Press “Friends”, then “Unfriend”, yourself.';
    const reply = await handOver(job, who.name, says);
    if (reply === 'stop' || job.stopped()) return 'stopped';
    if (reply === 'skip') return 'skipped';
    page = await readIn(job.tab);
    if (page.profile?.friendship !== 'not_friends') return 'skipped';
  }
  await end(false);
  return 'done';
}

/** How it went, in words for the person. */
function summary(which: TidyJob, done: number, skipped: number, gone: number): string {
  const parts = [`${WORDS[which].done}: ${counted(done, 'person', 'people')}.`];
  if (skipped) parts.push(`Skipped: ${skipped.toLocaleString()}.`);
  if (gone) parts.push(`No longer on the list: ${gone.toLocaleString()}.`);
  return parts.join(' ');
}

/**
 * Cancels the old requests, or unfriends the friends, the person ticked: those still on HandsFreeOS's list, a person
 * at a time, up to today's limit.
 */
export async function tidy(
  job: Job,
  which: TidyJob,
  profileIds: readonly string[],
): Promise<JobEnd> {
  job.progress('Getting the list from HandsFreeOS…');
  const lists = valueOf(await job.hfos({ type: 'hfos-tidy', workspaceId: job.businessId }));
  const list = which === 'cancel_request' ? lists.cancel : lists.unfriend;
  const byId = new Map(list.map((c) => [c.profileId, c]));
  const picks = profileIds.map((id) => byId.get(id)).filter((c): c is TidyCandidate => !!c);
  const gone = profileIds.length - picks.length;
  let room = Math.max(0, lists.limits[which].most - lists.limits[which].done);
  let done = 0;
  let skipped = 0;
  if (!picks.length) return { line: summary(which, 0, 0, gone), warned: false };
  for (const [i, who] of picks.entries()) {
    if (job.stopped())
      return { line: `Stopped. ${summary(which, done, skipped, gone)}`, warned: false };
    if (room <= 0)
      return {
        line: `That’s today’s limit of ${lists.limits[which].most}. ${summary(which, done, skipped, gone)} Ask again tomorrow for the rest.`,
        warned: false,
      };
    job.progress(`${i + 1} of ${picks.length}: ${WORDS[which].doing} ${who.name}…`);
    const outcome = await one(job, which, who);
    if (outcome === 'stopped')
      return { line: `Stopped. ${summary(which, done, skipped, gone)}`, warned: false };
    if (typeof outcome === 'object') return outcome;
    if (outcome === 'done') {
      done++;
      room--;
    } else if (outcome === 'skipped') skipped++;
    if (i < picks.length - 1 && !job.stopped()) {
      job.progress(
        `${WORDS[which].done}: ${counted(done, 'person', 'people')}. Waiting a moment before the next…`,
      );
      await pause(paced(PACE_MS));
    }
  }
  return { line: `Done. ${summary(which, done, skipped, gone)}`, warned: false };
}

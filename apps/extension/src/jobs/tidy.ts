/**
 * Tidying the person's friends (docs/outreach.md, decisions 10, 12, 15, 17 and 43), asked from the Friends tab in
 * HandsFreeOS: the old requests they ticked to cancel, or the friends they ticked to unfriend
 * (packages/core/src/addons/outreach/tidy.ts); and from 0.97.0 on its own once a day (decision 98), those HandsFreeOS
 * picks as the person chose, with nobody handed to them. The extension opens each one's profile in a tab they can see, checks
 * it's them and where things stand, presses Cancel request or Unfriend (src/networks/facebook/tidy.ts), checks it worked, and
 * notes it in HandsFreeOS. It goes slowly, stops at today's limit, and stops for the day on any Facebook warning. A
 * step it can't find, it hands to the person: Carry on once they've done it, or Skip that person.
 *
 * From 0.110.0 on its own too (decision 121): the requests nobody answered that Cancel all is cancelling, however new,
 * and the requests the person got that HandsFreeOS picked to delete as they chose for those, Respond then Delete
 * request, each noted as their answer.
 *
 * From 0.110.1 a request the person sent is cancelled from their friend requests instead (the owner's report of 29 Oct
 * 2026, where a profile's Cancel request couldn't be found): View sent requests, then each one's row found by the link
 * to their profile, scrolling the list for it, and its own Cancel request pressed (src/networks/facebook/sent.ts). Only
 * someone the list, read to its end, doesn't show has their profile opened, to see where things stand.
 */
import { TIDY_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import { withTheirName } from '../networks/facebook/auto';
import { FRIENDSHIP_WORDS, TIDY_PLANS, sameProfile, type TidyJob } from '../networks/facebook/tidy';
import type { FetchStep } from '../networks/facebook/fetch';
import { facebook } from '../networks/facebook/kit';
import type { ProfileRef, ReadResult } from '../networks/facebook/types';
import type { Tidy, TidyCandidate } from '../hfos/messages';
import { listOnPage } from '../hfos/saves';
import { counted } from '../words';
import { paced, pause, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';
import { ownTidy } from './own-tidy';
import { FRIEND_REQUESTS, VIEW_SENT } from './people';

/** Between people, a steady pace like a person's: never the same twice. */
const PACE_MS = [TIDY_PACE_SECONDS[0] * 1000, TIDY_PACE_SECONDS[1] * 1000] as const;
/** While Facebook draws what a press opened. */
const SETTLE_MS = 1_500;
/** How long a step is looked for before it's handed to the person; the box asking to be sure, less. */
const WAIT_MS = 8_000;
const WAIT_OPTIONAL_MS = 3_000;
/** Sent requests: the most screens it scrolls looking for one person, how fast, and how long it lets more load. */
export const LOOK_SCROLLS = 60;
const SCROLL_PACE_MS = [4_000, 9_000] as const;
const LOAD_MS = 3_000;

const WORDS: Record<TidyJob, { doing: string; done: string }> = {
  cancel_request: { doing: 'Cancelling the request to', done: 'Requests cancelled' },
  unfriend: { doing: 'Unfriending', done: 'Unfriended' },
  decline: { doing: 'Deleting the request from', done: 'Requests deleted' },
};

/** What the person presses themselves when the extension couldn't finish. */
const YOURSELF: Record<TidyJob, string> = {
  cancel_request: 'Press “Cancel request” yourself.',
  unfriend: 'Press “Friends”, then “Unfriend”, yourself.',
  decline: 'Press “Respond”, then “Delete request”, yourself.',
};

/**
 * What became of someone ticked: done, done already, skipped, or the job's end (a warning, a stop); or, not under
 * Sent requests, left for their profile.
 */
type Outcome = 'done' | 'already' | 'skipped' | 'later' | JobEnd | 'stopped';

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

/** Their profile, as HandsFreeOS keeps it. */
const profileOf = (who: TidyCandidate): ProfileRef => ({
  id: who.platformId,
  username: who.username,
  url: who.url,
});

/** Notes it in HandsFreeOS: a request or friend ended, or a request they got deleted, as their answer. */
async function noteEnd(
  job: Job,
  which: TidyJob,
  who: TidyCandidate,
  already: boolean,
  mutualFriends: number | null,
): Promise<void> {
  // A request they got, deleted (or gone already): noted as their answer, so it isn't picked again.
  if (which === 'decline') {
    valueOf(
      await job.hfos({
        type: 'hfos-friend-note',
        input: {
          workspaceId: job.businessId,
          platform: facebook.platform,
          answer: 'delete',
          profile: profileOf(who),
          name: who.name,
          mutualFriends,
        },
      }),
    );
    return;
  }
  valueOf(
    await job.hfos({
      type: 'hfos-friend-end',
      input: {
        workspaceId: job.businessId,
        platform: facebook.platform,
        kind: which,
        profile: profileOf(who),
        name: who.name,
        already,
      },
    }),
  );
}

/** One person: open, check, press, check again, note. */
async function one(job: Job, which: TidyJob, who: TidyCandidate): Promise<Outcome> {
  const plan = TIDY_PLANS[which];
  await job.tab.open(who.url);
  let page = await readIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (!page.profile || !sameProfile(page.profile.profile, who)) return 'skipped';
  const end = (already: boolean) =>
    noteEnd(job, which, who, already, page.profile?.mutualFriends ?? null);
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

  const went = await byPath(job, who.name, withTheirName(plan.path, [page.profile.name, who.name]));
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
    const reply = await handOver(job, who.name, YOURSELF[which]);
    if (reply === 'stop' || job.stopped()) return 'stopped';
    if (reply === 'skip') return 'skipped';
    page = await readIn(job.tab);
    if (page.profile?.friendship !== 'not_friends') return 'skipped';
  }
  await end(false);
  return 'done';
}

// ------------------------------------------------------------------------------------------- Sent requests

/** Whether Sent requests, as far as it has loaded, lists a request to them: by their profile, never their name alone. */
function listed(page: ReadResult, who: TidyCandidate): boolean {
  const mine = listOnPage(page);
  return mine?.list === 'sent' && mine.people.some((p) => sameProfile(p.profile, who));
}

/**
 * Opens Sent requests: the person's friend requests, then View sent requests. Null once it's open; `missing` when
 * View sent requests isn't there; or the job's end on a warning.
 */
async function openSent(job: Job): Promise<null | 'missing' | JobEnd> {
  job.progress('Opening the friend requests you’ve sent…');
  await job.tab.open(FRIEND_REQUESTS);
  const warned = await warnedOn(job, await readIn(job.tab));
  if (warned) return warned;
  const pressed = await job.tab.ask({
    type: 'hfos-fetch-step',
    step: VIEW_SENT,
    waitMs: WAIT_MS,
    lists: true,
  });
  if (!pressed.ok) throw new Error(pressed.error);
  if (pressed.result !== 'done' && pressed.result !== 'already') return 'missing';
  await pause(SETTLE_MS);
  return null;
}

/**
 * Finds their row under Sent requests, scrolling the list for it: `found`; `gone` when the list ended without them;
 * `lost` when it scrolled as far as it goes without getting to the end, or read no sent request at all (a list it
 * can't read is never taken for one without them). At the bottom it lets Facebook load more once before calling it
 * the end. A list that isn't open any more (shut, or the tab gone elsewhere while the person had a step) is opened
 * again once. A warning ends it.
 */
async function find(job: Job, who: TidyCandidate): Promise<'found' | 'gone' | 'lost' | JobEnd> {
  let seen = false;
  let waited = false;
  let reopened = false;
  for (let screen = 0; ;) {
    const page = await readIn(job.tab);
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    if (listed(page, who)) return 'found';
    seen ||= listOnPage(page)?.list === 'sent';
    if (!seen && !reopened) {
      reopened = true;
      const opened = await openSent(job);
      if (opened === 'missing') return 'lost';
      if (opened) return opened;
      continue;
    }
    if (screen >= LOOK_SCROLLS || job.stopped()) return 'lost';
    if ((await job.tab.ask({ type: 'hfos-scroll-list' })).ok) {
      screen++;
      waited = false;
      await pause(paced(SCROLL_PACE_MS));
      continue;
    }
    if (waited) return seen ? 'gone' : 'lost';
    waited = true;
    await pause(LOAD_MS);
  }
}

/** Hands a request in Sent requests to the person, with what to press. */
function handOverSent(job: Job, name: string): Promise<'carry_on' | 'skip' | 'stop'> {
  if (!job.handOver) return Promise.resolve('skip');
  return job.handOver(
    `Couldn’t cancel the request to ${name}. Under Sent requests, press “Cancel request” beside their name. Then press Carry on, or Skip.`,
  );
}

/** One request, under Sent requests: find, press, check again, note. Someone the whole list doesn't show, `later`. */
async function cancelOnList(job: Job, who: TidyCandidate): Promise<Outcome> {
  const found = await find(job, who);
  if (typeof found === 'object') return found;
  if (job.stopped()) return 'stopped';
  if (found === 'gone') return 'later';
  if (found === 'lost') {
    job.progress(`Skipped ${who.name}: couldn’t find their request under Sent requests.`);
    return 'skipped';
  }
  const pressed = await job.tab.ask({ type: 'hfos-cancel-sent', profile: profileOf(who) });
  if (!pressed.ok) throw new Error(pressed.error);
  if (job.stopped()) return 'stopped';
  await pause(SETTLE_MS);
  let page = await readIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  // Their row went before anything was pressed (Facebook drew the list again): nothing to finish, so it's left as it is.
  if (pressed.result === 'not_found' && !listed(page, who)) {
    job.progress(`Skipped ${who.name}: their request went from the list before it was cancelled.`);
    return 'skipped';
  }
  if (pressed.result !== 'done' || listed(page, who)) {
    // Not cancelled yet: the person finishes it, or skips them.
    const reply = await handOverSent(job, who.name);
    if (reply === 'stop' || job.stopped()) return 'stopped';
    if (reply === 'skip') return 'skipped';
    page = await readIn(job.tab);
    if (listed(page, who)) return 'skipped';
  }
  await noteEnd(job, 'cancel_request', who, false, null);
  return 'done';
}

// ------------------------------------------------------------------------------------------- the people picked

/** How it went, in words for the person. */
function summary(which: TidyJob, done: number, skipped: number, gone: number): string {
  const parts = [`${WORDS[which].done}: ${counted(done, 'person', 'people')}.`];
  if (skipped) parts.push(`Skipped: ${skipped.toLocaleString()}.`);
  if (gone) parts.push(`No longer on the list: ${gone.toLocaleString()}.`);
  return parts.join(' ');
}

/**
 * Goes through those picked, a person at a time, up to today's limit. Requests the person sent go from Sent requests
 * first; anyone it doesn't show, and everyone else, by their profile.
 */
async function tidyThese(
  job: Job,
  which: TidyJob,
  picks: readonly TidyCandidate[],
  lists: Tidy,
  gone = 0,
): Promise<JobEnd> {
  let room = Math.max(0, lists.limits[which].most - lists.limits[which].done);
  let done = 0;
  let skipped = 0;
  let at = 0;
  const said = () => summary(which, done, skipped, gone);
  if (!picks.length) return { line: said(), warned: false };
  /** Each of `these` with `per`: the job's end when it ends early, else those left for their profile. */
  const each = async (
    these: readonly TidyCandidate[],
    per: (who: TidyCandidate) => Promise<Outcome>,
  ): Promise<JobEnd | TidyCandidate[]> => {
    const later: TidyCandidate[] = [];
    for (const who of these) {
      if (job.stopped()) return { line: `Stopped. ${said()}`, warned: false };
      if (room <= 0)
        return {
          line: `That’s today’s limit of ${lists.limits[which].most}. ${said()} Ask again tomorrow for the rest.`,
          warned: false,
        };
      job.progress(`${at + 1} of ${picks.length}: ${WORDS[which].doing} ${who.name}…`);
      const outcome = await per(who);
      if (outcome === 'stopped') return { line: `Stopped. ${said()}`, warned: false };
      if (typeof outcome === 'object') return outcome;
      if (outcome === 'later') {
        later.push(who);
        continue;
      }
      at++;
      if (outcome === 'done') {
        done++;
        room--;
      } else if (outcome === 'skipped') skipped++;
      if (at < picks.length && !job.stopped()) {
        job.progress(
          `${WORDS[which].done}: ${counted(done, 'person', 'people')}. Waiting a moment before the next…`,
        );
        await pause(paced(PACE_MS));
      }
    }
    return later;
  };
  let rest: readonly TidyCandidate[] = picks;
  if (which === 'cancel_request') {
    const opened = await openSent(job);
    if (opened && opened !== 'missing') return opened;
    if (!opened) {
      const left = await each(picks, (who) => cancelOnList(job, who));
      if (!Array.isArray(left)) return left;
      rest = left;
    }
  }
  const ended = await each(rest, (who) => one(job, which, who));
  return Array.isArray(ended) ? { line: `Done. ${said()}`, warned: false } : ended;
}

/**
 * Cancels the old requests, or unfriends the friends, the person ticked: those still on HandsFreeOS's list, a person
 * at a time, up to today's limit.
 */
export async function tidy(
  job: Job,
  which: Exclude<TidyJob, 'decline'>,
  profileIds: readonly string[],
): Promise<JobEnd> {
  job.progress('Getting the list from HandsFreeOS…');
  const lists = valueOf(await job.hfos({ type: 'hfos-tidy', workspaceId: job.businessId }));
  const list = which === 'cancel_request' ? lists.cancel : lists.unfriend;
  const byId = new Map(list.map((c) => [c.profileId, c]));
  const picks = profileIds.map((id) => byId.get(id)).filter((c): c is TidyCandidate => !!c);
  return tidyThese(job, which, picks, lists, profileIds.length - picks.length);
}

/**
 * Tidying on its own, once a day (decisions 98 and 121): those HandsFreeOS picks for today as the person chose for
 * Facebook, the old requests (and Cancel all's) first, then the friends to unfriend, then the requests they got to
 * delete, within today's limits. Nobody is handed to the person: a step it can't find, it passes over.
 */
export async function tidyOnItsOwn(job: Job): Promise<JobEnd> {
  const lists = valueOf(await job.hfos({ type: 'hfos-tidy', workspaceId: job.businessId }));
  return ownTidy(
    job,
    lists,
    (which, picks) => tidyThese(job, which, picks, lists),
    (picks) => tidyThese(job, 'decline', picks, lists),
  );
}

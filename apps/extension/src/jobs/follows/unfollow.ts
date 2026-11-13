/**
 * Unfollowing on Threads and X (decision 163, as Instagram's ../instagram/unfollow.ts): those the person followed who
 * didn't follow back once the warm-up's wait was over (decision 161), at most 20 a day, its kit's tidy limit. On its own
 * once a day, as the person chose for that network (decision 98, `ownTidy`), or the ones they ticked, when asked from
 * HandsFreeOS. It opens each one's profile, checks it's them and where things stand, presses Following then the
 * Unfollow the site asks to be sure with (../../networks/follows/auto.ts), reads the page again, and notes it.
 * Someone not followed already is noted as done already. It goes slowly and stops on any warning. A step it can't do,
 * it hands to the person when asked by them (Carry on, or Skip); on its own, it passes them over.
 */
import { TIDY_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import type { Tidy, TidyCandidate } from '../../hfos/messages';
import type { FollowPlatform } from '../../networks/follows/types';
import { counted } from '../../words';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { ownTidy } from '../own-tidy';
import { readFollowIn, sameAs, signedOutEnd } from './read';

const PACE_MS = [TIDY_PACE_SECONDS[0] * 1000, TIDY_PACE_SECONDS[1] * 1000] as const;
const SETTLE_MS = 2_000;

type Outcome = 'done' | 'already' | 'skipped' | 'stopped' | JobEnd;

function handOver(
  job: Job,
  platform: FollowPlatform,
  name: string,
): Promise<'carry_on' | 'skip' | 'stop'> {
  if (!job.handOver) return Promise.resolve('skip');
  return job.handOver(
    `Couldn’t unfollow ${name}. On their ${NETWORKS[platform].name} profile, press Following, then Unfollow. Then press Carry on, or Skip.`,
  );
}

async function one(job: Job, platform: FollowPlatform, who: TidyCandidate): Promise<Outcome> {
  const end = async (already: boolean) => {
    valueOf(
      await job.hfos({
        type: 'hfos-friend-end',
        input: {
          workspaceId: job.businessId,
          platform,
          kind: 'cancel_request',
          profile: { id: who.platformId, username: who.username, url: who.url },
          name: who.name,
          already,
        },
      }),
    );
  };
  await job.tab.open(who.url);
  await pause(SETTLE_MS);
  let page = await readFollowIn(job.tab, platform);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd(platform);
  const theirs = page.found.profile;
  if (!theirs || !sameAs(theirs.username, who.username)) {
    job.progress(`Skipped ${who.name}: ${NETWORKS[platform].name} didn’t open their profile.`);
    return 'skipped';
  }
  if (theirs.following === 'no') {
    await end(true);
    return 'already';
  }
  if (job.stopped()) return 'stopped';
  const pressed = await job.tab.ask({ type: 'hfos-unfollow' });
  if (!pressed.ok) throw new Error(pressed.error);
  if (job.stopped()) return 'stopped';
  await pause(1_500);
  page = await readFollowIn(job.tab, platform);
  const warnedAfter = await warnedOn(job, page);
  if (warnedAfter) return warnedAfter;
  if (pressed.result === 'not_found' && page.found.profile?.following === 'no') {
    await end(true);
    return 'already';
  }
  if (pressed.result !== 'done' || page.found.profile?.following !== 'no') {
    const reply = await handOver(job, platform, who.name);
    if (reply === 'stop' || job.stopped()) return 'stopped';
    if (reply === 'skip') return 'skipped';
    page = await readFollowIn(job.tab, platform);
    if (page.found.profile?.following !== 'no') return 'skipped';
  }
  await end(false);
  return 'done';
}

function summary(done: number, skipped: number, gone: number, already: number): string {
  const parts = [`Unfollowed: ${counted(done, 'person', 'people')}.`];
  if (already) parts.push(`Not followed already: ${already.toLocaleString()}.`);
  if (skipped) parts.push(`Skipped: ${skipped.toLocaleString()}.`);
  if (gone) parts.push(`No longer on the list: ${gone.toLocaleString()}.`);
  return parts.join(' ');
}

const listsOf = async (job: Job, platform: FollowPlatform): Promise<Tidy> =>
  valueOf(await job.hfos({ type: 'hfos-tidy', workspaceId: job.businessId, platform }));

/** Unfollows the ones the person ticked: those still on HandsFreeOS's list, up to today's limit. */
export async function unfollowTicked(
  job: Job,
  platform: FollowPlatform,
  profileIds: readonly string[],
): Promise<JobEnd> {
  job.progress('Getting the list from HandsFreeOS…');
  const lists = await listsOf(job, platform);
  const byId = new Map(lists.cancel.map((c) => [c.profileId, c]));
  const picks = profileIds.map((id) => byId.get(id)).filter((c): c is TidyCandidate => !!c);
  return unfollowThese(job, platform, picks, lists, profileIds.length - picks.length);
}

/** Unfollowing on its own, once a day, as the person chose: the oldest HandsFreeOS picked for today. */
export async function unfollowOnItsOwn(job: Job, platform: FollowPlatform): Promise<JobEnd> {
  const lists = await listsOf(job, platform);
  return ownTidy(job, lists, (which, picks) =>
    which === 'cancel_request'
      ? unfollowThese(job, platform, picks, lists)
      : Promise.resolve({ line: '', warned: false }),
  );
}

async function unfollowThese(
  job: Job,
  platform: FollowPlatform,
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
        line: `That’s today’s limit of ${limit.most} on ${NETWORKS[platform].name}. ${said()} The rest go tomorrow.`,
        warned: false,
      };
    job.progress(`${i + 1} of ${picks.length}: unfollowing ${who.name}…`);
    const outcome = await one(job, platform, who);
    if (outcome === 'stopped') return { line: `Stopped. ${said()}`, warned: false };
    if (typeof outcome === 'object') return { ...outcome, line: `${outcome.line} ${said()}` };
    if (outcome === 'done') {
      done++;
      room--;
    } else if (outcome === 'already') already++;
    else skipped++;
    if (i < picks.length - 1 && !job.stopped() && outcome === 'done') await pause(paced(PACE_MS));
  }
  return { line: `Done. ${said()}`, warned: false };
}

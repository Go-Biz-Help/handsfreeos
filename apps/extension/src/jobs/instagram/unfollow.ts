/**
 * Unfollowing on Instagram (the Instagram and Alignable plan's question 5; core's tidy `cancel_request` there), asked
 * from the Friends tab in HandsFreeOS once the person ticks who: those they followed who didn't follow back in the
 * business's wait (3 weeks to start), never anyone who wrote back or a customer (packages/core/src/addons/outreach/ops/
 * tidy.ts). At most 20 a day, its kit's tidy limit. Nothing is unfollowed on its own: only who the person ticked.
 *
 * It opens each one's account in a tab they can see (decision 17: what's pressed on their network is pressed where they
 * see it), checks it's them and where things stand, presses Following then Unfollow by Instagram's own words
 * (src/networks/instagram/unfollow.ts), reads the page again, and notes it in HandsFreeOS. Someone not followed already
 * is noted as done already, and not counted. It goes slowly, stops at today's limit, and stops on any Instagram
 * warning. A step it can't do, it hands to the person: Carry on once they've done it, or Skip that person.
 */
import { TIDY_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import type { TidyCandidate } from '../../hfos/messages';
import { counted } from '../../words';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { readInstagramIn, signedOutEnd } from './read';

/** Between people, a steady pace like a person's: never the same twice. */
const PACE_MS = [TIDY_PACE_SECONDS[0] * 1000, TIDY_PACE_SECONDS[1] * 1000] as const;
/** While Instagram draws their page. */
const SETTLE_MS = 2_000;

/** What became of someone ticked: done, done already, skipped, or the job's end (a warning, a stop). */
type Outcome = 'done' | 'already' | 'skipped' | 'stopped' | JobEnd;

/** Hands a step to the person, with what to press. */
function handOver(job: Job, name: string): Promise<'carry_on' | 'skip' | 'stop'> {
  if (!job.handOver) return Promise.resolve('skip');
  return job.handOver(
    `Couldn’t unfollow ${name}. On their Instagram page, press Following, then Unfollow. Then press Carry on, or Skip.`,
  );
}

/** One person: open, check it's them, press, check again, note. */
async function one(job: Job, who: TidyCandidate): Promise<Outcome> {
  const end = async (already: boolean) => {
    valueOf(
      await job.hfos({
        type: 'hfos-friend-end',
        input: {
          workspaceId: job.businessId,
          platform: 'instagram',
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
  let page = await readInstagramIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd();
  const theirs = page.found.profile;
  // Their page, by the name in its address: never anyone else's.
  if (!theirs || theirs.username.toLowerCase() !== (who.username ?? '').toLowerCase()) {
    job.progress(`Skipped ${who.name}: Instagram didn’t open their page.`);
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
  page = await readInstagramIn(job.tab);
  const warnedAfter = await warnedOn(job, page);
  if (warnedAfter) return warnedAfter;
  if (pressed.result === 'not_found' && page.found.profile?.following === 'no') {
    await end(true);
    return 'already';
  }
  if (pressed.result !== 'done' || page.found.profile?.following !== 'no') {
    // Not unfollowed yet: the person finishes it, or skips them.
    const reply = await handOver(job, who.name);
    if (reply === 'stop' || job.stopped()) return 'stopped';
    if (reply === 'skip') return 'skipped';
    page = await readInstagramIn(job.tab);
    if (page.found.profile?.following !== 'no') return 'skipped';
  }
  await end(false);
  return 'done';
}

/** How it went, in words for the person. */
function summary(done: number, skipped: number, gone: number, already: number): string {
  const parts = [`Unfollowed: ${counted(done, 'person', 'people')}.`];
  if (already) parts.push(`Not followed already: ${already.toLocaleString()}.`);
  if (skipped) parts.push(`Skipped: ${skipped.toLocaleString()}.`);
  if (gone) parts.push(`No longer on the list: ${gone.toLocaleString()}.`);
  return parts.join(' ');
}

/**
 * Unfollows the ones the person ticked: those still on HandsFreeOS's list for Instagram, a person at a time, up to
 * today's limit there.
 */
export async function unfollowTicked(job: Job, profileIds: readonly string[]): Promise<JobEnd> {
  job.progress('Getting the list from HandsFreeOS…');
  const lists = valueOf(
    await job.hfos({ type: 'hfos-tidy', workspaceId: job.businessId, platform: 'instagram' }),
  );
  const byId = new Map(lists.cancel.map((c) => [c.profileId, c]));
  const picks = profileIds.map((id) => byId.get(id)).filter((c): c is TidyCandidate => !!c);
  const gone = profileIds.length - picks.length;
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
        line: `That’s today’s limit of ${limit.most} on Instagram. ${said()} Ask again tomorrow for the rest.`,
        warned: false,
      };
    job.progress(`${i + 1} of ${picks.length}: unfollowing ${who.name}…`);
    const outcome = await one(job, who);
    if (outcome === 'stopped') return { line: `Stopped. ${said()}`, warned: false };
    if (typeof outcome === 'object') return { ...outcome, line: `${outcome.line} ${said()}` };
    if (outcome === 'done') {
      done++;
      room--;
    } else if (outcome === 'already') already++;
    else skipped++;
    if (i < picks.length - 1 && !job.stopped() && outcome === 'done') {
      job.progress(
        `Unfollowed: ${counted(done, 'person', 'people')}. Waiting a moment before the next…`,
      );
      await pause(paced(PACE_MS));
    }
  }
  return { line: `Done. ${said()}`, warned: false };
}

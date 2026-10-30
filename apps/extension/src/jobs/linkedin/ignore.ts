/**
 * Ignoring the invitations the person got on LinkedIn (docs/outreach.md, decision 136; Facebook's Delete request), from
 * 0.118.0, with the day's withdrawing on its own (./withdraw.ts): those HandsFreeOS picked for today, the ones they
 * pressed Delete on first, then as they chose and the AI said (packages/core/src/addons/outreach/ops/tidy.ts), at most
 * 30 a day.
 *
 * It opens each one's profile in the job's window (decision 17), checks it's them by the link to their profile (never by
 * a name alone), presses Ignore in its top card (src/networks/linkedin/auto.ts, `answerInvitation`), checks Accept is
 * gone, and notes it in HandsFreeOS as their answer, so it isn't picked again. One whose invitation went already is
 * noted the same, and not counted; one connected now is passed over. It goes slowly, stops at today's limit, and stops
 * on any LinkedIn warning. Nobody is handed to the person: one it can't ignore, it passes over.
 */
import { TIDY_PACE_SECONDS } from '@hfos/core/addons/outreach/asks';
import type { Tidy, TidyCandidate } from '../../hfos/messages';
import type { ProfileRef } from '../../networks/linkedin/types';
import { sameMember } from '../../networks/linkedin/urls';
import { counted } from '../../words';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { readLinkedIn } from './read';

/** Between people, a steady pace like a person's: never the same twice. */
const PACE_MS = [TIDY_PACE_SECONDS[0] * 1000, TIDY_PACE_SECONDS[1] * 1000] as const;

/** What became of someone: done, done already, skipped, or the job's end (a warning, a stop). */
type Outcome = 'done' | 'already' | 'skipped' | 'stopped' | JobEnd;

const profileOf = (who: TidyCandidate): ProfileRef => ({
  id: who.platformId,
  username: who.username,
  url: who.url,
});

/** One person: open their profile, check it's them, press Ignore, check again, note. */
async function one(job: Job, who: TidyCandidate): Promise<Outcome> {
  const profile = profileOf(who);
  const note = async (mutualFriends: number | null) => {
    valueOf(
      await job.hfos({
        type: 'hfos-friend-note',
        input: {
          workspaceId: job.businessId,
          platform: 'linkedin',
          answer: 'delete',
          profile,
          name: who.name,
          mutualFriends,
        },
      }),
    );
  };
  await job.tab.open(who.url);
  const page = await readLinkedIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  const shown = page.kind === 'profile' ? page.profile : null;
  if (!shown?.profile || !sameMember(shown.profile, profile)) {
    job.progress(`Skipped ${who.name}: LinkedIn showed a different page.`);
    return 'skipped';
  }
  if (shown.connection === 'connected') {
    job.progress(`Skipped ${who.name}: you’re connected now.`);
    return 'skipped';
  }
  if (job.stopped()) return 'stopped';
  const pressed = await job.tab.ask({ type: 'hfos-answer-request', answer: 'delete' });
  if (!pressed.ok) throw new Error(pressed.error);
  if (pressed.result === 'already') {
    await note(shown.mutualConnections);
    return 'already';
  }
  await pause(1_500);
  const after = await readLinkedIn(job.tab);
  const warnedAfter = await warnedOn(job, after);
  if (warnedAfter) return warnedAfter;
  if (pressed.result !== 'done' || after.profile?.connection === 'received') {
    job.progress(`Skipped ${who.name}: couldn’t find Ignore on their profile.`);
    return 'skipped';
  }
  await note(shown.mutualConnections);
  return 'done';
}

/** How it went, in words for the person. */
function summary(done: number, skipped: number, already: number): string {
  const parts = [`Invitations ignored: ${counted(done, 'person', 'people')}.`];
  if (already) parts.push(`Answered or gone already: ${already.toLocaleString()}.`);
  if (skipped) parts.push(`Skipped: ${skipped.toLocaleString()}.`);
  return parts.join(' ');
}

/** Ignores those picked, a person at a time, up to today's limit on LinkedIn. */
export async function ignoreThese(
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
        line: `That’s today’s limit of ${limit.most} on LinkedIn. ${said()}`,
        warned: false,
      };
    job.progress(`${i + 1} of ${picks.length}: ignoring the invitation from ${who.name}…`);
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
        `Invitations ignored: ${counted(done, 'person', 'people')}. Waiting a moment before the next…`,
      );
      await pause(paced(PACE_MS));
    }
  }
  return { line: said(), warned: false };
}

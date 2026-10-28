/**
 * Tidying on its own, once a day (docs/outreach.md, decision 98), on any network: what HandsFreeOS picked for today
 * from the person's choice there (packages/core/src/addons/outreach/tidy.ts, `own`), each kind in turn through the
 * network's own job: Facebook's cancel and unfriend (./tidy.ts), LinkedIn's and Alignable's withdraw, Instagram's
 * unfollow. Nobody is handed to the person: a step it can't find, it passes over.
 */
import type { TidyKind } from '@hfos/core/addons/outreach/limits';
import type { Tidy, TidyCandidate } from '../hfos/messages';
import type { Job, JobEnd } from './job';

/** Nothing picked: a server from before it picks nobody. */
const NONE: NonNullable<Tidy['own']> = { mode: 'off', cancel: [], unfriend: [] };

/**
 * Nothing while the person only ticks; else each kind HandsFreeOS picked, the old requests first, through `run`. A
 * warning or a stop ends it there.
 */
export async function ownTidy(
  job: Pick<Job, 'stopped'>,
  lists: Tidy,
  run: (which: TidyKind, picks: readonly TidyCandidate[]) => Promise<JobEnd>,
): Promise<JobEnd> {
  const own = lists.own ?? NONE;
  if (own.mode === 'off')
    return { line: 'Off: only the ones you tick in HandsFreeOS go.', warned: false };
  const lines: string[] = [];
  for (const which of ['cancel_request', 'unfriend'] as const) {
    const picks = which === 'cancel_request' ? own.cancel : own.unfriend;
    if (!picks.length) continue;
    const end = await run(which, picks);
    if (end.warned || job.stopped()) return end;
    if (end.line) lines.push(end.line);
  }
  return { line: lines.length ? lines.join(' ') : 'Nothing to tidy up today.', warned: false };
}

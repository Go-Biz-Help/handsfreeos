/**
 * Tidying on its own, once a day (docs/outreach.md, decision 98), on any network: what HandsFreeOS picked for today
 * from the person's choice there (packages/core/src/addons/outreach/tidy.ts, `own`), each kind in turn through the
 * network's own job: Facebook's cancel and unfriend (./tidy.ts), LinkedIn's and Alignable's withdraw, Instagram's
 * unfollow; with Cancel all's, however the person picked (decision 121). Then on Facebook, the requests the person got
 * that it deletes as they picked for those. Nobody is handed to the person: a step it can't find, it passes over.
 */
import type { TidyKind } from '@hfos/core/addons/outreach/limits';
import type { Tidy, TidyCandidate } from '../hfos/messages';
import type { Job, JobEnd } from './job';

/** Nothing picked: a server from before it picks nobody. */
const NONE: NonNullable<Tidy['own']> = { mode: 'off', cancel: [], unfriend: [], decline: [] };

/**
 * Nothing while the person only ticks and has no requests to delete; else each kind HandsFreeOS picked, the old
 * requests first, through `run`, then the requests they got through `decline` where the network has one. A warning or
 * a stop ends it there.
 */
export async function ownTidy(
  job: Pick<Job, 'stopped'>,
  lists: Tidy,
  run: (which: TidyKind, picks: readonly TidyCandidate[]) => Promise<JobEnd>,
  decline?: (picks: readonly TidyCandidate[]) => Promise<JobEnd>,
): Promise<JobEnd> {
  const own = lists.own ?? NONE;
  const declines = decline ? (own.decline ?? []) : [];
  if (own.mode === 'off' && !declines.length)
    return { line: 'Off: only the ones you tick in HandsFreeOS go.', warned: false };
  const lines: string[] = [];
  const kinds = [
    ...(['cancel_request', 'unfriend'] as const).map((which) => ({
      picks: which === 'cancel_request' ? own.cancel : own.unfriend,
      go: (picks: readonly TidyCandidate[]) => run(which, picks),
    })),
    { picks: declines, go: decline },
  ];
  for (const { picks, go } of kinds) {
    if (!picks.length || !go) continue;
    const end = await go(picks);
    if (end.warned || job.stopped()) return end;
    if (end.line) lines.push(end.line);
  }
  return { line: lines.length ? lines.join(' ') : 'Nothing to tidy up today.', warned: false };
}

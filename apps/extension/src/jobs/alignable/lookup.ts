/**
 * Looking a business up on Alignable before the AI drafts to them (docs/outreach.md, decisions 21 and 43; partners
 * stage 6c, part 4), asked from Today in HandsFreeOS: the extension opens its business page in a window of its own and
 * reads what it says, one page, and the window closes. What it read goes with the ask for drafts, so they mention
 * only what's really there; the drafts go back to Today. Nothing is pressed or kept on Alignable, and the lines aren't
 * saved. It stops on any Alignable warning.
 */
import type { AskResult, AskTask } from '@hfos/core/addons/outreach/asks';
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import { valueOf, type Job, type JobEnd } from '../job';
import { readThemOnAlignable } from './checks';

type LookupTask = Extract<AskTask, { kind: 'lookup' }>;

/** Looks them up on Alignable, then asks the AI for drafts; the drafts are the ask's result, for Today to show. */
export async function lookupOnAlignable(
  job: Job,
  task: LookupTask,
): Promise<JobEnd & { readonly result: AskResult | null }> {
  job.progress(`Looking ${task.name} up on Alignable…`);
  let lines: string[] = [];
  if (task.profileUrl) {
    try {
      const read = await readThemOnAlignable(job, {
        profileId: '',
        name: task.name,
        url: task.profileUrl,
      });
      if ('end' in read) return { ...read.end, result: null };
      lines = read.lines.slice(0, LOOKUP_LINES);
    } catch {
      // Alignable went elsewhere: draft from what's known.
    }
  }
  if (job.stopped()) return { line: 'Stopped.', warned: false, result: null };
  await job.tab.close?.();
  job.progress('Writing drafts…');
  const drafted = valueOf(
    await job.hfos({
      type: 'hfos-draft',
      workspaceId: job.businessId,
      input: { ...task.draft, lookup: lines },
    }),
  );
  const drafts = drafted.drafts.slice(0, 5).map((d) => d.slice(0, 2_000));
  const lookedUp = lines.length > 0;
  const n = drafts.length;
  const wrote = n === 1 ? 'Wrote a draft' : `Wrote ${n.toLocaleString()} drafts`;
  return {
    line: !n
      ? 'The AI had nothing to write. Try Draft again.'
      : lookedUp
        ? `${wrote} after looking ${task.name} up on Alignable.`
        : `${wrote} from what HandsFreeOS knows: Alignable didn’t show their business page.`,
    warned: false,
    failed: !n,
    result: {
      drafts,
      kind: drafted.kind,
      opener: drafted.opener,
      simple: drafted.simple,
      lookedUp,
      queued: false,
    },
  };
}

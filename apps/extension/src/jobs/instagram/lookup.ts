/**
 * Looking someone up on Instagram before the AI drafts to them (docs/outreach.md, decisions 21 and 43; the Instagram
 * and Alignable plan's part 13), asked from Today in HandsFreeOS: the extension opens their account in a window of its
 * own and reads its header and what their latest posts show, one page, and the window closes. What it read goes with
 * the ask for drafts, so they mention only what's really there; the drafts go back to Today. Nothing is pressed or
 * kept on Instagram, and the lines aren't saved. It stops on any Instagram warning.
 */
import type { AskResult, AskTask } from '@hfos/core/addons/outreach/asks';
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import { valueOf, type Job, type JobEnd } from '../job';
import { readThemOnInstagram } from './checks';

type LookupTask = Extract<AskTask, { kind: 'lookup' }>;

/**
 * What their account says, as lines for the AI's drafts: empty when there's no account to open or Instagram didn't
 * show theirs, which still lets the drafts be written from what HandsFreeOS knows. A warning, or a page asking them to
 * sign in, ends it. Instagram's runner looks up the same way before it drafts (../../auto/instagram.ts).
 */
export async function lookUpOnInstagram(
  job: Job,
  name: string,
  profileUrl: string | null,
): Promise<{ readonly lines: string[] } | { readonly end: JobEnd }> {
  if (!profileUrl) return { lines: [] };
  try {
    const read = await readThemOnInstagram(job, { profileId: '', name, url: profileUrl });
    if ('end' in read) return read;
    return { lines: read.lines.slice(0, LOOKUP_LINES) };
  } catch {
    // Instagram went elsewhere: draft from what's known.
    return { lines: [] };
  }
}

/** Looks them up on Instagram, then asks the AI for drafts; the drafts are the ask's result, for Today to show. */
export async function lookupOnInstagram(
  job: Job,
  task: LookupTask,
): Promise<JobEnd & { readonly result: AskResult | null }> {
  job.progress(`Looking ${task.name} up on Instagram…`);
  const looked = await lookUpOnInstagram(job, task.name, task.profileUrl);
  if ('end' in looked) return { ...looked.end, result: null };
  const lines = looked.lines;
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
        ? `${wrote} after looking ${task.name} up on Instagram.`
        : `${wrote} from what HandsFreeOS knows: Instagram didn’t show their account.`,
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

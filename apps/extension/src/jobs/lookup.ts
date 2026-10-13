/**
 * Looking someone up before the AI drafts to them (docs/outreach.md, decisions 21 and 43), asked from Today in
 * HandsFreeOS: the extension opens their profile in a window of its own, reads what it says about them and their
 * latest posts, follows a link from it to the business they own or work at and reads that page too. What it read goes
 * with the ask for drafts, so they can mention only what's really there; the drafts go back to Today. Nothing is
 * pressed or kept on Facebook, and the lines aren't saved: they go to the AI for this draft alone.
 *
 * It stops when Facebook shows a warning (decision 25). The runner's own look-up (src/auto/run.ts) is its own, with
 * its checks of who it opened.
 */
import type { AskResult, AskTask } from '@hfos/core/addons/outreach/asks';
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import { linesOf, ownsPage, pageHeading, POSTS_READ } from '../facebook/lookup';
import { workUrl } from '../facebook/urls';
import { readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';

type LookupTask = Extract<AskTask, { kind: 'lookup' }>;

/**
 * What their profile and business page say, as lines for the AI's drafts: empty when there's no profile to open or
 * Facebook didn't show it, which still lets the drafts be written from what HandsFreeOS knows. A warning ends it.
 */
export async function lookUpLines(
  job: Job,
  profileUrl: string | null,
): Promise<{ readonly lines: string[] } | { readonly end: JobEnd }> {
  if (!profileUrl?.startsWith('https://www.facebook.com/')) return { lines: [] };
  const lines: string[] = [];
  try {
    await job.tab.open(profileUrl);
    const profile = await readIn(job.tab);
    const warned = await warnedOn(job, profile);
    if (warned) return { end: warned };
    lines.push(...linesOf(profile, null, POSTS_READ));
    const business = profile.pages?.[0];
    // Only a Facebook page of theirs: a link read off their profile never takes the tab anywhere else.
    const pageUrl = business?.profile ? workUrl(business.profile.url) : null;
    if (business && pageUrl && !job.stopped()) {
      job.progress(
        ownsPage(profile, business) ? 'Reading their business page…' : 'Reading where they work…',
      );
      await job.tab.open(pageUrl);
      const page = await readIn(job.tab);
      const warnedThere = await warnedOn(job, page);
      if (warnedThere) return { end: warnedThere };
      lines.push(pageHeading(profile, business), ...linesOf(page, business.name, 1));
    }
  } catch {
    // Facebook went elsewhere: draft from what's known.
  }
  return { lines: [...new Set(lines.filter(Boolean))].slice(0, LOOKUP_LINES) };
}

/** Looks them up, then asks the AI for drafts; the drafts are the ask's result, for Today to show. */
export async function lookupAndDraft(
  job: Job,
  task: LookupTask,
): Promise<JobEnd & { readonly result: AskResult | null }> {
  job.progress(`Looking ${task.name} up on Facebook…`);
  const looked = await lookUpLines(job, task.profileUrl);
  if ('end' in looked) return { ...looked.end, result: null };
  if (job.stopped()) return { line: 'Stopped.', warned: false, result: null };
  job.progress('Writing drafts…');
  const drafted = valueOf(
    await job.hfos({
      type: 'hfos-draft',
      workspaceId: job.businessId,
      input: { ...task.draft, lookup: looked.lines },
    }),
  );
  const drafts = drafted.drafts.slice(0, 5).map((d) => d.slice(0, 2_000));
  const lookedUp = looked.lines.length > 0;
  const n = drafts.length;
  const wrote = n === 1 ? 'Wrote a draft' : `Wrote ${n.toLocaleString()} drafts`;
  return {
    line: !n
      ? 'The AI had nothing to write. Try Draft again.'
      : lookedUp
        ? `${wrote} after looking ${task.name} up.`
        : `${wrote} from what HandsFreeOS knows: Facebook didn’t show their profile.`,
    warned: false,
    failed: !n,
    result: { drafts, opener: drafted.opener, simple: drafted.simple, lookedUp },
  };
}

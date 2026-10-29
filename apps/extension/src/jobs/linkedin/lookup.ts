/**
 * Looking someone up on LinkedIn before the AI drafts to them (docs/outreach.md, decisions 21 and 43), asked from
 * Today in HandsFreeOS: the extension opens their profile in a window of its own and reads what it says about them,
 * then the page of the company their role links to and what it says about itself: two pages, and the window closes.
 * What it read goes with the ask for drafts, so they mention only what's really there; the drafts go back to Today.
 * Nothing is pressed or kept on LinkedIn, and the lines aren't saved: they go to the AI for this draft alone. It stops
 * on any LinkedIn warning.
 */
import type { AskResult, AskTask } from '@hfos/core/addons/outreach/asks';
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import { companyHeading, companyLines, profileLines } from '../../networks/linkedin/lookup';
import { profileRefOf, workUrl } from '../../networks/linkedin/urls';
import { valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { readLinkedIn } from './read';

type LookupTask = Extract<AskTask, { kind: 'lookup' }>;

/**
 * What their profile and their company's page say, as lines for the AI's drafts: empty when there's no LinkedIn
 * profile to open or LinkedIn didn't show it, which still lets the drafts be written from what HandsFreeOS knows. A
 * warning ends it.
 */
export async function lookUpOnLinkedIn(
  job: Job,
  profileUrl: string | null,
): Promise<{ readonly lines: string[] } | { readonly end: JobEnd }> {
  const want = profileUrl ? profileRefOf(profileUrl) : null;
  if (!want) return { lines: [] };
  const lines: string[] = [];
  try {
    await job.tab.open(want.url);
    const page = await readLinkedIn(job.tab);
    const warned = await warnedOn(job, page);
    if (warned) return { end: warned };
    const profile = page.kind === 'profile' ? page.profile : undefined;
    if (!profile) return { lines: [] };
    lines.push(...profileLines(profile));
    const company = profile.company;
    // Only a company page on LinkedIn, by its About: a link read off their profile never takes the window elsewhere.
    const companyUrl = company?.company ? workUrl(`${company.company.url}about/`) : null;
    if (company && companyUrl && !job.stopped()) {
      job.progress(`Reading ${company.name}’s page…`);
      await job.tab.open(companyUrl);
      const there = await readLinkedIn(job.tab);
      const warnedThere = await warnedOn(job, there);
      if (warnedThere) return { end: warnedThere };
      if (there.company)
        lines.push(
          companyHeading(profile, there.company.name ?? company.name),
          ...companyLines(there.company, there.company.name ?? company.name),
        );
    }
  } catch {
    // LinkedIn went elsewhere: draft from what's known.
  }
  return { lines: [...new Set(lines.filter(Boolean))].slice(0, LOOKUP_LINES) };
}

/** Looks them up on LinkedIn, then asks the AI for drafts; the drafts are the ask's result, for Today to show. */
export async function lookupOnLinkedIn(
  job: Job,
  task: LookupTask,
): Promise<JobEnd & { readonly result: AskResult | null }> {
  job.progress(`Looking ${task.name} up on LinkedIn…`);
  const looked = await lookUpOnLinkedIn(job, task.profileUrl);
  if ('end' in looked) return { ...looked.end, result: null };
  if (job.stopped()) return { line: 'Stopped.', warned: false, result: null };
  // Two pages, and the window closes before the AI writes: the ask's end closes it too.
  await job.tab.close?.();
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
        ? `${wrote} after looking ${task.name} up on LinkedIn.`
        : `${wrote} from what HandsFreeOS knows: LinkedIn didn’t show their profile.`,
    warned: false,
    failed: !n,
    result: {
      drafts,
      kind: drafted.kind,
      opener: drafted.opener,
      simple: drafted.simple,
      unanswered: drafted.unanswered ?? null,
      lookedUp,
      queued: false,
    },
  };
}

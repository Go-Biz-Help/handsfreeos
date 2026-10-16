/**
 * Checking the person's friends for good fits (docs/outreach.md, decision 46), asked from the Friends tab in
 * HandsFreeOS (**Check my friends**) and done once a day while the extension works on its own (src/auto/daily.ts).
 * HandsFreeOS says who's next (friends they've chatted with first) and how many today has room for; the extension
 * opens each one's profile in a window of its own, checks it's them, reads what it says about them and their latest
 * posts, follows the link to the business they own or work at and reads that too, and sends those lines for the AI
 * to read with the person's chat with them. Nothing is pressed on Facebook. It goes at a person's pace and stops for
 * the day on any Facebook warning.
 */
import type { AskResult } from '@hfos/core/addons/outreach/asks';
import {
  CHECK_PACE_SECONDS,
  CHECKS_WORDS,
  RESEARCH_WORDS,
} from '@hfos/core/addons/outreach/checks';
import type { ChecksNext } from '../hfos/messages';
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import { samePerson } from '../networks/facebook/auto';
import { linesOf, pageHeading, POSTS_READ } from '../networks/facebook/lookup';
import { profileFromUrl, workUrl } from '../networks/facebook/urls';
import { counted } from '../words';
import { paced, pause, readIn, valueOf, warnedOn, type Job, type JobEnd } from './job';

/** Between people, a steady pace like a person's: never the same twice. */
const PACE_MS = [CHECK_PACE_SECONDS[0] * 1000, CHECK_PACE_SECONDS[1] * 1000] as const;

/** Who HandsFreeOS listed to check. */
interface Who {
  readonly profileId: string;
  readonly name: string;
  readonly url: string;
}

/**
 * What their profile and business page say, as lines for the AI; `missing` when Facebook showed someone else or no
 * profile at all. A warning ends it.
 */
async function readThem(
  job: Job,
  who: Who,
): Promise<{ readonly lines: string[]; readonly missing: boolean } | { readonly end: JobEnd }> {
  let want;
  try {
    want = profileFromUrl(new URL(who.url));
  } catch {
    want = null;
  }
  if (!want) return { lines: [], missing: true };
  await job.tab.open(want.url);
  const profile = await readIn(job.tab);
  const warned = await warnedOn(job, profile);
  if (warned) return { end: warned };
  const shown = profile.profile?.profile ?? null;
  if (!profile.profile || !shown || !samePerson(shown, profile.profile.name, want, who.name))
    return { lines: [], missing: true };
  const lines = linesOf(profile, null, POSTS_READ);
  const business = profile.pages?.[0];
  // Only a Facebook page of theirs: a link read off their profile never takes the window anywhere else.
  const pageUrl = business?.profile ? workUrl(business.profile.url) : null;
  if (business && pageUrl && !job.stopped()) {
    await job.tab.open(pageUrl);
    const page = await readIn(job.tab);
    const warnedThere = await warnedOn(job, page);
    if (warnedThere) return { end: warnedThere };
    lines.push(pageHeading(profile, business), ...linesOf(page, business.name, 1));
  }
  return { lines: [...new Set(lines.filter(Boolean))].slice(0, LOOKUP_LINES), missing: false };
}

/** How it went, in words for the person. */
function summary(sent: number, missing: number): string {
  const parts = [`Checked ${counted(sent, 'person', 'people')} for the AI.`];
  if (missing) parts.push(`Facebook didn’t show ${counted(missing, 'profile')}.`);
  if (sent)
    parts.push('The good fits show under Good fits on the Friends tab once it has read them.');
  return parts.join(' ');
}

/**
 * Research on a person's row in HandsFreeOS (decision 46a): that one person, checked as above, within today's checks.
 * With none left, they go first tomorrow; HandsFreeOS says so.
 */
export async function research(
  job: Job,
  who: { readonly profileId: string; readonly name: string },
): Promise<JobEnd & { readonly result?: AskResult }> {
  job.progress(`Asking HandsFreeOS about ${who.name}…`);
  const next = valueOf(
    await job.hfos({
      type: 'hfos-checks-next',
      input: { workspaceId: job.businessId, most: 1, profileId: who.profileId },
    }),
  );
  if (!next.people.length)
    return next.today >= next.perDay
      ? {
          line: RESEARCH_WORDS.tomorrow(who.name, next.perDay),
          warned: false,
          result: {
            drafts: [],
            kind: null,
            opener: null,
            simple: false,
            lookedUp: false,
            queued: true,
          },
        }
      : { line: RESEARCH_WORDS.gone(who.name), warned: false, failed: true };
  return checkFriends(job, 1, next);
}

/** Checks the next of the person's friends and chats, up to `most` and today's room. */
export async function checkFriends(
  job: Job,
  most: number,
  listed: ChecksNext | null = null,
): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS who to check…');
  const next =
    listed ??
    valueOf(
      await job.hfos({ type: 'hfos-checks-next', input: { workspaceId: job.businessId, most } }),
    );
  if (!next.people.length)
    return {
      line:
        next.today >= next.perDay
          ? `That’s today’s ${next.perDay.toLocaleString()}. It carries on tomorrow.`
          : `Nobody left to check. ${CHECKS_WORDS.none}`,
      warned: false,
    };
  let sent = 0;
  let missing = 0;
  for (const [i, who] of next.people.entries()) {
    if (job.stopped()) return { line: `Stopped. ${summary(sent, missing)}`, warned: false };
    job.progress(`${i + 1} of ${next.people.length}: reading ${who.name}’s profile…`);
    let read: Awaited<ReturnType<typeof readThem>>;
    try {
      read = await readThem(job, who);
    } catch {
      // Facebook went elsewhere: tried again in a week.
      read = { lines: [], missing: true };
    }
    if ('end' in read) return { ...read.end, line: `${read.end.line} ${summary(sent, missing)}` };
    valueOf(
      await job.hfos({
        type: 'hfos-check-look',
        input: {
          workspaceId: job.businessId,
          profileId: who.profileId,
          lines: read.lines,
          missing: read.missing,
        },
      }),
    );
    if (read.missing) missing++;
    else sent++;
    if (i < next.people.length - 1 && !job.stopped()) {
      job.progress(
        `Checked ${counted(sent, 'person', 'people')}. Waiting a moment before the next…`,
      );
      await pause(paced(PACE_MS));
    }
  }
  return { line: `Done. ${summary(sent, missing)}`, warned: false };
}

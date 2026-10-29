/**
 * Checking the person's LinkedIn connections for good fits (docs/outreach.md, decision 46, LinkedIn's way), asked
 * from the Friends tab in HandsFreeOS (**Check my connections**), and **Research** on one person's row (decision
 * 46a). HandsFreeOS says who's next and how many today has room for, on LinkedIn's own count: a look at a profile
 * is seen by its owner, so profiles read there have a day's limit of their own (40 to start), and each one read here
 * counts. The extension opens each one's profile in a window of its own, checks it's them, reads what it says about
 * them, and sends those lines for the AI to read with the person's chat with them. One page each: nothing is followed
 * from it, and nothing is pressed. It goes at a person's pace and stops on any LinkedIn warning.
 */
import type { AskResult } from '@hfos/core/addons/outreach/asks';
import { CHECK_PACE_SECONDS, RESEARCH_WORDS } from '@hfos/core/addons/outreach/checks';
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import type { ChecksNext } from '../../hfos/messages';
import { profileLines } from '../../networks/linkedin/lookup';
import type { ProfilePage, ProfileRef } from '../../networks/linkedin/types';
import { profileRefOf, sameMember } from '../../networks/linkedin/urls';
import { counted } from '../../words';
import type { ReadThem, Who } from '../checks';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { readLinkedIn } from './read';

/** Between people, a steady pace like a person's: never the same twice. */
const PACE_MS = [CHECK_PACE_SECONDS[0] * 1000, CHECK_PACE_SECONDS[1] * 1000] as const;

/**
 * Whether the profile shown is the one opened: the same member by their address's name or LinkedIn's id. A link with
 * only the id takes LinkedIn to their address with their name in it; then the name on the page must be theirs.
 */
export function isThem(
  shown: Pick<ProfilePage, 'name' | 'profile'>,
  want: ProfileRef,
  name: string,
): boolean {
  if (!shown.profile) return false;
  if (sameMember(shown.profile, want)) return true;
  return (
    !want.username &&
    shown.name !== null &&
    shown.name.trim().toLowerCase() === name.trim().toLowerCase()
  );
}

/**
 * What their profile says, as lines for the AI, and how many follow them; `missing` when LinkedIn showed someone else
 * or no profile at all. A warning ends it. The partner check reads people the same way (../partners.ts).
 */
export async function readThemOnLinkedIn(job: Job, who: Who): Promise<ReadThem> {
  const want = profileRefOf(who.url);
  if (!want) return { lines: [], missing: true, followers: null };
  await job.tab.open(want.url);
  const page = await readLinkedIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return { end: warned };
  if (page.kind !== 'profile' || !page.profile || !isThem(page.profile, want, who.name))
    return { lines: [], missing: true, followers: null };
  return {
    lines: profileLines(page.profile).slice(0, LOOKUP_LINES),
    missing: false,
    followers: page.profile.followers ?? null,
  };
}

/** How it went, in words for the person. */
function summary(sent: number, missing: number): string {
  const parts = [`Checked ${counted(sent, 'person', 'people')} for the AI.`];
  if (missing) parts.push(`LinkedIn didn’t show ${counted(missing, 'profile')}.`);
  if (sent)
    parts.push('The good fits show under Good fits on the Friends tab once it has read them.');
  return parts.join(' ');
}

/** Research on a LinkedIn row in HandsFreeOS: that one person, checked as above, within today's LinkedIn checks. */
export async function researchOnLinkedIn(
  job: Job,
  who: { readonly profileId: string; readonly name: string },
): Promise<JobEnd & { readonly result?: AskResult }> {
  job.progress(`Asking HandsFreeOS about ${who.name}…`);
  const next = valueOf(
    await job.hfos({
      type: 'hfos-checks-next',
      input: {
        workspaceId: job.businessId,
        most: 1,
        profileId: who.profileId,
        platform: 'linkedin',
      },
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
            unanswered: null,
            lookedUp: false,
            queued: true,
          },
        }
      : { line: RESEARCH_WORDS.gone(who.name), warned: false, failed: true };
  return checkConnections(job, 1, next);
}

/** Checks the next of the person's LinkedIn connections, up to `most` and today's room on LinkedIn. */
export async function checkConnections(
  job: Job,
  most: number,
  listed: ChecksNext | null = null,
): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS who to check…');
  const next =
    listed ??
    valueOf(
      await job.hfos({
        type: 'hfos-checks-next',
        input: { workspaceId: job.businessId, most, platform: 'linkedin' },
      }),
    );
  if (!next.people.length)
    return {
      line:
        next.today >= next.perDay
          ? `That’s today’s ${next.perDay.toLocaleString()} profiles on LinkedIn. It carries on tomorrow.`
          : 'Nobody left to check. Save your LinkedIn connections first, or read your LinkedIn chats, and there’s someone to check.',
      warned: false,
    };
  let sent = 0;
  let missing = 0;
  for (const [i, who] of next.people.entries()) {
    if (job.stopped()) return { line: `Stopped. ${summary(sent, missing)}`, warned: false };
    job.progress(`${i + 1} of ${next.people.length}: reading ${who.name}’s profile…`);
    let read: ReadThem;
    try {
      read = await readThemOnLinkedIn(job, who);
    } catch {
      // LinkedIn went elsewhere: tried again another week.
      read = { lines: [], missing: true, followers: null };
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

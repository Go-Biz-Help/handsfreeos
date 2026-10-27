/**
 * Checking the people found by topic on Instagram, LinkedIn and Alignable (docs/outreach.md, decision 92), once a day
 * while the extension works on its own there, last of the day's jobs: the writers of good posts, who liked or reacted
 * to them and who commented, the businesses an Alignable search showed and the members of its groups. HandsFreeOS says
 * who's next (writers first, then commenters, likers, members and search results; a post asking for what the business
 * offers first, then the newest) and how many today has room for: the network's found checks a day (30, half on
 * training wheels or for a week after a warning), on LinkedIn inside its 40 profiles read, and none while the good fits
 * waiting for their like are two days of likes or more. The extension opens each one's page in a window of its own,
 * checks it's theirs, reads it as that network's checks read people (the network's `read`), and sends those lines for
 * the AI's found check (`outreach.check.look`, which HandsFreeOS marks `found`). Only a good check puts them on Today.
 * Nothing is pressed. It goes at a person's pace, 15 to 30 seconds between people, and stops for the day on any
 * warning. Each network's runner calls it as `jobs/partners.ts`'s `checkPartners` is called, with its own reader.
 */
import { CHECK_PACE_SECONDS } from '@hfos/core/addons/outreach/checks';
import { FINDS_NEXT_MOST } from '@hfos/core/addons/outreach/finds';
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import type { FindsNext } from '../hfos/messages';
import { counted } from '../words';
import type { ReadThem, Who } from './checks';
import { paced, pause, valueOf, type Job, type JobEnd } from './job';

/** Between people, a steady pace like a person's, as the checks of friends go. */
const PACE_MS = [CHECK_PACE_SECONDS[0] * 1000, CHECK_PACE_SECONDS[1] * 1000] as const;

/** What a page of someone's is called on each network, for "Instagram didn’t show 2 accounts". */
const PAGE: Readonly<Record<Platform, string>> = {
  facebook: 'profile',
  linkedin: 'profile',
  instagram: 'account',
  alignable: 'business page',
};

/** How a network's found checks go: its network, and how its checks read someone's page. */
export interface FoundChecksOn {
  readonly platform: Platform;
  readonly read: (job: Job, who: Who) => Promise<ReadThem>;
}

/** How many it asks for at once: the network's found checks a day, at most what one ask takes. */
export const foundMost = (platform: Platform): number =>
  Math.min(FINDS_NEXT_MOST, NETWORKS[platform].foundChecksPerDay ?? FINDS_NEXT_MOST);

/** How it went, in words for the person. */
function summary(sent: number, missing: number, platform: Platform): string {
  const parts = [`Checked ${counted(sent, 'person', 'people')} found by topic for the AI.`];
  if (missing)
    parts.push(`${NETWORKS[platform].name} didn’t show ${counted(missing, PAGE[platform])}.`);
  if (sent) parts.push('The good fits come onto Today once it has read them.');
  return parts.join(' ');
}

/** The line when nobody's listed: today's all checked, or nobody found waits for a check. */
function noneLine(next: FindsNext, platform: Platform): string {
  const name = NETWORKS[platform].name;
  if (next.perDay > 0 && next.today >= next.perDay)
    return `That’s today’s ${next.perDay.toLocaleString()} people found on ${name}. It carries on tomorrow.`;
  return `Nobody found on ${name} waits for a check, or the good fits found wait for their likes first.`;
}

/**
 * Checks the next people found by topic on a network, up to `most` and today's room there, each read by `on.read`
 * (`readThemOnInstagram`, `readThemOnLinkedIn`, `readThemOnAlignable`). Someone the network didn't show is sent as
 * missing, and tried again in a week.
 */
export async function checkFound(
  job: Job,
  on: FoundChecksOn,
  most: number = foundMost(on.platform),
): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS who of the people found to check…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-finds-next',
      input: {
        workspaceId: job.businessId,
        platform: on.platform,
        most: Math.max(1, Math.min(most, FINDS_NEXT_MOST)),
      },
    }),
  );
  if (!next.people.length) return { line: noneLine(next, on.platform), warned: false };
  const name = NETWORKS[on.platform].name;
  let sent = 0;
  let missing = 0;
  for (const [i, who] of next.people.entries()) {
    if (job.stopped())
      return { line: `Stopped. ${summary(sent, missing, on.platform)}`, warned: false };
    job.progress(`${i + 1} of ${next.people.length}: reading ${who.name}’s ${name}…`);
    let read: ReadThem;
    try {
      read = await on.read(job, who);
    } catch {
      // The network went elsewhere: tried again in a week.
      read = { lines: [], missing: true, followers: null };
    }
    if ('end' in read)
      return { ...read.end, line: `${read.end.line} ${summary(sent, missing, on.platform)}` };
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
        `Checked ${counted(sent, 'person', 'people')} found. Waiting a moment before the next…`,
      );
      await pause(paced(PACE_MS));
    }
  }
  return { line: `Done. ${summary(sent, missing, on.platform)}`, warned: false };
}

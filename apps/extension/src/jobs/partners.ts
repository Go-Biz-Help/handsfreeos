/**
 * Reading people who could partner with the business (docs/outreach.md, decision 81), once a day while the extension
 * works on its own (src/auto/daily.ts), after its checks of friends. First it does today's searches for partners
 * (./partner-search.ts, stage 4 of the partners plan), which find creators and businesses beyond the person's own
 * groups and friends. Then HandsFreeOS says who's next (admins of the biggest groups the business's customers are in,
 * then the biggest followings and creators a search found, then businesses) and how many today has room for; the
 * extension opens each one's profile in a window of its own, checks it's them, reads what it says about them, their
 * latest posts and how many follow them, and sends that for the AI's partner check, on Facebook and on LinkedIn.
 * Nothing is pressed. It goes at a person's pace and stops for the day on any warning.
 */
import { CHECK_PACE_SECONDS } from '@hfos/core/addons/outreach/checks';
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import { counted } from '../words';
import { readThem, type ReadThem, type Who } from './checks';
import { paced, pause, valueOf, type Job, type JobEnd } from './job';
import { searchedLine, searchFacebook, searchPartners, type PartnerSearch } from './partner-search';

/** Between people, a steady pace like a person's, as the checks of friends go. */
const PACE_MS = [CHECK_PACE_SECONDS[0] * 1000, CHECK_PACE_SECONDS[1] * 1000] as const;

/** How it went, in words for the person. */
function summary(sent: number, missing: number, platform: Platform): string {
  const parts = [`Read ${counted(sent, 'possible partner')} for the AI.`];
  if (missing) parts.push(`${NETWORKS[platform].name} didn’t show ${counted(missing, 'profile')}.`);
  if (sent) parts.push('Good partners show on the Partners list once it has read them.');
  return parts.join(' ');
}

/**
 * Searches a network for people who could partner with the business, then reads the next ones, up to `most` and
 * today's room there, each read as that network's checks read people: Facebook's unless said.
 */
export async function checkPartners(
  job: Job,
  most: number,
  on: {
    readonly platform: Platform;
    readonly read: (job: Job, who: Who) => Promise<ReadThem>;
    readonly search: PartnerSearch;
  } = { platform: 'facebook', read: readThem, search: searchFacebook },
): Promise<JobEnd> {
  const searched = await searchPartners(job, on.platform, on.search);
  if ('warned' in searched) return searched;
  const found = searchedLine(searched.searched, searched.kept, on.platform);
  const done = (sent: number, missing: number) =>
    [found, summary(sent, missing, on.platform)].filter(Boolean).join(' ');
  job.progress('Asking HandsFreeOS who could partner with you…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-partners-next',
      input: { workspaceId: job.businessId, most, platform: on.platform },
    }),
  );
  if (!next.people.length)
    return {
      line: [
        found,
        next.perDay > 0 && next.today >= next.perDay
          ? `That’s today’s ${next.perDay.toLocaleString()}. It carries on tomorrow.`
          : 'Nobody to read as a partner today. A playbook whose goal is Find partners has your computer look for them.',
      ]
        .filter(Boolean)
        .join(' '),
      warned: false,
    };
  let sent = 0;
  let missing = 0;
  for (const [i, who] of next.people.entries()) {
    if (job.stopped()) return { line: `Stopped. ${done(sent, missing)}`, warned: false };
    job.progress(`${i + 1} of ${next.people.length}: reading ${who.name}’s profile…`);
    let read: ReadThem;
    try {
      read = await on.read(job, who);
    } catch {
      // The network went elsewhere: tried again in a week.
      read = { lines: [], missing: true, followers: null };
    }
    if ('end' in read) return { ...read.end, line: `${read.end.line} ${done(sent, missing)}` };
    valueOf(
      await job.hfos({
        type: 'hfos-partner-look',
        input: {
          workspaceId: job.businessId,
          profileId: who.profileId,
          kind: who.kind,
          lines: read.lines,
          followers: read.followers,
          missing: read.missing,
        },
      }),
    );
    if (read.missing) missing++;
    else sent++;
    if (i < next.people.length - 1 && !job.stopped()) {
      job.progress(`Read ${counted(sent, 'possible partner')}. Waiting a moment before the next…`);
      await pause(paced(PACE_MS));
    }
  }
  return { line: `Done. ${done(sent, missing)}`, warned: false };
}

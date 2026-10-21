/**
 * Checking the person's Alignable connections for good fits (docs/outreach.md, decision 46, Alignable's way; partners
 * stage 6c, part 4), asked from the Friends tab in HandsFreeOS (**Check my connections**), and **Research** on one
 * business's row. HandsFreeOS says who's next and how many today has room for, on Alignable's own count (30 business
 * pages a day to start, its kit's `checksPerDay`). The extension opens each one's business page in a window of its
 * own, checks it's theirs, reads what it says (its Elevator Pitch, About Us, who it's for and who it refers with, and
 * its tags), and sends those lines for the AI to read with the person's chat with them. One page each: nothing is
 * followed from it, and nothing is pressed. It goes at a person's pace and stops on any Alignable warning.
 */
import type { AskResult } from '@hfos/core/addons/outreach/asks';
import { CHECK_PACE_SECONDS, RESEARCH_WORDS } from '@hfos/core/addons/outreach/checks';
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import type { ChecksNext } from '../../hfos/messages';
import type { BusinessPage, Ideal } from '../../networks/alignable/read';
import { businessRef, idIn, urlOf } from '../../networks/alignable/read';
import { counted } from '../../words';
import type { ReadThem, Who } from '../checks';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { ALIGNABLE, readAlignableIn, signedOutEnd } from './read';

/** Between businesses, a steady pace like a person's: never the same twice. */
const PACE_MS = [CHECK_PACE_SECONDS[0] * 1000, CHECK_PACE_SECONDS[1] * 1000] as const;

/** Who a business says it's for, or refers with, in a line. */
function idealLine(label: string, ideal: Ideal | null): string | null {
  if (!ideal) return null;
  const parts = [ideal.words, ideal.type, ideal.place, ideal.tags.join(', ')].filter(
    (p): p is string => !!p,
  );
  return parts.length ? `${label}: ${parts.join(' · ')}` : null;
}

/** What a business's page says about it, as lines for the AI. */
export function businessLines(page: BusinessPage): string[] {
  return [
    page.title ? `${page.name}, ${page.title}` : page.name,
    page.town ? `In ${page.town}` : null,
    page.pitch ? `Elevator Pitch: ${page.pitch}` : null,
    page.about ? `About Us: ${page.about}` : null,
    idealLine('Their ideal customer', page.customer),
    idealLine('Who they refer with', page.partner),
    page.tags.length ? `Tags: ${page.tags.join(', ')}` : null,
  ].filter((line): line is string => !!line);
}

/** Whether the business page shown is the one opened: the same business by Alignable's id, or its address. */
export function isTheirs(shown: BusinessPage, want: { id: string | null; url: string }): boolean {
  const got = shown.profile;
  if (!got) return false;
  if (want.id && got.id) return want.id === got.id;
  return got.url.toLowerCase() === want.url.toLowerCase();
}

/**
 * What their business's page says, as lines for the AI; `missing` when Alignable showed another business or no page
 * at all. A warning, or a page asking them to sign in, ends it. The partner check reads businesses the same way.
 */
export async function readThemOnAlignable(job: Job, who: Who): Promise<ReadThem> {
  const url = urlOf(who.url, ALIGNABLE);
  const want = url ? businessRef(url, idIn(url)) : null;
  if (!want) return { lines: [], missing: true, followers: null };
  await job.tab.open(want.url);
  const page = await readAlignableIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return { end: warned };
  if (page.signedOut) return { end: signedOutEnd() };
  const shown = page.found.business;
  if (!shown || !isTheirs(shown, want)) return { lines: [], missing: true, followers: null };
  return { lines: businessLines(shown).slice(0, LOOKUP_LINES), missing: false, followers: null };
}

/** How it went, in words for the person. */
function summary(sent: number, missing: number): string {
  const parts = [`Checked ${counted(sent, 'business', 'businesses')} for the AI.`];
  if (missing) parts.push(`Alignable didn’t show ${counted(missing, 'business page')}.`);
  if (sent)
    parts.push('The good fits show under Good fits on the Friends tab once it has read them.');
  return parts.join(' ');
}

/** Research on an Alignable row in HandsFreeOS: that one business, checked as above, within today's checks. */
export async function researchOnAlignable(
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
        platform: 'alignable',
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
            lookedUp: false,
            queued: true,
          },
        }
      : { line: RESEARCH_WORDS.gone(who.name), warned: false, failed: true };
  return checkConnections(job, 1, next);
}

/** Checks the next of the person's Alignable connections, up to `most` and today's room on Alignable. */
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
        input: { workspaceId: job.businessId, most, platform: 'alignable' },
      }),
    );
  if (!next.people.length)
    return {
      line:
        next.today >= next.perDay
          ? `That’s today’s ${next.perDay.toLocaleString()} business pages on Alignable. It carries on tomorrow.`
          : 'Nobody left to check. Save your Alignable connections first, and there’s someone to check.',
      warned: false,
    };
  let sent = 0;
  let missing = 0;
  for (const [i, who] of next.people.entries()) {
    if (job.stopped()) return { line: `Stopped. ${summary(sent, missing)}`, warned: false };
    job.progress(`${i + 1} of ${next.people.length}: reading ${who.name}’s business page…`);
    let read: ReadThem;
    try {
      read = await readThemOnAlignable(job, who);
    } catch {
      // Alignable went elsewhere: tried again another week.
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
        `Checked ${counted(sent, 'business', 'businesses')}. Waiting a moment before the next…`,
      );
      await pause(paced(PACE_MS));
    }
  }
  return { line: `Done. ${summary(sent, missing)}`, warned: false };
}

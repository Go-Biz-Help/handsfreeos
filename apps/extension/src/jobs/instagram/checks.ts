/**
 * Checking the person's Instagram followers for good fits (docs/outreach.md, decision 46, Instagram's way; the
 * Instagram and Alignable plan's part 13), asked from the Friends tab in HandsFreeOS (**Check your followers for good
 * fits**), and **Research** on one person's row. HandsFreeOS says who's next and how many today has room for, on
 * Instagram's own count (20 profiles a day to start, its kit's `checksPerDay`). The extension opens each one's account
 * in a window of its own, checks it's theirs by the name in its address, reads its header (their name, what they do,
 * their bio, how many follow them) and what Instagram says their latest posts show, and sends those lines for the AI
 * to read with the person's chat with them. One page each: nothing is followed from it, and nothing is pressed. It goes
 * at a person's pace and stops on any Instagram warning.
 */
import type { AskResult } from '@hfos/core/addons/outreach/asks';
import { CHECK_PACE_SECONDS, RESEARCH_WORDS } from '@hfos/core/addons/outreach/checks';
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import type { ChecksNext } from '../../hfos/messages';
import { line } from '../../networks/facebook/lookup';
import type { Account, InstagramProfile } from '../../networks/instagram/read';
import { instagramUrl, profileOf } from '../../networks/instagram/urls';
import { counted } from '../../words';
import type { ReadThem, Who } from '../checks';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { readInstagramIn, signedOutEnd } from './read';

/** Between people, a steady pace like a person's: never the same twice. */
const PACE_MS = [CHECK_PACE_SECONDS[0] * 1000, CHECK_PACE_SECONDS[1] * 1000] as const;
/** What their latest posts show, as lines: a few. */
const POST_LINES = 4;

/** The account a link kept in HandsFreeOS is, by the name in its address; null for any other link. */
export function accountIn(url: string | null): Account | null {
  const at = url ? instagramUrl(url) : null;
  return at ? profileOf(at) : null;
}

/** Whether the account shown is the one opened: the same name in its address, whatever its case. */
export const isTheirs = (shown: Pick<InstagramProfile, 'username'>, want: Account): boolean =>
  shown.username.toLowerCase() === want.username.toLowerCase();

/**
 * What their account's header and grid say about them, as lines for the AI, each cut to what HandsFreeOS takes
 * (LinkedIn's way): a bio line or a picture's description can run long, and one too long turns the whole check away.
 */
export function profileLines(profile: InstagramProfile): string[] {
  return [
    profile.name ? `${profile.name} (@${profile.username})` : `@${profile.username}`,
    ...profile.bio,
    profile.followers !== null ? `${profile.followers.toLocaleString('en-US')} followers` : null,
    ...profile.pictures
      .filter((p): p is string => !!p)
      .slice(0, POST_LINES)
      .map((p) => `A post: ${p}`),
  ]
    .filter((l): l is string => !!l)
    .map((l) => line(l));
}

/**
 * What their account says, as lines for the AI, and how many follow them; `missing` when Instagram showed someone
 * else's or no account at all. A warning, or a page asking them to sign in, ends it. The partner check and the look-up
 * read people the same way.
 */
export async function readThemOnInstagram(job: Job, who: Who): Promise<ReadThem> {
  const want = accountIn(who.url);
  if (!want) return { lines: [], missing: true, followers: null };
  await job.tab.open(want.url);
  const page = await readInstagramIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return { end: warned };
  if (page.signedOut) return { end: signedOutEnd() };
  const shown = page.found.profile;
  if (!shown || !isTheirs(shown, want)) return { lines: [], missing: true, followers: null };
  return {
    lines: profileLines(shown).slice(0, LOOKUP_LINES),
    missing: false,
    followers: shown.followers,
  };
}

/** How it went, in words for the person. */
function summary(sent: number, missing: number): string {
  const parts = [`Checked ${counted(sent, 'person', 'people')} for the AI.`];
  if (missing) parts.push(`Instagram didn’t show ${counted(missing, 'account')}.`);
  if (sent)
    parts.push('The good fits show under Good fits on the Friends tab once it has read them.');
  return parts.join(' ');
}

/** Research on an Instagram row in HandsFreeOS: that one person, checked as above, within today's checks. */
export async function researchOnInstagram(
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
        platform: 'instagram',
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
  return checkFollowers(job, 1, next);
}

/** Checks the next of the person's Instagram followers, up to `most` and today's room on Instagram. */
export async function checkFollowers(
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
        input: { workspaceId: job.businessId, most, platform: 'instagram' },
      }),
    );
  if (!next.people.length)
    return {
      line:
        next.today >= next.perDay
          ? `That’s today’s ${next.perDay.toLocaleString()} profiles on Instagram. It carries on tomorrow.`
          : 'Nobody left to check. Save your Instagram followers first, and there’s someone to check.',
      warned: false,
    };
  let sent = 0;
  let missing = 0;
  for (const [i, who] of next.people.entries()) {
    if (job.stopped()) return { line: `Stopped. ${summary(sent, missing)}`, warned: false };
    job.progress(`${i + 1} of ${next.people.length}: reading ${who.name}’s Instagram…`);
    let read: ReadThem;
    try {
      read = await readThemOnInstagram(job, who);
    } catch {
      // Instagram went elsewhere: tried again another week.
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

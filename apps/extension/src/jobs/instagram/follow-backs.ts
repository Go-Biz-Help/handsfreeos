/**
 * Who followed back, from their own accounts (the owner, 21 Oct 2026; core's `outreach.follow_backs.next`). Save my
 * followers reads only the newest (./people.ts), so whether someone the person followed follows them back is seen on
 * that someone's own account, where Instagram says so ("Follows you", or Follow Back). HandsFreeOS names who: those
 * followed at least a day ago who haven't followed back, not looked at in the last day or so, the longest since a look
 * first. The extension opens each account in a window of its own at a person's pace, checks it's theirs by the name in
 * its address, and notes what it saw:
 *
 * - **They follow back:** saved among the person's followers, which HandsFreeOS counts as accepting, as it does from
 *   the list of followers: "Followed you back" on Today, then their first message, and they're never suggested for
 *   unfollowing.
 * - **Still waiting** (Following, or Requested for a private account), or their account not shown: saved among the
 *   follows the person has sent, which keeps when they were followed (so the one message to their Requests and the
 *   unfollow list's wait go by it) and leaves them a day before the next look.
 * - **Not followed any more** (their account says Follow): the follow noted as ended already, not counted.
 *
 * It presses nothing and sends nothing for the AI, and stops on any Instagram warning. About 30 accounts a day (its
 * kit's `followBackLooksPerDay`, halved for a week after a warning there), counted on this computer across Save my
 * followers and the runner's once-a-day job (`followBackMemory`). These looks don't count against the profiles checked
 * a day (`checksPerDay`, 20 on Instagram): that count is the accounts read for the AI, its checks and its partner
 * check, and sharing it would leave those fewer, while a look reads an account the person follows already and sends
 * nothing on. They go at the checks' pace all the same.
 */
import { CHECK_PACE_SECONDS } from '@hfos/core/addons/outreach/checks';
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import type { FollowBacksNext } from '../../hfos/messages';
import { instagramListSave } from '../../hfos/saves';
import { counted } from '../../words';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { accountIn, isTheirs } from './checks';
import { readInstagramIn, signedOutEnd } from './read';

/** Between accounts, the checks' steady pace: never the same twice. */
const PACE_MS = [CHECK_PACE_SECONDS[0] * 1000, CHECK_PACE_SECONDS[1] * 1000] as const;

/** Where this computer counts the day's looks, by business. */
export const FOLLOW_BACKS_KEY = 'hfos.followBacks';

/** How many accounts this computer looked at today for a business, across Save my followers and the runner. */
export interface FollowBackMemory {
  today(businessId: string): Promise<number>;
  looked(businessId: string, more: number): Promise<void>;
}

/** Today on this computer's clock: "2026-10-21". */
const dayNow = (): string => {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
};

type Looks = Record<string, { readonly day: string; readonly looked: number }>;

async function looksKept(): Promise<Looks> {
  try {
    const kept: unknown = (await chrome.storage.local.get(FOLLOW_BACKS_KEY))[FOLLOW_BACKS_KEY];
    return kept && typeof kept === 'object' ? (kept as Looks) : {};
  } catch {
    return {};
  }
}

export const followBackMemory: FollowBackMemory = {
  async today(businessId) {
    const mine = (await looksKept())[businessId];
    return mine?.day === dayNow() ? mine.looked : 0;
  },
  async looked(businessId, more) {
    const kept = await looksKept();
    const day = dayNow();
    const had = kept[businessId]?.day === day ? kept[businessId]!.looked : 0;
    try {
      await chrome.storage.local.set({
        [FOLLOW_BACKS_KEY]: { ...kept, [businessId]: { day, looked: had + more } },
      });
    } catch {
      // Not kept: the day's count starts again, and HandsFreeOS still leaves anyone looked at a day.
    }
  },
};

type Who = FollowBacksNext['people'][number];
/** What a look saw: they follow back, still waiting, not followed any more, or no account of theirs shown. */
type Seen = 'back' | 'waiting' | 'gone' | 'missing';

/** Opens their account and reads where things stand, by its own Follows you, Follow Back, Following and Follow. */
async function lookAt(job: Job, who: Who): Promise<Seen | JobEnd> {
  const want = accountIn(who.url);
  if (!want) return 'missing';
  await job.tab.open(want.url);
  const page = await readInstagramIn(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd();
  const shown = page.found.profile;
  if (!shown || !isTheirs(shown, want)) return 'missing';
  if (shown.followsYou === true) return 'back';
  if (shown.following === 'no') return 'gone';
  return 'waiting';
}

/** Notes what a look saw in HandsFreeOS: a list of one, or the follow ended already. */
async function note(job: Job, who: Who, seen: Seen): Promise<void> {
  const want = accountIn(who.url);
  if (!want) return;
  if (seen === 'gone') {
    valueOf(
      await job.hfos({
        type: 'hfos-friend-end',
        input: {
          workspaceId: job.businessId,
          platform: 'instagram',
          kind: 'cancel_request',
          profile: { id: who.platformId, username: want.username, url: want.url },
          name: who.name,
          already: true,
        },
      }),
    );
    return;
  }
  const built = instagramListSave(
    [{ username: want.username, url: want.url, name: who.name }],
    job.businessId,
    seen === 'back' ? 'friends' : 'sent',
  );
  if (!built.ok) return;
  for (const input of built.input) valueOf(await job.hfos({ type: 'hfos-save-friends', input }));
}

/** "2 followed you back", "none has followed you back yet". */
const backWords = (back: number) =>
  back ? `${back.toLocaleString()} followed you back` : 'none has followed you back yet';

/** How it went, in words for the person. */
function summary(looked: number, back: number, gone: number, missing: number): string {
  const parts = [`Looked at ${counted(looked, 'account')} you followed: ${backWords(back)}.`];
  if (gone) parts.push(`You don’t follow ${counted(gone, 'of them', 'of them')} any more.`);
  if (missing) parts.push(`Instagram didn’t show ${counted(missing, 'account')}.`);
  return parts.join(' ');
}

/**
 * Looks at the accounts of people the person followed for who follows them back now, up to today's looks on this
 * computer and HandsFreeOS's count a day.
 */
export async function lookForFollowBacks(
  job: Job,
  memory: FollowBackMemory = followBackMemory,
): Promise<JobEnd> {
  const most = NETWORKS.instagram.followBackLooksPerDay ?? 0;
  const done = await memory.today(job.businessId);
  if (done >= most)
    return {
      line: `That’s today’s ${most} looks at who followed you back. It carries on tomorrow.`,
      warned: false,
    };
  job.progress('Asking HandsFreeOS who you followed…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-follow-backs-next',
      input: { workspaceId: job.businessId, platform: 'instagram', most: most - done },
    }),
  );
  // After a warning HandsFreeOS looks at fewer a day: those this computer looked at today count.
  const people = next.people.slice(0, Math.max(0, next.perDay - done));
  if (!people.length)
    return {
      line:
        done && done >= next.perDay
          ? `That’s today’s ${next.perDay} looks at who followed you back. It carries on tomorrow.`
          : 'Nobody you followed is due a look for a follow-back today.',
      warned: false,
    };
  let looked = 0;
  let back = 0;
  let gone = 0;
  let missing = 0;
  for (const [i, who] of people.entries()) {
    if (job.stopped())
      return { line: `Stopped. ${summary(looked, back, gone, missing)}`, warned: false };
    job.progress(`${i + 1} of ${people.length}: seeing whether ${who.name} follows you back…`);
    let seen: Seen | JobEnd;
    try {
      seen = await lookAt(job, who);
    } catch {
      // Instagram went elsewhere: looked at again another day.
      seen = 'missing';
    }
    if (typeof seen === 'object')
      return { ...seen, line: `${seen.line} ${summary(looked, back, gone, missing)}` };
    looked++;
    await memory.looked(job.businessId, 1);
    await note(job, who, seen);
    if (seen === 'back') back++;
    else if (seen === 'gone') gone++;
    else if (seen === 'missing') missing++;
    if (i < people.length - 1 && !job.stopped()) {
      job.progress(
        `Looked at ${counted(looked, 'account')}: ${backWords(back)}. Waiting a moment before the next…`,
      );
      await pause(paced(PACE_MS));
    }
  }
  return { line: summary(looked, back, gone, missing), warned: false };
}

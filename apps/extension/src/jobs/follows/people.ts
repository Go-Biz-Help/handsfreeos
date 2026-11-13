/**
 * The person's followers on Threads and X (decision 163), as Instagram's are (../instagram/people.ts and
 * ../instagram/follow-backs.ts): on a follow network, their follow-back is the accepting.
 *
 * - **Save my followers** (`friends`): their own profile from the menu, then their followers (X's own page of them,
 *   Threads' box over their profile, opened by their count of followers as a person does), read a screen at a time at
 *   a person's pace. The first time it reads the newest 200; after that only those new since: each screen is saved as
 *   it's read, and it stops at a screen whose followers were all saved before. Everyone it read is saved as the
 *   network's friends list, which only adds and updates.
 * - **Who followed back** (`follow_backs`): the accounts the person followed, at least a day ago, that haven't
 *   followed back, as HandsFreeOS names them (`outreach.follow_backs.next`), each looked at on their own profile, which
 *   says whether they follow the person (X's "Follows you", either's Follow back); 30 a day at most (its kit's
 *   `followBackLooksPerDay`), counted on this computer.
 *
 * Nothing is pressed but Threads' count of followers, once, and the list is only scrolled. It stops on any warning.
 */
import { CHECK_PACE_SECONDS } from '@hfos/core/addons/outreach/checks';
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import type { FollowBacksNext } from '../../hfos/messages';
import { followListSave } from '../../hfos/saves';
import { FOLLOW_SPECS } from '../../networks/follows/specs';
import type { FollowListed, FollowPlatform } from '../../networks/follows/types';
import { counted } from '../../words';
import { onScreen, paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import {
  accountIn,
  ended,
  gather,
  isTheirs,
  readFollowIn,
  signedInWords,
  signedOutEnd,
} from './read';

/** The most a save reads: the newest followers. */
export const FOLLOWERS_MOST = 200;
/** Screens of the list at most, beside that. */
const FOLLOWER_SCROLLS = 60;
/** For the list to draw its first rows. */
const LIST_MS = 2_500;
/** How many times the list is looked for before it's taken as not there. */
const LIST_LOOKS = 4;
/** The fewest followers on a screen, all saved before, for a later save to take the rest as saved. */
const REACHED = 3;

const keyOf = (person: FollowListed) => person.username.toLowerCase();
const newOnes = (added: number) => (added ? `, ${added.toLocaleString()} new` : '');

/** Opens the person's followers, reads the newest (up to those saved before, or 200), and saves them. */
export async function saveFollowers(job: Job, platform: FollowPlatform): Promise<JobEnd> {
  const spec = FOLLOW_SPECS[platform];
  job.progress(`Opening ${spec.name}…`);
  await job.tab.open(spec.pages.home);
  // A list draws more of itself only as it's scrolled on screen: its window is in front while it reads.
  return onScreen(job, () => followersSaved(job, platform));
}

async function followersSaved(job: Job, platform: FollowPlatform): Promise<JobEnd> {
  const spec = FOLLOW_SPECS[platform];
  const home = await readFollowIn(job.tab, platform);
  if (home.signedOut) return signedOutEnd(platform);
  const own = accountIn(platform, home.own);
  if (!own)
    return {
      line: `Couldn’t find your own profile in ${spec.name}’s menu. ${signedInWords(platform)}`,
      warned: false,
      failed: true,
    };
  job.progress('Opening your followers…');
  const page = spec.pages.followers(own);
  await job.tab.open(page ?? own.url);
  for (let look = 0; look < LIST_LOOKS; look++) {
    await pause(LIST_MS);
    const read = await readFollowIn(job.tab, platform);
    if (read.found.people.length || read.signedOut || read.warnings.length) break;
    // Threads' followers open from the count on their own profile, pressed once as a person does.
    if (!page && look === 0) await job.tab.ask({ type: 'hfos-show-all' });
  }
  let saved = 0;
  let kept = 0;
  let added = 0;
  let reached = false;
  const saveNew = async (items: readonly FollowListed[]) => {
    const fresh = items.slice(saved, FOLLOWERS_MOST);
    saved += fresh.length;
    const built = fresh.length ? followListSave(platform, fresh, job.businessId) : null;
    if (!built?.ok) return;
    kept += fresh.length;
    let news = 0;
    for (const input of built.input) {
      const got = valueOf(await job.hfos({ type: 'hfos-save-friends', input }));
      added += got.added;
      news += got.added + got.changed;
    }
    if (fresh.length >= REACHED && !news) reached = true;
  };
  const got = await gather(
    job,
    platform,
    FOLLOWER_SCROLLS,
    (p) => p.found.people,
    keyOf,
    (count) => `Reading your newest followers… ${counted(count, 'follower')} so far.`,
    async (items) => {
      await saveNew(items);
      return reached || items.length >= FOLLOWERS_MOST;
    },
  );
  if (ended(got)) return got;
  // Closed again where it was a box over their profile.
  if (!page) await job.tab.ask({ type: 'hfos-close-dialog' });
  if (!got.items.length)
    return {
      line: `${spec.name} showed nobody in your followers. If you have some, ${signedInWords(platform).replace(/^C/, 'c')}`,
      warned: false,
      failed: true,
    };
  await saveNew(got.items);
  if (!kept)
    return {
      line: `There are no followers on the page to save. Open your followers on ${spec.name}, then try again.`,
      warned: false,
      failed: true,
    };
  const read = got.items.slice(0, FOLLOWERS_MOST);
  const stopped = job.stopped();
  const whole = got.whole && !stopped;
  const count = counted(read.length, 'follower');
  if (whole) return { line: `Saved your ${count}${newOnes(added)}.`, warned: false, whole };
  if (stopped)
    return { line: `Stopped. Saved your newest ${count}${newOnes(added)}.`, warned: false, whole };
  return {
    line: reached
      ? `Saved your newest ${count}${newOnes(added)}, up to those saved before.`
      : `Saved your newest ${count}${newOnes(added)}. Each save after reads only those new since.`,
    warned: false,
    whole,
  };
}

// ------------------------------------------------------------------------------------------------ who followed back

/** Between accounts, the checks' steady pace. */
const PACE_MS = [CHECK_PACE_SECONDS[0] * 1000, CHECK_PACE_SECONDS[1] * 1000] as const;
/** Where this computer counts the day's looks, by network and business. */
const looksKey = (platform: FollowPlatform) => `hfos.followBacks.${platform}`;

const dayNow = (): string => {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
};

type Looks = Record<string, { readonly day: string; readonly looked: number }>;

async function looksKept(platform: FollowPlatform): Promise<Looks> {
  try {
    const kept: unknown = (await chrome.storage.local.get(looksKey(platform)))[looksKey(platform)];
    return kept && typeof kept === 'object' ? (kept as Looks) : {};
  } catch {
    return {};
  }
}

async function lookedToday(platform: FollowPlatform, businessId: string): Promise<number> {
  const mine = (await looksKept(platform))[businessId];
  return mine?.day === dayNow() ? mine.looked : 0;
}

async function lookedOne(platform: FollowPlatform, businessId: string): Promise<void> {
  const kept = await looksKept(platform);
  const day = dayNow();
  const had = kept[businessId]?.day === day ? kept[businessId]!.looked : 0;
  try {
    await chrome.storage.local.set({
      [looksKey(platform)]: { ...kept, [businessId]: { day, looked: had + 1 } },
    });
  } catch {
    // Not kept: the day's count starts again, and HandsFreeOS still leaves anyone looked at a day.
  }
}

type Who = FollowBacksNext['people'][number];
type Seen = 'back' | 'waiting' | 'gone' | 'missing';

async function lookAt(job: Job, platform: FollowPlatform, who: Who): Promise<Seen | JobEnd> {
  const want = accountIn(platform, who.url);
  if (!want) return 'missing';
  await job.tab.open(want.url);
  const page = await readFollowIn(job.tab, platform);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd(platform);
  const shown = page.found.profile;
  if (!shown || !isTheirs(shown, want)) return 'missing';
  if (shown.followsYou === true) return 'back';
  if (shown.following === 'no') return 'gone';
  return 'waiting';
}

async function note(job: Job, platform: FollowPlatform, who: Who, seen: Seen): Promise<void> {
  const want = accountIn(platform, who.url);
  if (!want) return;
  if (seen === 'gone') {
    valueOf(
      await job.hfos({
        type: 'hfos-friend-end',
        input: {
          workspaceId: job.businessId,
          platform,
          kind: 'cancel_request',
          profile: { id: who.platformId, username: want.username, url: want.url },
          name: who.name,
          already: true,
        },
      }),
    );
    return;
  }
  const built = followListSave(
    platform,
    [{ username: want.username, url: want.url, name: who.name }],
    job.businessId,
    seen === 'back' ? 'friends' : 'sent',
  );
  if (!built.ok) return;
  for (const input of built.input) valueOf(await job.hfos({ type: 'hfos-save-friends', input }));
}

const backWords = (back: number) =>
  back ? `${back.toLocaleString()} followed you back` : 'none has followed you back yet';

function summary(
  platform: FollowPlatform,
  looked: number,
  back: number,
  gone: number,
  missing: number,
): string {
  const parts = [`Looked at ${counted(looked, 'account')} you followed: ${backWords(back)}.`];
  if (gone) parts.push(`You don’t follow ${counted(gone, 'of them', 'of them')} any more.`);
  if (missing) parts.push(`${NETWORKS[platform].name} didn’t show ${counted(missing, 'account')}.`);
  return parts.join(' ');
}

/** Looks at the accounts the person followed for who follows them back now, up to today's looks. */
export async function lookForFollowBacks(job: Job, platform: FollowPlatform): Promise<JobEnd> {
  const most = NETWORKS[platform].followBackLooksPerDay ?? 0;
  const done = await lookedToday(platform, job.businessId);
  if (done >= most)
    return {
      line: `That’s today’s ${most} looks at who followed you back. It carries on tomorrow.`,
      warned: false,
    };
  job.progress('Asking HandsFreeOS who you followed…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-follow-backs-next',
      input: { workspaceId: job.businessId, platform, most: most - done },
    }),
  );
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
  const said = () => summary(platform, looked, back, gone, missing);
  for (const [i, who] of people.entries()) {
    if (job.stopped()) return { line: `Stopped. ${said()}`, warned: false };
    job.progress(`${i + 1} of ${people.length}: seeing whether ${who.name} follows you back…`);
    let seen: Seen | JobEnd;
    try {
      seen = await lookAt(job, platform, who);
    } catch {
      seen = 'missing';
    }
    if (typeof seen === 'object') return { ...seen, line: `${seen.line} ${said()}` };
    looked++;
    await lookedOne(platform, job.businessId);
    await note(job, platform, who, seen);
    if (seen === 'back') back++;
    else if (seen === 'gone') gone++;
    else if (seen === 'missing') missing++;
    if (i < people.length - 1 && !job.stopped()) await pause(paced(PACE_MS));
  }
  return { line: said(), warned: false };
}

/** Save my followers, asked from HandsFreeOS: the newest saved, then who followed back looked for. */
export async function saveMyFollowers(job: Job, platform: FollowPlatform): Promise<JobEnd> {
  const saved = await saveFollowers(job, platform);
  if (saved.warned || saved.failed || job.stopped()) return saved;
  const looked = await lookForFollowBacks(job, platform);
  return { ...looked, line: `${saved.line} ${looked.line}`, whole: saved.whole };
}

/**
 * Saving the person's newest Instagram followers, asked from the Friends tab in HandsFreeOS on Instagram (the Instagram
 * and Alignable plan's part 12, "A follow-back counts as accepting"; the owner's design of 21 Oct 2026):
 *
 * - **Save my followers** (`friends`): opens their own account from Instagram's menu, then their followers, which
 *   Instagram draws newest first in a box over it (/<you>/followers/), and reads the box a screen at a time at a
 *   person's pace (`SCROLL_PACE_MS`, 8 to 15 seconds a screen, as Instagram blocks accounts that scroll fast). The
 *   first time it reads the newest 200 (about ten minutes), as new followers are the warmest; after that, only
 *   those new since the last save: it stops once it reaches the followers that were newest then, which this computer
 *   remembers (`followerMemory`), usually within a minute, and at 200 all the same, so a burst of new followers still
 *   ends. Everyone it read is saved as Instagram's friends list, which only adds and updates: nobody it didn't read is
 *   taken for gone or unfollowed. Someone they followed who's among them has followed back: HandsFreeOS counts that as
 *   accepting, and their first message comes as on the other networks. Then it looks at the accounts they followed for
 *   who follows them back (./follow-backs.ts), which the newest followers alone can't say.
 *
 * Before Instagram's first day, weekly after, and once a day while it works on its own, its runner saves them the same
 * way (../../auto/lists.ts, ../../auto/instagram.ts), and looks for follow-backs in a job of its own. Nothing is
 * pressed on Instagram but their own account's count of followers, once, where Instagram doesn't open the box from its
 * address (0.84.0); the box is only scrolled. It stops on any Instagram warning.
 */
import { instagramListSave, type InstagramListed } from '../../hfos/saves';
import { counted } from '../../words';
import { pause, valueOf, type Job, type JobEnd } from '../job';
import { lookForFollowBacks } from './follow-backs';
import { ended, gather, INSTAGRAM, readInstagramIn, SIGNED_IN, signedOutEnd } from './read';

/** The most a save reads: the newest followers, about ten minutes of screens at a person's pace. */
export const FOLLOWERS_MOST = 200;
/** Screens of the box at most, beside that: well past 200 followers, if Instagram draws a few a screen. */
export const FOLLOWER_SCROLLS = 60;
/** For Instagram to draw the box over their profile, and its first rows. */
const BOX_MS = 2_500;
/** How many times the box is looked for before it's taken as not there. */
const BOX_LOOKS = 4;
/** Looks for the box before their count of followers is pressed to open it. */
const PRESS_AFTER = 2;

/** Where this computer keeps the followers that were newest at each save, by business and Instagram account. */
export const FOLLOWERS_KEY = 'hfos.followersRead';
/** The followers kept from the top of the list a save read: the newest then. */
const TOP = 12;
/**
 * How many of those a later save reads before it takes the rest of the list as saved: more than one, as one of them
 * may have unfollowed and followed again, and so moved to the top.
 */
const REACHED = 3;

/** The followers that were newest at the last save, newest first, by business and account: none the first time. */
export interface FollowerMemory {
  newest(key: string): Promise<readonly string[]>;
  remember(key: string, newest: readonly string[]): Promise<void>;
}

async function followersKept(): Promise<Record<string, unknown>> {
  try {
    const kept: unknown = (await chrome.storage.local.get(FOLLOWERS_KEY))[FOLLOWERS_KEY];
    return kept && typeof kept === 'object' ? (kept as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const followerMemory: FollowerMemory = {
  async newest(key) {
    const mine = (await followersKept())[key];
    return Array.isArray(mine) ? mine.filter((u): u is string => typeof u === 'string') : [];
  },
  async remember(key, newest) {
    try {
      await chrome.storage.local.set({
        [FOLLOWERS_KEY]: { ...(await followersKept()), [key]: newest.slice(0, TOP) },
      });
    } catch {
      // Not kept: the next save reads the newest 200 again, and saving them twice changes nothing.
    }
  },
};

const keyOf = (person: InstagramListed) => person.username.toLowerCase();

/** "check you're signed in…", after another sentence's start. */
const SIGNED_IN_LOWER = `${SIGNED_IN.charAt(0).toLowerCase()}${SIGNED_IN.slice(1)}`;

const newOnes = (added: number) => (added ? `, ${added.toLocaleString()} new` : '');

/**
 * Opens the person's followers, reads the newest (up to those saved last time, or 200), and saves them as their
 * friends list.
 */
export async function saveFollowers(
  job: Job,
  memory: FollowerMemory = followerMemory,
): Promise<JobEnd> {
  job.progress('Opening Instagram…');
  await job.tab.open(`${INSTAGRAM}/`);
  const home = await readInstagramIn(job.tab);
  if (home.signedOut) return signedOutEnd();
  if (!home.own)
    return {
      line: `Couldn’t find your own account in Instagram’s menu. ${SIGNED_IN}`,
      warned: false,
      failed: true,
    };
  job.progress('Opening your followers…');
  await job.tab.open(`${home.own.replace(/\/?$/, '/')}followers/`);
  // Instagram draws the box over their profile a moment after it opens; where it doesn't from the address, their
  // account's count of followers opens it, pressed once as a person does (the owner's Check, 21 Oct 2026).
  for (let look = 0; look < BOX_LOOKS; look++) {
    await pause(BOX_MS);
    const page = await readInstagramIn(job.tab);
    if (page.found.followers.length || page.signedOut || page.warnings.length) break;
    if (look === PRESS_AFTER - 1) await job.tab.ask({ type: 'hfos-show-all' });
  }
  // Whose followers, by the business and their own account: another account in this browser has its own.
  const kept = `${job.businessId}:${home.own.toLowerCase()}`;
  const before = new Set(await memory.newest(kept));
  const reach = Math.min(REACHED, before.size);
  const reached = (items: readonly InstagramListed[]) =>
    reach > 0 && items.filter((p) => before.has(keyOf(p))).length >= reach;
  const got = await gather(
    job,
    FOLLOWER_SCROLLS,
    (page) => page.found.followers,
    keyOf,
    (count) => `Reading your newest followers… ${counted(count, 'follower')} so far.`,
    (items) => items.length >= FOLLOWERS_MOST || reached(items),
  );
  if (ended(got)) return got;
  if (!got.items.length)
    return {
      line: `Instagram showed nobody in your followers. If you have some, ${SIGNED_IN_LOWER}`,
      warned: false,
      failed: true,
    };
  const read = got.items.slice(0, FOLLOWERS_MOST);
  const built = instagramListSave(read, job.businessId);
  if (!built.ok) return { line: built.why, warned: false, failed: true };
  let added = 0;
  for (const input of built.input)
    added += valueOf(await job.hfos({ type: 'hfos-save-friends', input })).added;
  const stopped = job.stopped();
  // The top of the list as read now is where the next save stops: kept only once this one got as far as it goes, so a
  // save stopped part way is read again.
  if (!stopped) await memory.remember(kept, read.slice(0, TOP).map(keyOf));
  const whole = got.whole && !stopped;
  const saved = counted(read.length, 'follower');
  if (whole) return { line: `Saved your ${saved}${newOnes(added)}.`, warned: false, whole };
  if (stopped)
    return {
      line: `Stopped. Saved your newest ${saved}${newOnes(added)}. Ask again to go on.`,
      warned: false,
      whole,
    };
  return {
    line: reached(read)
      ? `Saved your newest ${saved}${newOnes(added)}, up to those saved before.`
      : `Saved your newest ${saved}${newOnes(added)}. Each save after reads only those new since.`,
    warned: false,
    whole,
  };
}

/**
 * Save my followers, asked from HandsFreeOS: the newest followers saved, then the accounts they followed looked at for
 * who follows them back (./follow-backs.ts), at today's looks.
 */
export async function saveMyFollowers(job: Job): Promise<JobEnd> {
  const saved = await saveFollowers(job);
  if (saved.warned || saved.failed || job.stopped()) return saved;
  const looked = await lookForFollowBacks(job);
  return { ...looked, line: `${saved.line} ${looked.line}`, whole: saved.whole };
}

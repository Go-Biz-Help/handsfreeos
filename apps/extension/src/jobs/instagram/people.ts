/**
 * Saving the person's newest Instagram followers, asked from the Friends tab in HandsFreeOS on Instagram (the Instagram
 * and Alignable plan's part 12, "A follow-back counts as accepting"; the owner's design of 21 Oct 2026):
 *
 * - **Save my followers** (`friends`): opens their own account from Instagram's menu, then their followers, which
 *   Instagram draws newest first in a box over it (/<you>/followers/), and reads the box a screen at a time at a
 *   person's pace (`SCROLL_PACE_MS`, 8 to 15 seconds a screen, as Instagram blocks accounts that scroll fast). The
 *   first time it reads the newest 200 (a few minutes), as new followers are the warmest; after that, only those new
 *   since: each screen is saved as it's read, and it stops at a screen whose followers were all saved before, which
 *   HandsFreeOS says (so a new install or another computer stops there too, 0.88.0), usually within a minute, and at
 *   200 all the same, so a burst of new followers still ends. Everyone it read is saved as Instagram's friends list,
 *   which only adds and updates: nobody it didn't read is taken for gone or unfollowed. Someone they followed who's
 *   among them has followed back: HandsFreeOS counts that as accepting, and their first message comes as on the other
 *   networks. Then it looks at the accounts they followed for who follows them back (./follow-backs.ts), which the
 *   newest followers alone can't say.
 *
 * Before Instagram's first day, weekly after, and once a day while it works on its own, its runner saves them the same
 * way (../../auto/lists.ts, ../../auto/instagram.ts), and looks for follow-backs in a job of its own. Its window is in
 * front while it reads, as Chrome draws nothing in one hidden behind another. Nothing is pressed on Instagram but
 * their own account's count of followers, once, where Instagram doesn't open the box from its address (0.84.0); the
 * box is only scrolled, to its end a screen at a time (0.88.0). It stops on any Instagram warning.
 */
import { instagramListSave, type InstagramListed } from '../../hfos/saves';
import { counted } from '../../words';
import { pause, valueOf, type Job, type JobEnd } from '../job';
import { lookForFollowBacks } from './follow-backs';
import { ended, gather, INSTAGRAM, readInstagramIn, SIGNED_IN, signedOutEnd } from './read';

/** The most a save reads: the newest followers, a few minutes of screens at a person's pace. */
export const FOLLOWERS_MOST = 200;
/** Screens of the box at most, beside that: well past 200 followers, if Instagram draws only a few a screen. */
export const FOLLOWER_SCROLLS = 60;
/** For Instagram to draw the box over their profile, and its first rows. */
const BOX_MS = 2_500;
/** How many times the box is looked for before it's taken as not there. */
const BOX_LOOKS = 4;
/** Looks for the box before their count of followers is pressed to open it. */
const PRESS_AFTER = 2;
/**
 * The fewest followers on a screen, all saved before, for a later save to take the rest of the list as saved: more than
 * one, as someone saved may have unfollowed and followed again, and so moved to the top.
 */
const REACHED = 3;

const keyOf = (person: InstagramListed) => person.username.toLowerCase();

/** "check you're signed in…", after another sentence's start. */
const SIGNED_IN_LOWER = `${SIGNED_IN.charAt(0).toLowerCase()}${SIGNED_IN.slice(1)}`;

const newOnes = (added: number) => (added ? `, ${added.toLocaleString()} new` : '');

/**
 * Opens the person's followers, reads the newest (up to a screen of those saved before, or 200), and saves them as
 * their friends list, a screen at a time.
 */
export async function saveFollowers(job: Job): Promise<JobEnd> {
  job.progress('Opening Instagram…');
  await job.tab.open(`${INSTAGRAM}/`);
  // Instagram draws more of the box only as it's scrolled on screen, and Chrome draws nothing in a window hidden behind
  // another (0.88.0: a save behind the person's window read 87 in twelve minutes): its window is in front while it
  // reads, then theirs is put back.
  return job.tab.inFront ? job.tab.inFront(() => followersSaved(job)) : followersSaved(job);
}

async function followersSaved(job: Job): Promise<JobEnd> {
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
  // Each screen's new rows are saved as they're read; one whose followers HandsFreeOS had already (none new to it, and
  // none newly a follower) is where the last save got to.
  let saved = 0;
  let kept = 0;
  let added = 0;
  let reached = false;
  const saveNew = async (items: readonly InstagramListed[]) => {
    const fresh = items.slice(saved, FOLLOWERS_MOST);
    saved += fresh.length;
    const built = fresh.length ? instagramListSave(fresh, job.businessId) : null;
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
    FOLLOWER_SCROLLS,
    (page) => page.found.followers,
    keyOf,
    (count) => `Reading your newest followers… ${counted(count, 'follower')} so far.`,
    async (items) => {
      await saveNew(items);
      return reached || items.length >= FOLLOWERS_MOST;
    },
  );
  if (ended(got)) return got;
  if (!got.items.length)
    return {
      line: `Instagram showed nobody in your followers. If you have some, ${SIGNED_IN_LOWER}`,
      warned: false,
      failed: true,
    };
  // Read since the last screen saved: the list's end, or a stop.
  await saveNew(got.items);
  if (!kept)
    return {
      line: 'There are no followers on the page to save. Open your followers on Instagram, then try again.',
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

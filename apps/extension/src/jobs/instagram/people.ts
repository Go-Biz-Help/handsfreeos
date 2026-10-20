/**
 * Saving the person's Instagram followers, asked from the Friends tab in HandsFreeOS on Instagram (the Instagram and
 * Alignable plan's part 12, "A follow-back counts as accepting"):
 *
 * - **Save my followers** (`friends`): opens their own account from Instagram's menu, then their followers, which
 *   Instagram draws in a box over it (/<you>/followers/), reads the box a screen at a time at a person's pace to its
 *   end, and saves everyone as Instagram's friends list. Someone they followed who's among them has followed back:
 *   HandsFreeOS counts that as accepting, and their first message comes as on the other networks.
 *
 * Nothing is pressed on Instagram: the box is only scrolled. It stops on any Instagram warning.
 */
import { instagramListSave, type InstagramListed } from '../../hfos/saves';
import { counted } from '../../words';
import { pause, valueOf, type Job, type JobEnd } from '../job';
import { ended, gather, INSTAGRAM, readInstagramIn, SIGNED_IN, signedOutEnd } from './read';

/** Followers are read to the end, up to this many screens of their box. */
export const FOLLOWER_SCROLLS = 150;
/** For Instagram to draw the box over their profile, and its first rows. */
const BOX_MS = 2_500;
/** How many times the box is looked for before it's taken as not there. */
const BOX_LOOKS = 4;

const keyOf = (person: InstagramListed) => person.username.toLowerCase();

/** "check you're signed in…", after another sentence's start. */
const SIGNED_IN_LOWER = `${SIGNED_IN.charAt(0).toLowerCase()}${SIGNED_IN.slice(1)}`;

const newOnes = (added: number) => (added ? `, ${added.toLocaleString()} new` : '');

/** Opens the person's followers, reads them to the end, and saves them as their friends list. */
export async function saveFollowers(job: Job): Promise<JobEnd> {
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
  // Instagram draws the box over their profile a moment after it opens.
  for (let look = 0; look < BOX_LOOKS; look++) {
    await pause(BOX_MS);
    const page = await readInstagramIn(job.tab);
    if (page.found.followers.length || page.signedOut || page.warnings.length) break;
  }
  const got = await gather(
    job,
    FOLLOWER_SCROLLS,
    (page) => page.found.followers,
    keyOf,
    (count) => `Reading your followers… ${counted(count, 'follower')} so far.`,
  );
  if (ended(got)) return got;
  if (!got.items.length)
    return {
      line: `Instagram showed nobody in your followers. If you have some, ${SIGNED_IN_LOWER}`,
      warned: false,
      failed: true,
    };
  const built = instagramListSave(got.items, job.businessId);
  if (!built.ok) return { line: built.why, warned: false, failed: true };
  let added = 0;
  for (const input of built.input)
    added += valueOf(await job.hfos({ type: 'hfos-save-friends', input })).added;
  const whole = got.whole && !job.stopped();
  const tail = whole ? '' : ' It stopped before the end of the list: ask again for the rest.';
  return {
    line: `Saved ${counted(got.items.length, 'follower')}${newOnes(added)}.${tail}`,
    warned: false,
    whole,
  };
}

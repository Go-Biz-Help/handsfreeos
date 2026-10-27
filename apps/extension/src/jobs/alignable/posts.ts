/**
 * **Find posts in your town** on Alignable (partners stage 6c; the Instagram and Alignable plan's "Where the people
 * are", 2 and 3): Alignable groups its members by town, and its owners ask there for what they need. The extension
 * opens the person's own profile to learn their town, then their town's group (/groups/<town-st>, the owner's Check,
 * 0.66.0), reads a few screens of its posts and forum questions slowly, and sends the ones by businesses to
 * HandsFreeOS, in no group, where the AI checks each: a good one goes on Today's list with an answer or comment to
 * draft, and its author to connect with once warmed up. Nothing is pressed or written on Alignable. It stops on any
 * Alignable warning.
 */
import { alignablePostsSave } from '../../hfos/saves';
import { counted } from '../../words';
import { pause, paced, warnedOn, type Job, type JobEnd } from '../job';
import {
  ALIGNABLE,
  myTown,
  readAlignableIn,
  SCROLL_PACE_MS,
  signedOutEnd,
  SIGNED_IN,
} from './read';

/** Screens of the town's posts it reads. */
export const TOWN_SCREENS = 4;
/** For the town's posts to be drawn after its page: the owner's Check (0.67.0) read it while they were loading. */
export const DRAWN_MS = 3_000;

/** Reads their town's posts, a few screens, and sends what it finds for the AI to check. */
export async function findPostsInTown(job: Job): Promise<JobEnd> {
  const town = await myTown(job);
  if (town !== null && typeof town === 'object') return town;
  if (!town)
    return {
      line: `Alignable didn’t show your town on your profile. Add your business’s town on Alignable, then ask again. ${SIGNED_IN}`,
      warned: false,
      failed: true,
    };
  job.progress('Opening your town’s posts…');
  await job.tab.open(`${ALIGNABLE}/${town}`);
  await pause(DRAWN_MS);
  const sent = new Set<string>();
  let checking = 0;
  for (let screen = 0; screen < TOWN_SCREENS && !job.stopped(); screen++) {
    const page = await readAlignableIn(job.tab);
    const warnedHere = await warnedOn(job, page);
    if (warnedHere) return warnedHere;
    if (page.signedOut) return signedOutEnd();
    const built = alignablePostsSave(page.found.threads, job.businessId);
    if (built.ok) {
      const posts = built.input.posts.filter((post) => !sent.has(post.url));
      if (posts.length) {
        const answer = await job.hfos({
          type: 'hfos-save-posts',
          input: { ...built.input, posts },
        });
        if (!answer.ok) throw new Error(answer.problem.message);
        for (const post of posts) sent.add(post.url);
        checking += answer.value.checking;
      }
    }
    job.progress(`Reading your town’s posts… ${counted(checking, 'post')} sent to check so far.`);
    if (screen === TOWN_SCREENS - 1) break;
    if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) break;
    await pause(paced(SCROLL_PACE_MS));
  }
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}Read ${counted(sent.size, 'post')} in your town on Alignable: ${counted(checking, 'post')} sent for the AI to check. The good ones go on your list for today.`,
    warned: false,
  };
}

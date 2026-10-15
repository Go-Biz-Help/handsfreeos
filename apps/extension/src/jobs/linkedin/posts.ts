/**
 * **Find posts** on LinkedIn (docs/outreach.md, decision 49; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Where
 * the people are", 3): its groups are quiet, so it searches LinkedIn's posts with the playbooks' own words
 * (HandsFreeOS picks them: the quoted words in their signs, then their words for groups), the latest first, a few
 * screens of each, slowly, and sends the posts by people (never a company's page) to HandsFreeOS, in no group, where
 * the AI checks each one; the good ones go on Today's list with comment drafts. Nothing is pressed or written on
 * LinkedIn. It stops on any LinkedIn warning.
 */
import { linkedInPostsSave } from '../../hfos/saves';
import type { LinkedInRead } from '../../networks';
import { counted } from '../../words';
import { pause, paced, warnedOn, type Job, type JobEnd } from '../job';
import { postSearchUrl, readLinkedIn, SCROLL_PACE_MS } from './read';

/** Screens of each search it reads. */
export const SEARCH_SCREENS = 3;
/** Between searches: a person typing the next. */
const SEARCH_PACE_MS = [15_000, 30_000] as const;

/** Sends a screen's posts not sent before for the AI to check: how many went to it. */
function postSender(job: Job): (page: LinkedInRead) => Promise<number> {
  const sent = new Set<string>();
  return async (page) => {
    const built = linkedInPostsSave(page, job.businessId, 'find');
    if (!built.ok) return 0;
    const posts = built.input.posts.filter((post) => !sent.has(post.url));
    if (!posts.length) return 0;
    const answer = await job.hfos({ type: 'hfos-save-posts', input: { ...built.input, posts } });
    if (!answer.ok) throw new Error(answer.problem.message);
    for (const post of posts) sent.add(post.url);
    return answer.value.checking;
  };
}

/** Searches LinkedIn's posts with each of the words, the latest first, and sends what it finds for the AI to check. */
export async function findPostsBySearch(job: Job, words: readonly string[]): Promise<JobEnd> {
  if (!words.length)
    return {
      line: 'None of your playbooks has words to search LinkedIn’s posts with. On the Playbooks tab, add some under Words to search for groups, or put a sign in quotes under Signs they fit, then ask again.',
      warned: false,
      failed: true,
    };
  const send = postSender(job);
  let checking = 0;
  let searched = 0;
  for (const [w, said] of words.entries()) {
    if (job.stopped()) break;
    job.progress(
      `Searching LinkedIn’s posts for “${said}”… ${counted(checking, 'post')} sent to check so far.`,
    );
    await job.tab.open(postSearchUrl(said));
    for (let screen = 0; screen < SEARCH_SCREENS && !job.stopped(); screen++) {
      const page = await readLinkedIn(job.tab);
      const warned = await warnedOn(job, page);
      if (warned) return warned;
      checking += await send(page);
      job.progress(
        `Reading posts about “${said}”… ${counted(checking, 'post')} sent to check so far.`,
      );
      if (screen === SEARCH_SCREENS - 1) break;
      if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) break;
      await pause(paced(SCROLL_PACE_MS));
    }
    searched++;
    if (!job.stopped() && w < words.length - 1) await pause(paced(SEARCH_PACE_MS));
  }
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}Searched LinkedIn’s posts for ${counted(searched, 'phrase')}: ${counted(checking, 'post')} sent for the AI to check. The good ones go on your list for today.`,
    warned: false,
  };
}

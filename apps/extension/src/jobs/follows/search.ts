/**
 * **Find posts** on Threads and X (decision 163, the owner's "every hour"): in the working hours, each network's runner
 * searches its posts with the playbooks' own phrases for it in turn (Words to search Threads with, Words to search X
 * with; HandsFreeOS hands it the hour's `perLook` of them, `outreach.posts.words`), newest first, a screen or two of
 * each, and sends the posts under `newestHours` old (2 days) for the AI's check (decision 141's: only posts about the
 * business's topic get a reply), with the phrase that found them. The good ones go on Today with a reply the AI drafts,
 * and their writers are checked for the warm-up (decision 92). Also asked from HandsFreeOS (`posts`, Find posts).
 *
 * Nothing is pressed or written here. It goes at a person's pace and stops on any warning.
 */
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import { followPostsSave, postFresh } from '../../hfos/saves';
import { FOLLOW_SPECS } from '../../networks/follows/specs';
import type { FollowPlatform, FollowPost } from '../../networks/follows/types';
import { counted } from '../../words';
import { pause, paced, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { readFollowIn, SCROLL_PACE_MS, signedOutEnd } from './read';

/** Screens of each search it reads, at most: the newest posts are at the top. */
export const SEARCH_SCREENS = 3;
/** Between searches: a person typing the next. */
const SEARCH_PACE_MS = [15_000, 30_000] as const;
/** For a search's first posts to draw. */
const DRAWN_MS = 2_500;

/** The newest a post may be to keep, in hours, on the network. */
const newestHours = (platform: FollowPlatform) => NETWORKS[platform].postSearch?.newestHours ?? 48;

/** Searches the network's posts with each of the words, newest first, and sends the fresh ones for the AI's check. */
export async function findPostsOn(
  job: Job,
  platform: FollowPlatform,
  words: readonly string[],
  now: () => Date = () => new Date(),
): Promise<JobEnd> {
  const spec = FOLLOW_SPECS[platform];
  if (!words.length)
    return {
      line: `None of your playbooks has words to search ${spec.name} with. On the Playbooks tab, add some under Words to search ${spec.name} with.`,
      warned: false,
      failed: true,
    };
  const sent = new Set<string>();
  let checking = 0;
  let read = 0;
  let searched = 0;
  for (const [w, said] of words.entries()) {
    if (job.stopped()) break;
    job.progress(
      `Searching ${spec.name} for “${said}”… ${counted(checking, 'post')} sent to check so far.`,
    );
    await job.tab.open(spec.pages.search(said));
    await pause(DRAWN_MS);
    for (let screen = 0; screen < SEARCH_SCREENS && !job.stopped(); screen++) {
      const page = await readFollowIn(job.tab, platform);
      const warned = await warnedOn(job, page);
      if (warned) return warned;
      if (page.signedOut) return signedOutEnd(platform);
      const at = now();
      const fresh: FollowPost[] = page.found.posts.filter(
        (p) => !sent.has(p.url) && postFresh(p, newestHours(platform), at),
      );
      read += fresh.length;
      const built = followPostsSave(platform, fresh, job.businessId, said, page.found.me);
      if (built.ok) {
        const answer = await job.hfos({ type: 'hfos-save-posts', input: built.input });
        checking += valueOf(answer).checking;
        for (const post of built.input.posts) sent.add(post.url);
      }
      for (const post of fresh) sent.add(post.url);
      job.progress(
        `Reading posts about “${said}”… ${counted(checking, 'post')} sent to check so far.`,
      );
      // Newest first: once a screen ends past the posts it keeps, there's nothing newer below.
      const last = page.found.posts.at(-1);
      if (last && !postFresh(last, newestHours(platform), at)) break;
      if (screen === SEARCH_SCREENS - 1) break;
      if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) break;
      await pause(paced(SCROLL_PACE_MS));
    }
    searched++;
    if (!job.stopped() && w < words.length - 1) await pause(paced(SEARCH_PACE_MS));
  }
  const line = `Searched ${spec.name} for ${counted(searched, 'phrase')}: ${counted(read, 'new post')} from the last ${newestHours(platform)} hours, ${counted(checking, 'post')} sent for the AI to check.`;
  return { line: job.stopped() ? `Stopped. ${line}` : line, warned: false };
}

/** The hour's search: HandsFreeOS's phrases for this hour's turn, then the search with them. */
export async function hourlySearch(job: Job, platform: FollowPlatform): Promise<JobEnd> {
  job.progress(`Asking HandsFreeOS what to search ${NETWORKS[platform].name} with this hour…`);
  const words = valueOf(
    await job.hfos({ type: 'hfos-post-words', workspaceId: job.businessId, platform }),
  );
  return findPostsOn(job, platform, words.words);
}

/**
 * **Comment research** on Threads and X (docs/outreach.md, decision 172: `comment_research`), read by the research's
 * shared day (../comment-research.ts): a couple of everyday search words HandsFreeOS names (dinner, my dog, road trip,
 * and so on: none about the business) a batch, each searched as the network ranks it (the busiest posts first, where
 * the replies are), a few posts with replies opened in turn, and the replies each shows read. Never the post writer's
 * own replies, nor the person's.
 *
 * Nothing is pressed and nothing is written. It goes at a person's pace and stops for the day on any warning.
 */
import { FOLLOW_SPECS } from '../../networks/follows/specs';
import type { FollowPlatform } from '../../networks/follows/types';
import { readCommentsFor, type ResearchReader } from '../comment-research';
import { pause, paced, warnedOn, type Job, type JobEnd } from '../job';
import { readFollowIn, sameAs, SCROLL_PACE_MS, signedOutEnd } from './read';

/** For a search's posts, and a post's replies, to draw. */
const DRAWN_MS = [2_500, 4_000] as const;
/** Screens of a search past its first, for enough posts with replies. */
const SEARCH_SCROLLS = 2;

/** Threads' or X's research. */
export function followResearch(platform: FollowPlatform): ResearchReader {
  const spec = FOLLOW_SPECS[platform];
  return {
    platform,
    where: (words) => `posts about “${words}”`,
    async links(job, words, most, _progress, fresh) {
      await job.tab.open(spec.pages.topSearch(words));
      await pause(paced(DRAWN_MS));
      const links: string[] = [];
      for (let screen = 0; ; screen++) {
        const page = await readFollowIn(job.tab, platform);
        const warned = await warnedOn(job, page);
        if (warned) return warned;
        if (page.signedOut) return signedOutEnd(platform);
        // Posts by others with replies to read: one showing no count may have some.
        for (const post of page.found.posts)
          if (
            post.replies !== 0 &&
            !sameAs(post.author.username, page.found.me) &&
            !links.includes(post.url)
          )
            links.push(post.url);
        if (links.filter(fresh).length >= most || screen >= SEARCH_SCROLLS || job.stopped()) break;
        if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) break;
        await pause(paced(SCROLL_PACE_MS));
      }
      return links;
    },
    async comments(job: Job, link: string): Promise<readonly string[] | null | JobEnd> {
      await job.tab.open(link);
      await pause(paced(DRAWN_MS));
      const page = await readFollowIn(job.tab, platform);
      const warned = await warnedOn(job, page);
      if (warned) return warned;
      if (page.signedOut) return signedOutEnd(platform);
      const post = page.found.post;
      if (!post) return null;
      // What other people replied: never the post's writer, nor the person.
      return page.found.replies
        .filter(
          (r) =>
            !sameAs(r.author.username, post.author.username) &&
            !sameAs(r.author.username, page.found.me),
        )
        .map((r) => r.text);
    },
  };
}

/** Reads the next batch of comments for the research this person started on Threads or X, if they started one. */
export const readFollowComments = (job: Job, platform: FollowPlatform): Promise<JobEnd> =>
  readCommentsFor(job, followResearch(platform));

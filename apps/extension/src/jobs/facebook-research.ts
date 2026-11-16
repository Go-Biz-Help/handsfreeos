/**
 * **Comment research** on Facebook (docs/outreach.md, decision 172: `comment_research`), read by the research's
 * shared day (./comment-research.ts): a couple of everyday search words HandsFreeOS names a batch (dinner, my dog,
 * road trip, and so on: none about the business), each searched in Facebook's posts as it ranks them (the busiest
 * first, where the comments are), a few posts with comments opened in turn, and the comments each shows read. Never
 * the post writer's own comments, nor the person's.
 *
 * A post's time has no address till it's pointed at, so each screen's times are pointed at first, as Find posts does
 * (./posts.ts `readPointed`, decision 138). Nothing else is pressed: a post's comments are read as its page shows
 * them, with no box of who reacted opened, and nothing is written. It goes at a person's pace and stops for the day on
 * any Facebook warning.
 */
import { profileKey } from '../networks/facebook/urls';
import { readCommentsFor, type ResearchReader } from './comment-research';
import { pause, paced, readIn, warnedOn, type Job, type JobEnd } from './job';
import { facebookPostSearch } from './partner-search';
import { readPointed } from './posts';

/** Screens of a search past its first, for enough posts with comments. */
const SEARCH_SCROLLS = 2;
/** Between one screen of a search and the next. */
const SCROLL_PACE_MS = [4_000, 9_000] as const;

export const FACEBOOK_RESEARCH: ResearchReader = {
  platform: 'facebook',
  where: (words) => `posts about “${words}”`,
  async links(job, words, most, _progress, fresh) {
    await job.tab.open(facebookPostSearch(words));
    const links: string[] = [];
    for (let screen = 0; ; screen++) {
      const page = await readPointed(job);
      const warned = await warnedOn(job, page);
      if (warned) return warned;
      // Posts with comments to read: one showing no count may have some.
      for (const post of page.posts ?? [])
        if (post.url && post.comments !== 0 && !links.includes(post.url)) links.push(post.url);
      if (links.filter(fresh).length >= most || screen >= SEARCH_SCROLLS || job.stopped()) break;
      if (!(await job.tab.ask({ type: 'hfos-scroll-page' })).ok) break;
      await pause(paced(SCROLL_PACE_MS));
    }
    return links;
  },
  async comments(job: Job, link: string): Promise<readonly string[] | null | JobEnd> {
    await job.tab.open(link);
    const page = await readIn(job.tab);
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    if (page.kind !== 'post') return null;
    const writer = page.posts?.[0]?.author?.profile ?? null;
    // Its comments alone: the box of who reacted is never opened.
    const read = await job.tab.ask({ type: 'hfos-engaged', reactions: false });
    if (!read.ok || !('comments' in read)) return null;
    // What other people commented (the reader leaves out the person): never the post's writer.
    return read.comments
      .filter((c) => !writer || profileKey(c.profile) !== profileKey(writer))
      .flatMap((c) => (c.comment ? [c.comment] : []));
  },
};

/** Reads the next batch of comments for the research this person started on Facebook, if they started one. */
export const readFacebookComments = (job: Job): Promise<JobEnd> =>
  readCommentsFor(job, FACEBOOK_RESEARCH);

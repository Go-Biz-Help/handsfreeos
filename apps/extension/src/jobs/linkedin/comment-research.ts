/**
 * **Comment research** on LinkedIn (docs/outreach.md, decision 172: `comment_research`), read by the research's
 * shared day (../comment-research.ts): a couple of work search words HandsFreeOS names a batch (new jobs, wins, tips,
 * hiring, events, asking for a recommendation: what people post about their work, none about the business), each
 * searched as LinkedIn ranks it, a few posts with comments opened in turn, and the comments each shows read. Never the
 * post writer's own comments, nor the person's.
 *
 * LinkedIn's newer post search links no post, so a post's own link comes from its menu's Copy link to post, caught on
 * the page so the person's clipboard is never written to, as Find posts does (./posts.ts `withLinks`, decision 123).
 * That's all it presses: a post's comments are read as its page shows them, with no box of who reacted opened. It
 * goes at a person's pace and stops for the day on any LinkedIn warning.
 */
import { postOf, sameMember } from '../../networks/linkedin/urls';
import { readCommentsFor, type ResearchReader } from '../comment-research';
import { pause, paced, warnedOn, type Job, type JobEnd } from '../job';
import { withLinks } from './posts';
import { readLinkedIn, SCROLL_PACE_MS } from './read';

const LINKEDIN = 'https://www.linkedin.com';
/** Screens of a search past its first, for enough posts with comments. */
const SEARCH_SCROLLS = 2;

/** LinkedIn's post search for some words, as it ranks them: the posts people talk under first. */
export const topPostSearchUrl = (words: string) =>
  `${LINKEDIN}/search/results/content/?keywords=${encodeURIComponent(words)}`;

export const LINKEDIN_RESEARCH = {
  platform: 'linkedin',
  where: (words) => `posts about “${words}”`,
  async links(job, words, most, _progress, fresh) {
    await job.tab.open(topPostSearchUrl(words));
    const known = new Set<string>();
    const links: string[] = [];
    for (let screen = 0; ; screen++) {
      const read = await readLinkedIn(job.tab);
      const warned = await warnedOn(job, read);
      if (warned) return warned;
      const page = await withLinks(job, read, known);
      // Posts with comments to read: one showing no count may have some.
      for (const post of page.posts ?? [])
        if (post.url && post.comments !== 0 && !links.includes(post.url)) links.push(post.url);
      if (links.filter(fresh).length >= most || screen >= SEARCH_SCROLLS || job.stopped()) break;
      if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) break;
      await pause(paced(SCROLL_PACE_MS));
    }
    return links;
  },
  async comments(job: Job, link: string): Promise<readonly string[] | null | JobEnd> {
    await job.tab.open(postOf(link) ?? link);
    const page = await readLinkedIn(job.tab);
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    if (page.kind !== 'post' || !page.posts?.length) return null;
    const writer = page.posts[0]?.author?.profile ?? null;
    // Its comments alone: the box of who reacted is never opened.
    const read = await job.tab.ask({ type: 'hfos-engaged', reactions: false });
    if (!read.ok || !('comments' in read)) return null;
    // What other people commented (the reader leaves out the person): never the post's writer.
    return read.comments
      .filter((c) => !writer || !sameMember(c.profile, writer))
      .flatMap((c) => (c.comment ? [c.comment] : []));
  },
} satisfies ResearchReader;

/** Reads the next batch of comments for the research this person started on LinkedIn, if they started one. */
export const readLinkedInComments = (job: Job): Promise<JobEnd> =>
  readCommentsFor(job, LINKEDIN_RESEARCH);

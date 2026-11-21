/**
 * **Comment research** on Instagram (docs/outreach.md, decision 166: `comment_research`), read by the research's
 * shared day (../comment-research.ts): a couple of everyday hashtags HandsFreeOS names (food, pets, cars, trips, and
 * so on: none about the business) a batch, a few posts on each opened in turn, and the comments each shows read, with
 * its View more comments pressed once. Never the post writer's own comments, nor the person's.
 *
 * Nothing is pressed but a post's View more comments, and nothing is written. A hashtag's grid is drawn only on
 * screen, so it reads with its window in front, only while the person is away from their computer (decision 120), and
 * it stops for the day on any Instagram warning.
 */
import { warnedOn, type Job, type JobEnd } from '../job';
import { pause, paced } from '../job';
import { readCommentsFor, type ResearchReader } from '../comment-research';
import { accountIn } from './checks';
import { tagUrl } from './posts';
import {
  ended,
  gather,
  readInstagramIn,
  SCROLL_PACE_MS,
  signedOutEnd,
  type InstagramPage,
} from './read';

/** While Instagram draws more comments after a press. */
const DRAWN_MS = [2_000, 4_000] as const;
/** Screens of a hashtag's grid past its first, for enough posts to open. */
const GRID_SCROLLS = 3;

/** A warning on the page, or Instagram asking them to sign in: the end of the day's reading. */
async function stopOn(job: Job, page: InstagramPage): Promise<JobEnd | null> {
  return (await warnedOn(job, page)) ?? (page.signedOut ? signedOutEnd() : null);
}

/** A hashtag's posts' links, as its grid shows them. */
const linksOn = (page: InstagramPage): string[] => [
  ...new Set([...(page.found.tag?.posts ?? []), ...page.posts.map((p) => p.url)]),
];

export const INSTAGRAM_RESEARCH: ResearchReader = {
  platform: 'instagram',
  where: (tag) => `#${tag} posts`,
  onScreen: true,
  postPace: SCROLL_PACE_MS,
  async links(job, tag, most, progress, fresh) {
    await job.tab.open(tagUrl(tag));
    const got = await gather(
      job,
      GRID_SCROLLS,
      linksOn,
      (link) => link,
      () => progress,
      (links) => links.filter(fresh).length >= most,
    );
    return ended(got) ? got : got.items;
  },
  async comments(job, link) {
    await job.tab.open(link);
    let page = await readInstagramIn(job.tab);
    const first = await stopOn(job, page);
    if (first) return first;
    // More of its comments, once: never a reply's View replies.
    if ((await job.tab.ask({ type: 'hfos-more-comments' })).ok) {
      await pause(paced(DRAWN_MS));
      page = await readInstagramIn(job.tab);
      const more = await stopOn(job, page);
      if (more) return more;
    }
    const post = page.found.post;
    if (!post) return null;
    // Never the post writer's own comments, nor the person's: what other people typed under it.
    const leftOut = new Set(
      [accountIn(page.own)?.username, post.author?.username].flatMap((u) =>
        u ? [u.toLowerCase()] : [],
      ),
    );
    return post.comments.filter((c) => !leftOut.has(c.username.toLowerCase())).map((c) => c.text);
  },
};

/** Reads the next batch of comments for the research this person started on Instagram, if they started one. */
export const readCommentsForResearch = (job: Job): Promise<JobEnd> =>
  readCommentsFor(job, INSTAGRAM_RESEARCH);

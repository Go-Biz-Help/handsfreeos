/**
 * **Comment research** on Instagram (docs/outreach.md, decision 166: `comment_research`), once a day in batches while
 * it works on its own: HandsFreeOS's own study of how real people comment, started by HandsFreeOS staff from Social
 * Outreach → Settings. Only the browser of whoever started one reads for it; for everyone else HandsFreeOS answers
 * that there's none, and this does nothing.
 *
 * - **Each batch:** a couple of everyday hashtags HandsFreeOS names (food, pets, cars, trips, and so on: none about
 *   the business), a few posts on each opened in turn, and the comments each shows read, with its View more comments
 *   pressed once. Then the next batch later in the day (`again`), until the day's share is read.
 * - **What leaves the browser:** each comment's words alone, sorted here first (core's `sortComments`): never who
 *   wrote it, the post, its caption or its address; no @name, link, email or phone number; and nothing that reads
 *   like a bot's or an advert's. Never the post writer's own comments, nor the person's.
 *
 * Nothing is pressed but a post's View more comments, and nothing is written. It goes at a person's pace, with its
 * window in front only while the person is away from their computer (decision 120), and stops for the day on any
 * Instagram warning.
 */
import { sortComments } from '@hfos/core/addons/outreach/comment-research';
import { counted } from '../../words';
import { onScreen, paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
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

const PLATFORM = 'instagram';
/** Between one hashtag and the next: a person going on to another. */
const TAG_PACE_MS = [20_000, 40_000] as const;
/** While Instagram draws more comments after a press. */
const DRAWN_MS = [2_000, 4_000] as const;
/** Screens of a hashtag's grid past its first, for enough posts to open. */
const GRID_SCROLLS = 3;

/** One post's comments as they leave the browser: the words kept, and how many were left out. */
interface PostComments {
  readonly comments: string[];
  readonly dropped: number;
}

/** A warning on the page, or Instagram asking them to sign in: the end of the day's reading. */
async function stopOn(job: Job, page: InstagramPage): Promise<JobEnd | null> {
  return (await warnedOn(job, page)) ?? (page.signedOut ? signedOutEnd() : null);
}

/** A hashtag's posts' links, as its grid shows them. */
const linksOn = (page: InstagramPage): string[] => [
  ...new Set([...(page.found.tag?.posts ?? []), ...page.posts.map((p) => p.url)]),
];

/**
 * One hashtag's posts, with the tab's window in front (Instagram draws a grid only on screen): a few opened in turn,
 * more of each one's comments shown once, and the comments' words sorted. A post it couldn't read is passed over.
 */
async function readTag(
  job: Job,
  tag: string,
  most: number,
  progress: string,
): Promise<{ readonly posts: PostComments[] } | JobEnd> {
  await job.tab.open(tagUrl(tag));
  const got = await gather(
    job,
    GRID_SCROLLS,
    linksOn,
    (link) => link,
    () => progress,
    (links) => links.length >= most,
  );
  if (ended(got)) return got;
  const posts: PostComments[] = [];
  for (const link of got.items.slice(0, most)) {
    if (job.stopped()) break;
    await pause(paced(SCROLL_PACE_MS));
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
    if (!post) continue;
    // Never the post writer's own comments, nor the person's: what other people typed under it.
    const leftOut = new Set(
      [accountIn(page.own)?.username, post.author?.username].flatMap((u) =>
        u ? [u.toLowerCase()] : [],
      ),
    );
    const sorted = sortComments(
      post.comments.filter((c) => !leftOut.has(c.username.toLowerCase())).map((c) => c.text),
    );
    posts.push({ comments: sorted.kept, dropped: sorted.dropped });
  }
  return { posts };
}

/** Reads the next batch of comments for the research this person started, if they started one, and sends the words. */
export async function readCommentsForResearch(job: Job): Promise<JobEnd> {
  const { research } = valueOf(
    await job.hfos({
      type: 'hfos-comment-research-next',
      input: { workspaceId: job.businessId, platform: PLATFORM },
    }),
  );
  if (!research) return { line: 'No comment research is running.', warned: false };
  const so = (total: number) =>
    `${total.toLocaleString()} of about ${research.target.toLocaleString()} comments kept so far`;
  if (!research.tags.length)
    return {
      line: `Today’s share of the comment research is read: ${so(research.kept)}. It carries on tomorrow.`,
      warned: false,
    };
  let kept = 0;
  let posts = 0;
  let total = research.kept;
  let reading = true;
  const summary = () =>
    `Read the comments under ${counted(posts, 'post')} for the comment research and kept ${counted(kept, 'comment')}’ words: ${so(total)}.`;
  for (const [i, tag] of research.tags.entries()) {
    if (job.stopped()) return { line: `Stopped. ${summary()}`, warned: false };
    if (i > 0) await pause(paced(TAG_PACE_MS));
    const progress = `Comment research: reading the comments under #${tag} posts on Instagram… ${so(total)}.`;
    job.progress(progress);
    const read = await onScreen(job, () => readTag(job, tag, research.postsEach, progress));
    if (ended(read)) return { ...read, line: `${read.line} ${summary()}` };
    const saved = valueOf(
      await job.hfos({
        type: 'hfos-comment-research-save',
        input: { workspaceId: job.businessId, id: research.id, tag, posts: read.posts },
      }),
    );
    posts += read.posts.length;
    kept += saved.kept;
    total = saved.total;
    reading = saved.reading;
    if (!reading) break;
  }
  if (!reading)
    return {
      line: `${summary()} That’s all it set out to read, so the AI sums it up now: see it in Social Outreach → Settings.`,
      warned: false,
    };
  // More of today's share may be left: the next batch goes later today, and HandsFreeOS says when the day's is read.
  return { line: `${summary()} The next batch goes later today.`, warned: false, again: true };
}

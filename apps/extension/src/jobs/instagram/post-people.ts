/**
 * **Who liked and commented** on good posts on Instagram (docs/outreach.md, decision 92: `post_people`), once a day
 * while it works on its own, after the day's hashtags: for a post the AI called good, the people who liked it and who
 * commented on it are found, and each is checked by the AI from their own account before any like or follow
 * (../found-checks.ts). HandsFreeOS says which posts (`outreach.posts.people_next`): the person's own good posts its
 * hashtags and places found in the last week, one asking for what the business offers first, then the most comments
 * and likes, then the newest; 5 a day, and none while the people found already wait for their checks.
 *
 * - **Each post:** its own page, with its window in front; its View all comments (or Load more comments) pressed once,
 *   and who commented read with what they said (HandsFreeOS keeps it only till the AI's check reads it); then its
 *   Likes box opened by its count of likes, as a person opens it, up to 3 screens of who liked it read (decision 116,
 *   about 45) with whether the person follows them, and the box closed again by its own Close.
 * - **Never** the person, the post's writer, or anyone the person follows (the Likes box's own buttons say so);
 *   HandsFreeOS leaves out anyone else they follow or who follows them, their customers, and anyone left alone.
 *
 * Each post's people go to HandsFreeOS (`outreach.finds.save`): its commenters even when it showed none, so the post
 * counts as read, then its likers. Nothing is pressed but the post's View all comments, its count of likes and the
 * box's Close, and nothing is written. It goes at a person's pace, 20 to 40 seconds between posts, and stops for the
 * day on any Instagram warning, in the Likes box too. A post it couldn't read, or whose Likes box didn't open, is noted
 * with the page's outline (decision 74), once a day each.
 */
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import type { PostsPeopleNext } from '../../hfos/messages';
import { findsSave, type FoundPerson } from '../../hfos/saves';
import type { Account } from '../../networks/instagram/read';
import { counted } from '../../words';
import { onScreen, paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { accountIn } from './checks';
import { ended, gather, readInstagramIn, signedOutEnd, type InstagramPage } from './read';

const PLATFORM = 'instagram';
/** Between one post and the next: a person going on to another post. */
const POST_PACE_MS = [20_000, 40_000] as const;
/** While Instagram draws what a press opened: more comments, or the Likes box. */
const DRAWN_MS = [2_000, 4_000] as const;
/** Screens of the Likes box past its first: 3 in all, about 45 people (decision 116). Never further. */
const LIKES_SCROLLS = 2;
/** Of who liked a post, the most it reads. */
export const LIKERS_MOST = 45;

type Post = PostsPeopleNext['posts'][number];

/** A post's people, read: who commented (with what they said) and who liked it, without anyone left out. */
interface PostPeople {
  readonly commented: readonly FoundPerson[];
  readonly liked: readonly FoundPerson[];
}

/** Someone as HandsFreeOS keeps a find: their account, the name shown (else their username), and what they said. */
const foundOf = (account: Account, name: string | null, said?: string): FoundPerson => ({
  name: name?.trim() || account.username,
  profile: { id: null, username: account.username, url: account.url },
  ...(said === undefined ? {} : { said: said.trim() || null }),
});

/** A warning on the page, or Instagram asking them to sign in: the end of the day's reading. */
async function stopOn(job: Job, page: InstagramPage): Promise<JobEnd | null> {
  return (await warnedOn(job, page)) ?? (page.signedOut ? signedOutEnd() : null);
}

/**
 * One good post's people, with the tab's window in front (Instagram draws a box's rows only on screen): its
 * commenters, with View all comments pressed once, then who liked it, in its Likes box opened and closed again.
 */
async function readPost(
  job: Job,
  post: Post,
  note: (kind: string, words: string, found: Record<string, number>) => Promise<void>,
): Promise<PostPeople | JobEnd> {
  await job.tab.open(post.url);
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
  const shown = page.found.post;
  if (!shown) await note('post', 'Couldn’t read the post.', { post: 0 });
  // Never the person, nor the post's writer.
  const leftOut = new Set(
    [
      accountIn(page.own)?.username,
      shown?.author?.username,
      accountIn(post.profileUrl)?.username,
    ].flatMap((u) => (u ? [u.toLowerCase()] : [])),
  );
  const commented = (shown?.comments ?? [])
    .filter((c) => !leftOut.has(c.username.toLowerCase()))
    .map((c) => foundOf(c, null, c.text));
  // Who liked it, in its Likes box: a screen or two, never anyone the person follows.
  if (!(await job.tab.ask({ type: 'hfos-open-likers' })).ok) {
    if (post.reactions !== 0)
      await note('likers', 'Couldn’t open the post’s Likes box.', { likers: 0 });
    return { commented, liked: [] };
  }
  await pause(paced(DRAWN_MS));
  const got = await gather(
    job,
    LIKES_SCROLLS,
    (p) => p.found.likers,
    (liker) => liker.username.toLowerCase(),
    (n) => `Reading who liked ${post.name}’s post… ${counted(n, 'person', 'people')} so far.`,
    (likers) => likers.length >= LIKERS_MOST,
  );
  if (ended(got)) return got;
  if (!got.items.length)
    await note('likers', 'Nobody read in the post’s Likes box.', { likers: 0 });
  await job.tab.ask({ type: 'hfos-close-dialog' });
  const liked = got.items
    .filter(
      (l) =>
        !leftOut.has(l.username.toLowerCase()) &&
        l.following !== 'following' &&
        l.following !== 'requested',
    )
    .slice(0, LIKERS_MOST)
    .map((l) => foundOf(l, l.name));
  return { commented, liked };
}

/**
 * Sends a post's people to HandsFreeOS: how many it kept to check, or null when it no longer keeps the post (it's had
 * its people read, or was set aside), so it's passed over.
 */
async function savePeople(job: Job, post: Post, people: PostPeople): Promise<number | null> {
  let added = 0;
  for (const [how, found] of [
    ['commented', people.commented],
    ['liked', people.liked],
  ] as const) {
    // Its commenters go even when there are none, so the post counts as read; its likers only when there are some.
    if (how === 'liked' && !found.length) continue;
    const built = findsSave(found, how, PLATFORM, job.businessId, { postId: post.postId });
    if (!built.ok) continue;
    for (const input of built.input) {
      const saved = await job.hfos({ type: 'hfos-finds-save', input });
      if (!saved.ok && saved.problem.rule === 'outreach_find_post') return null;
      added += valueOf(saved).added;
    }
  }
  return added;
}

/** How it went, in words for the person. */
function summary(read: number, added: number): string {
  return `Read who liked and commented on ${counted(read, 'good post')} on Instagram: ${counted(added, 'new person', 'new people')} to check for good fits.`;
}

/** The line when there's no post to read: today's all read, or none waits (or the people found wait first). */
function noneLine(next: PostsPeopleNext): string {
  const name = NETWORKS.instagram.name;
  if (next.perDay > 0 && next.today >= next.perDay)
    return `That’s today’s ${next.perDay.toLocaleString()} good posts on ${name}. It carries on tomorrow.`;
  return `No good post on ${name} waits for who liked and commented on it, or the people found wait for their checks first.`;
}

/** Reads who liked and commented on the next good posts on Instagram, as HandsFreeOS lists them, and sends them. */
export async function readPostPeople(job: Job): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS which good posts to read who liked and commented on…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-posts-people-next',
      input: { workspaceId: job.businessId, platform: PLATFORM },
    }),
  );
  if (!next.posts.length) return { line: noneLine(next), warned: false };
  const noted = new Set<string>();
  const note = async (kind: string, words: string, found: Record<string, number>) => {
    if (noted.has(kind)) return;
    noted.add(kind);
    await job.report?.({ job: `post_people.${kind}`, note: words, found, outline: true });
  };
  let read = 0;
  let added = 0;
  for (const [i, post] of next.posts.entries()) {
    if (job.stopped()) return { line: `Stopped. ${summary(read, added)}`, warned: false };
    if (i > 0) await pause(paced(POST_PACE_MS));
    job.progress(
      `${i + 1} of ${next.posts.length}: reading who liked and commented on ${post.name}’s post…`,
    );
    const look = () => readPost(job, post, note);
    const people = await onScreen(job, look);
    if (ended(people)) return { ...people, line: `${people.line} ${summary(read, added)}` };
    const kept = await savePeople(job, post, people);
    if (kept === null) continue;
    read++;
    added += kept;
  }
  return { line: `Done. ${summary(read, added)}`, warned: false };
}

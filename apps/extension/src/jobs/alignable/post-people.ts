/**
 * **Who liked and answered** good posts on Alignable (docs/outreach.md, decision 116: `post_people`, the owner's pick
 * 34a: "It reads up to 3 screens of a Likes box, and Alignable likers."), once a day while it works on its own, after
 * its town's and its groups' posts are read: for a post the AI called good, the businesses that answered it and that
 * liked it are found, and each is checked by the AI from its own page before any like or connection
 * (../found-checks.ts). HandsFreeOS says which posts (`outreach.posts.people_next`): the person's own good posts found
 * in the last week, one asking for what the business offers first, then the most answers and likes, then the newest;
 * 5 a day, and none while the businesses found already wait for their checks.
 *
 * - **Each post:** its own page (a discussion's), where its answers are read with what they said (HandsFreeOS keeps it
 *   only till the AI's check reads it); then its box of who liked it opened by its count of likes, as a person opens
 *   it, up to 3 screens of it read (about 45), and the box closed again by its own Close (../../networks/alignable/
 *   likers.ts, from guessed markup till the owner's next Check Alignable).
 * - **Never** the person's own business, which their own profile names (opened first), nor the post's writer;
 *   HandsFreeOS leaves out their connections, their customers, and anyone left alone.
 *
 * Each post's people go to HandsFreeOS (`outreach.finds.save`): who answered even when nobody did, so the post counts
 * as read, then who liked it. Nothing is pressed but the post's count of likes, the box's Close and its own Show more,
 * and nothing is written. It goes at a person's pace, 20 to 40 seconds between posts, and stops for the day on any
 * Alignable warning, in the box too. A post it couldn't read, or whose box didn't open, is noted with the page's
 * outline (decision 74), once a day each.
 */
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import type { PostsPeopleNext } from '../../hfos/messages';
import { findsSave, type FoundPerson } from '../../hfos/saves';
import { ALIGNABLE_LIKERS_MOST } from '../../networks/alignable/likers';
import type { Named } from '../../networks/facebook/types';
import { counted } from '../../words';
import { onScreen, paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { DRAWN_MS } from './posts';
import {
  ended,
  gather,
  mine,
  notMine,
  readAlignableIn,
  signedOutEnd,
  type AlignablePage,
} from './read';

const PLATFORM = 'alignable';
/** Between one post and the next: a person going on to another post. */
const POST_PACE_MS = [20_000, 40_000] as const;
/** Screens of the box of who liked a post past its first: 3 in all (decision 116). Never further. */
const LIKES_SCROLLS = 2;

type Post = PostsPeopleNext['posts'][number];

/** A post's people, read: who answered (with what they said) and who liked it, without anyone left out. */
interface PostPeople {
  readonly commented: readonly FoundPerson[];
  readonly liked: readonly FoundPerson[];
}

/** A warning on the page, or Alignable asking them to sign in: the end of the day's reading. */
async function stopOn(job: Job, page: AlignablePage): Promise<JobEnd | null> {
  return (await warnedOn(job, page)) ?? (page.signedOut ? signedOutEnd() : null);
}

/** One good post's people, on its own page: who answered it, then who liked it, in its box opened and closed again. */
async function readPost(
  job: Job,
  post: Post,
  someoneElse: (profile: { readonly url: string }) => boolean,
  note: (kind: string, words: string, found: Record<string, number>) => Promise<void>,
): Promise<PostPeople | JobEnd> {
  await job.tab.open(post.url);
  await pause(DRAWN_MS);
  const page = await readAlignableIn(job.tab);
  const first = await stopOn(job, page);
  if (first) return first;
  const shown = page.found.threads[0];
  if (!shown) await note('post', 'Couldn’t read the post.', { post: 0 });
  // Never the person, nor the post's writer.
  const writer = shown?.author?.profile?.url ?? post.profileUrl;
  const keep = (who: Named | null): FoundPerson | null =>
    who?.profile && someoneElse(who.profile) && who.profile.url !== writer
      ? { name: who.name, profile: who.profile }
      : null;
  const commented = page.found.answers.flatMap((a) => {
    const who = keep(a.author);
    return who ? [{ ...who, said: a.text.trim() || null }] : [];
  });
  // Who liked it, in its box: up to 3 screens.
  if (!(await job.tab.ask({ type: 'hfos-open-likers' })).ok) {
    if (post.reactions !== 0)
      await note('likers', 'Couldn’t open the post’s box of who liked it.', { likers: 0 });
    return { commented, liked: [] };
  }
  await pause(paced([2_000, 4_000]));
  const got = await gather(
    job,
    LIKES_SCROLLS,
    (p) => p.found.likers ?? [],
    (liker) => liker.profile?.url ?? liker.name,
    (n) => `Reading who liked ${post.name}’s post… ${counted(n, 'business', 'businesses')} so far.`,
  );
  if (ended(got)) return got;
  if (!got.items.length)
    await note('likers', 'Nobody read in the post’s box of who liked it.', { likers: 0 });
  await job.tab.ask({ type: 'hfos-close-dialog' });
  const liked = got.items.flatMap((l) => keep(l) ?? []).slice(0, ALIGNABLE_LIKERS_MOST);
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
    // Who answered goes even when nobody did, so the post counts as read; who liked it only when somebody did.
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
  return `Read who liked and answered ${counted(read, 'good post')} on Alignable: ${counted(added, 'new business', 'new businesses')} to check for good fits.`;
}

/** The line when there's no post to read: today's all read, or none waits (or the businesses found wait first). */
function noneLine(next: PostsPeopleNext): string {
  const name = NETWORKS.alignable.name;
  if (next.perDay > 0 && next.today >= next.perDay)
    return `That’s today’s ${next.perDay.toLocaleString()} good posts on ${name}. It carries on tomorrow.`;
  return `No good post on ${name} waits for who liked and answered it, or the businesses found wait for their checks first.`;
}

/** Reads who liked and answered the next good posts on Alignable, as HandsFreeOS lists them, and sends them. */
export async function readAlignablePostPeople(job: Job): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS which good posts to read who liked and answered…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-posts-people-next',
      input: { workspaceId: job.businessId, platform: PLATFORM },
    }),
  );
  if (!next.posts.length) return { line: noneLine(next), warned: false };
  // Never their own business, which their own profile names.
  const own = await mine(job);
  if (ended(own)) return own;
  const someoneElse = notMine(own.business);
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
      `${i + 1} of ${next.posts.length}: reading who liked and answered ${post.name}’s post…`,
    );
    const look = () => readPost(job, post, someoneElse, note);
    const people = await onScreen(job, look);
    if (ended(people)) return { ...people, line: `${people.line} ${summary(read, added)}` };
    const kept = await savePeople(job, post, people);
    if (kept === null) continue;
    read++;
    added += kept;
  }
  return { line: `Done. ${summary(read, added)}`, warned: false };
}

/**
 * **Who replied** to good posts on Threads and X (decision 163's 6a, as decision 92's `post_people`), once a day while
 * it works on its own, after the hourly searches found some: for a post the AI called good, the people who replied to
 * it are found, and each is checked by the AI from their own profile (../found-checks.ts) before any like, reply or
 * follow. HandsFreeOS says which posts (`outreach.posts.people_next`): 5 a day, none while the people found already wait
 * for their checks.
 *
 * Each post's own page is opened and read once, its replies with what they say (HandsFreeOS keeps that only till the AI's
 * check reads it), never the person or the post's writer. Who liked a post isn't read: neither network lists it to
 * everyone. Nothing is pressed or written. It goes at a person's pace and stops for the day on any warning. A post it
 * couldn't read is noted with the page's outline (decision 74), once a day.
 */
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import type { PostsPeopleNext } from '../../hfos/messages';
import { findsSave, type FoundPerson } from '../../hfos/saves';
import type { FollowPlatform } from '../../networks/follows/types';
import { counted } from '../../words';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { accountIn, readFollowIn, sameAs, signedOutEnd } from './read';

/** Between one post and the next: a person going on to another post. */
const POST_PACE_MS = [20_000, 40_000] as const;
/** For a post's replies to draw under it. */
const DRAWN_MS = [2_500, 4_000] as const;
/** Of who replied to a post, the most it keeps. */
export const REPLIERS_MOST = 30;

type Post = PostsPeopleNext['posts'][number];

/** One good post's repliers, read off its own page, or the job's end on a warning or a sign-in. */
async function repliersOf(
  job: Job,
  platform: FollowPlatform,
  post: Post,
  note: (words: string) => Promise<void>,
): Promise<FoundPerson[] | JobEnd> {
  await job.tab.open(post.url);
  await pause(paced(DRAWN_MS));
  const page = await readFollowIn(job.tab, platform);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd(platform);
  const shown = page.found.post;
  if (!shown) await note('Couldn’t read the post.');
  const writer = shown?.author.username ?? accountIn(platform, post.profileUrl)?.username ?? null;
  const seen = new Set<string>();
  return page.found.replies
    .filter((r) => !sameAs(r.author.username, page.found.me) && !sameAs(r.author.username, writer))
    .filter((r) => {
      const key = r.author.username.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, REPLIERS_MOST)
    .map((r) => ({
      name: r.name?.trim() || r.author.username,
      profile: { id: null, username: r.author.username, url: r.author.url },
      said: r.text.trim() || null,
    }));
}

/** Sends a post's repliers: how many were kept to check, or null when HandsFreeOS no longer keeps the post. */
async function savePeople(
  job: Job,
  platform: FollowPlatform,
  post: Post,
  found: readonly FoundPerson[],
): Promise<number | null> {
  const built = findsSave(found, 'commented', platform, job.businessId, { postId: post.postId });
  if (!built.ok) return 0;
  let added = 0;
  for (const input of built.input) {
    const saved = await job.hfos({ type: 'hfos-finds-save', input });
    if (!saved.ok && saved.problem.rule === 'outreach_find_post') return null;
    added += valueOf(saved).added;
  }
  return added;
}

function summary(platform: FollowPlatform, read: number, added: number): string {
  return `Read who replied to ${counted(read, 'good post')} on ${NETWORKS[platform].name}: ${counted(added, 'new person', 'new people')} to check for good fits.`;
}

function noneLine(platform: FollowPlatform, next: PostsPeopleNext): string {
  const name = NETWORKS[platform].name;
  if (next.perDay > 0 && next.today >= next.perDay)
    return `That’s today’s ${next.perDay.toLocaleString()} good posts on ${name}. It carries on tomorrow.`;
  return `No good post on ${name} waits for who replied to it, or the people found wait for their checks first.`;
}

/** Reads who replied to the next good posts on the network, as HandsFreeOS lists them, and sends them. */
export async function readPostRepliers(job: Job, platform: FollowPlatform): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS which good posts to read who replied to…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-posts-people-next',
      input: { workspaceId: job.businessId, platform },
    }),
  );
  if (!next.posts.length) return { line: noneLine(platform, next), warned: false };
  let noted = false;
  const note = async (words: string) => {
    if (noted) return;
    noted = true;
    await job.report?.({ job: 'post_people.post', note: words, found: { post: 0 }, outline: true });
  };
  let read = 0;
  let added = 0;
  for (const [i, post] of next.posts.entries()) {
    if (job.stopped()) return { line: `Stopped. ${summary(platform, read, added)}`, warned: false };
    if (i > 0) await pause(paced(POST_PACE_MS));
    job.progress(`${i + 1} of ${next.posts.length}: reading who replied to ${post.name}’s post…`);
    const people = await repliersOf(job, platform, post, note);
    if (!Array.isArray(people))
      return { ...people, line: `${people.line} ${summary(platform, read, added)}` };
    const kept = await savePeople(job, platform, post, people);
    if (kept === null) continue;
    read++;
    added += kept;
  }
  return { line: `Done. ${summary(platform, read, added)}`, warned: false };
}

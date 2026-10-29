/**
 * **Accounts like yours** on Instagram (docs/outreach.md, decision 110: `like_yours`), once a day while it works on its
 * own, after the day's hashtags: accounts whose followers and commenters are the business's own kind of customer, a
 * chamber, a venue or a business with the same customers, up to 5 kept by the AI or the person (Settings → Instagram →
 * Accounts like yours). HandsFreeOS says what to do (`outreach.like_yours.next`):
 *
 * - **Searches**, while fewer than 5 are kept and none were looked for this week: Instagram's search for each of the
 *   words HandsFreeOS gives (the area's chamber of commerce, its events, a kind of business with the same customers,
 *   the niche there), a few screens of the accounts it shows, all sent for the AI to pick from
 *   (`outreach.like_yours.found`). Nothing is followed.
 * - **One kept account a day**, the one read longest ago: its latest 3 posts opened in turn and sent for the AI's check
 *   as found by it (`account`), so who liked and commented on them is read by `post_people` whatever the AI says of
 *   the post; then the box of its followers opened by its count of followers, as a person opens it, and up to 25 read,
 *   sent as people found who follow it (`follows`), each checked by the AI from their own account before any like or
 *   follow (../found-checks.ts). Never the person, the account itself, or anyone the person follows already.
 *
 * Nothing is pressed but the account's count of followers and the box's Close, and nothing is written. It goes at a
 * person's pace and stops for the day on any Instagram warning. An account whose followers' box didn't open is noted
 * with the page's outline (decision 74), once a day.
 */
import {
  LIKE_YOURS_FOLLOWERS,
  LIKE_YOURS_FOUND_MOST,
  LIKE_YOURS_POSTS,
} from '@hfos/core/addons/outreach/like-yours';
import type { LikeYoursNext } from '../../hfos/messages';
import { findsSave, instagramPostsSave, type FoundPerson } from '../../hfos/saves';
import type { InstagramPost } from '../../networks/instagram/read';
import { counted } from '../../words';
import { paced, pause, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import { accountIn } from './checks';
import { accountsFound, SEARCH_SCREENS, searchUrl } from './partner-search';
import {
  ended,
  gather,
  readInstagramIn,
  SCROLL_PACE_MS,
  signedOutEnd,
  type InstagramPage,
} from './read';

const PLATFORM = 'instagram';
/** Between one search, or one post, and the next: a person going on. */
const STEP_PACE_MS = [20_000, 40_000] as const;
/** For Instagram to draw the box of followers over the account, and its first rows. */
const BOX_MS = 2_500;
/** How many times the box is looked for before it's taken as not there. */
const BOX_LOOKS = 4;
/** Looks for the box before the account's count of followers is pressed to open it. */
const PRESS_AFTER = 2;
/** Screens of the followers' box past its first: about 25 people, never further. */
const FOLLOWER_SCROLLS = 2;

type Account = NonNullable<LikeYoursNext['account']>;

/** A count, or the end of the day's reading. */
const isEnd = (got: number | JobEnd): got is JobEnd => typeof got !== 'number';

/** A warning on the page, or Instagram asking them to sign in: the end of the day's reading. */
async function stopOn(job: Job, page: InstagramPage): Promise<JobEnd | null> {
  return (await warnedOn(job, page)) ?? (page.signedOut ? signedOutEnd() : null);
}

/** The accounts each search showed, each once with the words that first showed it: never the person's own. */
async function search(job: Job, searches: readonly string[]): Promise<number | JobEnd> {
  const found = new Map<string, { username: string; name: null; words: string }>();
  for (const [i, words] of searches.entries()) {
    if (job.stopped() || found.size >= LIKE_YOURS_FOUND_MOST) break;
    if (i > 0) await pause(paced(STEP_PACE_MS));
    job.progress(`Searching Instagram for accounts like yours: “${words}”…`);
    await job.tab.open(searchUrl(words));
    const got = await gather(
      job,
      SEARCH_SCREENS - 1,
      accountsFound,
      (f) => (f.profile.username ?? f.profile.url).toLowerCase(),
      (n) => `Reading Instagram’s accounts for “${words}”… ${counted(n, 'account')} so far.`,
    );
    if (ended(got)) return got;
    const own = accountIn(got.page.own)?.username.toLowerCase();
    for (const f of got.items) {
      const username = f.profile.username?.toLowerCase();
      if (!username || username === own || found.has(username)) continue;
      found.set(username, { username, name: null, words });
    }
  }
  if (!found.size) return 0;
  const saved = valueOf(
    await job.hfos({
      type: 'hfos-like-yours-found',
      input: {
        workspaceId: job.businessId,
        platform: PLATFORM,
        accounts: [...found.values()].slice(0, LIKE_YOURS_FOUND_MOST),
      },
    }),
  );
  return saved.candidates;
}

/** The account's latest posts, opened in turn and sent for the AI's check as found by it. How many it sent. */
async function readPosts(
  job: Job,
  account: Account,
  posts: readonly string[],
): Promise<number | JobEnd> {
  const read: InstagramPost[] = [];
  for (const url of posts.slice(0, LIKE_YOURS_POSTS)) {
    if (job.stopped()) break;
    await pause(paced(SCROLL_PACE_MS));
    await job.tab.open(url);
    const page = await readInstagramIn(job.tab);
    const stop = await stopOn(job, page);
    if (stop) return stop;
    const post = page.found.post;
    if (post?.author?.username.toLowerCase() === account.username) read.push(post);
  }
  const built = instagramPostsSave(read, job.businessId, `@${account.username}`, 'account');
  if (!built.ok) return 0;
  return valueOf(await job.hfos({ type: 'hfos-save-posts', input: built.input })).checking;
}

/**
 * The account's followers, in the box over its page opened by its count of followers: up to 25, never the person,
 * the account itself or anyone the person follows already. Sent as people found who follow it; how many were new.
 */
async function readFollowers(
  job: Job,
  account: Account,
  note: (words: string) => Promise<void>,
): Promise<number | JobEnd> {
  await job.tab.open(`${account.url.replace(/\/?$/, '/')}followers/`);
  let page: InstagramPage | null = null;
  for (let look = 0; look < BOX_LOOKS; look++) {
    await pause(BOX_MS);
    page = await readInstagramIn(job.tab);
    const stop = await stopOn(job, page);
    if (stop) return stop;
    if (page.found.followers.length) break;
    if (look === PRESS_AFTER - 1) await job.tab.ask({ type: 'hfos-open-their-followers' });
  }
  if (!page?.found.followers.length) {
    await note('Couldn’t open the account’s followers.');
    return 0;
  }
  const got = await gather(
    job,
    FOLLOWER_SCROLLS,
    (p) => p.found.followers,
    (f) => f.username.toLowerCase(),
    (n) => `Reading who follows @${account.username}… ${counted(n, 'person', 'people')} so far.`,
    (items) => items.length >= LIKE_YOURS_FOLLOWERS,
  );
  if (ended(got)) return got;
  await job.tab.ask({ type: 'hfos-close-dialog' });
  const own = accountIn(got.page.own)?.username.toLowerCase();
  const found: FoundPerson[] = got.items
    .filter((f) => {
      const username = f.username.toLowerCase();
      // On another account's followers, a row's Following says the person follows them already.
      return username !== own && username !== account.username && f.followBack !== true;
    })
    .slice(0, LIKE_YOURS_FOLLOWERS)
    .map((f) => ({
      name: f.name?.trim() || f.username,
      profile: { id: null, username: f.username, url: f.url },
    }));
  if (!found.length) return 0;
  const built = findsSave(found, 'follows', PLATFORM, job.businessId, {
    words: `@${account.username}`,
  });
  if (!built.ok) return 0;
  let added = 0;
  for (const input of built.input)
    added += valueOf(await job.hfos({ type: 'hfos-finds-save', input })).added;
  return added;
}

/** One kept account read: its posts, then its followers, with its window in front, then marked read. */
async function readAccount(
  job: Job,
  account: Account,
  note: (words: string) => Promise<void>,
): Promise<{ posts: number; people: number } | JobEnd> {
  await job.tab.open(account.url);
  const home = await readInstagramIn(job.tab);
  const stop = await stopOn(job, home);
  if (stop) return stop;
  const posts = await readPosts(job, account, home.found.profile?.posts ?? []);
  if (isEnd(posts)) return posts;
  if (job.stopped()) return { posts, people: 0 };
  await pause(paced(STEP_PACE_MS));
  const people = await readFollowers(job, account, note);
  if (isEnd(people)) return people;
  await job.hfos({
    type: 'hfos-like-yours-read',
    input: { workspaceId: job.businessId, id: account.id },
  });
  return { posts, people };
}

/** The day's accounts like yours: searched for while there's room, and one kept account read. */
export async function readLikeYours(job: Job): Promise<JobEnd> {
  job.progress('Asking HandsFreeOS about accounts like yours on Instagram…');
  const next = valueOf(
    await job.hfos({
      type: 'hfos-like-yours-next',
      input: { workspaceId: job.businessId, platform: PLATFORM },
    }),
  );
  if (!next.searches.length && !next.account)
    return {
      line: 'No account like yours to read on Instagram today. Add some in Settings → Instagram → Accounts like yours, or add your area to a playbook so the AI finds some.',
      warned: false,
    };
  const lines: string[] = [];
  if (next.searches.length) {
    const found = await search(job, next.searches);
    if (isEnd(found)) return found;
    lines.push(
      found
        ? `Found ${counted(found, 'account')} like yours on Instagram for the AI to pick from.`
        : 'Instagram’s search showed no new accounts like yours.',
    );
  }
  if (next.account && !job.stopped()) {
    const account = next.account;
    let noted = false;
    const note = async (words: string) => {
      if (noted) return;
      noted = true;
      await job.report?.({
        job: 'like_yours.followers',
        note: words,
        found: { followers: 0 },
        outline: true,
      });
    };
    if (next.searches.length) await pause(paced(STEP_PACE_MS));
    job.progress(`Reading @${account.username}, an account like yours on Instagram…`);
    const look = () => readAccount(job, account, note);
    const read = await (job.tab.inFront ? job.tab.inFront(look) : look());
    if (ended(read)) return { ...read, line: [read.line, ...lines].join(' ') };
    lines.push(
      `Read @${account.username}: ${counted(read.posts, 'post')} sent to check, ${counted(read.people, 'new person', 'new people')} from its followers to check for good fits.`,
    );
  }
  return { line: `${job.stopped() ? 'Stopped. ' : 'Done. '}${lines.join(' ')}`, warned: false };
}

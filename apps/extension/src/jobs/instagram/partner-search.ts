/**
 * Instagram's searches for partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 6d; ../partner-search.ts), the
 * start of Find partners there each day (../partners.ts), as LinkedIn's and Alignable's are: Instagram's search for the
 * partner playbooks' words (/explore/search/keyword/?q=, as Check Instagram opens it), a few screens of it. For
 * creators, whoever posted what it shows, by the name each post's own link carries (/<name>/p/<code>/), else by opening
 * a few of those posts, one at a time at a person's pace, and then the same on the hashtag of the words (part 15:
 * "local businesses" is #localbusinesses); for businesses with the same customers, the accounts it shows, and once a
 * run the accounts Instagram suggests to the person (/explore/people/), which are often like theirs. Each is kept by
 * the name in its address; how many follow them is read when they're read for the partner check. Nothing is pressed but
 * the page's own scrolling; it stops on any Instagram warning.
 */
import type { PartnerSearchKind } from '@hfos/core/addons/outreach/partners';
import { hashtagOf } from '@hfos/core/addons/outreach/posts';
import type { Found } from '../../hfos/saves';
import type { Account } from '../../networks/instagram/read';
import { profileOf } from '../../networks/instagram/urls';
import { counted } from '../../words';
import { pause, paced, warnedOn, type Job, type JobEnd } from '../job';
import {
  ended,
  gather,
  INSTAGRAM,
  readInstagramIn,
  SCROLL_PACE_MS,
  signedOutEnd,
  type InstagramPage,
} from './read';
import { tagUrl } from './posts';

/** Instagram's search for some words, as Check Instagram opens it. */
export const searchUrl = (words: string) =>
  `${INSTAGRAM}/explore/search/keyword/?q=${encodeURIComponent(words)}`;
/** Screens of a search it reads. */
export const SEARCH_SCREENS = 3;
/** Posts it opens to see who posted them, when the search's own links don't say. */
export const POSTS_OPENED = 4;

/** Someone a search showed, as a partner search keeps them: by the name in their address. */
const found = (account: Account): Found => ({
  name: account.username,
  profile: { id: null, username: account.username, url: account.url },
  lines: [],
  followers: null,
});

const keyOf = (f: Found) => (f.profile.username ?? f.profile.url).toLowerCase();

/** Whoever posted what a page shows, by the name each post's own link carries. */
export const authorsFound = (page: InstagramPage): Found[] =>
  page.found.authors.map(({ author }) => found(author));

/** The accounts a page links to, as a search shows them: never the person's own. */
export function accountsFound(page: InstagramPage): Found[] {
  return page.people.flatMap(({ url }) => {
    const account = profileOf(new URL(url));
    return account ? [found(account)] : [];
  });
}

/**
 * Who posted the posts a page shows whose links don't name them: each opened in turn, at a person's pace, up to
 * `most`. A warning, or a page asking them to sign in, ends it.
 */
export async function postersOf(
  job: Job,
  posts: readonly string[],
  most: number,
): Promise<Found[] | JobEnd> {
  const out: Found[] = [];
  for (const [i, url] of posts.slice(0, most).entries()) {
    if (job.stopped()) break;
    if (i > 0) await pause(paced(SCROLL_PACE_MS));
    await job.tab.open(url);
    const page = await readInstagramIn(job.tab);
    const warned = await warnedOn(job, page);
    if (warned) return warned;
    if (page.signedOut) return signedOutEnd();
    const author = page.found.post?.author;
    if (author) out.push(found(author));
  }
  return out;
}

/**
 * Reads a page of posts a screen at a time (a search's, a hashtag's or a place's), keeping whoever posted them: by
 * their posts' own links, then a few posts opened for those that don't say.
 */
export async function postersOn(
  job: Job,
  url: string,
  what: string,
): Promise<readonly Found[] | JobEnd> {
  await job.tab.open(url);
  const unnamed = new Set<string>();
  const got = await gather(
    job,
    SEARCH_SCREENS - 1,
    (page) => {
      const named = new Set(page.found.authors.map((a) => a.post));
      for (const { url: post } of page.posts) if (!named.has(post)) unnamed.add(post);
      return authorsFound(page);
    },
    keyOf,
    (n) => `Reading Instagram’s posts for ${what}… ${counted(n, 'account')} so far.`,
  );
  if (ended(got)) return got;
  const items = new Map(got.items.map((f) => [keyOf(f), f]));
  if (unnamed.size && !job.stopped()) {
    const opened = await postersOf(job, [...unnamed], POSTS_OPENED);
    if (ended(opened)) return opened;
    for (const f of opened) if (!items.has(keyOf(f))) items.set(keyOf(f), f);
  }
  return [...items.values()];
}

/** The accounts Instagram suggests to the person: read once a run, its first screen. */
export const SUGGESTED = `${INSTAGRAM}/explore/people/`;
const suggestedIn = new WeakSet<Job>();

/** Each once, by the name in their address, the first found first. */
function eachOnce(found: readonly Found[]): Found[] {
  const once = new Map<string, Found>();
  for (const f of found) if (!once.has(keyOf(f))) once.set(keyOf(f), f);
  return [...once.values()];
}

/**
 * One of Instagram's searches: for creators whoever posted what it showed, then what the hashtag of its words shows;
 * for businesses the accounts it showed, then, the first time in a run, the accounts Instagram suggests.
 */
export async function searchInstagram(
  job: Job,
  kind: PartnerSearchKind,
  words: string,
): Promise<readonly Found[] | JobEnd> {
  if (kind === 'creator') {
    const searched = await postersOn(job, searchUrl(words), `“${words}”`);
    const tag = hashtagOf(words);
    if (ended(searched) || !tag || job.stopped()) return searched;
    await pause(paced(SCROLL_PACE_MS));
    let tagged: readonly Found[] | JobEnd;
    try {
      tagged = await postersOn(job, tagUrl(tag), `#${tag}`);
    } catch {
      // Instagram went elsewhere: the search's own posters still count.
      return searched;
    }
    return ended(tagged) ? tagged : eachOnce([...searched, ...tagged]);
  }
  await job.tab.open(searchUrl(words));
  const got = await gather(
    job,
    SEARCH_SCREENS - 1,
    accountsFound,
    keyOf,
    (n) => `Reading Instagram’s accounts for “${words}”… ${counted(n, 'account')} so far.`,
  );
  if (ended(got)) return got;
  if (suggestedIn.has(job) || job.stopped()) return got.items;
  suggestedIn.add(job);
  await pause(paced(SCROLL_PACE_MS));
  job.progress('Reading the accounts Instagram suggests to you…');
  let page: InstagramPage;
  try {
    await job.tab.open(SUGGESTED);
    page = await readInstagramIn(job.tab);
  } catch {
    // Instagram went elsewhere: the search's own accounts still count.
    return got.items;
  }
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd();
  return eachOnce([...got.items, ...accountsFound(page)]);
}

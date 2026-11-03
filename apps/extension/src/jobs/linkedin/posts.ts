/**
 * **Find posts** on LinkedIn (docs/outreach.md, decision 49; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Where
 * the people are", 3): its groups are quiet, so it searches LinkedIn's posts with the playbooks' own words
 * (HandsFreeOS picks them: the quoted words in their signs, then their words for groups), the latest first, a few
 * screens of each, slowly, and sends the posts by people (never a company's page) to HandsFreeOS, in no group, where
 * the AI checks each one; the good ones go on Today's list with comment drafts. From 0.95.0 the words are the playbooks'
 * own phrases the AI wrote (decision 92), 5 a day in turn, and each save carries the phrase it searched with, so a post
 * found with one is worth the AI's check whatever its words say; who reacted to and commented on the good ones is read
 * after (./post-people.ts). It stops on any LinkedIn warning.
 *
 * LinkedIn's newer search links no post (the owner's Check LinkedIn of 29 Oct 2026), and a post with no link can't be
 * kept, so from 0.112.0 (decision 123) each person's post with none gets its own from its menu's Copy link to post,
 * caught on the page so the person's clipboard is never written to (`withLinks`). That's all it presses. When that
 * doesn't work, the page is noted with its outline, the menu open (decision 74), once a day. From 0.119.0 (decision
 * 138) the short link it copies now (https://lnkd.in/p/…) is followed to the post's own address (./short-links.ts).
 */
import { linkedInPostsSave } from '../../hfos/saves';
import type { LinkedInRead } from '../../networks';
import { postKey } from '../../networks/linkedin/post-links';
import { shortLinkFrom } from '../../networks/linkedin/urls';
import { counted } from '../../words';
import { pause, paced, warnedOn, type Job, type JobEnd } from '../job';
import { postSearchUrl, readLinkedIn, SCROLL_PACE_MS } from './read';
import { postUrlOfShort } from './short-links';

/** Screens of each search it reads. */
export const SEARCH_SCREENS = 3;
/** Between searches: a person typing the next. */
const SEARCH_PACE_MS = [15_000, 30_000] as const;

/** The people's posts it gets links for on each screen, at most. */
export const LINKS_PER_SCREEN = 8;

/**
 * The screen's posts with the links their menus copy, for the people's posts that show none (decision 123): only when
 * the page catches copies, so nothing goes to the person's clipboard. `known` holds the keys of posts it has tried
 * already, link or not, and gains each it tries, so no post's menu is pressed twice. A short link is followed to the
 * post (`follow`), and one that leads to none is dropped. When no link came, the page is noted with the outline its
 * menu showed (once a job), or that the short links led nowhere.
 */
export async function withLinks(
  job: Job,
  page: LinkedInRead,
  known: Set<string>,
  most = LINKS_PER_SCREEN,
  follow: (short: string) => Promise<string | null> = postUrlOfShort,
): Promise<LinkedInRead> {
  const posts = page.posts ?? [];
  const wanted = posts.some(
    (p) => !p.url && !p.company && p.author?.profile && !known.has(postKey(p)),
  );
  if (!wanted || !(await job.tab.catchCopies?.())) return page;
  const answer = await job.tab.ask({ type: 'hfos-post-links', most, skip: [...known] });
  if (!answer.ok) return page;
  const followed = await Promise.all(
    answer.links.map(async (l) => ({
      key: l.key,
      url: shortLinkFrom(l.url) ? await follow(l.url) : l.url,
    })),
  );
  const links = new Map(followed.flatMap((l) => (l.url ? [[l.key, l.url] as const] : [])));
  for (const key of [...answer.tried, ...answer.links.map((l) => l.key)]) known.add(key);
  if (!links.size && answer.links.length && !noted.has(job)) {
    noted.add(job);
    await job.report?.({
      job: 'posts.links',
      note: 'Copy link to post on LinkedIn’s post search gave short links that didn’t lead to a post.',
      found: { ...answer.found, followed: 0 },
    });
  }
  if (!links.size && answer.outline && !noted.has(job)) {
    noted.add(job);
    await job.report?.({
      job: 'posts.links',
      note: answer.found['items']
        ? 'Copy link to post in a post’s menu on LinkedIn’s post search gave no link.'
        : 'No Copy link to post in a post’s menu on LinkedIn’s post search.',
      found: answer.found,
      outline: true,
      outlineText: answer.outline,
    });
  }
  if (!links.size) return page;
  return {
    ...page,
    posts: posts.map((p) => (p.url ? p : { ...p, url: links.get(postKey(p)) ?? null })),
  };
}

/** The jobs whose post search was noted for giving no link: once each. */
const noted = new WeakSet<Job>();

/** Sends a screen's posts not sent before for the AI to check, with the phrase that found them: how many went to it. */
function postSender(job: Job): (page: LinkedInRead, words: string) => Promise<number> {
  const sent = new Set<string>();
  return async (page, words) => {
    const built = linkedInPostsSave(page, job.businessId, 'search', words);
    if (!built.ok) return 0;
    const posts = built.input.posts.filter((post) => !sent.has(post.url));
    if (!posts.length) return 0;
    const answer = await job.hfos({ type: 'hfos-save-posts', input: { ...built.input, posts } });
    if (!answer.ok) throw new Error(answer.problem.message);
    for (const post of posts) sent.add(post.url);
    return answer.value.checking;
  };
}

/** Searches LinkedIn's posts with each of the words, the latest first, and sends what it finds for the AI to check. */
export async function findPostsBySearch(job: Job, words: readonly string[]): Promise<JobEnd> {
  if (!words.length)
    return {
      line: 'None of your playbooks has words to search LinkedIn’s posts with. On the Playbooks tab, add some under Words to search LinkedIn’s posts with, then ask again.',
      warned: false,
      failed: true,
    };
  const send = postSender(job);
  const linked = new Set<string>();
  let checking = 0;
  let searched = 0;
  for (const [w, said] of words.entries()) {
    if (job.stopped()) break;
    job.progress(
      `Searching LinkedIn’s posts for “${said}”… ${counted(checking, 'post')} sent to check so far.`,
    );
    await job.tab.open(postSearchUrl(said));
    for (let screen = 0; screen < SEARCH_SCREENS && !job.stopped(); screen++) {
      const read = await readLinkedIn(job.tab);
      const warned = await warnedOn(job, read);
      if (warned) return warned;
      const page = await withLinks(job, read, linked);
      checking += await send(page, said);
      job.progress(
        `Reading posts about “${said}”… ${counted(checking, 'post')} sent to check so far.`,
      );
      if (screen === SEARCH_SCREENS - 1) break;
      if (!(await job.tab.ask({ type: 'hfos-scroll-list' })).ok) break;
      await pause(paced(SCROLL_PACE_MS));
    }
    searched++;
    if (!job.stopped() && w < words.length - 1) await pause(paced(SEARCH_PACE_MS));
  }
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}Searched LinkedIn’s posts for ${counted(searched, 'phrase')}: ${counted(checking, 'post')} sent for the AI to check. The good ones go on your list for today.`,
    warned: false,
  };
}

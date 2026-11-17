/**
 * Check if it posted (the owner, 15 Nov 2026; docs/socialcontent.md, "Picking many posts"): a post marked as didn't post may have
 * gone up all the same (Facebook was still publishing two Page posts on 14 Nov when the extension gave up). The reading
 * computer looks for it where it hadn't gone up, by its first words, as a person would, from its reading window
 * (./tab.ts), the same way posting finds a post's link (./posting.ts):
 *
 * - **Facebook:** the top of the person's own profile, or of the business's Page, once Facebook has drawn its newest
 *   posts there (./posting.ts `lookOn`). When it never did, it says it couldn't check, rather than that it isn't there.
 * - **LinkedIn:** their own posts.
 * - **Instagram:** their own newest posts, as Instagram's page loads them.
 * - **Threads and X:** the top of their own profile.
 *
 * Each minute, after posting and before reading its own posts' numbers (./run.ts), it asks for the next post to look
 * for (`socialcontent.post.look_next`): one a person asked about, or one that may have gone up, 10 minutes after it was
 * marked as didn't post. It says what it found (`socialcontent.post.looked`): found everywhere, it's posted, with its
 * links. A network's warning stops it there for the day, for both social add-ons, as posting does, and says why it
 * couldn't look.
 */
import type { PostingNetwork, PostPlace } from '@hfos/core/addons/socialcontent/calendar';
import type { LookPost } from '@hfos/core/addons/socialcontent/content-shapes';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { keepWarning } from '../hfos/warned';
import { postLooked, postLookNext, ResearchRefused } from './hfos';
import {
  FACEBOOK_ME,
  INSTAGRAM_HOME,
  instagramLink,
  LINKEDIN_OWN_POSTS,
  lookOn,
  openAt,
  POSTS_LOOKED_BACK,
  postsNow,
  shortLink,
  THREADS_HOME,
} from './posting';
import type { ResearchTab } from './tab';

const X_HOME = 'https://x.com/home';

/**
 * How looking in one place ended: its link when found, null when not (`unseen` when the page never showed its newest
 * posts, so it couldn't tell), or the network's warning.
 */
type PlaceEnd =
  | {
      readonly place: PostPlace;
      readonly link: string | null;
      readonly found: boolean;
      readonly unseen?: boolean;
    }
  | { readonly halt: string };

/** The words a person reads when it couldn't look at all. */
export function lookFailure(network: PostingNetwork, why: 'no_page' | 'warned', said = ''): string {
  const name = networkName(network);
  return why === 'no_page'
    ? 'Add your Facebook Page’s link in Settings → Posting, so it can look on your Page.'
    : `${name} said “${said.slice(0, 120)}”, so it waits till tomorrow to look there, for both social add-ons.`;
}

/** The words a person reads when Facebook never showed the newest posts where it looked, so it couldn't check. */
export function unseenFailure(place: PostPlace): string {
  const where = place === 'page' ? 'your Page’s' : 'your profile’s';
  return `Facebook didn’t load ${where} posts, so it couldn’t check. Look there yourself, or press Check if it posted again in a few minutes.`;
}

/** Looks for the post in one place: the page that lists it, by its first words. */
async function lookIn(tab: ResearchTab, post: LookPost, place: PostPlace): Promise<PlaceEnd> {
  const network = post.network;
  let listed: string | null = null;
  let home: string | null = null;
  if (network === 'facebook') listed = place === 'page' ? post.facebookPage : FACEBOOK_ME;
  else if (network === 'linkedin') listed = LINKEDIN_OWN_POSTS;
  else home = network === 'instagram' ? INSTAGRAM_HOME : network === 'x' ? X_HOME : THREADS_HOME;
  if (network === 'facebook' && !listed) return { halt: lookFailure(network, 'no_page') };
  const warnings = await openAt(tab, (listed ?? home)!);
  if (warnings.length) {
    await keepWarning(warnings, network as Platform).catch(() => []);
    return { halt: lookFailure(network, 'warned', warnings[0]!) };
  }
  if (listed) {
    const look = await lookOn(tab, listed, post.text, POSTS_LOOKED_BACK);
    return {
      place,
      link: look.link,
      found: look.found,
      unseen: network === 'facebook' && !look.seen,
    };
  }
  const link =
    network === 'instagram'
      ? await instagramLink(tab, post.text)
      : await shortLink(tab, network as 'threads' | 'x', post.text);
  return { place, link, found: link !== null };
}

/** Looks for one post in each place it hadn't gone up, and says what it found. */
export async function lookFor(businessId: string, tab: ResearchTab, post: LookPost): Promise<void> {
  const found: { place: PostPlace; link: string | null }[] = [];
  let failure: string | null = null;
  for (const place of post.places) {
    let end: PlaceEnd;
    try {
      end = await lookIn(tab, post, place);
    } catch (error) {
      console.warn('HandsFreeOS Social couldn’t look for a post', error);
      end = { place, link: null, found: false };
    }
    if ('halt' in end) {
      failure = end.halt;
      break;
    }
    if (end.found) found.push({ place: end.place, link: end.link });
    else if (end.unseen) failure ??= unseenFailure(end.place);
  }
  try {
    await postLooked(businessId, post.id, found, found.length ? null : failure);
  } catch (error) {
    if (!(error instanceof ResearchRefused)) throw error;
  }
}

/**
 * One turn of looking for posts that didn't post: the next one due, looked for. Whether there was one (so reading
 * waits a turn). Never throws for HandsFreeOS saying no: the look simply waits.
 */
export async function lookTurn(
  businessId: string,
  tabFor: (network: PostingNetwork) => ResearchTab,
): Promise<boolean> {
  const networks = await postsNow();
  if (!networks.length) return false;
  let post: LookPost | null;
  try {
    post = (await postLookNext(businessId, networks)).post;
  } catch (error) {
    if (error instanceof ResearchRefused) return false;
    throw error;
  }
  if (!post) return false;
  await lookFor(businessId, tabFor(post.network), post);
  return true;
}

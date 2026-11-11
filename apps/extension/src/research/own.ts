/**
 * Reading the business's own posts' numbers (docs/socialcontent.md, "Its own posts' numbers"; HANDSFREEOS_CONTENT_
 * CREATOR_IMPLEMENTATION_PLAN.md, part 11). About 2 and 7 days after a post went up, the reading computer opens it in
 * each place it went up with a link, from its reading window (./tab.ts), and reads what the network shows:
 *
 * - **Instagram:** the post's own answer, by the number in its link (views on a video, likes, comments, shares), as a
 *   creator's post is read.
 * - **Facebook and LinkedIn:** the post's own page, by the network's reader: its reactions count as likes, and its
 *   comments. Neither shows views or shares there.
 *
 * Each minute, after posting (./run.ts), it asks for the next post whose read is due (`socialcontent.own.next`), on the
 * networks with no warning today, and says what each place showed (`socialcontent.own.read`), or why a place couldn't be
 * read. A network's warning stops it there for the day, for both social add-ons, as reading does; the read is asked
 * for again later, since a read handed out is put off half an hour.
 */
import type { OwnCheck } from '@hfos/core/addons/socialcontent/content-shapes';
import type { PostingNetwork, PostPlace } from '@hfos/core/addons/socialcontent/calendar';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { keepWarning } from '../hfos/warned';
import { ownNext, ownRead, ResearchRefused } from './hfos';
import { mediaIdOf, mediaInfoPath, postOf } from './instagram';
import { shownOf, type PagePost } from './page-read';
import { postsNow } from './posting';
import { pause, paced, RESEARCH_PACE } from './read';
import type { ResearchTab } from './tab';

/** What one place showed, or why it couldn't be read. */
export interface OwnPlaceRead {
  readonly place: PostPlace;
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
  readonly failure: string | null;
}

/** How reading one place ended: `halt` when the network warned (nothing more there today, and nothing said). */
type PlaceEnd = OwnPlaceRead | { readonly halt: true };

const plain = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
/** A post's words as a page shows them, without what it adds when it cuts one short ("…", "… more", "See more"). */
const uncut = (s: string) =>
  plain(s)
    .replace(/(?:\s*(?:…|\.\.\.)\s*(?:see more|more)?|\s+see more)$/, '')
    .trim();

/** The code in an Instagram post's link (instagram.com/p/<code>/, /reel/<code>/); null when it has none. */
export function instagramCode(link: string): string | null {
  try {
    const u = new URL(link);
    if (!/(^|\.)instagram\.com$/.test(u.hostname)) return null;
    return /^\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]{5,80})\/?/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Of the posts a post's own page shows, the one that's it: the one that starts the way its words do (Facebook and
 * LinkedIn may cut a long one short), else the first, which a post's own page shows first. Null when it shows none.
 */
export function ownPostOf(posts: readonly PagePost[], text: string): PagePost | null {
  const mine = plain(text).slice(0, 60);
  const same = mine
    ? posts.find((p) => {
        const theirs = uncut(p.text).slice(0, 60);
        return (
          theirs.length >= Math.min(20, mine.length) &&
          (theirs.startsWith(mine) || mine.startsWith(theirs))
        );
      })
    : undefined;
  return same ?? posts[0] ?? null;
}

/** The words a person reads when a place couldn't be read. */
export function ownFailure(network: PostingNetwork, why: 'no_tab' | 'not_shown'): string {
  const name = networkName(network);
  return why === 'no_tab'
    ? `The extension couldn’t reach its window on ${name} to read how it did.`
    : `${name} didn’t show the post at its link. It may have been taken down, or the computer that posts isn’t signed in to ${name}.`;
}

/** Reads one place. */
async function readAt(
  tab: ResearchTab,
  check: OwnCheck,
  place: PostPlace,
  link: string,
): Promise<PlaceEnd> {
  const network = check.network;
  const failed = (why: 'no_tab' | 'not_shown'): OwnPlaceRead => ({
    place,
    views: null,
    likes: null,
    comments: null,
    shares: null,
    failure: ownFailure(network, why),
  });
  const code = network === 'instagram' ? instagramCode(link) : null;
  const id = code ? mediaIdOf(code) : null;
  if (network === 'instagram' && !id) return failed('not_shown');
  await pause(paced(RESEARCH_PACE.answerMs));
  await tab.open(link);
  const warnings = (await tab.hands('warnings')) ?? [];
  if (warnings.length) {
    await keepWarning(warnings, network as Platform).catch(() => []);
    return { halt: true };
  }
  if (id) {
    const got = await tab.hands('get', mediaInfoPath(id));
    if (!got) return failed('no_tab');
    const post = got.ok ? postOf(got.json) : null;
    if (!post) return failed('not_shown');
    return {
      place,
      views: post.views,
      likes: post.likes,
      comments: post.comments,
      shares: post.shares,
      failure: null,
    };
  }
  const read = await tab.hands('read');
  if (read === null) return failed('no_tab');
  const post = ownPostOf(shownOf(read)?.posts ?? [], check.text);
  if (!post) return failed('not_shown');
  return {
    place,
    views: null,
    likes: post.reactions,
    comments: post.comments,
    shares: null,
    failure: null,
  };
}

/** Reads one post's numbers in each place given, and says what each showed. */
export async function readOwn(
  businessId: string,
  tab: ResearchTab,
  check: OwnCheck,
): Promise<void> {
  const reads: OwnPlaceRead[] = [];
  for (const { place, link } of check.places) {
    let end: PlaceEnd;
    try {
      end = await readAt(tab, check, place, link);
    } catch (error) {
      console.warn('HandsFreeOS Social couldn’t read how a post did', error);
      end = {
        place,
        views: null,
        likes: null,
        comments: null,
        shares: null,
        failure: ownFailure(check.network, 'no_tab'),
      };
    }
    // A warning: the rest waits, and what's read is asked for again later.
    if ('halt' in end) break;
    reads.push(end);
  }
  if (!reads.length) return;
  try {
    await ownRead(businessId, check.id, check.read, reads);
  } catch (error) {
    if (!(error instanceof ResearchRefused)) throw error;
  }
}

/**
 * One turn of reading the business's own posts' numbers: the next one due, read. Whether there was one (so reading
 * creators waits a turn). Never throws for HandsFreeOS saying no: the read simply waits.
 */
export async function ownTurn(
  businessId: string,
  tabFor: (network: PostingNetwork) => ResearchTab,
): Promise<boolean> {
  const networks = await postsNow();
  if (!networks.length) return false;
  let check: OwnCheck | null;
  try {
    check = (await ownNext(businessId, networks)).check;
  } catch (error) {
    if (error instanceof ResearchRefused) return false;
    throw error;
  }
  if (!check) return false;
  await readOwn(businessId, tabFor(check.network), check);
  return true;
}

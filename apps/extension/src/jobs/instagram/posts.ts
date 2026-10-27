/**
 * **Look at your hashtags and places** on Instagram, once a day while it works on its own (part 15; the Instagram and
 * Alignable plan's "Where the people are", 3: "Local hashtags and places from the playbook (#austinplumbing, a
 * neighborhood). The posts and the accounts that post them"). A playbook has no hashtags or places of its own:
 * HandsFreeOS makes the day's few from its area and its words for groups, local ones first, and gives the area's places
 * (`outreach.posts.words`, core's `postLooks`).
 *
 * - **Each hashtag:** its page (/explore/tags/<tag>/, which Instagram now sends to its search for it, read the same),
 *   and a few of its posts opened in turn at a person's pace, each read for who posted it, its caption, its likes and
 *   its place.
 * - **Places:** a post tagged at a place in the area leads to that place's page (/explore/locations/<id>/<name>/),
 *   read the same way, a couple a day. A place's page has an id of Instagram's that no name gives, so only a post
 *   leads to one.
 *
 * The posts go to HandsFreeOS in no group, as a network's search finds are, kept only when they say a playbook's words
 * or ask for help, and the AI checks each. A good one's author goes on Today's list: a like of theirs, which the runner
 * does, then a follow a day after; the post's comment stays the person's to write. Nothing is pressed or written on
 * Instagram. It stops on any Instagram warning.
 */
import { says } from '@hfos/core/addons/outreach/fit';
import { PLACE_LOOKS_PER_DAY } from '@hfos/core/addons/outreach/posts';
import { instagramPostsSave } from '../../hfos/saves';
import type { InstagramPost } from '../../networks/instagram/read';
import { counted } from '../../words';
import { pause, paced, valueOf, warnedOn, type Job, type JobEnd } from '../job';
import {
  ended,
  gather,
  INSTAGRAM,
  readInstagramIn,
  SCROLL_PACE_MS,
  signedOutEnd,
  type InstagramPage,
} from './read';

/**
 * A hashtag's page. Instagram sends it to its search for the hashtag now (the owner's Check, 21 Oct 2026:
 * /explore/search/keyword/?q=#smallbusiness), whose grid of posts is read as the hashtag's.
 */
export const tagUrl = (tag: string) => `${INSTAGRAM}/explore/tags/${encodeURIComponent(tag)}/`;
/** Posts it opens on each hashtag's or place's page, one at a time. */
export const POSTS_OPENED_EACH = 4;
/**
 * The most screens of a hashtag's or place's grid it scrolls past for posts not opened yet: Instagram draws the grid a
 * few rows at a time as it's scrolled, and the owner's look of 26 Oct 2026 read none on its first screen.
 */
const GRID_SCROLLS = 2;
/** Between one page of posts and the next: a person going on to another hashtag. */
const LOOK_PACE_MS = [20_000, 40_000] as const;

/** What the day's look goes to: HandsFreeOS's hashtags, without their #, and the area's places. */
export interface PostLooks {
  readonly tags: readonly string[];
  readonly places: readonly string[];
}

/** Whether a post's place is in the area: it names one of the area's places ("Austin, Texas" names Austin). */
export const inArea = (name: string | null, places: readonly string[]): boolean =>
  !!name && places.some((place) => says([name], place));

type Looked = { readonly checking: number; readonly read: number; readonly posts: InstagramPost[] };

/** A page's posts' links, a hashtag's or a place's grid, or any posts the page showed. */
const linksOn = (page: InstagramPage): string[] => [
  ...new Set([
    ...(page.found.tag?.posts ?? []),
    ...(page.found.place?.posts ?? []),
    ...page.posts.map((p) => p.url),
  ]),
];

/**
 * One page of posts, a hashtag's or a place's, with its window in front, then theirs put back until the next page:
 * Instagram draws a grid only on screen, and Chrome draws nothing in a window hidden behind another (the owner's look
 * of 26 Oct 2026 read no posts at all). Its posts' links, a screen at a time until enough aren't opened yet, a few of
 * those opened in turn and read, and what was worth a look sent for the AI to check. A page with no posts, or a post
 * whose author it couldn't read, is noted in HandsFreeOS with the page's outline (decision 74), once a look. A
 * warning, or a page asking them to sign in, ends it.
 */
function lookAt(
  job: Job,
  url: string,
  progress: string,
  opened: Set<string>,
  noted: Set<string>,
): Promise<Looked | JobEnd> {
  const look = () => lookedAt(job, url, progress, opened, noted);
  return job.tab.inFront ? job.tab.inFront(look) : look();
}

async function lookedAt(
  job: Job,
  url: string,
  progress: string,
  opened: Set<string>,
  noted: Set<string>,
): Promise<Looked | JobEnd> {
  await job.tab.open(url);
  const note = async (kind: string, words: string, found: Record<string, number>) => {
    if (noted.has(kind)) return;
    noted.add(kind);
    await job.report?.({ job: `posts.${kind}`, note: words, found, outline: true });
  };
  const got = await gather(
    job,
    GRID_SCROLLS,
    linksOn,
    (link) => link,
    () => progress,
    (links) => links.filter((link) => !opened.has(link)).length >= POSTS_OPENED_EACH,
  );
  if (ended(got)) return got;
  const links = got.items.filter((link) => !opened.has(link));
  if (!got.items.length) await note('page', 'No posts on the page.', { links: 0 });
  const posts: InstagramPost[] = [];
  for (const link of links.slice(0, POSTS_OPENED_EACH)) {
    if (job.stopped()) break;
    await pause(paced(SCROLL_PACE_MS));
    opened.add(link);
    await job.tab.open(link);
    const read = await readInstagramIn(job.tab);
    const warnedHere = await warnedOn(job, read);
    if (warnedHere) return warnedHere;
    if (read.signedOut) return signedOutEnd();
    if (read.found.post) posts.push(read.found.post);
    // A post whose author it couldn't read never goes to HandsFreeOS.
    if (!read.found.post?.author)
      await note('post', 'Couldn’t read who posted it.', { post: read.found.post ? 1 : 0 });
  }
  const built = instagramPostsSave(posts, job.businessId);
  const checking = built.ok
    ? valueOf(await job.hfos({ type: 'hfos-save-posts', input: built.input })).checking
    : 0;
  return { checking, read: posts.length, posts };
}

/** The day's look at their hashtags, then the places in the area their posts were tagged at, a page at a time. */
export async function lookAtTagsAndPlaces(job: Job, looks: PostLooks): Promise<JobEnd> {
  if (!looks.tags.length)
    return {
      line: 'None of your playbooks for Instagram has an area or words to make hashtags from. On the Playbooks tab, add your area (“Austin and Round Rock”) or some Words to search for groups, and it looks tomorrow.',
      warned: false,
      failed: true,
    };
  const opened = new Set<string>();
  const noted = new Set<string>();
  const places = new Map<string, string>();
  let checking = 0;
  let read = 0;
  let tags = 0;
  let placesLooked = 0;
  const went = async (got: Looked | JobEnd): Promise<JobEnd | null> => {
    if (ended(got)) return got;
    checking += got.checking;
    read += got.read;
    for (const post of got.posts)
      if (post.place && inArea(post.place.name, looks.places) && !places.has(post.place.url))
        places.set(post.place.url, post.place.name ?? '');
    return null;
  };
  for (const tag of looks.tags) {
    if (job.stopped()) break;
    if (tags) await pause(paced(LOOK_PACE_MS));
    const progress = `Looking at #${tag} on Instagram… ${counted(checking, 'post')} sent to check so far.`;
    job.progress(progress);
    const end = await went(await lookAt(job, tagUrl(tag), progress, opened, noted));
    if (end) return end;
    tags++;
  }
  for (const [url, name] of [...places].slice(0, PLACE_LOOKS_PER_DAY)) {
    if (job.stopped()) break;
    await pause(paced(LOOK_PACE_MS));
    const progress = `Looking at posts at ${name || 'a place in your area'} on Instagram… ${counted(checking, 'post')} sent to check so far.`;
    job.progress(progress);
    const end = await went(await lookAt(job, url, progress, opened, noted));
    if (end) return end;
    placesLooked++;
  }
  const where = placesLooked
    ? `${counted(tags, 'hashtag')} and ${counted(placesLooked, 'place')} in your area`
    : counted(tags, 'hashtag');
  return {
    line: `${job.stopped() ? 'Stopped. ' : ''}Looked at ${where} on Instagram and read ${counted(read, 'post')}: ${counted(checking, 'post')} sent for the AI to check. Who posted the good ones goes on your list for today: a like first, then a follow.`,
    warned: false,
  };
}

/**
 * AI Social Media Content Creator's posting (docs/socialcontent.md, "Posting"; HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION
 * _PLAN.md, part 9): the reading computer puts the business's OK'd posts up at their times, from its reading window
 * (./tab.ts), before any reading. Each minute (./run.ts) it asks HandsFreeOS for the next post due on the networks it
 * posts on with no warning today (`socialcontent.post.next`), fetches its pictures (or the person's video) from
 * HandsFreeOS's storage on the person's own sign-in, and puts it up in each place it goes:
 *
 * - **Facebook, the person's profile:** their home feed's box (./post-here.ts); then its link, from the top of their
 *   own profile by its first words.
 * - **Facebook, the business's Page:** the Page's number from its page, then Meta Business Suite's Create post for it,
 *   so the person's own profile is never switched to the Page (Social Outreach works as them meanwhile); then its link,
 *   from the top of the Page by its first words.
 * - **LinkedIn:** their feed's Start a post; its link from LinkedIn's View post, else from their own posts.
 * - **Instagram (part 10):** Create on their home page, with the pictures or the person's video; then its link, from
 *   their own newest posts as Instagram's page loads them, by its first words.
 *
 * Then it says how each place went (`socialcontent.post.went`). Once Post is pressed it's never pressed again for that
 * place: a post that may have gone up is the person's to look at. A network's warning stops it there for the day (for
 * both social add-ons, as reading does) and puts the post back to waiting. When a place doesn't work, a problem report
 * goes to HandsFreeOS's staff with the page's outline and what it did (never a name), as a read's does.
 */
import { PROBLEM_OUTLINE_MOST } from '@hfos/core/problem-report';
import type { DuePost } from '@hfos/core/addons/socialcontent/content-shapes';
import type { PostingNetwork, PostPlace } from '@hfos/core/addons/socialcontent/calendar';
import { POSTING } from '@hfos/core/addons/socialcontent/calendar';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { config } from '../hfos/config';
import { token } from '../hfos/session';
import { keepWarning, warnedNow } from '../hfos/warned';
import { foundPost } from '../jobs/helpful';
import { postNext, postWent, reportProblem, ResearchRefused } from './hfos';
import { postsByNamePath, postsFrom } from './instagram';
import type { PostDone, PostFileIn, PostWhere } from './post-here';
import { pause, paced, RESEARCH_PACE } from './read';
import type { ResearchTab } from './tab';

/** The networks this build posts on: Facebook and LinkedIn (part 9), and Instagram (part 10). */
export const POSTS_ON = POSTING.networks;

const FACEBOOK_HOME = 'https://www.facebook.com/';
const FACEBOOK_ME = 'https://www.facebook.com/me';
const BUSINESS_COMPOSER = 'https://business.facebook.com/latest/composer/';
const LINKEDIN_FEED = 'https://www.linkedin.com/feed/';
const LINKEDIN_OWN_POSTS = 'https://www.linkedin.com/in/me/recent-activity/all/';
const INSTAGRAM_HOME = 'https://www.instagram.com/';
/** While the network puts the post at the top before its link is looked for. */
const SETTLE_MS = 5_000;
/**
 * The most a post's files may weigh together, as they're handed to the tab: within what Chrome passes to a page in one
 * go once written out (a video can be up to 25 MB, core's most for a file).
 */
const FILES_MOST_BYTES = 40 * 1024 * 1024;

/** How one place went, for `socialcontent.post.went`. */
interface Went {
  readonly place: PostPlace;
  readonly posted: boolean;
  readonly link: string | null;
  readonly failure: string | null;
}

/** How putting it up in one place ended: `halt` when the network warned (nothing more there today). */
interface PlaceEnd extends Went {
  readonly pressed: boolean;
  readonly halt?: boolean;
}

/** The networks it may post on now: no warning today. */
export async function postsNow(): Promise<PostingNetwork[]> {
  const open: PostingNetwork[] = [];
  for (const n of POSTS_ON) if (!(await warnedNow(n as Platform))) open.push(n);
  return open;
}

/** A post's files, fetched from HandsFreeOS's storage on the person's own sign-in, ready to hand to the tab. */
export async function fetchFiles(files: DuePost['files']): Promise<PostFileIn[] | null> {
  const bearer = await token().catch(() => null);
  if (!bearer || !config.supabaseUrl) return null;
  const out: PostFileIn[] = [];
  let bytes = 0;
  for (const f of files) {
    const path = f.objectPath.split('/').map(encodeURIComponent).join('/');
    let response: Response;
    try {
      response = await fetch(
        `${config.supabaseUrl}/storage/v1/object/authenticated/${encodeURIComponent(f.bucket)}/${path}`,
        {
          headers: { authorization: `Bearer ${bearer}`, apikey: config.supabasePublishableKey },
        },
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const buffer = new Uint8Array(await response.arrayBuffer());
    bytes += buffer.byteLength;
    if (bytes > FILES_MOST_BYTES) return null;
    let binary = '';
    for (let i = 0; i < buffer.length; i += 0x8000)
      binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    out.push({
      name: f.name,
      type: f.mimeType ?? response.headers.get('content-type') ?? 'image/png',
      base64: btoa(binary),
    });
  }
  return out;
}

/** The words a person reads when a place didn't take the post. */
export function failureFor(
  network: PostingNetwork,
  place: PostPlace,
  done: PostDone | null,
  video = false,
): string {
  const name = networkName(network);
  const where =
    place === 'page'
      ? 'your Page'
      : place === 'profile'
        ? 'your profile'
        : network === 'instagram'
          ? 'your Instagram'
          : `your ${name} feed`;
  const press = network === 'instagram' ? 'Share' : 'Post';
  if (!done)
    return `The extension couldn’t reach its window on ${name}. It tries again with Post it now.`;
  if (done.result === 'none')
    return place === 'page'
      ? `Meta Business Suite didn’t show Create post for your Page. Check you’re an admin of the Page in Settings → Posting’s link, then press Post it now.`
      : `${name} didn’t show the box to write a post on ${where}. Check you’re signed in to ${name} in Chrome on the computer that posts, then press Post it now.`;
  if (done.result === 'no_media')
    return `${name} didn’t take its ${video ? 'video' : 'pictures'} on ${where}, so nothing went up. Press Post it now to try again, or copy the words and post it yourself.`;
  return done.pressed
    ? `It pressed ${press} on ${where}, but ${name} didn’t show the post going up. Look on ${where}: if it isn’t there, press Post it now.`
    : `${name} didn’t take the post on ${where}. Press Post it now to try again, or copy the words and post it yourself.`;
}

/** Opens a page in the window, at a person's pace, and says the network's warning when there's one. */
async function openAt(tab: ResearchTab, url: string): Promise<string[]> {
  await pause(paced(RESEARCH_PACE.answerMs));
  await tab.open(url);
  return (await tab.hands('warnings')) ?? [];
}

/** The post's link, from the top of a page that lists it (the person's profile, the Page, their own posts). */
async function linkFrom(tab: ResearchTab, url: string, text: string): Promise<string | null> {
  await pause(SETTLE_MS);
  try {
    await tab.open(url);
    const read = (await tab.hands('read')) as {
      posts?: { text: string; url: string | null }[];
    } | null;
    return read ? foundPost(read, text) : null;
  } catch {
    return null;
  }
}

/**
 * An Instagram post's link, from the person's own newest posts as Instagram's page loads them (their name from the
 * Profile link in its side menu), by its first words. Null when it isn't among them yet.
 */
async function instagramLink(tab: ResearchTab, text: string): Promise<string | null> {
  await pause(SETTLE_MS);
  try {
    const me = await tab.hands('me');
    if (!me) return null;
    const got = await tab.hands('get', postsByNamePath(me));
    const posts = got?.ok ? (postsFrom(got.json)?.posts ?? []) : [];
    return foundPost({ posts: posts.map((p) => ({ text: p.caption ?? '', url: p.link })) }, text);
  } catch {
    return null;
  }
}

/** Sends a problem report on a place that didn't work: what it did and the page's outline, never a name. */
async function report(
  businessId: string,
  tab: ResearchTab,
  post: DuePost,
  place: PostPlace,
  note: string,
  done: PostDone | null,
): Promise<void> {
  try {
    const page = await tab.hands('outline');
    const outline = page?.outline ?? '';
    await reportProblem(businessId, {
      addonId: 'socialcontent',
      source: 'extension',
      area: post.network,
      job: `post.${place}`,
      ref: post.id,
      version: chrome.runtime.getManifest().version.slice(0, 20),
      page: page ? String(page.result.kind).slice(0, 40) : 'unknown',
      path: (/^Page: \S+ (.+)$/m.exec(outline)?.[1] ?? '').slice(0, 500),
      shown: page?.shown ?? null,
      found: {
        result: [done?.result ?? 'no_tab'],
        pressed: done?.pressed ?? false,
        steps: [...(done?.steps ?? [])].slice(0, 20),
        files: post.files.length,
        format: [post.format],
      },
      note: note.slice(0, 300),
      outline: outline ? outline.slice(0, PROBLEM_OUTLINE_MOST) : null,
      helper: null,
    });
  } catch (error) {
    console.warn('HandsFreeOS Social couldn’t send its report on a post', error);
  }
}

/** Puts the post up in one place. */
async function putUpAt(
  businessId: string,
  tab: ResearchTab,
  post: DuePost,
  place: PostPlace,
  files: readonly PostFileIn[],
): Promise<PlaceEnd> {
  const network = post.network;
  const name = networkName(network);
  let where: PostWhere;
  let url: string;
  let listed: string | null;
  if (network === 'instagram') {
    where = 'instagram';
    url = INSTAGRAM_HOME;
    listed = null;
  } else if (network === 'linkedin') {
    where = 'linkedin';
    url = LINKEDIN_FEED;
    listed = LINKEDIN_OWN_POSTS;
  } else if (place === 'page') {
    if (!post.facebookPage)
      return {
        place,
        posted: false,
        pressed: false,
        link: null,
        failure:
          'Add your Facebook Page’s link in Settings → Posting first, or post it to your profile only.',
      };
    const warnings = await openAt(tab, post.facebookPage);
    if (warnings.length) return warnedEnd(place, network, warnings);
    const id = await tab.hands('pageId');
    where = 'business';
    url = id ? `${BUSINESS_COMPOSER}?asset_id=${id}` : BUSINESS_COMPOSER;
    listed = post.facebookPage;
  } else {
    where = 'facebook';
    url = FACEBOOK_HOME;
    listed = FACEBOOK_ME;
  }
  const warnings = await openAt(tab, url);
  if (warnings.length) return warnedEnd(place, network, warnings);
  await tab.holdPicker();
  const done = await tab.hands('post', { where, text: post.text, files: [...files] });
  if (done?.result !== 'done') {
    const failure = failureFor(
      network,
      place,
      done,
      files.some((f) => f.type.startsWith('video/')),
    );
    await report(businessId, tab, post, place, failure, done);
    // Nothing pressed and no box at all: most often signed out, so it's said, not tried again on its own.
    return { place, posted: false, pressed: done?.pressed ?? false, link: null, failure };
  }
  const link =
    done.url ??
    (listed ? await linkFrom(tab, listed, post.text) : await instagramLink(tab, post.text));
  return { place, posted: true, pressed: true, link, failure: null };

  async function warnedEnd(
    at: PostPlace,
    on: PostingNetwork,
    words: readonly string[],
  ): Promise<PlaceEnd> {
    await keepWarning(words, on as Platform).catch(() => []);
    return {
      place: at,
      posted: false,
      pressed: false,
      halt: true,
      link: null,
      failure: `${name} said “${words[0]!.slice(0, 120)}”, so posting there waits till tomorrow, for both social add-ons.`,
    };
  }
}

/** Puts one post up in each place it still goes, and says how it went. */
export async function putUp(businessId: string, tab: ResearchTab, post: DuePost): Promise<void> {
  const files = post.files.length ? await fetchFiles(post.files) : [];
  if (!files) {
    await postWent(businessId, post.id, {
      went: [],
      again: false,
      failure:
        'The computer that posts couldn’t get its pictures from HandsFreeOS. Check it’s signed in to the extension, then press Post it now.',
    }).catch(() => undefined);
    return;
  }
  const went: PlaceEnd[] = [];
  for (const place of post.places) {
    let end: PlaceEnd;
    try {
      end = await putUpAt(businessId, tab, post, place, files);
    } catch (error) {
      console.warn('HandsFreeOS Social couldn’t post', error);
      end = {
        place,
        posted: false,
        pressed: false,
        link: null,
        failure: failureFor(post.network, place, null),
      };
    }
    went.push(end);
    if (end.halt) break;
  }
  // A warning before anything was pressed anywhere: it waits for another day, while its time is recent.
  const again = went.every((w) => !w.pressed) && went.some((w) => w.halt);
  try {
    await postWent(businessId, post.id, {
      went: again
        ? []
        : went.map(({ place, posted, link, failure }) => ({ place, posted, link, failure })),
      again,
      failure: again ? (went.find((w) => w.halt)?.failure ?? null) : null,
    });
  } catch (error) {
    if (!(error instanceof ResearchRefused)) throw error;
  }
}

/**
 * One turn of posting for a business: the next post due, put up. Whether there was one (so reading waits a turn).
 * Never throws for HandsFreeOS saying no: posting simply waits.
 */
export async function postTurn(
  businessId: string,
  tabFor: (network: PostingNetwork) => ResearchTab,
  version: string,
): Promise<boolean> {
  const networks = await postsNow();
  if (!networks.length) return false;
  let post: DuePost | null;
  try {
    post = (await postNext(businessId, networks, version)).post;
  } catch (error) {
    if (error instanceof ResearchRefused) return false;
    throw error;
  }
  if (!post) return false;
  await putUp(businessId, tabFor(post.network), post);
  return true;
}

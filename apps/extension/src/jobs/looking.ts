/**
 * Check Instagram and Check Alignable (`checkup` on a network still looked at, docs/outreach.md decision 78): the plan's
 * "a look at a real account", from the person's own. One press opens the network's main pages one at a time, at a
 * person's pace, with its window in front, and notes each in HandsFreeOS with its outline (names and words hidden), so
 * the network's readers and steps can be built from its real pages. On the way it looks for each step's button
 * (src/networks/instagram/site.ts, src/networks/alignable/site.ts) and never presses the last: nothing is followed,
 * liked, connected, recommended, posted or sent. It stops on any warning of the network's, and ends at once when the
 * network asks the person to sign in.
 *
 * - **Instagram:** the feed, the person's own account (read as the AI's check reads it) and its form (the bio), a
 *   search, someone from their feed
 *   (Follow, which isn't tried on someone they follow, and Message, whose chat is opened and closed), one of their posts
 *   (Like, and the box to comment in, where a word is written and taken out to see Post show; from 0.95.0, decision 92,
 *   its Likes box opened by its count of likes and closed again, and its View all comments pressed once), the accounts
 *   Instagram suggests and up to three of them (Follow, on someone they don't follow), and their messages.
 * - **Alignable:** its signed-in pages at /biz (alignable.com/ is its public home page, signed in or not; the owner's
 *   first Check, 17 Oct 2026), then the places its menus lead to, those whose words say people, messages or posts
 *   first (never anything that signs out, pays or deletes), the person's own profile and a business's or a member's,
 *   looking for Connect, Message, Recommend, Like and a box to comment in on each until each is found. On their own
 *   profile (decision 80) it reads it as the AI's check would, opens its Elevator Pitch and My Ideal Customer and closes
 *   them with nothing written, and reads the pages About Us and their details are changed on, once they're drawn. Then
 *   (0.66.0, partners stage 6) the pages Alignable's steps and Find partners are built from next: the person's town, a
 *   search for businesses, a forum question, their connection requests and a chat with a connection, nothing written.
 */
import {
  ASK_CODE_MINUTES,
  askCodeRanOutWords,
  askCodeWords,
  hasEveryPart,
  hasNewProfileParts,
  profileEditDoneWords,
  type AskTaken,
  type AskTask,
} from '@hfos/core/addons/outreach/asks';
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import {
  cleanUsername,
  PROFILE_CHECK_WORDS as P,
  profileCheckWordsOn,
  type ProfileRead,
} from '@hfos/core/addons/outreach/profile-check';
import { partHowOn } from '@hfos/core/addons/outreach/profile-parts';
import type { CenterPart } from '../networks/accounts-center/pages';
import { townOf } from '../networks/alignable/site';
import { clean } from '../networks/facebook/dom';
import type { FormSteps } from '../networks/instagram/own-profile';
import { instagramUrl, profileOf as instagramProfileOf } from '../networks/instagram/urls';
import type { LookingPlatform, LookingRead } from '../networks/looking/site';
import type { TryStep } from '../networks/tries';
import {
  centerAllowed,
  centerProfile,
  chromeKeepsOff,
  nameReviewWords,
  putNameIn,
  putUsernameIn,
  unseenWords as centerUnseenWords,
} from './accounts-center';
import { groupStops } from './alignable/checkup';
import { Checkup, isEnd, SEARCH_WORDS, wholeProfile } from './checkup';
import { readPageIn, valueOf, warnedOn, type Job, type JobEnd, type JobTab } from './job';
import { partSteps, putParts, shownParts, unseenParts, unseenPartsWords } from './own-parts';
import { checkUsernames, putInByHand, type ByHandPart } from './profile-parts';
import { ownProfileNote } from './report';

/** Reads the page in the job's window as the network's: anything else means it sent the window elsewhere. */
export const readOn =
  (platform: LookingPlatform) =>
  async (tab: JobTab): Promise<LookingRead> => {
    const page = await readPageIn(tab);
    if (!('platform' in page) || page.platform !== platform) {
      const name = NETWORKS[platform].name;
      throw new Error(
        `${name} didn’t open in the extension’s window. Check you’re signed in to ${name} in this browser, then ask again.`,
      );
    }
    return page as LookingRead;
  };

const STOPPED: JobEnd = { line: 'Stopped.', warned: false, failed: true };

const stoppedEnd = (job: Job): JobEnd | null =>
  job.stopped() ? { line: 'Stopped.', warned: false } : null;

/** The network asked the person to sign in: nothing else can be read. */
const signedOutEnd = (platform: LookingPlatform): JobEnd => {
  const name = NETWORKS[platform].name;
  return {
    line: `${name} asked you to sign in. Sign in to ${name} in this browser, then press Check ${name} again.`,
    warned: false,
    failed: true,
  };
};

/** How many accounts it suggests are opened for someone to look for Follow on. */
const FOLLOW_LOOKS = 3;

// ------------------------------------------------------------------------------------------------ Instagram

const INSTAGRAM = 'https://www.instagram.com';

async function checkupInstagram(job: Job): Promise<JobEnd> {
  const c = new Checkup(job, 'instagram', readOn('instagram'));

  // Your feed: the accounts and posts it shows, and your own account from its menu.
  const feed = await c.open(`${INSTAGRAM}/`, 'your feed');
  if (isEnd(feed)) return feed;
  if (feed.signedOut) return signedOutEnd('instagram');
  await c.note('your feed', feed.posts.length + feed.people.length);

  // Your own account, and its form, where the bio is.
  if (feed.own) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const own = await c.open(feed.own, 'your profile');
    if (isEnd(own)) return own;
    await c.note('your profile', null);
    // Read as the AI's check reads it (decision 80): what was found is noted, never what it says.
    await wholeProfile(job, true);
  }
  if (stoppedEnd(job)) return stoppedEnd(job)!;
  const form = await c.open(`${INSTAGRAM}/accounts/edit/`, 'your profile’s form');
  if (isEnd(form)) return form;
  // Its outline too: which of the form's boxes the extension may write in (decision 80).
  await c.note('your profile’s form', null);
  await c.tryHere('bio');

  // A search, for the accounts and posts it shows.
  if (stoppedEnd(job)) return stoppedEnd(job)!;
  const search = await c.open(
    `${INSTAGRAM}/explore/search/keyword/?q=${encodeURIComponent(SEARCH_WORDS)}`,
    'a search',
  );
  if (isEnd(search)) return search;
  await c.note('a search', search.posts.length + search.people.length);

  // Someone's account, from your feed or the search: Follow looked for, then Message, whose chat is opened and closed.
  const someone = [...feed.people, ...search.people][0]?.url ?? null;
  let theirPosts: readonly { readonly url: string }[] = [];
  if (someone) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const theirs = await c.open(someone, 'someone’s account');
    if (isEnd(theirs)) return theirs;
    await c.note('someone’s account', null);
    theirPosts = theirs.posts;
    await c.tryHere('follow');
    await c.tryHere('message');
  } else {
    await c.nothingFor('message', 'no account on your feed or the search to open');
  }

  // One of their posts, or one from your feed or the search: Like and the box to comment in looked for.
  // A photo's page before a reel's: a reel opens in the reels player, which shows no box to comment in till Comment
  // is pressed (the owner's second Check, 17 Oct 2026).
  const posts = [...theirPosts, ...feed.posts, ...search.posts];
  const post =
    (posts.find((p) => new URL(p.url).pathname.startsWith('/p/')) ?? posts[0])?.url ?? null;
  let postPage: LookingRead | null = null;
  if (post) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const page = await c.open(post, 'a post');
    if (isEnd(page)) return page;
    postPage = page;
    await c.note('a post', null);
    await c.tryHere('like');
    await c.tryHere('comment');
    // Who liked it (decision 92): its Likes box opened by its count of likes, outlined while it's open, and closed
    // again by its own Close. Then its View all comments (or Load more comments) pressed once, and the post read
    // again: a post with only a few comments shows none, so nothing more is noted.
    await c.tryHere('reactors');
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const before = commentsOf(page);
    if ((await job.tab.ask({ type: 'hfos-more-comments' })).ok) {
      const more = await c.readTill(page, (p) => commentsOf(p) > before, 3);
      if (isEnd(more)) return more;
      await c.note('a post’s comments', commentsOf(more));
    }
  } else {
    for (const step of ['like', 'comment', 'reactors'] as const)
      await c.nothingFor(
        step,
        'no post with its own link on their account, your feed or the search',
      );
  }

  // Someone you don't follow, for Follow: the accounts Instagram suggests, then the search's and your feed's.
  if (!c.steps().some((t) => t.step === 'follow' && t.tried)) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const suggested = await c.open(
      `${INSTAGRAM}/explore/people/`,
      'the accounts Instagram suggests',
    );
    if (isEnd(suggested)) return suggested;
    await c.note('the accounts Instagram suggests', suggested.people.length);
    const tried = new Set(someone ? [someone.toLowerCase()] : []);
    const others = [...suggested.people, ...search.people, ...feed.people].filter((p) => {
      const key = p.url.toLowerCase();
      if (tried.has(key)) return false;
      tried.add(key);
      return true;
    });
    for (const other of others.slice(0, FOLLOW_LOOKS)) {
      if (stoppedEnd(job)) return stoppedEnd(job)!;
      const theirs = await c.open(other.url, 'an account Instagram suggests');
      if (isEnd(theirs)) return theirs;
      if ((await c.tryHere('follow')).tried) break;
    }
    if (!c.has('follow'))
      await c.nothingFor(
        'follow',
        'no account on your feed, the search or Instagram’s suggestions to open',
      );
  }

  // What its steps and Find partners are built from (the plan's part 9, 0.79.0): their followers, a hashtag, a place,
  // their notifications and a chat. Each is opened and read; nothing is pressed or written but their own count of
  // followers, to open the list of them (0.84.0).
  if (feed.own) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    // Instagram draws the list over their profile, a moment after it opens; where it doesn't from the address, their
    // count of followers opens it, pressed as a person does (the owner's Check, 21 Oct 2026, read their account
    // without it).
    const opened = await c.open(`${feed.own.replace(/\/?$/, '/')}followers/`, 'your followers');
    if (isEnd(opened)) return opened;
    let page = await c.readTill(opened, (p) => countOf(p, 'followers') > 0, 2);
    if (isEnd(page)) return page;
    if (!countOf(page, 'followers') && (await job.tab.ask({ type: 'hfos-show-all' })).ok) {
      page = await c.readTill(
        await readOn('instagram')(job.tab),
        (p) => countOf(p, 'followers') > 0,
        3,
      );
      if (isEnd(page)) return page;
    }
    await c.note('your followers', countOf(page, 'followers'));
  } else c.nothingOn.push('your followers');

  if (stoppedEnd(job)) return stoppedEnd(job)!;
  // Instagram sends a hashtag's page to its search for it now (the owner's Check, 21 Oct 2026): read the same.
  const tag = await c.open(`${INSTAGRAM}/explore/tags/${HASHTAG}/`, 'a hashtag');
  if (isEnd(tag)) return tag;
  await c.note('a hashtag', tag.posts.length);

  // A place a post was tagged at, from the hashtag's page or the post read before, else from one of the hashtag's posts
  // opened, as the day's look at places goes: /explore/locations/ alone is no list of places now (the owner's Check,
  // 21 Oct 2026, found an account Instagram draws there).
  let place = [tag, postPage].flatMap((p) => (p ? linksFound(p, 'locations') : []))[0] ?? null;
  for (const { url } of place ? [] : tag.posts.slice(0, PLACE_POSTS)) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const opened = await c.open(url, 'a post from the hashtag');
    if (isEnd(opened)) return opened;
    place = linksFound(opened, 'locations')[0] ?? null;
    if (place) break;
  }
  if (place) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const atPlace = await c.open(place, 'a place');
    if (isEnd(atPlace)) return atPlace;
    await c.note('a place', atPlace.posts.length);
  } else c.nothingOn.push('a place');

  if (stoppedEnd(job)) return stoppedEnd(job)!;
  const notifications = await c.open(`${INSTAGRAM}/notifications/`, 'your notifications');
  if (isEnd(notifications)) return notifications;
  await c.note('your notifications', notifications.people.length);

  // Your messages, and a chat in them: its box is only counted.
  if (stoppedEnd(job)) return stoppedEnd(job)!;
  const inbox = await c.open(`${INSTAGRAM}/direct/inbox/`, 'your messages');
  if (isEnd(inbox)) return inbox;
  await c.note('your messages', null);
  const chat = linksFound(inbox, 'threads')[0];
  if (chat) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const opened = await c.open(chat, 'a chat');
    if (isEnd(opened)) return opened;
    const page = await c.readTill(opened, (p) => p.boxes > 0, 2);
    if (isEnd(page)) return page;
    await c.note('a chat', page.boxes);
  } else if (
    !stoppedEnd(job) &&
    (await job.tab.ask({ type: 'hfos-open-chat', threadId: 'first-with-words' })).ok
  ) {
    // Its chats' rows are buttons, not links (the owner's Check, 0.62.0): the first with words is opened by its row, as
    // a person reading their messages does (0.80.0), and read once it's drawn its box.
    const page = await c.readTill(await readOn('instagram')(job.tab), (p) => p.boxes > 0, 3);
    if (isEnd(page)) return page;
    await c.note('a chat', page.boxes);
  } else c.nothingOn.push('a chat');

  return c.end();
}

/** The hashtag Check opens: one every small business's posts are under. */
const HASHTAG = 'smallbusiness';
/** The hashtag's posts it opens, one at a time, for one tagged at a place. */
const PLACE_POSTS = 2;

/** The addresses one of Instagram's own readers found on a page (`InstagramFound`): places, hashtags or chats. */
const linksFound = (page: LookingRead, list: 'locations' | 'tags' | 'threads'): string[] => {
  const links = page.found?.[list];
  return Array.isArray(links) ? links.filter((l): l is string => typeof l === 'string') : [];
};

// ------------------------------------------------------------------------------------------------ Alignable

const ALIGNABLE = 'https://www.alignable.com';
/** Where its signed-in pages are: alignable.com/ is its public home page, signed in or not. */
const ALIGNABLE_IN = `${ALIGNABLE}/biz`;
/** How many of its menus' places it opens. */
const PLACES_MOST = 8;
/** The steps looked for on each page, till each is found. */
const ALIGNABLE_STEPS: readonly TryStep[] = ['connect', 'message', 'recommend', 'like', 'comment'];

async function checkupAlignable(job: Job): Promise<JobEnd> {
  const c = new Checkup(job, 'alignable', readOn('alignable'));
  const lookHere = async () => {
    for (const step of ALIGNABLE_STEPS) if (!c.found(step)) await c.look(step);
  };

  // Your Alignable: its signed-in pages, whose menus say where everything is.
  const home = await c.open(ALIGNABLE_IN, 'your Alignable');
  if (isEnd(home)) return home;
  if (home.signedOut) return signedOutEnd('alignable');
  await c.note('your Alignable', home.places.length);
  await lookHere();
  // The box to start a post on it (0.101.0, decision 109): looked for, nothing written.
  await c.look('post');
  const reads: LookingRead[] = [home];

  // Its public home page too, when the signed-in one's menus have nothing worth a look: its menu leads in.
  if (!home.places.some((p) => p.worth) && new URL(home.url).pathname !== '/') {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const front = await c.open(`${ALIGNABLE}/`, 'Alignable’s home page');
    if (isEnd(front)) return front;
    await c.note('Alignable’s home page', front.places.length);
    reads.push(front);
  }

  // The places its menus lead to: those whose words say people, messages or posts first. The tab never lists one that
  // signs out, pays or deletes.
  const seen = new Set(reads.map((r) => new URL(r.url).pathname));
  const places = reads
    .flatMap((r) => r.places)
    .sort((a, b) => Number(b.worth) - Number(a.worth))
    .filter((p) => {
      const path = new URL(p.url).pathname;
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
  let people: readonly { readonly url: string }[] = home.people;
  const posts = reads.flatMap((r) => r.posts);
  for (const place of places.slice(0, PLACES_MOST)) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const page = await c.open(place.url, 'a page from Alignable’s menus');
    if (isEnd(page)) return page;
    await c.note(place.name, null);
    if (!people.length) people = page.people;
    posts.push(...page.posts);
    await lookHere();
  }

  // Your own profile (decision 80), at its business's address: read as the AI's check reads it, its Elevator Pitch and
  // My Ideal Customer opened to see where they're written and closed again with nothing written, then the pages its
  // Edit links open, About Us's and your details', each read once it's drawn its boxes (the owner's Check, 0.62.0,
  // read your details' page before it had), About Us's looked at for its box and Save.
  if (stoppedEnd(job)) return stoppedEnd(job)!;
  const mine = await c.open(`${ALIGNABLE}/biz/businesses/my_profile`, 'your profile');
  if (isEnd(mine)) return mine;
  await c.note('your profile', null);
  await wholeProfile(job, true);
  await c.tryHere('pitch');
  await c.tryHere('ideal');
  for (const [url, name] of formsOf(mine.edits)) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const opened = await c.open(url, name);
    if (isEnd(opened)) return opened;
    // Your details' page drew nothing in the time the owner's Check gave it (0.66.0): it's given longer.
    const form = await c.readTill(opened, (page) => page.boxes > 0, 8);
    if (isEnd(form)) return form;
    await c.note(name, form.boxes);
    if (name === ABOUT_FORM) await c.tryHere('about');
  }
  const someone = people[0]?.url ?? null;
  if (someone) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const theirs = await c.open(someone, 'someone’s profile');
    if (isEnd(theirs)) return theirs;
    await c.note('someone’s profile', null);
    posts.push(...theirs.posts);
    await lookHere();
  }

  const more = await nextPages(c, job, townOf(mine.url) ?? townOf(mine.own ?? ''), posts);
  if (more) return more;

  await c.noteLooks();
  return c.end();
}

/**
 * What its steps and Find partners are built from next (the plan's build order, step 4; partners stage 6): the
 * person's town and its businesses, a search for businesses, a forum question, their connection requests, and a chat
 * with one of their connections. Each is noted with its outline; nothing is pressed but the link that opens it, and
 * nothing is written. A chat's box is only counted.
 */
async function nextPages(
  c: Checkup<LookingRead>,
  job: Job,
  town: string | null,
  posts: readonly { readonly url: string }[],
): Promise<JobEnd | null> {
  if (town) {
    if (stoppedEnd(job)) return stoppedEnd(job);
    // Alignable opens a town at its own group, /groups/<town-st>, where its owners post (the owner's Check, 0.66.0).
    const opened = await c.open(`${ALIGNABLE}/${town}`, 'your town');
    if (isEnd(opened)) return opened;
    // Its posts are drawn a moment after the page: the owner's Check (0.67.0) read it while they were still loading.
    const page = await c.readTill(opened, (p) => countOf(p, 'threads') > 0, 4);
    if (isEnd(page)) return page;
    await c.note('your town', countOf(page, 'threads'));
  } else c.nothingOn.push('your town');

  if (stoppedEnd(job)) return stoppedEnd(job);
  const found = await c.open(
    `${ALIGNABLE_IN}/search?q=${encodeURIComponent(SEARCH_WORDS)}`,
    'a search for businesses',
  );
  if (isEnd(found)) return found;
  await c.note('a search for businesses', countOf(found, 'businesses'));
  // The page a business's Recommend opens, for one found (0.75.0): the recommendation's noticer is checked against
  // its outline. Opened only: nothing is written, and its Submit is never pressed.
  const recommendable = (
    found.found?.['businesses'] as readonly { profile?: { id?: string | null } }[] | undefined
  )
    ?.map((b) => b.profile?.id)
    .find((id): id is string => !!id);
  if (recommendable) {
    if (stoppedEnd(job)) return stoppedEnd(job);
    const opened = await c.open(
      `${ALIGNABLE}/biz/recommendations/new?id=${encodeURIComponent(recommendable)}`,
      'a recommendation’s page',
    );
    if (isEnd(opened)) return opened;
    const page = await c.readTill(opened, (p) => p.boxes > 0, 2);
    if (isEnd(page)) return page;
    await c.note('a recommendation’s page', page.boxes);
  } else c.nothingOn.push('a recommendation’s page');

  const question = posts.find((p) => /\/forum\//i.test(new URL(p.url).pathname)) ?? posts[0];
  if (question) {
    if (stoppedEnd(job)) return stoppedEnd(job);
    const opened = await c.open(question.url, 'a forum question');
    if (isEnd(opened)) return opened;
    const page = await c.readTill(opened, (p) => p.boxes > 0, 2);
    if (isEnd(page)) return page;
    await c.note('a forum question', countOf(page, 'threads'));
    await c.look('comment');
    await c.look('like');
  } else c.nothingOn.push('a forum question');

  if (stoppedEnd(job)) return stoppedEnd(job);
  const network = await c.open(`${ALIGNABLE_IN}/my_network`, 'your network');
  if (isEnd(network)) return network;
  await c.note('your network', countOf(network, 'businesses'));
  // Requests is a tab in My Network's own menu, so among its places, not its links (the owner's Check, 0.66.0).
  const requests = [...network.links, ...network.places].find((l) => /^requests?$/i.test(l.name));
  if (requests) {
    if (stoppedEnd(job)) return stoppedEnd(job);
    const page = await c.open(requests.url, 'your connection requests');
    if (isEnd(page)) return page;
    await c.note('your connection requests', null);
  } else c.nothingOn.push('your connection requests');
  const chat = network.links.find((l) => /^message$/i.test(l.name));
  if (chat) {
    if (stoppedEnd(job)) return stoppedEnd(job);
    const opened = await c.open(chat.url, 'a chat with a connection');
    if (isEnd(opened)) return opened;
    const page = await c.readTill(opened, (p) => p.boxes > 0);
    if (isEnd(page)) return page;
    await c.note('a chat with a connection', page.found?.['chat'] ? 1 : 0);
    // A chat with messages in it, opened from Messages' side (0.73.0): the chat reader is built from its outline, as
    // a connection's own chat may have none yet (the owner's Check, 0.68.0, opened an empty one).
    if (stoppedEnd(job)) return stoppedEnd(job);
    if ((await job.tab.ask({ type: 'hfos-open-chat', threadId: 'first-with-words' })).ok) {
      const read = await c.readTill(await readOn('alignable')(job.tab), (p) => p.boxes > 0, 3);
      if (isEnd(read)) return read;
      await c.note('a chat with messages', countOf(read, 'chats'));
    } else c.nothingOn.push('a chat with messages');
  } else c.nothingOn.push('a chat with a connection');
  // From 0.95.0 (decision 92), its groups: theirs, a search for them, and one not their town's (./alignable/checkup.ts).
  return groupStops(c, job, town);
}

/** How many of one of the network's own readers' lists a page had (`LookingRead.found`). */
const countOf = (page: LookingRead, list: string): number => {
  const rows = page.found?.[list];
  return Array.isArray(rows) ? rows.length : 0;
};

/** How many comments Instagram's readers found on a post's page: counted, never said. */
const commentsOf = (page: LookingRead): number => {
  const post = page.found?.post as { readonly comments?: unknown } | null | undefined;
  return Array.isArray(post?.comments) ? post.comments.length : 0;
};

const ABOUT_FORM = 'your About Us’s page';

/** The pages their profile's Edit links open, one of each: About Us's, then their own details'. */
function formsOf(edits: readonly string[]): (readonly [string, string])[] {
  const at = (path: RegExp) => edits.find((edit) => path.test(new URL(edit).pathname));
  const about = at(/^\/biz\/profile\/[^/]+\/?$/i);
  const details = at(/^\/biz\/users\/[^/]+\/edit\/?$/i);
  return [
    ...(about ? [[about, ABOUT_FORM] as const] : []),
    ...(details ? [[details, 'your details’ page'] as const] : []),
  ];
}

// ------------------------------------------------------------------------------------------------ your profile

const INSTAGRAM_FORM = `${INSTAGRAM}/accounts/edit/`;
type EditTask = Extract<AskTask, { kind: 'profile_edit' }>;

/** Opens a page of the network's for the person's own profile: their account's, or its form. */
async function openForProfile(
  job: Job,
  url: string,
  platform: LookingPlatform = 'instagram',
): Promise<JobEnd | LookingRead> {
  await job.tab.open(url);
  const page = await readOn(platform)(job.tab);
  const warned = await warnedOn(job, page);
  if (warned) return warned;
  if (page.signedOut) return signedOutEnd(platform);
  return page;
}

/** Reads the profile the tab shows, as the AI's check reads it. */
async function ownRead(
  job: Job,
  platform: LookingPlatform = 'instagram',
): Promise<ProfileRead | JobEnd> {
  const answer = await job.tab.ask({ type: 'hfos-own-profile' });
  if (!answer.ok) return { line: answer.error, warned: false, failed: true };
  if (!('read' in answer))
    return {
      line: `${NETWORKS[platform].name} didn’t show your profile.`,
      warned: false,
      failed: true,
    };
  return answer.read;
}

/** What Read my profile found on Instagram: the account's page as read, its address, and the bio as its form keeps it. */
interface InstagramSeen {
  readonly read: ProfileRead;
  readonly own: string;
  readonly keptBio: string | null;
}

/**
 * Read my profile, on Instagram (decision 80): their account's own page from the menu's Profile, then its form, whose
 * bio is the bio as kept; both read, noted, and sent for the AI's check. `after` looks at what was read first (Put
 * these in's parts, to be sure they show).
 */
export async function instagramProfileRead(
  job: Job,
  after?: (seen: InstagramSeen) => Promise<void>,
): Promise<JobEnd> {
  job.progress('Opening your Instagram profile…');
  const feed = await openForProfile(job, `${INSTAGRAM}/`);
  if (isEnd(feed)) return feed;
  if (!feed.own)
    return {
      line: `Instagram didn’t show your own account. ${SIGNED_IN_INSTAGRAM}`,
      warned: false,
      failed: true,
    };
  const own = await openForProfile(job, feed.own);
  if (isEnd(own)) return own;
  job.progress('Reading your profile…');
  const read = await ownRead(job);
  if (isEnd(read)) return read;
  await job.report?.({ ...ownProfileNote(read), outline: true });
  if (job.stopped()) return { line: 'Stopped.', warned: false };
  const form = await openForProfile(job, INSTAGRAM_FORM);
  if (isEnd(form)) return form;
  const kept = await ownRead(job);
  if (isEnd(kept)) return kept;
  await job.report?.({ outline: true });
  await after?.({ read, own: feed.own, keptBio: kept.bio ?? null });
  if (job.stopped()) return { line: 'Stopped.', warned: false };
  job.progress('Checking it with the AI…');
  valueOf(
    await job.hfos({
      type: 'hfos-profile-check',
      workspaceId: job.businessId,
      input: { ...read, bio: kept.bio ?? read.bio ?? null },
    }),
  );
  return { line: P.readDone, warned: false };
}

/** The username of the account an address on Instagram is, as written there; null for any other. */
const usernameAt = (href: string | null): string | null => {
  const url = href ? instagramUrl(href) : null;
  return url ? (instagramProfileOf(url)?.username ?? null) : null;
};

/** Instagram's parts read back after Put these in, to be sure they show. */
const INSTAGRAM_SHOWN = ['bio', 'username', 'name'] as const;
type InstagramShown = (typeof INSTAGRAM_SHOWN)[number];

/**
 * Put these in, on Instagram (decision 89): the bio on its form (decision 80); then its username and name on
 * Instagram's own Accounts Center, for the account signed in on instagram.com, each put in by itself, waited on while
 * Instagram asks the person for something, or handed over (./accounts-center.ts), and both handed over while Chrome
 * keeps the extension off that Accounts Center; its links in its phone app, said in words. Then the account read
 * again for a new check: only what shows is said to be in, and nothing is when it wasn't read again.
 */
async function instagramProfileEdit(job: Job, task: EditTask): Promise<JobEnd> {
  const bio = task.bio;
  const more = hasNewProfileParts(task);
  if (!bio && !more) return { line: 'Pick a bio to put in first.', warned: false, failed: true };
  if (bio) {
    const put = await instagramBio(job, bio);
    if (put) return put;
  }
  const done = new Set<ByHandPart>();
  // What Instagram refused, in its words, by part; and a name it's looking at first.
  const refused = new Map<CenterPart, string>();
  let review = false;
  const username = task.username ? cleanUsername(task.username) : null;
  const name = task.name ? clean(task.name) : null;
  const putUsername = username !== null && partHowOn('instagram', 'username') === 'auto';
  const putName = name !== null && partHowOn('instagram', 'name') === 'auto';
  if ((putUsername || putName) && !(await centerAllowed('instagram'))) {
    // Chrome keeps the extension off Instagram's Accounts Center: the person changes them there, told how to let it
    // on.
    for (const [part, value] of [
      ['username', putUsername ? username : null],
      ['name', putName ? name : null],
    ] as const) {
      if (value === null) continue;
      if (job.stopped()) return STOPPED;
      const put = await chromeKeepsOff(job, 'instagram', part, value);
      if (isEnd(put)) return put;
      done.add(part);
    }
  } else if (putUsername || putName) {
    if (job.stopped()) return STOPPED;
    // The account they're signed in to, by Instagram's menu: whose row it is among Accounts Center's Profiles.
    job.progress('Opening your Instagram profile…');
    const feed = await openForProfile(job, `${INSTAGRAM}/`);
    if (isEnd(feed)) return feed;
    const was = usernameAt(feed.own);
    if (!was)
      return {
        line: `Instagram didn’t show your own account. ${SIGNED_IN_INSTAGRAM}`,
        warned: false,
        failed: true,
      };
    job.progress('Opening Accounts Center’s profiles…');
    const center = await centerProfile(job, 'instagram', putUsername ? 'username' : 'name', was);
    if (isEnd(center)) return center;
    // Instagram said "Try again later" of the username: nothing more is pressed there today.
    let later = false;
    if (putUsername) {
      const put = await putUsernameIn(job, 'instagram', username, center);
      if (isEnd(put)) return put;
      if (put.refused) refused.set('username', put.refused);
      later = put.later ?? false;
      done.add('username');
    }
    if (putName && later) {
      refused.set(
        'name',
        `Instagram said to try again later, so the extension didn’t go on to your name. Press Put these in again tomorrow to put “${name}” in.`,
      );
      done.add('name');
    } else if (putName) {
      if (job.stopped()) return STOPPED;
      const put = await putNameIn(job, 'instagram', name, center);
      if (isEnd(put)) return put;
      if (put.refused) refused.set('name', put.refused);
      review = put.review ?? false;
      done.add('name');
    }
  }
  if (more) {
    const byHand = await putInByHand(job, 'instagram', task, done);
    if (byHand) return byHand;
  }
  // What went in but doesn't show on the account read after: never said to be in.
  let unseen: InstagramShown[] = [];
  // Whether the account was read again: stopped before, nothing is said to be in.
  let looked = false;
  const checked = await instagramProfileRead(job, async ({ read, own, keptBio }) => {
    looked = true;
    const at = usernameAt(own);
    unseen = INSTAGRAM_SHOWN.filter((part) =>
      part === 'bio'
        ? bio !== null && clean(keptBio ?? read.bio) !== clean(bio)
        : part === 'username'
          ? username !== null &&
            !refused.has('username') &&
            (at === null || at.toLowerCase() !== username.toLowerCase())
          : name !== null && !refused.has('name') && !review && clean(read.name) !== name,
    );
    if (unseen.length)
      await job.report?.({
        job: 'profile_edit.check',
        note: `Not shown on the profile after it went in: ${unseen.map((p) => `the ${p}`).join(', ')}.`,
        outline: true,
      });
  });
  if (checked.failed) return checked;
  if (!looked) return checked.warned ? checked : STOPPED;
  const shown = {
    ...task,
    bio: unseen.includes('bio') ? null : bio,
    username: refused.has('username') || unseen.includes('username') ? null : task.username,
    name: refused.has('name') || review || unseen.includes('name') ? null : task.name,
  };
  const anyIn = Boolean(shown.bio || shown.name || shown.username || shown.links.length);
  const doneLine = !anyIn
    ? null
    : shown.bio && !hasNewProfileParts(shown)
      ? P.editDone(shown.bio)
      : profileEditDoneWords('instagram', shown);
  const after = [
    refused.get('username'),
    refused.get('name'),
    review && name ? nameReviewWords('instagram', name) : null,
    ...unseen.map((part) =>
      part === 'bio'
        ? `Instagram hasn’t shown your new bio on your profile yet. Check it there, and if it isn’t, press Edit profile, write “${bio ?? ''}” under Bio, and press Submit.`
        : centerUnseenWords('instagram', part, (part === 'name' ? name : username) ?? ''),
    ),
  ];
  return {
    line: [doneLine, ...after].filter((l): l is string => Boolean(l)).join(' '),
    warned: false,
    ...(refused.size || (!anyIn && !review) ? { failed: true } : {}),
  };
}

/** What the person is asked to do with the bio on Instagram, by where it stopped on its form. */
function instagramBioWords(bio: string, result: string, steps: FormSteps | undefined): string {
  if (result === 'not_saved')
    return `Instagram didn’t keep your new bio after Submit. On this page, check Bio says “${bio}”, and press Submit if it’s on. Then press Carry on.`;
  if (steps?.typed)
    return 'Your new bio is in its box on this page. Press Submit once Instagram turns it on, then press Carry on.';
  if (steps?.box)
    return `Put your new bio in: on this page, write “${bio}” under Bio, and press Submit. Then press Carry on.`;
  return `Put your new bio in: on Instagram press Edit profile, write “${bio}” under Bio, and press Submit. Then press Carry on.`;
}

/** Where the bio stopped on Instagram's form, in the extension's own words, for the note. */
function formMissing(result: string, steps: FormSteps | undefined): string {
  if (!steps?.box) return 'no box for the bio on the form';
  if (!steps.typed) return 'writing in the bio’s box didn’t take';
  if (!steps.submits) return 'no Submit on the form';
  if (!steps.submitOn) return 'Submit stayed off';
  return result === 'not_saved' ? 'Submit didn’t keep it' : 'the form didn’t keep it';
}

/**
 * The bio on Instagram's form, or by the person when the form isn't as expected: a warning there ends it first. Null
 * once it's in, or they carried on.
 */
async function instagramBio(job: Job, bio: string): Promise<JobEnd | null> {
  job.progress('Opening your Instagram profile’s form…');
  const form = await openForProfile(job, INSTAGRAM_FORM);
  if (isEnd(form)) return form;
  job.progress('Putting your new bio in…');
  const wrote = await job.tab.ask({ type: 'hfos-write-bio', bio });
  const result = wrote.ok && 'result' in wrote ? wrote.result : 'none';
  if (result === 'done') return null;
  const steps = wrote.ok && 'result' in wrote ? wrote.formSteps : undefined;
  // Something wasn't as expected: a warning on the form ends it, nothing more pressed.
  const warned = await warnedOn(job, await readOn('instagram')(job.tab));
  if (warned) return warned;
  if (!job.handOver)
    return {
      line: 'Instagram didn’t let the extension change your bio.',
      warned: false,
      failed: true,
    };
  // The person puts it in, and says when. The note of the page says which step.
  const reply = await job.handOver(instagramBioWords(bio, result, steps), {
    job: 'profile_edit.bio',
    note: `Not done: ${formMissing(result, steps)}.`,
    ...(steps ? { found: { ...steps } } : {}),
    outline: true,
  });
  if (reply !== 'carry_on') return STOPPED;
  return null;
}

// ------------------------------------------------------------------------------------------------ your Alignable profile

/** Alignable's own address for the person's profile: it shows it at their business's (the owner's Check, 0.62.0). */
const ALIGNABLE_MINE = 'https://www.alignable.com/biz/businesses/my_profile';
/** Tries at a code: a mistyped or an old one asks for the newest. */
const CODE_TRIES = 3;

/**
 * Read my profile, on Alignable: their own profile, read, noted, and sent for the AI's check. `after` looks at what was
 * read first (decision 99's parts that went in).
 */
export async function alignableProfileRead(
  job: Job,
  after?: (read: ProfileRead) => Promise<void>,
): Promise<JobEnd> {
  job.progress('Opening your Alignable profile…');
  const mine = await openForProfile(job, ALIGNABLE_MINE, 'alignable');
  if (isEnd(mine)) return mine;
  job.progress('Reading your profile…');
  const read = await ownRead(job, 'alignable');
  if (isEnd(read)) return read;
  await job.report?.({ ...ownProfileNote(read), outline: true });
  if (job.stopped()) return { line: 'Stopped.', warned: false };
  if (!read.name && !read.about)
    return {
      line: 'Alignable didn’t show your profile. Check you’re signed in to Alignable in this browser, then ask again.',
      warned: false,
      failed: true,
    };
  await after?.(read);
  job.progress('Checking it with the AI…');
  valueOf(await job.hfos({ type: 'hfos-profile-check', workspaceId: job.businessId, input: read }));
  return { line: P.readDone, warned: false };
}

/**
 * The code Alignable emailed, for one of decision 99's parts: asked of the person in HandsFreeOS and put in where
 * Alignable asks. `again` to ask the part again (taken, or mistyped with tries left), `none` when none came in its time
 * or it wasn't taken (the part is handed over then).
 */
async function partCode(job: Job, tries: { wrong: number; again: boolean }) {
  if (!job.code) return 'none' as const;
  const code = await job.code(askCodeWords('alignable', tries.again));
  if (job.stopped()) return { line: 'Stopped.', warned: false } satisfies JobEnd;
  if (!code) return 'none' as const;
  job.progress('Putting the code in…');
  const put = await job.tab.ask({ type: 'hfos-put-code', code });
  const taken = put.ok ? put.code : 'none';
  if (taken === 'none') return 'none' as const;
  if (taken === 'wrong') {
    tries.again = true;
    return ++tries.wrong >= CODE_TRIES ? ('none' as const) : ('again' as const);
  }
  tries.again = false;
  return 'again' as const;
}

/**
 * About Us, past the code Alignable emails (decision 82). Its Edit asks for the code; HandsFreeOS asks the person for
 * it (`job.code`), and it goes in where Alignable asks, then About Us is written and saved. A code that didn't work
 * asks for the newest. None in its 30 minutes hands them Try again: pressed, their profile is opened afresh and its
 * Edit asks Alignable for a new one. Anything else the person does by hand, and presses Carry on. Null once it's in.
 */
async function alignableAbout(job: Job, about: string): Promise<JobEnd | null> {
  job.progress('Putting your About Us in…');
  let result: string = 'none';
  let again = false;
  let wrong = 0;
  for (;;) {
    if (job.stopped()) return { line: 'Stopped.', warned: false };
    const wrote = await job.tab.ask({ type: 'hfos-write-about', about });
    result = wrote.ok && 'result' in wrote ? wrote.result : 'none';
    if (result !== 'code' || !job.code) break;
    const code = await job.code(askCodeWords('alignable', again));
    if (job.stopped()) return { line: 'Stopped.', warned: false };
    if (!code) {
      if (!job.handOver)
        return {
          line: `No code came from your email in ${ASK_CODE_MINUTES} minutes, so About Us wasn’t changed. Ask again, and Alignable emails a new one.`,
          warned: false,
          failed: true,
        };
      // None came in its time (Chris: "prompt the user to have the extension try again").
      const reply = await job.handOver(askCodeRanOutWords('alignable'), {
        note: `No code came in ${ASK_CODE_MINUTES} minutes.`,
      });
      if (reply !== 'carry_on') return { line: 'Stopped.', warned: false, failed: true };
      // Their profile afresh: its Edit asks Alignable for a new code.
      const reopened = await openForProfile(job, ALIGNABLE_MINE, 'alignable');
      if (isEnd(reopened)) return reopened;
      again = false;
      continue;
    }
    job.progress('Putting the code in…');
    const put = await job.tab.ask({ type: 'hfos-put-code', code });
    const taken = put.ok ? put.code : 'none';
    if (taken === 'none') {
      result = 'none';
      break;
    }
    if (taken === 'wrong' && ++wrong >= CODE_TRIES) break;
    again = taken === 'wrong';
    job.progress('Putting your About Us in…');
  }
  if (result === 'done') return null;
  // Something wasn't as expected: the person puts it in, and says when. The note of the page says which.
  await job.report?.({
    note: `About Us didn’t go in (${
      result === 'not_saved'
        ? 'Save didn’t keep it'
        : result === 'code'
          ? 'Alignable kept asking for a code'
          : 'no Edit, no box for About Us, or no Save'
    }).`,
    outline: true,
  });
  if (!job.handOver)
    return {
      line: 'Alignable didn’t let the extension change your About Us.',
      warned: false,
      failed: true,
    };
  const reply = await job.handOver(
    'Put your About Us in: on your Alignable profile press Edit by About Us, paste what HandsFreeOS wrote, and press Save. Then press Carry on.',
  );
  return reply === 'carry_on' ? null : { line: 'Stopped.', warned: false, failed: true };
}

/**
 * Put this one in, or Put these in, on Alignable: About Us (`alignableAbout`), then from 0.98.0 (decision 99) the
 * Elevator Pitch, the ideal customer and partner and the services (./own-parts.ts, src/networks/alignable/parts.ts),
 * each past the code Alignable may email first. Then it's read again for a new check.
 */
async function alignableProfileEdit(job: Job, task: EditTask): Promise<JobEnd> {
  const about = task.about;
  const every = hasEveryPart('alignable', task);
  if (!about && !every)
    return { line: 'Pick an About Us to put in first.', warned: false, failed: true };
  job.progress('Opening your Alignable profile…');
  const mine = await openForProfile(job, ALIGNABLE_MINE, 'alignable');
  if (isEnd(mine)) return mine;
  if (about) {
    const ended = await alignableAbout(job, about);
    if (ended) return ended;
  }
  const steps = partSteps('alignable', task, { profile: ALIGNABLE_MINE });
  if (steps.length) {
    const tries = { wrong: 0, again: false };
    const put = await putParts(job, steps, {
      open: async (url) => {
        const page = await openForProfile(job, url, 'alignable');
        return isEnd(page) ? page : null;
      },
      code: () => partCode(job, tries),
    });
    if (!Array.isArray(put)) return put;
  }
  let unseen = new Set<string>();
  const checked = await alignableProfileRead(job, async (read) => {
    unseen = every ? unseenParts('alignable', task, read) : new Set();
    if (unseen.size)
      await job.report?.({
        job: 'profile_edit.check',
        note: `Not shown on the profile after it went in: ${[...unseen].map((p) => `the ${p}`).join(', ')}.`,
        outline: true,
      });
  });
  if (checked.failed) return checked;
  if (!every) return { line: profileCheckWordsOn('alignable').editAboutDone, warned: false };
  const words = [
    profileEditDoneWords('alignable', shownParts(task, unseen)),
    unseenPartsWords('alignable', unseen),
  ];
  return { line: words.filter(Boolean).join(' '), warned: false };
}

/** What Instagram says when it isn't the person's own account in front of the extension. */
const SIGNED_IN_INSTAGRAM = 'Check you’re signed in to Instagram in this browser, then ask again.';

/** Check Instagram or Check Alignable: with its window in front the whole time, then the person's own back. */
function inFront(job: Job, work: (job: Job) => Promise<JobEnd>): Promise<JobEnd> {
  return job.tab.inFront ? job.tab.inFront(() => work(job)) : work(job);
}

/**
 * What an ask on Instagram or Alignable does that their own jobs don't: their Check, and their own profile read and put
 * in (core asks nothing else there that their jobs don't do, and an ask of a kind this build doesn't do ends saying
 * how to update).
 */
export function lookingAsk(platform: LookingPlatform) {
  return async (task: AskTaken['task'], job: Job): Promise<JobEnd> => {
    if (task.kind === 'checkup')
      return inFront(job, platform === 'instagram' ? checkupInstagram : checkupAlignable);
    // Instagram's own profile, before its steps (decision 80): read, and the bio put in.
    if (platform === 'instagram' && task.kind === 'profile_read')
      return inFront(job, instagramProfileRead);
    if (platform === 'instagram' && task.kind === 'profile_edit')
      return inFront(job, (j) => instagramProfileEdit(j, task));
    // Whether usernames are free there (decision 84).
    if (platform === 'instagram' && task.kind === 'username_check')
      return checkUsernames(job, 'instagram', task.usernames);
    // Alignable's, before its steps: read, and About Us put in past the code it emails (decision 82).
    if (platform === 'alignable' && task.kind === 'profile_read')
      return inFront(job, alignableProfileRead);
    if (platform === 'alignable' && task.kind === 'profile_edit')
      return inFront(job, (j) => alignableProfileEdit(j, task));
    const name = NETWORKS[platform].name;
    return {
      line: `This build of HandsFreeOS Social can’t do that on ${name} yet. Download the newest one, unzip it over the old folder, press Reload on Chrome’s Extensions page, and ask again.`,
      warned: false,
      failed: true,
    };
  };
}

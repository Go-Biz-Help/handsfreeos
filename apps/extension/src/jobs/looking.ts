/**
 * Check Instagram and Check Alignable (`checkup` on a network still looked at, docs/outreach.md decision 78): the plan's
 * "a look at a real account", from the person's own. One press opens the network's main pages one at a time, at a
 * person's pace, with its window in front, and notes each in HandsFreeOS with its outline (names and words hidden), so
 * the network's readers and steps can be built from its real pages. On the way it looks for each step's button
 * (src/networks/instagram/site.ts, src/networks/alignable/site.ts) and never presses the last: nothing is followed,
 * liked, connected, recommended, posted or sent. It stops on any warning of the network's, and ends at once when the
 * network asks the person to sign in.
 *
 * - **Instagram:** the feed, the person's own account and its form (the bio), a search, someone from their feed
 *   (Follow, which isn't tried on someone they follow, and Message, whose chat is opened and closed), one of their posts
 *   (Like, and the box to comment in, where a word is written and taken out to see Post show), the accounts Instagram
 *   suggests and up to three of them (Follow, on someone they don't follow), and their messages.
 * - **Alignable:** its signed-in pages at /biz (alignable.com/ is its public home page, signed in or not; the owner's
 *   first Check, 17 Oct 2026), then the places its menus lead to, those whose words say people, messages or posts
 *   first (never anything that signs out, pays or deletes), the person's own profile and a business's or a member's,
 *   looking for Connect, Message, Recommend, Like and a box to comment in on each until each is found.
 */
import type { AskTaken } from '@hfos/core/addons/outreach/asks';
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import type { LookingPlatform, LookingRead } from '../networks/looking/site';
import type { TryStep } from '../networks/tries';
import { Checkup, isEnd, SEARCH_WORDS } from './checkup';
import { readPageIn, type Job, type JobEnd, type JobTab } from './job';

/** Reads the page in the job's window as the network's: anything else means it sent the window elsewhere. */
const readOn =
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
  }
  if (stoppedEnd(job)) return stoppedEnd(job)!;
  const form = await c.open(`${INSTAGRAM}/accounts/edit/`, 'your profile’s form');
  if (isEnd(form)) return form;
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
  if (post) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const page = await c.open(post, 'a post');
    if (isEnd(page)) return page;
    await c.note('a post', null);
    await c.tryHere('like');
    await c.tryHere('comment');
  } else {
    await c.nothingFor(
      'like',
      'no post with its own link on their account, your feed or the search',
    );
    await c.nothingFor(
      'comment',
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

  // Your messages.
  if (stoppedEnd(job)) return stoppedEnd(job)!;
  const inbox = await c.open(`${INSTAGRAM}/direct/inbox/`, 'your messages');
  if (isEnd(inbox)) return inbox;
  await c.note('your messages', null);

  return c.end();
}

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
  for (const place of places.slice(0, PLACES_MOST)) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const page = await c.open(place.url, 'a page from Alignable’s menus');
    if (isEnd(page)) return page;
    await c.note(place.name, null);
    if (!people.length) people = page.people;
    await lookHere();
  }

  // Your own profile, then a business's or a member's.
  const own = reads.find((r) => r.own)?.own ?? null;
  if (own && !seen.has(new URL(own).pathname)) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const page = await c.open(own, 'your profile');
    if (isEnd(page)) return page;
    await c.note('your profile', null);
  }
  const someone = people[0]?.url ?? null;
  if (someone) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const theirs = await c.open(someone, 'someone’s profile');
    if (isEnd(theirs)) return theirs;
    await c.note('someone’s profile', null);
    await lookHere();
  }

  await c.noteLooks();
  return c.end();
}

/** Check Instagram or Check Alignable: with its window in front the whole time, then the person's own back. */
function inFront(job: Job, work: (job: Job) => Promise<JobEnd>): Promise<JobEnd> {
  return job.tab.inFront ? job.tab.inFront(() => work(job)) : work(job);
}

/**
 * What an ask on a network still looked at does: its Check, and nothing else yet (core asks it nothing else there, and
 * an ask of a kind this build doesn't do ends saying so).
 */
export function lookingAsk(platform: LookingPlatform) {
  return async (task: AskTaken['task'], job: Job): Promise<JobEnd> => {
    if (task.kind === 'checkup')
      return inFront(job, platform === 'instagram' ? checkupInstagram : checkupAlignable);
    const name = NETWORKS[platform].name;
    return {
      line: `The extension only reads ${name} for now, for Check ${name}: it can’t do that there yet.`,
      warned: false,
      failed: true,
    };
  };
}

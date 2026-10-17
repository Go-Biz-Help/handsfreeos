/**
 * Check Instagram and Check Alignable (`checkup` on a network still looked at, docs/outreach.md decision 78): the plan's
 * "a look at a real account", from the person's own. One press opens the network's main pages one at a time, at a
 * person's pace, with its window in front, and notes each in HandsFreeOS with its outline (names and words hidden), so
 * the network's readers and steps can be built from its real pages. On the way it looks for each step's button
 * (src/networks/instagram/site.ts, src/networks/alignable/site.ts) and presses none: nothing is followed, liked,
 * connected, recommended, written or sent. It stops on any warning of the network's.
 *
 * - **Instagram:** the feed, the person's own account and its form (the bio), a search, someone's account (Follow and
 *   Message), one of their posts (Like and the box to comment in) and their messages.
 * - **Alignable:** its home page, then the places its own menu leads to (its network, messages, the forum, its
 *   communities and the rest, by their words: never anything that signs out, pays or deletes), the person's own profile
 *   and a business's or a member's, looking for Connect, Message, Recommend, Like and a box to comment in on each until
 *   each is found.
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

// ------------------------------------------------------------------------------------------------ Instagram

const INSTAGRAM = 'https://www.instagram.com';

async function checkupInstagram(job: Job): Promise<JobEnd> {
  const c = new Checkup(job, 'instagram', readOn('instagram'));

  // Your feed: the accounts and posts it shows, and your own account from its menu.
  const feed = await c.open(`${INSTAGRAM}/`, 'your feed');
  if (isEnd(feed)) return feed;
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

  // Someone's account, from your feed or the search: Follow and Message looked for.
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
    await c.nothingFor('follow', 'no account on your feed or the search to open');
    await c.nothingFor('message', 'no account on your feed or the search to open');
  }

  // One of their posts, or one from your feed or the search: Like and the box to comment in looked for.
  const post = [...theirPosts, ...feed.posts, ...search.posts][0]?.url ?? null;
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

  // Your messages.
  if (stoppedEnd(job)) return stoppedEnd(job)!;
  const inbox = await c.open(`${INSTAGRAM}/direct/inbox/`, 'your messages');
  if (isEnd(inbox)) return inbox;
  await c.note('your messages', null);

  return c.end();
}

// ------------------------------------------------------------------------------------------------ Alignable

const ALIGNABLE = 'https://www.alignable.com';
/** The places worth opening from its menu, by their words: where people, messages and posts are. */
const WORTH =
  /\b(home|dashboard|network|connections?|messages?|inbox|forum|q\s*&\s*a|questions?|communit(y|ies)|groups?|events?|notifications?|profile|recommendations?|search|people|businesses)\b/i;
/** Never opened, whatever the menu calls them: signing out, paying, inviting, deleting, settings. */
const NEVER =
  /\b(log ?out|sign ?out|upgrade|premium|billing|pay|delete|deactivate|close account|invite|settings)\b/i;
const NEVER_AT = /(log_?out|sign_?out|destroy|delete|billing|upgrade|payment|invite)/i;
/** How many of its menu's places it opens. */
const PLACES_MOST = 8;
/** The steps looked for on each page, till each is found. */
const ALIGNABLE_STEPS: readonly TryStep[] = ['connect', 'message', 'recommend', 'like', 'comment'];

async function checkupAlignable(job: Job): Promise<JobEnd> {
  const c = new Checkup(job, 'alignable', readOn('alignable'));
  const lookHere = async () => {
    for (const step of ALIGNABLE_STEPS) if (!c.found(step)) await c.look(step);
  };

  // Its home page: its menu says where everything is.
  const home = await c.open(`${ALIGNABLE}/`, 'your home page');
  if (isEnd(home)) return home;
  await c.note('your home page', home.places.length);
  await lookHere();

  // Each place its menu leads to that's worth a look, by its words.
  const seen = new Set<string>([new URL(home.url).pathname]);
  const places = home.places.filter((p) => {
    const path = new URL(p.url).pathname;
    if (seen.has(path) || !WORTH.test(p.name) || NEVER.test(p.name) || NEVER_AT.test(path))
      return false;
    seen.add(path);
    return true;
  });
  let people: readonly { readonly url: string }[] = home.people;
  for (const place of places.slice(0, PLACES_MOST)) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const page = await c.open(place.url, `${place.name} on Alignable`);
    if (isEnd(page)) return page;
    await c.note(place.name, null);
    if (!people.length) people = page.people;
    await lookHere();
  }

  // Your own profile, then a business's or a member's.
  if (home.own && !seen.has(new URL(home.own).pathname)) {
    if (stoppedEnd(job)) return stoppedEnd(job)!;
    const own = await c.open(home.own, 'your profile');
    if (isEnd(own)) return own;
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

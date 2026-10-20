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
 *   (Like, and the box to comment in, where a word is written and taken out to see Post show), the accounts Instagram
 *   suggests and up to three of them (Follow, on someone they don't follow), and their messages.
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
  type AskTaken,
  type AskTask,
} from '@hfos/core/addons/outreach/asks';
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import {
  PROFILE_CHECK_WORDS as P,
  profileCheckWordsOn,
  type ProfileRead,
} from '@hfos/core/addons/outreach/profile-check';
import { townOf } from '../networks/alignable/site';
import type { LookingPlatform, LookingRead } from '../networks/looking/site';
import type { TryStep } from '../networks/tries';
import { Checkup, isEnd, SEARCH_WORDS, wholeProfile } from './checkup';
import { readPageIn, valueOf, warnedOn, type Job, type JobEnd, type JobTab } from './job';
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
  return null;
}

/** How many of one of the network's own readers' lists a page had (`LookingRead.found`). */
const countOf = (page: LookingRead, list: string): number => {
  const rows = page.found?.[list];
  return Array.isArray(rows) ? rows.length : 0;
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

/**
 * Read my profile, on Instagram (decision 80): their account's own page from the menu's Profile, then its form, whose
 * bio is the bio as kept; both read, noted, and sent for the AI's check.
 */
async function instagramProfileRead(job: Job): Promise<JobEnd> {
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

/** Put this one in, on Instagram: the bio on its form, then the profile read again for a new check. */
async function instagramProfileEdit(job: Job, task: EditTask): Promise<JobEnd> {
  const bio = task.bio;
  if (!bio) return { line: 'Pick a bio to put in first.', warned: false, failed: true };
  job.progress('Opening your Instagram profile’s form…');
  const form = await openForProfile(job, INSTAGRAM_FORM);
  if (isEnd(form)) return form;
  job.progress('Putting your new bio in…');
  const wrote = await job.tab.ask({ type: 'hfos-write-bio', bio });
  const result = wrote.ok && 'result' in wrote ? wrote.result : 'none';
  if (result !== 'done') {
    // Something wasn't as expected: the person puts it in, and says when. The note of the page says which.
    await job.report?.({
      note: `The bio didn’t go in (${result === 'not_saved' ? 'Submit didn’t keep it' : 'no box for the bio, or no Submit'}).`,
      outline: true,
    });
    if (!job.handOver)
      return {
        line: 'Instagram didn’t let the extension change your bio.',
        warned: false,
        failed: true,
      };
    const reply = await job.handOver(
      `Put your new bio in: on Instagram press Edit profile, write “${bio}” under Bio, and press Submit. Then press Carry on.`,
    );
    if (reply !== 'carry_on') return { line: 'Stopped.', warned: false, failed: true };
  }
  const checked = await instagramProfileRead(job);
  return checked.failed ? checked : { line: P.editDone(bio), warned: false };
}

// ------------------------------------------------------------------------------------------------ your Alignable profile

/** Alignable's own address for the person's profile: it shows it at their business's (the owner's Check, 0.62.0). */
const ALIGNABLE_MINE = 'https://www.alignable.com/biz/businesses/my_profile';
/** Tries at a code: a mistyped or an old one asks for the newest. */
const CODE_TRIES = 3;

/** Read my profile, on Alignable: their own profile, read, noted, and sent for the AI's check. */
async function alignableProfileRead(job: Job): Promise<JobEnd> {
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
  job.progress('Checking it with the AI…');
  valueOf(await job.hfos({ type: 'hfos-profile-check', workspaceId: job.businessId, input: read }));
  return { line: P.readDone, warned: false };
}

/**
 * Put this one in, on Alignable: About Us, past the code Alignable emails (decision 82). Its Edit asks for the code;
 * HandsFreeOS asks the person for it (`job.code`), and it goes in where Alignable asks, then About Us is written and
 * saved. A code that didn't work asks for the newest. None in its 30 minutes hands them Try again: pressed, their
 * profile is opened afresh and its Edit asks Alignable for a new one. Anything else the person does by hand, and
 * presses Carry on. Then it's read again for a new check.
 */
async function alignableProfileEdit(job: Job, task: EditTask): Promise<JobEnd> {
  const about = task.about;
  if (!about) return { line: 'Pick an About Us to put in first.', warned: false, failed: true };
  job.progress('Opening your Alignable profile…');
  const mine = await openForProfile(job, ALIGNABLE_MINE, 'alignable');
  if (isEnd(mine)) return mine;
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
  if (result !== 'done') {
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
    if (reply !== 'carry_on') return { line: 'Stopped.', warned: false, failed: true };
  }
  const checked = await alignableProfileRead(job);
  return checked.failed
    ? checked
    : { line: profileCheckWordsOn('alignable').editAboutDone, warned: false };
}

/** What Instagram says when it isn't the person's own account in front of the extension. */
const SIGNED_IN_INSTAGRAM = 'Check you’re signed in to Instagram in this browser, then ask again.';

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
    // Instagram's own profile, before its steps (decision 80): read, and the bio put in.
    if (platform === 'instagram' && task.kind === 'profile_read')
      return inFront(job, instagramProfileRead);
    if (platform === 'instagram' && task.kind === 'profile_edit')
      return inFront(job, (j) => instagramProfileEdit(j, task));
    // Alignable's, before its steps: read, and About Us put in past the code it emails (decision 82).
    if (platform === 'alignable' && task.kind === 'profile_read')
      return inFront(job, alignableProfileRead);
    if (platform === 'alignable' && task.kind === 'profile_edit')
      return inFront(job, (j) => alignableProfileEdit(j, task));
    const name = NETWORKS[platform].name;
    return {
      line: `The extension only reads ${name} for now, for Check ${name}: it can’t do that there yet.`,
      warned: false,
      failed: true,
    };
  };
}

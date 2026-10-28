/**
 * Check Facebook (`checkup`, docs/outreach.md decision 77), and what it shares with Check LinkedIn (./linkedin/checkup.ts,
 * decisions 74 and 76): one press when something on the network isn't working. It opens the person's main pages one
 * at a time and reads each as the other jobs do, and on the way tries each of the extension's steps up to its last press
 * (src/networks/facebook/tries.ts). Nothing is ever saved, posted, sent, liked, added, confirmed, cancelled, unfriended
 * or joined. Each page and each step is noted in HandsFreeOS with what it found (./report.ts), the outline kept when a
 * step doesn't work, so everything that doesn't is found in one go; the end's line names the steps that don't, and
 * those it found nothing to try on. Its window stays in front while it works, as Chrome draws nothing in a window
 * hidden behind another (put another over it, and it comes back in front for its next page or step), and then the
 * person's own comes back. It stops on any warning of the network's.
 *
 * On Facebook: their profile (the bio; with no Edit bio, on the About tab's editor Edit profile leads to), Contact and
 * basic info (adding a link), their feed, their friend requests (confirming; then View sent requests, as
 * Check your friend requests presses it, for someone to try cancelling on), their friends, their groups and one of them
 * (posting, and commenting on one of its posts), a people search (a friend request on someone they aren't friends
 * with), a groups search (joining one they aren't in), their chats, one friend's profile (liking, unfriending and
 * messaging, the last as it may open Messenger), the profile of someone they sent a request to (cancelling), their
 * notifications, their friends' birthdays, Accounts Center's username page for their Facebook profile (the username: no warning is read there
 * while Facebook asks them for something, as its "Confirm it's you" is none), and Download your information (the
 * file).
 */
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import { REPORT_WORDS, type TryStepName } from '@hfos/core/addons/outreach/reports';
import type { PageRead, ProfileRef } from '../networks/kit';
import { FACEBOOK } from '../networks/facebook/urls';
import { DOWNLOAD_PAGE } from '../networks/facebook/fetch';
import {
  ACCOUNTS_PROFILES,
  usernameAddress,
  usernamePageOf,
  type Asking,
} from '../networks/accounts-center/username';
import type { ReadResult } from '../networks/facebook/types';
import type { StepTry, TryStep } from '../networks/tries';
import { listOnPage } from '../hfos/saves';
import { MESSENGER } from './chats';
import { groupSearch, YOUR_GROUPS } from './groups';
import {
  pause,
  paced,
  readIn,
  warnedLine,
  warnedOn,
  type Job,
  type JobEnd,
  type JobTab,
} from './job';
import { FRIEND_REQUESTS, VIEW_SENT, YOUR_FRIENDS } from './people';
import { OWN_PROFILE_URL } from './profile';
import { BIRTHDAYS_PAGE } from './occasions';
import { loadNote, ownProfileNote, tryNote } from './report';

/** What the searches look for: everyday words, to see how the network draws its results. */
export const SEARCH_WORDS = 'small business';
/** Between pages: a person going from one to the next. */
const BETWEEN_MS = [2_500, 5_000] as const;

export const isEnd = (got: object): got is JobEnd => 'warned' in got;

/** The step's name, as the progress line says it: "Trying a friend request…". */
const TRYING: Readonly<Record<TryStep, string>> = {
  headline: 'your headline',
  about: 'your About',
  bio: 'your bio',
  links: 'your links',
  username: 'your username',
  post: 'a post',
  comment: 'a comment',
  connect: 'connecting',
  request: 'a friend request',
  message: 'a message',
  like: 'a like',
  confirm: 'confirming a request',
  withdraw: 'withdrawing',
  cancel: 'cancelling a request',
  unfriend: 'unfriending',
  join: 'joining a group',
  file: 'the data file',
  follow: 'following',
  recommend: 'recommending',
  pitch: 'your elevator pitch',
  ideal: 'your ideal customer',
  reactors: 'who liked a post',
  story: 'a story’s Like',
};

/**
 * The person's own profile read whole for the AI's check (the own profile's read; on LinkedIn it scrolls the profile to
 * its foot and back first), and what it read noted.
 */
export async function wholeProfile(job: Job, own: boolean): Promise<void> {
  const read = await job.tab.ask({ type: 'hfos-own-profile' });
  const got = read.ok && 'read' in read ? read : null;
  const note = loadNote(own && got ? ownProfileNote(got.read) : {}, got?.load);
  await job.report?.({ ...note, outline: true });
}

/** The person's work in the job's window on one network: pages read and steps tried, as it goes. */
export class Checkup<R extends PageRead> {
  pages = 0;
  readonly nothingOn: string[] = [];
  readonly tries: StepTry[] = [];
  /** Steps looked for and not noted yet (`look`). */
  private readonly looked: StepTry[] = [];

  constructor(
    private readonly job: Job,
    private readonly platform: Platform,
    private readonly read: (tab: JobTab) => Promise<R>,
  ) {}

  /** Opens a page and reads it, at a person's pace after the first; a warning of the network's ends the job. */
  async open(url: string, name: string): Promise<R | JobEnd> {
    if (this.pages > 0) await pause(paced(BETWEEN_MS));
    this.job.progress(`Checking ${name}…`);
    await this.job.tab.open(url);
    return this.readHere();
  }

  /**
   * Reads the page the tab shows again, a few times a moment apart, till it shows what's wanted: a form drawn after its
   * page opens (Alignable's). Not a page more.
   */
  async readTill(page: R, ready: (page: R) => boolean, looks = 4): Promise<R | JobEnd> {
    for (let look = 0; look < looks && !ready(page); look++) {
      await pause(1_500);
      page = await this.read(this.job.tab);
      const warned = await warnedOn(this.job, page);
      if (warned) return warned;
    }
    return page;
  }

  /**
   * Opens a page without reading it yet, at a person's pace after the first: one whose warnings are read only once it's
   * known Facebook isn't asking the person for something there (Accounts Center's username page).
   */
  async openUnread(url: string, name: string): Promise<void> {
    if (this.pages > 0) await pause(paced(BETWEEN_MS));
    this.job.progress(`Checking ${name}…`);
    await this.job.tab.open(url);
    this.pages++;
  }

  /** Reads the page the tab shows now, as `open` does: what a press there opened. */
  async readHere(): Promise<R | JobEnd> {
    const page = await this.read(this.job.tab);
    const warned = await warnedOn(this.job, page);
    if (warned) return warned;
    this.pages++;
    return page;
  }

  /**
   * Notes the page with its outline, and says when its readers found nothing on it. With no count, none is expected:
   * nobody may have asked to be friends.
   */
  async note(name: string, count: number | null): Promise<void> {
    await this.job.report?.({ outline: true });
    if (count === 0) this.nothingOn.push(name);
  }

  /**
   * Tries a step on the page the tab shows, notes how it went, and says: with its window back in front first, when the
   * person put another over it since the page opened.
   */
  async tryHere(step: TryStep, profile?: ProfileRef): Promise<StepTry> {
    this.job.progress(`Trying ${TRYING[step]}…`);
    await this.job.tab.keepInFront?.();
    const answer = await this.job.tab.ask({
      type: 'hfos-try',
      step,
      ...(profile ? { profile } : {}),
    });
    const tried: StepTry = answer.ok
      ? answer.tried
      : { step, tried: true, works: false, found: {}, missing: [answer.error] };
    return this.noted(tried);
  }

  /** A step the job itself found didn't work on the way to it (View sent requests missing, say): noted as tried. */
  async failed(step: TryStep, why: string, found: Record<string, number | boolean> = {}) {
    return this.noted({ step, tried: true, works: false, found, missing: [why] });
  }

  /**
   * Looks for a step's button on the page the tab shows, without noting it yet: a network still looked at (decision 78)
   * looks for each on several pages, and `noteLooks` notes the best of each once.
   */
  async look(step: TryStep): Promise<StepTry> {
    const answer = await this.job.tab.ask({ type: 'hfos-try', step });
    const tried: StepTry = answer.ok
      ? answer.tried
      : { step, tried: true, works: false, found: {}, missing: [answer.error] };
    this.looked.push(tried);
    return tried;
  }

  /** Whether a step's button was found yet, on any page looked at. */
  found(step: TryStep): boolean {
    return this.looked.some((t) => t.step === step && t.works);
  }

  /**
   * Notes the best of each step looked for: where it was found, else the last page it wasn't, with what was there
   * instead. The pages' own notes carry their outlines.
   */
  async noteLooks(): Promise<void> {
    const best = new Map<TryStep, StepTry>();
    for (const tried of this.looked) {
      const before = best.get(tried.step);
      if (!before?.works) best.set(tried.step, tried);
    }
    for (const tried of best.values()) {
      this.tries.push(tried);
      await this.job.report?.({ ...tryNote(tried), outline: false });
    }
  }

  /** A step with nothing to try it on: noted as such, nothing opened. */
  async nothingFor(step: TryStep, why: string): Promise<void> {
    const tried: StepTry = { step, tried: false, works: false, found: {}, missing: [why] };
    this.tries.push(tried);
    await this.job.report?.({ ...tryNote(tried), outline: false });
  }

  /** Whether a step was tried or noted yet, any way. */
  has(step: TryStep): boolean {
    return this.tries.some((t) => t.step === step);
  }

  /**
   * The steps as the end's line counts them: one tried two ways (LinkedIn's messaging, on the profile and on the page
   * its Message links to; Facebook's friend request, on a few people from the search) works when either does.
   */
  steps(): StepTry[] {
    const each = new Map<TryStep, StepTry>();
    for (const tried of this.tries) {
      const before = each.get(tried.step);
      if (!before || (tried.works && !before.works) || (tried.tried && !before.tried))
        each.set(tried.step, tried);
    }
    return [...each.values()];
  }

  /** The end: a note of how it all went, and the line the ask ends with. */
  async end(): Promise<JobEnd> {
    const steps = this.steps();
    const names = (pick: (t: StepTry) => boolean) =>
      steps.filter(pick).map((t) => t.step as TryStepName);
    const broken = names((t) => t.tried && !t.works);
    const untried = names((t) => !t.tried);
    const line = REPORT_WORDS.checkupTried(
      NETWORKS[this.platform].name,
      this.pages,
      broken,
      untried,
      steps.length,
    );
    await this.job.report?.({
      job: 'checkup.summary',
      found: {
        pages: this.pages,
        steps: steps.length,
        working: steps.filter((t) => t.works).length,
        ...(broken.length ? { notWorking: broken } : {}),
        ...(untried.length ? { nothingToTry: untried } : {}),
        ...(this.nothingOn.length ? { nothingRead: this.nothingOn } : {}),
      },
      note: line,
      outline: false,
    });
    return { line, warned: false };
  }

  private async noted(tried: StepTry): Promise<StepTry> {
    this.tries.push(tried);
    await this.job.report?.(tryNote(tried));
    return tried;
  }
}

/** Reads the page in the job's window, as Facebook's. */
const readFacebook = (tab: JobTab): Promise<ReadResult> => readIn(tab);

/** How many people from the search are looked at for someone to try a friend request on, and groups to try joining. */
const SEARCH_LOOKS = 3;

async function checkup(job: Job): Promise<JobEnd> {
  const c = new Checkup(job, 'facebook', readFacebook);
  const stopped = (): JobEnd | null => (job.stopped() ? { line: 'Stopped.', warned: false } : null);

  // Your profile: read whole, then putting the bio in tried; with no Edit bio, again on the About tab's editor Edit
  // profile leads to (decision 89). Then adding a link, on Contact and basic info where Edit links leads.
  const own = await c.open(OWN_PROFILE_URL, 'your profile');
  if (isEnd(own)) return own;
  await wholeProfile(job, true);
  const places = await job.tab.ask({ type: 'hfos-own-editors' });
  const editors = places.ok ? places.editors : null;
  const bio = await c.tryHere('bio');
  if (!bio.works && bio.next) {
    if (stopped()) return stopped()!;
    const editor = await c.open(bio.next, 'where your bio is changed');
    if (isEnd(editor)) return editor;
    await c.tryHere('bio');
  }
  if (editors?.links) {
    if (stopped()) return stopped()!;
    const links = await c.open(editors.links, 'where your links are changed');
    if (isEnd(links)) return links;
    await c.tryHere('links');
  } else await c.failed('links', 'no Edit links on your profile', { editLinks: false });

  // Your feed.
  if (stopped()) return stopped()!;
  const feed = await c.open(`${FACEBOOK}/`, 'your feed');
  if (isEnd(feed)) return feed;
  await c.note('your feed', feed.posts?.length ?? 0);

  // Your friend requests: confirming tried; then View sent requests, as Check your friend requests presses it, and
  // someone you sent one to kept to try cancelling.
  if (stopped()) return stopped()!;
  const requests = await c.open(FRIEND_REQUESTS, 'your friend requests');
  if (isEnd(requests)) return requests;
  await c.note('your friend requests', null);
  await c.tryHere('confirm');
  let sentTo: ProfileRef | null = null;
  const viewed = await job.tab.ask({
    type: 'hfos-fetch-step',
    step: VIEW_SENT,
    waitMs: 8_000,
    lists: true,
  });
  if (viewed.ok && (viewed.result === 'done' || viewed.result === 'already')) {
    await pause(2_000);
    const sent = await c.readHere();
    if (isEnd(sent)) return sent;
    await c.note('the friend requests you’ve sent', null);
    const mine = listOnPage(sent);
    sentTo = mine?.list === 'sent' ? (mine.people.find((p) => p.profile)?.profile ?? null) : null;
  } else
    await c.failed('cancel', 'no View sent requests on your friend requests page', {
      viewSent: false,
    });

  // Your friends, and the first kept to like, unfriend and message.
  if (stopped()) return stopped()!;
  const friends = await c.open(YOUR_FRIENDS, 'your friends');
  if (isEnd(friends)) return friends;
  await c.note('your friends', friends.people?.length ?? 0);
  const friend = friends.people?.find((p) => p.profile)?.profile ?? null;

  // Your groups, and the first of them: posting tried there, and commenting on one of its posts on its own page.
  if (stopped()) return stopped()!;
  const groups = await c.open(YOUR_GROUPS, 'your groups');
  if (isEnd(groups)) return groups;
  await c.note('your groups', groups.groups?.length ?? 0);
  const yours = groups.groups?.[0] ?? null;
  let postUrl: string | null = null;
  if (yours) {
    if (stopped()) return stopped()!;
    const group = await c.open(yours.group.url, 'one of your groups');
    if (isEnd(group)) return group;
    await c.note('one of your groups', group.posts?.length ?? 0);
    await c.tryHere('post');
    postUrl = group.posts?.find((p) => p.url && p.author?.profile)?.url ?? null;
  } else await c.nothingFor('post', 'you’re in no groups to post in');
  // Else a person's post from your feed.
  postUrl ??= feed.posts?.find((p) => p.url && p.author?.profile)?.url ?? null;
  if (postUrl) {
    if (stopped()) return stopped()!;
    const post = await c.open(postUrl, 'a post');
    if (isEnd(post)) return post;
    await c.tryHere('comment');
  } else
    await c.nothingFor(
      'comment',
      'no person’s post with its own link, in your group or on your feed',
    );

  // A people search, and someone in it you aren't friends with: a friend request tried on their profile.
  if (stopped()) return stopped()!;
  const people = await c.open(
    `${FACEBOOK}/search/people/?q=${encodeURIComponent(SEARCH_WORDS)}`,
    'the people search',
  );
  if (isEnd(people)) return people;
  await c.note('the people search', people.people?.length ?? 0);
  for (const person of (people.people ?? []).filter((p) => p.profile).slice(0, SEARCH_LOOKS)) {
    if (stopped()) return stopped()!;
    const theirs = await c.open(person.profile!.url, 'someone from the search');
    if (isEnd(theirs)) return theirs;
    const tried = await c.tryHere('request');
    if (tried.tried) break;
  }
  if (!c.has('request'))
    await c.nothingFor('request', 'nobody in the search with a profile to open');

  // A groups search, and a group in it you aren't in: joining tried there.
  if (stopped()) return stopped()!;
  const found = await c.open(groupSearch(SEARCH_WORDS), 'the groups search');
  if (isEnd(found)) return found;
  await c.note('the groups search', found.groups?.length ?? 0);
  const joined = new Set((groups.groups ?? []).map((g) => g.group.id));
  for (const other of (found.groups ?? [])
    .filter((g) => !joined.has(g.group.id))
    .slice(0, SEARCH_LOOKS)) {
    if (stopped()) return stopped()!;
    const page = await c.open(other.group.url, 'a group from the search');
    if (isEnd(page)) return page;
    const tried = await c.tryHere('join');
    if (tried.tried) break;
  }
  if (!c.has('join')) await c.nothingFor('join', 'no group in the search you aren’t in');

  // Your chats.
  if (stopped()) return stopped()!;
  const chats = await c.open(MESSENGER, 'your chats');
  if (isEnd(chats)) return chats;
  await c.note('your chats', chats.chats?.length ?? 0);

  // One friend: liking, unfriending and messaging tried on their profile, messaging last as it may open Messenger.
  if (friend) {
    if (stopped()) return stopped()!;
    const theirs = await c.open(friend.url, 'one friend’s profile');
    if (isEnd(theirs)) return theirs;
    await c.note('one friend’s profile', null);
    await c.tryHere('like', friend);
    await c.tryHere('unfriend', friend);
    await c.tryHere('message', friend);
  } else {
    const why = 'no friend on your friends list to try it with';
    await c.nothingFor('like', why);
    await c.nothingFor('unfriend', why);
    await c.nothingFor('message', why);
  }

  // Someone you sent a request to: cancelling tried on their profile.
  if (sentTo) {
    if (stopped()) return stopped()!;
    const theirs = await c.open(sentTo.url, 'someone you sent a request to');
    if (isEnd(theirs)) return theirs;
    await c.tryHere('cancel');
  } else if (!c.has('cancel')) await c.nothingFor('cancel', 'no friend requests you’ve sent');

  // Your notifications, your friends' birthdays, your username in Accounts Center, and Download your information.
  if (stopped()) return stopped()!;
  const notices = await c.open(`${FACEBOOK}/notifications`, 'your notifications');
  if (isEnd(notices)) return notices;
  await c.note('your notifications', notices.notices?.length ?? 0);
  // Your friends' birthdays (decision 108).
  if (stopped()) return stopped()!;
  const birthdays = await c.open(BIRTHDAYS_PAGE, 'your friends’ birthdays');
  if (isEnd(birthdays)) return birthdays;
  await c.note('your friends’ birthdays', birthdays.people?.length ?? 0);
  if (stopped()) return stopped()!;
  const ended = await tryUsername(job, c, editors?.id ?? null);
  if (ended) return ended;
  if (stopped()) return stopped()!;
  const file = await c.open(DOWNLOAD_PAGE, 'Download your information');
  if (isEnd(file)) return file;
  await c.tryHere('file');

  return c.end();
}

/** What Facebook asked for first on Accounts Center's Profiles, as the step with nothing to try on says it. */
const PROFILES_ASK: Readonly<Record<Asking, string>> = {
  password: 'Facebook asks for your password first, so its profiles don’t show',
  code: 'Facebook asks for a code first, so its profiles don’t show',
  confirm: 'Facebook asks you to confirm it’s you first, so its profiles don’t show',
};

/**
 * Your username, on Accounts Center's username page for your Facebook profile (by its number; else Profiles, and the
 * Facebook one there): its box and Done tried, never pressed, only on that profile's page. Its warnings are read only
 * while Facebook asks for nothing there (the tab decides): its "Confirm it's you" is no warning (decision 25). How it
 * ended, when a warning ended it.
 */
async function tryUsername(
  job: Job,
  c: Checkup<ReadResult>,
  id: string | null,
): Promise<JobEnd | null> {
  const warnedThere = async (at: string): Promise<JobEnd | null> => {
    const here = await job.tab.ask({ type: 'hfos-account-warnings' });
    if (!here.ok || !here.warnings.length) return null;
    await job.warn(here.warnings, at);
    return { line: warnedLine(here.warnings), warned: true };
  };
  let url = usernameAddress(id);
  if (!url) {
    await c.openUnread(ACCOUNTS_PROFILES, 'Accounts Center’s profiles');
    const found = await job.tab.ask({ type: 'hfos-username-page' });
    if (found.ok && found.warnings.length) {
      await job.warn(found.warnings, ACCOUNTS_PROFILES);
      return { line: warnedLine(found.warnings), warned: true };
    }
    if (found.ok && found.asking) {
      await c.nothingFor('username', PROFILES_ASK[found.asking]);
      return null;
    }
    url = found.ok ? found.url : null;
    if (!url) {
      const warned = await warnedThere(ACCOUNTS_PROFILES);
      if (warned) return warned;
      await c.failed('username', 'no Facebook profile among Accounts Center’s profiles', {
        profile: false,
      });
      return null;
    }
  }
  const number = usernamePageOf(url);
  await c.openUnread(url, 'where your username is changed');
  await c.tryHere(
    'username',
    number
      ? { id: number, username: null, url: `${FACEBOOK}/profile.php?id=${number}` }
      : undefined,
  );
  return warnedThere(url);
}

/** Check Facebook: with its window in front the whole time, then the person's own back. */
export async function checkFacebook(job: Job): Promise<JobEnd> {
  return job.tab.inFront ? job.tab.inFront(() => checkup(job)) : checkup(job);
}

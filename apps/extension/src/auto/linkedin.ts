/**
 * LinkedIn's runner (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by part", 5): the extension
 * on its own on LinkedIn, beside Facebook's runner (./run.ts) and never waiting on it. It has its own line (its own
 * turn with LinkedIn's asks, ./turns.ts), its own window, its own alarm and its own state (`hfos.auto.linkedin`).
 *
 * - **In the working hours, or once its day is started.** From 0.96.0 it starts on its own in the person's working
 *   hours, in the business's time zone, at random times spread over the day as Facebook's does (./plan.ts,
 *   `networkDay`); LinkedIn's Start my day, pressed in HandsFreeOS or on the phone, which the beat brings
 *   (`days.linkedin`), starts it straight away at a person's pace. Stop for today there ends what it's doing at its
 *   next page, and its asks' too, until its next working hours. It works only while LinkedIn is on for the person and
 *   Chrome allows it, while noting is on, while this computer is the one that works, and while the person's LinkedIn
 *   Sending choice isn't Off.
 * - **Lists first** (decision 60): before LinkedIn's first day, its connections and the invitations either way are
 *   saved to their end, the old invitations to withdraw worked out and the connections checked once (./lists.ts);
 *   after that the invitations each morning and the connections weekly.
 * - **Once a day,** as the person's LinkedIn choices say (`collect`): the invitations, the connections checked for good
 *   fits (40 profiles a day: each is seen), their chats read for the AI, posts found with LinkedIn's post search, and
 *   today's helpful post asked for (for their own feed) with who engaged with those up lately read. From 0.95.0
 *   (decision 92) the post search goes with the playbooks' own phrases, who reacted to and commented on the good posts
 *   it found is read (`post_people`, ../jobs/linkedin/post-people.ts), and the people found are checked by the AI from
 *   their own profiles, last, inside the 40 profiles read (`found_checks`).
 * - **Today's helpful post,** when their LinkedIn posting choice lets it post on its own (`posting: 'own'`): put up on
 *   their own feed once the AI has written it (../jobs/linkedin/helpful.ts).
 * - **Then LinkedIn's list for today** (`outreach.today` with `platform: 'linkedin'`), the kinds it does on its own
 *   (`auto`): a look at their profile and a like on a post of theirs (warm-up; for a writer a search found, the post it
 *   found, liked on its own page), an invitation to connect without a note (Chris), and the messages: drafted after a
 *   look-up, and sent once OK'd, in LinkedIn messaging, typing only into that conversation's box. From 0.99.0 a comment
 *   on a good post goes as Instagram's and Alignable's do (decision 102, ./comments.ts): drafted from the post to wait
 *   for the person's OK at first, then written in the post's own box. Invitations they sent you are left for them to
 *   accept. Old invitations are withdrawn only when the person ticks them (their ask, ../asks/run.ts).
 * - **At LinkedIn's pace:** a few minutes between steps, within LinkedIn's own limits, which HandsFreeOS keeps (its
 *   list holds only what they have room for, the week's 80 invitations among them).
 * - **Stops on any LinkedIn warning,** for the day, on LinkedIn alone: Facebook's runner goes on.
 *
 * Each step is noted as the extension's own (`auto`), as LinkedIn's (`platform: 'linkedin'`).
 */
import { businessDay } from '@hfos/core/addons/outreach/automation';
import type { MessageKind } from '@hfos/core/addons/outreach/automation';
import { ASK_FIRST_WORDS } from '@hfos/core/addons/outreach/asks';
import { CHECKS_PER_DAY } from '@hfos/core/addons/outreach/checks';
import {
  fallbackLikePick,
  LIKE_POSTS_READ,
  likedText,
  neverLike,
} from '@hfos/core/addons/outreach/like-pick';
import { standDownWords } from '@hfos/core/addons/outreach/live';
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import { messageParts, partPauseMs } from '@hfos/core/addons/outreach/voice';
import type { TodayKind } from '@hfos/core/addons/outreach/today';
import { follow, loadSettings } from '../hfos/follow';
import { feed, keptFor, onBeat, type Kept } from '../hfos/live';
import type { Drafts, TodayList, TodayListItem } from '../hfos/messages';
import { isNoting, noteNeed, takeNote } from '../hfos/noting';
import { chatCollect } from '../hfos/saves';
import { answer, api, call, Refused, savingTo } from '../hfos/session';
import { keepWarning, warnedNow, warningInput } from '../hfos/warned';
import { chatMemory, LINKEDIN_MESSAGING, readChats } from '../jobs/chats';
import { valueOf, warnedLine, type Hfos, type Job, type JobEnd } from '../jobs/job';
import { reporter } from '../jobs/report';
import { checkConnections, isThem, readThemOnLinkedIn } from '../jobs/linkedin/checks';
import { checkFound } from '../jobs/found-checks';
import { checkPartners } from '../jobs/partners';
import { linkedInProfileRead } from '../jobs/linkedin/profile';
import { linkedInOccasions } from '../jobs/occasions';
import { readProfileOnItsOwn } from '../jobs/own-read';
import { PARTNER_CHECKS_PER_DAY } from '@hfos/core/addons/outreach/partners';
import { lookUpOnLinkedIn } from '../jobs/linkedin/lookup';
import { postOnLinkedIn, linkedInHelpfulDaily } from '../jobs/linkedin/helpful';
import { checkInvitations } from '../jobs/linkedin/people';
import { findPostsBySearch } from '../jobs/linkedin/posts';
import { readPostPeople } from '../jobs/linkedin/post-people';
import { searchLinkedIn } from '../jobs/linkedin/partner-search';
import { withdrawOnItsOwn } from '../jobs/linkedin/withdraw';
import { LINKEDIN, readLinkedIn } from '../jobs/linkedin/read';
import { linkedin, type LinkedInRead } from '../networks';
import type { ProfileRef, ThreadRef } from '../networks/linkedin/types';
import { comparable, postOf, profileRefOf, sameMember } from '../networks/linkedin/urls';
import { isWorking, statesNow } from '../networks/on';
import { WorkTab } from '../tab';
import {
  commentDoing,
  draftComment,
  isCommentWork,
  sendComment,
  type CommentOutcome,
  type CommentRunner,
} from './comments';
import { DAILY_CHATS } from './daily';
import {
  beforeDay,
  beforeDayDoing,
  beforeDayLine,
  doBeforeDay,
  markOf,
  type BeforeDay,
} from './lists';
import {
  freshState,
  gapAfter,
  HELPFUL_AGAIN_MS,
  helpfulDue,
  isState,
  LINKEDIN_STATE_KEY,
  needOf,
  networkDay,
  networkWaitWords,
  nextStart,
  workKey,
  workLeft,
  type AutoState,
  type DailyJob,
  type DoneKind,
  type OwnDailyJob,
  type Work,
} from './plan';
import { askInLine, inTurn } from './turns';
import { haltAsk } from '../asks/run';

const PLATFORM: Platform = 'linkedin';
const NAME = NETWORKS.linkedin.name;

export const LINKEDIN_ALARM = 'hfos-auto-linkedin';

/**
 * The kinds it does on its own on LinkedIn, in order: invitations they sent are theirs to accept. From 0.99.0 a comment
 * on a good post is drafted and sent through `sends` (decision 102), as Instagram's and Alignable's are, never as a step.
 */
export const LINKEDIN_AUTO: readonly TodayKind[] = ['warm_up', 'friend_request'];
/**
 * The once-a-day jobs on LinkedIn, in order. From 0.97.0 it withdraws old invitations on its own after checking the
 * new ones (`tidy`, decision 98), as the person chose; from 0.100.0 it then reads Catch up for birthdays and new jobs
 * (`occasions`, decision 108), for a note on Today that waits for the person's OK. From 0.95.0 (decision 92) who reacted to and commented on the good posts
 * its search found is read after the helpful post (`post_people`), and the people found are checked last
 * (`found_checks`), inside its 40 profiles read, found people first.
 */
export const LINKEDIN_DAILY = [
  'requests',
  'tidy',
  'occasions',
  'checks',
  'chats',
  'posts',
  'partners',
  'helpful',
  'post_people',
  'found_checks',
  'profile',
] as const satisfies readonly (DailyJob | OwnDailyJob)[];
type LinkedInDaily = (typeof LINKEDIN_DAILY)[number];

const DAILY_DOING: Readonly<Record<LinkedInDaily, string>> = {
  requests: 'Checking your invitations on LinkedIn…',
  occasions: 'Reading Catch up on LinkedIn for birthdays and new jobs…',
  tidy: 'Withdrawing your old invitations on LinkedIn…',
  checks: 'Checking your connections for good fits…',
  chats: 'Reading your LinkedIn chats for the AI…',
  posts: 'Finding posts with LinkedIn’s post search…',
  partners: 'Searching LinkedIn for people who could partner with you, then reading them…',
  helpful: 'Asking for today’s helpful post for your feed, and reading who engaged…',
  post_people: 'Reading who reacted to and commented on good posts on LinkedIn…',
  found_checks: 'Checking the people found on LinkedIn for good fits…',
  profile: 'Reading your LinkedIn profile, as it does on the 1st of each month…',
};
const DAILY_NAMES: Readonly<Record<LinkedInDaily, string>> = {
  requests: 'Invitations',
  occasions: 'Birthdays and new jobs',
  tidy: 'Tidy up',
  checks: 'Check my connections',
  chats: 'Read my chats',
  posts: 'Find posts',
  partners: 'Find partners',
  helpful: 'Helpful posts',
  post_people: 'Who reacted and commented',
  found_checks: 'Check the people found',
  profile: 'Read my profile',
};

/** LinkedIn's pace between steps: slower than Facebook's, a person's. */
export const LINKEDIN_GAP_MS = { least: 2 * 60_000, most: 6 * 60_000 } as const;
/** While LinkedIn draws what a press opened. */
const SETTLE_MS = 2_000;
/** A gap longer than this closes its window until the next step. */
const KEEP_WINDOW_MS = 5 * 60_000;
/** After something went wrong, it tries again this much later. */
const AGAIN_MS = 15 * 60_000;
/** While noting is off, it looks again this often. */
const LOOK_AGAIN_MS = 30 * 60_000;
/** While an ask on LinkedIn goes first, it looks again after this. */
const ASK_FIRST_MS = 2 * 60_000;

const tab = new WorkTab('window', linkedin);
/** LinkedIn's runner's window's tab, while it's open: what the person sees there isn't theirs to note. */
export const linkedInRunnerTabId = (): number | null => tab.tabId;

let busy = false;
/** LinkedIn's Stop for today, or another computer working now: a job under way ends at its next page. */
let stopAsked = false;
let again = false;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const now = () => new Date().toISOString();
const pickGap = (random: number) =>
  Math.round(LINKEDIN_GAP_MS.least + random * (LINKEDIN_GAP_MS.most - LINKEDIN_GAP_MS.least));

// ------------------------------------------------------------------------------------------------- state

async function stateNow(): Promise<AutoState> {
  try {
    const value: unknown = (await chrome.storage.local.get(LINKEDIN_STATE_KEY))[LINKEDIN_STATE_KEY];
    return isState(value) ? value : freshState(null);
  } catch {
    return freshState(null);
  }
}

let writing: Promise<unknown> = Promise.resolve();
function setState(change: Partial<AutoState>): Promise<AutoState> {
  const write = writing.then(async () => {
    const next = { ...(await stateNow()), ...change };
    await chrome.storage.local.set({ [LINKEDIN_STATE_KEY]: next });
    return next;
  });
  writing = write.catch(() => undefined);
  return write;
}

const say = (line: string, more: Partial<AutoState> = {}) =>
  setState({ line, lineAt: Date.now(), needs: false, ...more });

async function goAt(when: number | null): Promise<void> {
  if (when === null) await chrome.alarms.clear(LINKEDIN_ALARM);
  else await chrome.alarms.create(LINKEDIN_ALARM, { when: Math.max(when, Date.now() + 30_000) });
  await setState({ nextAt: when });
}

async function closeWindow(): Promise<void> {
  await tab.close();
  await setState({ tabId: null });
}

// ------------------------------------------------------------------------------------------------- LinkedIn

/** What a step came to: done, passed over (handed to the person with `need`), or a stop for the day. */
type Outcome =
  | { readonly done: true; readonly line: string }
  | { readonly done: false; readonly line: string; readonly need?: true }
  | { readonly stop: string };

/** Stops for the day on LinkedIn's warning on the page, noting it in HandsFreeOS once as LinkedIn's. */
async function warnedOn(page: LinkedInRead, businessId: string): Promise<string | null> {
  if (!page.warnings.length) return null;
  const fresh = await keepWarning(page.warnings, PLATFORM);
  if (fresh.length)
    await answer({
      type: 'hfos-warning',
      input: warningInput(businessId, fresh, page.url, PLATFORM),
    });
  return warnedLine(page.warnings, NAME);
}

const read = () => readLinkedIn(tab);

/** Opens someone's profile (a look they see) and checks it's them: the page, and the profile to note against. */
async function openProfile(
  item: TodayListItem,
  businessId: string,
): Promise<
  | { readonly page: LinkedInRead; readonly noted: ProfileRef; readonly name: string }
  | { readonly outcome: Outcome }
> {
  const want = item.profileUrl ? profileRefOf(item.profileUrl) : null;
  if (!want) return { outcome: { done: false, line: `${item.name}: no LinkedIn profile kept` } };
  await tab.open(want.url);
  await setState({ tabId: tab.tabId });
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { outcome: { stop } };
  const shown = page.profile;
  if (page.kind !== 'profile' || !shown?.profile || !isThem(shown, want, item.name))
    return {
      outcome: { done: false, line: `${item.name}: LinkedIn showed a different page`, need: true },
    };
  const noted = {
    id: want.id ?? shown.profile.id,
    username: want.username ?? shown.profile.username,
    url: want.url,
  };
  return { page, noted, name: shown.name ?? item.name };
}

/** Says a warm-up had nothing to like: the invitation goes without. */
async function missed(item: TodayListItem, businessId: string, line: string): Promise<Outcome> {
  await call(
    api().POST('/v1/commands/outreach.warm_up.missed', {
      body: { workspaceId: businessId, profileId: item.profileId! },
    }),
    businessId,
  );
  return { done: false, line };
}

/** What comes after a warm-up, in words: the invitation, or for a partner the ask about partnering (decision 81). */
interface After {
  readonly without: string;
  readonly next: string;
}

/**
 * The like on the post a search found them by (decision 92), on that post's own page: their post, by its link, when
 * nothing rules it out (never one about grief, illness or trouble). One liked already counts. Null when the post is
 * gone, isn't theirs or isn't one to like: then one of their latest is liked instead.
 */
async function likeFoundPost(
  item: TodayListItem,
  businessId: string,
  after: After,
): Promise<Outcome | null> {
  const want = item.profileUrl ? profileRefOf(item.profileUrl) : null;
  const url = item.postUrl ? postOf(item.postUrl) : null;
  if (!want || !url) return null;
  await tab.open(url);
  await setState({ tabId: tab.tabId });
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { stop };
  if (page.kind !== 'post') return null;
  const theirs = await tab.ask({ type: 'hfos-their-posts', profile: want, most: LIKE_POSTS_READ });
  if (!theirs.ok) throw new Error(theirs.error);
  const index = theirs.posts.findIndex((p) => p.url !== null && postOf(p.url) === url);
  const found = theirs.posts[index];
  if (!found || neverLike({ text: found.text, pictures: [] })) return null;
  if (!found.liked) {
    const liked = await tab.ask({ type: 'hfos-like-post', profile: want, index, url: found.url });
    if (!liked.ok) throw new Error(liked.error);
    if (liked.result === 'none' || liked.result === 'not_sent')
      return missed(item, businessId, `Couldn’t like ${item.name}’s post: ${after.without}`);
    await pause(SETTLE_MS);
    const warned = await warnedOn(await read(), businessId);
    if (warned) return { stop: warned };
  }
  await takeNote(
    {
      type: 'hfos-noted',
      step: {
        kind: 'like',
        to: { name: item.name, profile: want },
        group: null,
        postUrl: url,
        thread: null,
        replying: null,
        auto: true,
        postText: likedText({ text: found.text, pictures: [] }),
      },
      at: now(),
    },
    PLATFORM,
  );
  return {
    done: true,
    line: found.liked
      ? `${item.name}’s post was liked already: ${after.next}`
      : `Liked ${item.name}’s post that your search found: ${after.next}`,
  };
}

/**
 * A look at their profile, and a like on a post of theirs, a day before the invitation: the first post of theirs that
 * nothing rules out (never one about grief, illness or trouble), not liked yet. One liked already counts. For a writer
 * found by a search (decision 92), the like goes on the post it found, on its own page, and their latest only when
 * that one's gone.
 */
async function warmUp(item: TodayListItem, businessId: string): Promise<Outcome> {
  // A partner's warm-up comes before the ask about partnering (decision 81), not an invitation.
  const after: After =
    item.kind === 'partner_warm_up'
      ? { without: 'the ask about partnering goes without', next: 'the ask comes tomorrow' }
      : { without: 'the invitation goes without', next: 'the invitation comes tomorrow' };
  if (item.postUrl) {
    const found = await likeFoundPost(item, businessId, after);
    if (found) return found;
    await pause(SETTLE_MS);
  }
  const opened = await openProfile(item, businessId);
  if ('outcome' in opened) return opened.outcome;
  await pause(SETTLE_MS);
  await tab.open(`${opened.noted.url}recent-activity/all/`);
  const activity = await read();
  const stopped = await warnedOn(activity, businessId);
  if (stopped) return { stop: stopped };
  const theirs = await tab.ask({
    type: 'hfos-their-posts',
    profile: opened.noted,
    most: LIKE_POSTS_READ,
  });
  if (!theirs.ok) throw new Error(theirs.error);
  if (!theirs.posts.length)
    return missed(item, businessId, `No post of ${item.name}’s to like: ${after.without}`);
  const likedAlready = theirs.posts.findIndex((p) => p.liked);
  const pick =
    likedAlready >= 0
      ? likedAlready
      : fallbackLikePick(theirs.posts.map((p) => ({ text: p.text, pictures: [], when: p.when })))
          .pick;
  if (pick === null)
    return missed(
      item,
      businessId,
      `None of ${item.name}’s posts were right to like: ${after.without}`,
    );
  const chosen = theirs.posts[pick]!;
  let postUrl = chosen.url;
  if (likedAlready < 0) {
    const liked = await tab.ask({
      type: 'hfos-like-post',
      profile: opened.noted,
      index: pick,
      url: chosen.url,
    });
    if (!liked.ok) throw new Error(liked.error);
    if (liked.result === 'none' || liked.result === 'not_sent')
      return missed(item, businessId, `Couldn’t like ${item.name}’s post: ${after.without}`);
    postUrl = liked.postUrl ?? chosen.url;
    await pause(SETTLE_MS);
    const stop = await warnedOn(await read(), businessId);
    if (stop) return { stop };
  }
  await takeNote(
    {
      type: 'hfos-noted',
      step: {
        kind: 'like',
        to: { name: opened.name, profile: opened.noted },
        group: null,
        postUrl,
        thread: null,
        replying: null,
        auto: true,
        postText: likedText({ text: chosen.text, pictures: [] }),
      },
      at: now(),
    },
    PLATFORM,
  );
  return {
    done: true,
    line:
      likedAlready >= 0
        ? `${item.name}’s post was liked already: ${after.next}`
        : `Looked at ${item.name}’s profile and liked a post of theirs: ${after.next}`,
  };
}

/** Where you stand with them, in words: for a step passed over. */
const STANDING: Readonly<Record<string, string>> = {
  connected: 'you’re connected already',
  received: 'they invited you: accept it yourself on LinkedIn',
  self: 'it’s your own profile',
};

/** An invitation to connect, without a note, from their profile. */
async function invite(item: TodayListItem, businessId: string): Promise<Outcome> {
  const opened = await openProfile(item, businessId);
  if ('outcome' in opened) return opened.outcome;
  const standing = opened.page.profile!.connection;
  if (standing === 'pending') return { done: false, line: `${item.name}: invited already` };
  if (STANDING[standing])
    return {
      done: false,
      line: `${item.name}: ${STANDING[standing]}`,
      ...(standing === 'received' ? { need: true as const } : {}),
    };
  const went = await tab.ask({ type: 'hfos-connect' });
  if (!went.ok) throw new Error(went.error);
  await pause(SETTLE_MS);
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { stop };
  if (went.result === 'already') return { done: false, line: `${item.name}: invited already` };
  if (went.result === 'none')
    return {
      done: false,
      line: `${item.name}: couldn’t find Connect, or LinkedIn asked for more than Send`,
      need: true,
    };
  if (went.result !== 'done' || page.profile?.connection !== 'pending')
    return { done: false, line: `${item.name}: LinkedIn didn’t take the invitation`, need: true };
  await takeNote(
    {
      type: 'hfos-noted',
      step: {
        kind: 'friend_request',
        to: { name: opened.name, profile: opened.noted },
        group: null,
        postUrl: null,
        thread: null,
        replying: null,
        auto: true,
      },
      at: now(),
    },
    PLATFORM,
  );
  return { done: true, line: `Sent ${item.name} an invitation to connect` };
}

/**
 * What a comment's send (./comments.ts, decisions 92 and 102) borrows: this window's tab, and a look at the page it
 * opened for LinkedIn's warning. LinkedIn's pages never ask to sign in mid-run, so it never stops for now.
 */
const commenting: CommentRunner = {
  platform: PLATFORM,
  tab,
  async onPage(businessId) {
    await setState({ tabId: tab.tabId });
    const stop = await warnedOn(await read(), businessId);
    return stop ? { stop } : null;
  },
};

/** A comment's draft or send as LinkedIn's own outcome: a stop for now (which LinkedIn never asks) is a pass. */
const commentOutcome = (out: CommentOutcome): Outcome =>
  'again' in out ? { done: false, line: out.again } : out;

// ------------------------------------------------------------------------------------------------- messages

/** A job in the runner's window, for the look-up and the once-a-day jobs, noting LinkedIn's warnings as its own. */
function jobFor(businessId: string): Job {
  return {
    tab,
    hfos: answer as Hfos,
    businessId,
    stopped: () => stopAsked,
    progress: (line) => void say(line, { working: true }).catch(() => undefined),
    async warn(words, url) {
      const fresh = await keepWarning(words, PLATFORM);
      if (fresh.length)
        await answer({
          type: 'hfos-warning',
          input: warningInput(businessId, fresh, url, PLATFORM),
        });
    },
  };
}

const threadUrl = (key: string) => `${LINKEDIN}/messaging/thread/${encodeURIComponent(key)}/`;

/**
 * Opens the conversation with them: theirs in messaging when it's known, else their profile's Message. To send in
 * (`sending`), a conversation in messaging counts only when it links to them the way HandsFreeOS keeps them, or the
 * way their profile shows them (their member id, for someone kept by the name in their address): by its name alone it
 * could be someone else's with the same name, so their profile's Message opens theirs instead.
 */
async function openChat(
  item: TodayListItem,
  businessId: string,
  sending = false,
): Promise<
  | { readonly profile: ProfileRef; readonly thread: ThreadRef | null }
  | { readonly outcome: Outcome }
> {
  const want = item.profileUrl ? profileRefOf(item.profileUrl) : null;
  const different = {
    outcome: { done: false, line: `${item.name}: LinkedIn showed a different conversation` },
  };
  /** Their kept conversation, opened, and whom it links to. */
  const openKept = async (key: string) => {
    await tab.open(threadUrl(key));
    await setState({ tabId: tab.tabId });
    const page = await read();
    const stop = await warnedOn(page, businessId);
    return { stop, chat: page.chat };
  };
  // A conversation kept, shown by name only: what its link says, to check against their profile's.
  let byName: ProfileRef | null = null;
  if (item.threadKey) {
    const { stop, chat } = await openKept(item.threadKey);
    if (stop) return { outcome: { stop } };
    // By the link to them when both say the same kind of thing; else by the name the conversation shows.
    const keyed = !!(chat?.profile && want && comparable(chat.profile, want));
    const them =
      chat?.profile && want && keyed
        ? sameMember(chat.profile, want)
        : chat?.name != null && chat.name.trim().toLowerCase() === item.name.trim().toLowerCase();
    const profile = want ?? chat?.profile ?? null;
    if (!chat || !them || !profile) return different;
    if (keyed || !sending) return { profile, thread: chat.thread };
    byName = chat.profile;
  }
  const opened = await openProfile(item, businessId);
  if ('outcome' in opened) return opened;
  // Their profile shows them the way the kept conversation links to them: it's theirs, and it's sent in after all.
  // One that links to someone else is a namesake's, so Message opens theirs.
  if (item.threadKey && byName && sameMember(byName, opened.noted)) {
    const { stop, chat } = await openKept(item.threadKey);
    if (stop) return { outcome: { stop } };
    if (!chat?.profile || !sameMember(chat.profile, opened.noted)) return different;
    return { profile: opened.noted, thread: chat.thread };
  }
  const pressed = await tab.ask({ type: 'hfos-open-message' });
  if (!pressed.ok)
    return {
      outcome: { done: false, line: `${item.name}: couldn’t find Message on their profile` },
    };
  await pause(SETTLE_MS);
  return { profile: opened.noted, thread: null };
}

/** Their conversation as it is now, before a reply is drafted: brought into HandsFreeOS as LinkedIn's. */
async function bringInChat(
  item: TodayListItem,
  businessId: string,
): Promise<{ readonly stop: string } | null> {
  if (!item.threadKey) return null;
  const opened = await openChat(item, businessId);
  if ('outcome' in opened) return 'stop' in opened.outcome ? opened.outcome : null;
  const page = await read();
  const built = page.chat ? chatCollect(page.chat, new Date(), null, PLATFORM) : null;
  if (built)
    await answer({
      type: 'hfos-collect-chats',
      input: { workspaceId: businessId, platform: PLATFORM, chats: [built] },
    });
  return null;
}

/** Drafts a message with the AI after looking them up on LinkedIn, and hands it to HandsFreeOS to wait or go. */
async function draftMessage(item: TodayListItem, businessId: string): Promise<Outcome> {
  if (item.kind === 'comment') return commentOutcome(await draftComment(item, businessId));
  if (item.kind === 'reply' || item.kind === 'partner_reply') {
    const stopped = await bringInChat(item, businessId);
    if (stopped) return stopped;
  }
  const looked = await lookUpOnLinkedIn(jobFor(businessId), item.profileUrl);
  if ('end' in looked)
    return looked.end.warned ? { stop: looked.end.line } : { done: false, line: looked.end.line };
  const drafted = await answer({
    type: 'hfos-draft',
    workspaceId: businessId,
    input: {
      kind: item.kind as MessageKind,
      profileId: item.profileId,
      chatId: item.chatId,
      lookup: looked.lines,
    },
  });
  if (!drafted.ok) return { done: false, line: `${item.name}: ${drafted.problem.message}` };
  const { drafts, opener, simple, kind: draftedKind } = drafted.value as Drafts;
  const kind = (draftedKind ?? item.kind) as MessageKind;
  const text = drafts[0];
  if (!text) return { done: false, line: `${item.name}: the AI had nothing to write` };
  const queued = await call(
    api().POST('/v1/commands/outreach.send.queue', {
      body: {
        workspaceId: businessId,
        profileId: item.profileId!,
        kind,
        chatId: item.chatId,
        threadKey: item.threadKey,
        text,
        opener: kind === 'opener' ? opener : null,
        simple: kind === 'reply' && simple,
      },
    }),
    businessId,
  );
  return {
    done: true,
    line:
      queued.state === 'approved'
        ? `Wrote a message to ${item.name}: it goes soon`
        : `Wrote a message to ${item.name}: it waits for your OK`,
  };
}

/** Says how a send went in HandsFreeOS. One the person skipped meanwhile went anyway: nothing more to say. */
async function sendDone(sendId: string, businessId: string, sent: boolean, why: string | null) {
  try {
    await call(
      api().POST('/v1/commands/outreach.send.done', {
        body: { workspaceId: businessId, sendId, sent, why },
      }),
      businessId,
    );
  } catch (error) {
    if (!(error instanceof Refused) || error.problem.status !== 404) throw error;
  }
}

/** Sends a message OK'd in LinkedIn messaging, as a few short texts when the person texts that way, and notes it. */
async function sendMessage(
  item: TodayListItem,
  businessId: string,
  split: boolean,
): Promise<Outcome> {
  if (item.kind === 'comment')
    return commentOutcome(
      await sendComment(
        item,
        item.profileUrl ? profileRefOf(item.profileUrl) : null,
        businessId,
        commenting,
      ),
    );
  const send = item.send!;
  const failed = async (line: string): Promise<Outcome> => {
    const lead = `${item.name}: `;
    await sendDone(
      send.sendId,
      businessId,
      false,
      line.startsWith(lead) ? line.slice(lead.length) : line,
    );
    return { done: false, line };
  };
  const chat = await openChat(item, businessId, true);
  if ('outcome' in chat) return 'stop' in chat.outcome ? chat.outcome : failed(chat.outcome.line);
  const parts = messageParts(send.text, split);
  let partly: string | null = null;
  for (const [i, part] of parts.entries()) {
    if (i > 0) await pause(partPauseMs(part, Math.random()));
    const wrote = await tab.ask({ type: 'hfos-message', text: part, profile: chat.profile });
    const why = !wrote.ok
      ? wrote.error
      : wrote.result === 'none'
        ? 'couldn’t find the box to write in'
        : wrote.result === 'not_theirs'
          ? `its typing didn’t stay in their conversation, so it took it out${i === 0 ? ' and sent nothing' : ''}`
          : wrote.result !== 'done'
            ? 'LinkedIn didn’t take the message'
            : null;
    if (why === null) continue;
    if (i === 0) return failed(`${item.name}: ${why}`);
    partly = `Sent ${item.name} ${i} of ${parts.length} texts, then: ${why}`;
    break;
  }
  await takeNote(
    {
      type: 'hfos-noted',
      step: {
        kind: 'message',
        to: { name: item.name, profile: chat.profile },
        group: null,
        postUrl: null,
        thread: chat.thread ?? null,
        replying: item.kind === 'reply' || item.kind === 'partner_reply',
        auto: true,
      },
      at: now(),
    },
    PLATFORM,
  );
  await sendDone(send.sendId, businessId, true, null);
  await pause(SETTLE_MS);
  const stop = await warnedOn(await read(), businessId);
  if (stop) return { stop };
  return { done: true, line: partly ?? `Sent ${item.name} a message` };
}

/** Does a piece of work: a step on the list, a draft, or a send. */
export function doWork(work: Work, businessId: string, split: boolean): Promise<Outcome> {
  if (work.do === 'draft') return draftMessage(work.item, businessId);
  if (work.do === 'send') return sendMessage(work.item, businessId, split);
  switch (work.item.kind) {
    case 'warm_up':
    case 'partner_warm_up':
      return warmUp(work.item, businessId);
    case 'friend_request':
      return invite(work.item, businessId);
    default:
      // Never on its list for it (`LINKEDIN_AUTO`): comments go as sends, drafted and sent above.
      return Promise.resolve({
        done: false,
        line: `${work.item.name}: that’s yours to do on LinkedIn`,
      });
  }
}

const DOING: Readonly<Partial<Record<TodayKind, string>>> = {
  warm_up: 'Looking at the profile of',
  partner_warm_up: 'Looking at the profile of',
  friend_request: 'Inviting',
};

const doing = (work: Work) =>
  commentDoing(work) ??
  (work.do === 'step'
    ? `${DOING[work.item.kind] ?? 'Working on'} ${work.item.name}…`
    : work.do === 'draft'
      ? `Writing a message to ${work.item.name}…`
      : `Sending ${work.item.name} a message…`);

const doneAs = (work: Work): DoneKind =>
  work.do === 'step'
    ? work.item.kind === 'partner_warm_up'
      ? 'warm_up'
      : (work.item.kind as DoneKind)
    : work.do === 'draft'
      ? 'drafted'
      : isCommentWork(work)
        ? 'comment'
        : 'sent';

/** What's left on LinkedIn's list for it today: only the kinds it does there. */
export function linkedInWorkLeft(
  list: Pick<TodayList, 'items' | 'auto' | 'messages' | 'sending'> & {
    readonly partners?: readonly TodayListItem[];
  },
  tried: readonly string[],
): Work[] {
  return workLeft({ ...list, auto: list.auto.filter((k) => LINKEDIN_AUTO.includes(k)) }, tried);
}

// ------------------------------------------------------------------------------------------------- the once-a-day jobs

/** The once-a-day job to do next on LinkedIn: the first not done today. */
export const nextLinkedInDaily = (state: Pick<AutoState, 'daily'>): LinkedInDaily | null =>
  LINKEDIN_DAILY.find((job) => state.daily?.[job] === undefined) ?? null;

/** A job that notes a page it couldn't read with its outline (decision 74): its own way to, or the runner's. */
const reporting = (job: Job, kind: LinkedInDaily): Job => ({
  ...job,
  report:
    job.report ??
    reporter(job.tab, job.hfos, {
      businessId: job.businessId,
      platform: PLATFORM,
      askId: null,
      job: kind,
    }),
});

/** Does one of LinkedIn's once-a-day jobs. */
export async function runLinkedInDaily(kind: LinkedInDaily, job: Job): Promise<JobEnd> {
  switch (kind) {
    case 'requests':
      return checkInvitations(job);
    case 'occasions':
      return linkedInOccasions(job);
    case 'tidy':
      return withdrawOnItsOwn(job);
    case 'checks':
      return checkConnections(job, CHECKS_PER_DAY);
    case 'partners':
      return checkPartners(job, PARTNER_CHECKS_PER_DAY, {
        platform: PLATFORM,
        read: readThemOnLinkedIn,
        search: searchLinkedIn,
      });
    case 'chats':
      return readChats(job, {
        most: DAILY_CHATS,
        memory: chatMemory,
        again: 'The rest wait for tomorrow.',
        home: LINKEDIN_MESSAGING,
      });
    case 'posts': {
      const words = valueOf(
        await job.hfos({
          type: 'hfos-post-words',
          workspaceId: job.businessId,
          platform: PLATFORM,
        }),
      ).words;
      return findPostsBySearch(job, words);
    }
    case 'helpful':
      return linkedInHelpfulDaily(job);
    case 'post_people':
      // A post it couldn't read, or whose box of who reacted didn't open or read nobody, is noted with its outline.
      return readPostPeople(reporting(job, kind));
    case 'found_checks':
      return checkFound(job, { platform: PLATFORM, read: readThemOnLinkedIn });
    case 'profile':
      return readProfileOnItsOwn(job, PLATFORM, linkedInProfileRead);
  }
}

// ------------------------------------------------------------------------------------------------- the day

/** Whether LinkedIn's day is started today, as the beat last said; null when HandsFreeOS hasn't said. */
const dayOf = (kept: Kept | null) => kept?.days?.linkedin ?? null;

/** One go: where things stand, the next step when it's time, and when to go next. */
async function go(): Promise<void> {
  stopAsked = false;
  const to = await savingTo();
  if (!to) {
    await goAt(null);
    return closeWindow();
  }
  const found = await loadSettings(to.businessId);
  if (!found) {
    await goAt(null);
    return closeWindow();
  }
  void follow(() => void tick()).catch(() => undefined);
  const { settings, timezone } = found;
  const choices = settings.networks.linkedin;
  let state = await stateNow();
  const at = Date.now();
  const today = businessDay(at, timezone);
  if (state.day !== today) state = await setState(freshState(today, state.tabId));
  await tab.adopt(state.tabId);
  const kept = await keptFor(to);
  // Off on LinkedIn, or Chrome hasn't let it on: nothing runs there.
  if (!isWorking(linkedin, await statesNow()) || choices.sending === 'off') {
    await goAt(null);
    return closeWindow();
  }
  if (kept && !kept.working) {
    await closeWindow();
    await say(standDownWords(kept.workingName));
    return goAt(null);
  }
  // Its day (decision 28): after Start my day, now, at a person's pace; with nothing pressed, on its own in the
  // working hours, spread out over them; outside them, or after Stop for today, at the start of the next ones.
  const random = Math.random();
  const own = networkDay({
    day: dayOf(kept),
    today,
    hours: settings.hours,
    timeZone: timezone,
    now: at,
    random,
  });
  const tomorrow = () => nextStart(settings.hours, timezone, Date.now(), random);
  if (!own.go) {
    await closeWindow();
    await setState({ started: false, stopped: own.stopped });
    await say(networkWaitWords(NAME, own, settings.hours, timezone, at));
    // The beat says when it's pressed (`days.linkedin`), and wakes this before then.
    return goAt(own.next);
  }
  if (own.started && !state.started) state = await setState({ started: true, stopped: null });
  if (state.stopped === 'warning' || (await warnedNow(PLATFORM))) {
    const warned = await warnedNow(PLATFORM);
    await closeWindow();
    await say(
      `Stopped: ${NAME} warned you today${warned ? ` (“${warned.words[0]}”)` : ''}. The extension stops on ${NAME} until tomorrow.`,
      { stopped: 'warning' },
    );
    return goAt(tomorrow());
  }
  if (!(await isNoting())) {
    await closeWindow();
    await say(
      `Turn on noting your steps in Social Outreach → Settings in HandsFreeOS: the extension works on its own on ${NAME} only while it notes.`,
      { needs: true },
    );
    return goAt(at + LOOK_AGAIN_MS);
  }
  // What the person asked on LinkedIn goes first: this looks again in a couple of minutes.
  if (askInLine(PLATFORM)) {
    await say(ASK_FIRST_WORDS);
    return goAt(at + ASK_FIRST_MS);
  }
  const soon = () => goAt(Date.now() + pickGap(random));

  // Lists first (decision 60), LinkedIn's own.
  const lists = valueOf(
    await (answer as Hfos)({ type: 'hfos-lists', workspaceId: to.businessId, platform: PLATFORM }),
  );
  if (JSON.stringify(state.lists) !== JSON.stringify(lists)) state = await setState({ lists });
  const before = beforeDay(lists, state.before ?? {}, at, timezone, PLATFORM);
  if (before) {
    const end = await inTurn('runner', () => beforeTheDay(before, to.businessId), PLATFORM);
    const line = beforeDayLine(before, end, PLATFORM);
    if (end.warned) {
      await closeWindow();
      await say(end.line, { stopped: 'warning' });
      return goAt(tomorrow());
    }
    void feed('job', `${NAME}: ${line}`);
    if (before.do === 'save' && before.first && end.failed) {
      await closeWindow();
      await say(
        `${line} Your first day on ${NAME} starts once your connections and invitations are saved, so it tries again in a few minutes.`,
        { needs: true },
      );
      return goAt(Date.now() + AGAIN_MS);
    }
    await say(line);
    return soon();
  }

  const daily = choices.collect ? nextLinkedInDaily(state) : null;
  if (daily) {
    const end = await inTurn('runner', () => collect(daily, to.businessId), PLATFORM);
    if (end.warned) {
      await closeWindow();
      await say(end.line, { stopped: 'warning' });
      return goAt(tomorrow());
    }
    const line = `${DAILY_NAMES[daily]}: ${end.line}`;
    await say(line);
    void feed('job', `${NAME}: ${line}`);
    return soon();
  }

  // Today's helpful post, when the person lets it post on its own on LinkedIn: once the AI has written it.
  if (
    choices.posting === 'own' &&
    (!choices.collect || state.daily?.helpful !== undefined) &&
    helpfulDue(state, at)
  ) {
    const end = await inTurn('runner', () => postOwn(to.businessId), PLATFORM);
    // Up, or it couldn't go: done for today. None written yet: it looks again in a while.
    const settled = end.posted === true || end.failed === true;
    await setState({ helpfulUp: settled, helpfulAt: Date.now() + HELPFUL_AGAIN_MS });
    if (end.warned) {
      await closeWindow();
      await say(end.line, { stopped: 'warning' });
      return goAt(tomorrow());
    }
    if (settled) {
      const line = `Helpful post: ${end.line}`;
      await say(line);
      void feed(end.posted ? 'done' : 'passed', `${NAME}: ${line}`);
      return soon();
    }
  }

  const list: TodayList = await call(
    api().POST('/v1/queries/outreach.today', {
      body: { workspaceId: to.businessId, platform: PLATFORM },
    }),
    to.businessId,
  );
  const left = linkedInWorkLeft(list, state.tried);
  const work = left[0];
  if (!work) {
    await closeWindow();
    await say(
      state.tried.length
        ? `Done for today on ${NAME}. It looks again within the hour for anything new.`
        : `Nothing on your ${NAME} list for it to do yet.`,
    );
    return goAt(at + 60 * 60_000);
  }
  const { item } = work;
  await say(doing(work), { working: true });
  let outcome: Outcome;
  try {
    outcome = await inTurn(
      'runner',
      () => doWork(work, to.businessId, settings.voice?.split ?? true),
      PLATFORM,
    );
  } catch (error) {
    if (error instanceof Refused) throw error;
    outcome = {
      done: false,
      line: `${item.name}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await setState({ working: false });
  }
  // A step that didn't go: the page it ended on, outline and all, noted while the window still shows it (decision 74).
  if ('done' in outcome && !outcome.done)
    await reporter(tab, answer as Hfos, {
      businessId: to.businessId,
      platform: PLATFORM,
      askId: null,
      job: work.do === 'step' ? work.item.kind : work.do,
    })({ note: 'The step didn’t go.', outline: true });
  state = await stateNow();
  const kind = doneAs(work);
  const done =
    'done' in outcome && outcome.done
      ? { ...state.done, [kind]: (state.done[kind] ?? 0) + 1 }
      : state.done;
  await setState({ tried: [...state.tried, workKey(work)], done });
  if ('stop' in outcome) {
    await closeWindow();
    await say(outcome.stop, { stopped: 'warning' });
    return goAt(tomorrow());
  }
  await say(outcome.line);
  const need =
    'need' in outcome && work.do === 'step' ? needOf(item, outcome.line, to.businessId) : null;
  if (need) void noteNeed(need);
  void feed(outcome.done ? 'done' : 'passed', `${NAME}: ${outcome.line}`);
  if (stopAsked) {
    await closeWindow();
    return goAt(null);
  }
  const gap = Math.max(
    pickGap(Math.random()),
    gapAfter({
      now: Date.now(),
      until: own.until,
      left: left.length - 1,
      started: own.started,
      random,
    }),
  );
  if (gap > KEEP_WINDOW_MS) await closeWindow();
  await goAt(Date.now() + gap);
}

/** Does what's due before LinkedIn's day, and keeps how it went. */
async function beforeTheDay(step: BeforeDay, businessId: string): Promise<JobEnd> {
  const key = markOf(step);
  await setState({ beforeNow: key });
  await say(beforeDayDoing(step, PLATFORM), { working: true });
  let end: JobEnd;
  try {
    end = await doBeforeDay(step, jobFor(businessId), PLATFORM);
  } catch (error) {
    if (error instanceof Refused) throw error;
    end = {
      line: error instanceof Error ? error.message : String(error),
      warned: false,
      failed: true,
    };
  } finally {
    await setState({ working: false, tabId: tab.tabId, beforeNow: null });
  }
  const state = await stateNow();
  // The morning's invitations, and the first check, stand for today's once-a-day ones.
  const stands =
    !end.failed && (key === 'requests' || key === 'checks')
      ? { daily: { ...state.daily, [key]: end.line } }
      : {};
  await setState({ before: { ...state.before, [key]: end.line }, ...stands });
  return end;
}

/** Does a once-a-day job, and keeps how it went: one that went wrong isn't tried again today. */
async function collect(kind: LinkedInDaily, businessId: string): Promise<JobEnd> {
  await say(DAILY_DOING[kind], { working: true });
  let end: JobEnd;
  try {
    end = await runLinkedInDaily(kind, jobFor(businessId));
  } catch (error) {
    if (error instanceof Refused) throw error;
    end = {
      line: error instanceof Error ? error.message : String(error),
      warned: false,
    };
  } finally {
    await setState({ working: false, tabId: tab.tabId });
  }
  const state = await stateNow();
  await setState({ daily: { ...state.daily, [kind]: end.line } });
  return end;
}

/** Puts up today's helpful post on the person's feed, on its own. */
async function postOwn(businessId: string): ReturnType<typeof postOnLinkedIn> {
  await say('Looking for today’s helpful post…', { working: true });
  try {
    return await postOnLinkedIn(jobFor(businessId), null);
  } catch (error) {
    if (error instanceof Refused) throw error;
    return { line: error instanceof Error ? error.message : String(error), warned: false };
  } finally {
    await setState({ working: false, tabId: tab.tabId });
  }
}

/** The alarm went off, or LinkedIn's day changed: one go, never two at once. */
export async function linkedInTick(): Promise<void> {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    await go();
  } catch (error) {
    const words =
      error instanceof Refused
        ? error.problem.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`HandsFreeOS Social couldn’t work on its own on ${NAME}`, error);
    await setState({ working: false }).catch(() => undefined);
    await say(`Stopped for now: ${words} It tries again in a few minutes.`, { needs: true }).catch(
      () => undefined,
    );
    await goAt(Date.now() + AGAIN_MS).catch(() => undefined);
  } finally {
    busy = false;
    if (again) {
      again = false;
      void linkedInTick();
    }
  }
}

const tick = linkedInTick;

/** When the background starts: it looks once, and the beat wakes it after. */
export async function wakeLinkedIn(): Promise<void> {
  const alarm = await chrome.alarms.get(LINKEDIN_ALARM);
  if (!alarm) await linkedInTick();
}

/** LinkedIn's day as the last beat said it: a change starts it, or ends what it's doing at its next page. */
let lastDay: string | null = null;
onBeat((kept) => {
  const day = dayOf(kept);
  const said = day ? `${day.date}:${day.state}` : null;
  if (said === lastDay) return;
  const was = lastDay;
  lastDay = said;
  // The first beat after the background starts says nothing new.
  if (was === null && said !== null && day?.state !== 'started') return;
  if (day?.state === 'stopped' || !kept.working) stopAsked = true;
  // Stop for today on LinkedIn ends LinkedIn's ask under way too, as Facebook's does Facebook's.
  if (day?.state === 'stopped' && day.why !== 'warning')
    haltAsk(PLATFORM, `Stopped: you pressed Stop for today on ${NAME}.`);
  void linkedInTick();
});

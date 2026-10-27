/**
 * Alignable's runner (partners stage 6c, part 5; the Instagram and Alignable plan's "On its own"): the extension on its
 * own on Alignable, as LinkedIn's runner (./linkedin.ts) is on LinkedIn, beside it and Facebook's (./run.ts) and never
 * waiting on either. It has its own line (its own turn with Alignable's asks, ./turns.ts), its own window, its own alarm
 * and its own state (`hfos.auto.alignable`).
 *
 * - **Only while Alignable's day is started.** Alignable's Start my day, pressed in HandsFreeOS or on the phone, which
 *   the beat brings (`days.alignable`); Stop for today there ends what it's doing at its next page, and its asks' too.
 *   It works only while Alignable is on for the person and Chrome allows it, while noting is on, while this computer is
 *   the one that works, and while the person's Alignable Sending choice isn't Off.
 * - **Lists first** (decision 60): before Alignable's first day, its connections and the connection requests they've
 *   got are saved to their end, and the connections checked once (./lists.ts); after that the requests each morning
 *   and the connections weekly.
 * - **Once a day,** as the person's Alignable choices say (`collect`): the requests, the connections checked for good
 *   fits (30 business pages a day to start, its kit's `checksPerDay`), from 0.84.0 their conversations read for the AI
 *   with who wrote last noted, as Instagram's are, Find partners (Alignable's search for businesses, then those found
 *   read for the AI's partner check), and their town's posts and forum questions read for the AI. From 0.95.0
 *   (decision 92) their own groups first (`my_groups`); after the town's posts, Alignable's search for businesses like
 *   their clients, in their town or anywhere (`search`, ../jobs/alignable/customer-search.ts); groups found for their
 *   niche and area and checked by the AI, the good ones joined while their groups run low, their members read leaders
 *   first, and their posts read (`group_checks`, `join`, `members`, `group_posts`, ../jobs/alignable/groups.ts); and
 *   the businesses found, checked by the AI from their pages, last (`found_checks`).
 * - **Then Alignable's list for today** (`outreach.today` with `platform: 'alignable'`), the kinds it does on its own
 *   (`auto`): a look at their business page and a like on a recent post of theirs when the page shows one, or the
 *   look alone when it doesn't (warm-up; for a writer found by their post, the post it found, liked on its own page);
 *   a connection request with their page's own Connect, the business checked by
 *   Alignable's id first, never to one their page shows they're connected with already (0.94.0), who's kept as a
 *   connection instead; and the messages: drafted after a look-up of their page, and sent once OK'd in Alignable's
 *   messages, typing only into that conversation's box. From 0.95.0 a comment on a good post is drafted by the AI and
 *   goes through Waiting for you as messages do (decision 92, ./comments.ts): it waits for the person's OK while the
 *   comment hold or training wheels are on, then goes on its own, only in the post's own reply form; an answer to a
 *   post asking for what the business offers waits for their OK every time. Recommend is only ever theirs. Requests
 *   they got are left for them to accept, and old requests to withdraw are theirs too: no reader of the ones they've
 *   sent is built.
 * - **At Alignable's pace:** a few minutes between steps, within Alignable's limits, which HandsFreeOS keeps (its list
 *   holds only what they have room for).
 * - **Stops on any Alignable warning,** for the day, on Alignable alone: the other networks go on.
 *
 * Each step is noted as the extension's own (`auto`), as Alignable's (`platform: 'alignable'`). Anything its page
 * doesn't let it do is handed to the person (`noteNeed`), never guessed.
 */
import { businessDay } from '@hfos/core/addons/outreach/automation';
import type { MessageKind } from '@hfos/core/addons/outreach/automation';
import { ASK_FIRST_WORDS } from '@hfos/core/addons/outreach/asks';
import { GROUP_CHECKS_DAILY } from '@hfos/core/addons/outreach/group-checks';
import {
  fallbackLikePick,
  LIKE_POSTS_READ,
  likedText,
  neverLike,
} from '@hfos/core/addons/outreach/like-pick';
import { standDownWords } from '@hfos/core/addons/outreach/live';
import { chatUrlOn } from '@hfos/core/addons/outreach/network-words';
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import { PARTNER_CHECKS_PER_DAY } from '@hfos/core/addons/outreach/partners';
import { messageParts, partPauseMs } from '@hfos/core/addons/outreach/voice';
import type { TodayKind } from '@hfos/core/addons/outreach/today';
import { haltAsk } from '../asks/run';
import { follow, loadSettings } from '../hfos/follow';
import { feed, keptFor, onBeat, type Kept } from '../hfos/live';
import type { Drafts, TodayList, TodayListItem } from '../hfos/messages';
import { isNoting, noteNeed, takeNote } from '../hfos/noting';
import { alignableListSave } from '../hfos/saves';
import { answer, api, call, Refused, savingTo } from '../hfos/session';
import { keepWarning, warnedNow, warningInput } from '../hfos/warned';
import { readAlignableChats } from '../jobs/alignable/chats';
import { checkConnections, isTheirs, readThemOnAlignable } from '../jobs/alignable/checks';
import { searchForCustomers } from '../jobs/alignable/customer-search';
import {
  checkGroupsOn,
  joinGroupsOn,
  readGroupPosts,
  readMembers,
  readMyGroups,
} from '../jobs/alignable/groups';
import { lookUpOnAlignable } from '../jobs/alignable/lookup';
import { searchAlignable } from '../jobs/alignable/partner-search';
import { checkRequests } from '../jobs/alignable/people';
import { readWarmLeads } from '../jobs/alignable/engaged';
import { findPostsInTown } from '../jobs/alignable/posts';
import { ALIGNABLE, readAlignableIn, type AlignablePage } from '../jobs/alignable/read';
import { valueOf, warnedLine, type Hfos, type Job, type JobEnd } from '../jobs/job';
import { chatMemory } from '../jobs/chats';
import { checkFound } from '../jobs/found-checks';
import { checkPartners } from '../jobs/partners';
import { reporter } from '../jobs/report';
import { alignable } from '../networks';
import { businessRef, discussionIdOf, idIn, urlOf } from '../networks/alignable/read';
import type { ProfileRef, ThreadRef } from '../networks/facebook/types';
import { isWorking, statesNow } from '../networks/on';
import { WorkTab } from '../tab';
import {
  commentDoing,
  draftComment,
  isCommentWork,
  sendComment,
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
  ALIGNABLE_STATE_KEY,
  freshState,
  gapAfter,
  isState,
  needOf,
  workKey,
  workLeft,
  type AutoState,
  type DailyJob,
  type DoneKind,
  type OwnDailyJob,
  type Work,
} from './plan';
import { askInLine, inTurn } from './turns';

const PLATFORM: Platform = 'alignable';
const NAME = NETWORKS.alignable.name;

export const ALIGNABLE_ALARM = 'hfos-auto-alignable';

/**
 * The kinds it does on its own on Alignable, in order (its kit's `runs.auto`): comments and forum answers go through
 * `sends`, as messages do (./comments.ts), and requests they got are theirs to accept.
 */
export const ALIGNABLE_AUTO: readonly TodayKind[] = ['warm_up', 'friend_request'];
/**
 * The once-a-day jobs on Alignable, in order, as Instagram's: the requests, the connections checked, their chats
 * (0.84.0), Find partners, their town's posts, and who engaged with them, from their notifications (`helpful`: who
 * engaged, here with no helpful post of their own). From 0.95.0 (decision 92) the person's own groups go first
 * (`my_groups`), before any search or join; after the town's posts, the search for businesses like their clients
 * (`search`), the groups found and checked, joined, their members read and their posts (`group_checks`, `join`,
 * `members`, `group_posts`); and the businesses found by topic are checked last (`found_checks`).
 */
export const ALIGNABLE_DAILY = [
  'my_groups',
  'requests',
  'checks',
  'chats',
  'partners',
  'posts',
  'search',
  'group_checks',
  'join',
  'members',
  'group_posts',
  'helpful',
  'found_checks',
] as const satisfies readonly (DailyJob | OwnDailyJob)[];
type AlignableDaily = (typeof ALIGNABLE_DAILY)[number];

const DAILY_DOING: Readonly<Record<AlignableDaily, string>> = {
  my_groups: 'Reading your groups on Alignable…',
  requests: 'Checking your connection requests on Alignable…',
  checks: 'Checking your connections for good fits…',
  chats: 'Reading your Alignable chats for the AI…',
  partners: 'Searching Alignable for businesses that could partner with you, then reading them…',
  posts: 'Reading your town’s posts and forum questions for the AI…',
  search: 'Searching Alignable for businesses like your clients…',
  group_checks: 'Finding Alignable groups for your niche and area, and checking them…',
  join: 'Joining good Alignable groups, as your groups run low on people to reach…',
  members: 'Reading the members of your Alignable groups, leaders first…',
  group_posts: 'Reading the posts in your Alignable groups for the AI…',
  helpful: 'Reading your notifications for who liked, commented on or recommended you…',
  found_checks: 'Checking the businesses found on Alignable for good fits…',
};
const DAILY_NAMES: Readonly<Record<AlignableDaily, string>> = {
  my_groups: 'Your groups',
  requests: 'Connection requests',
  checks: 'Check my connections',
  chats: 'Read my chats',
  partners: 'Find partners',
  posts: 'Find posts in your town',
  search: 'Search for businesses',
  group_checks: 'Check groups',
  join: 'Join groups',
  members: 'Group members',
  group_posts: 'Posts in your groups',
  helpful: 'Who engaged with you',
  found_checks: 'Check the businesses found',
};

/** Alignable's pace between steps: LinkedIn's, a person's (the plan's "The risk, said plainly"). */
export const ALIGNABLE_GAP_MS = { least: 2 * 60_000, most: 6 * 60_000 } as const;
/** While Alignable draws what a press opened. */
const SETTLE_MS = 2_000;
/** A gap longer than this closes its window until the next step. */
const KEEP_WINDOW_MS = 5 * 60_000;
/** After something went wrong, or Alignable asked them to sign in, it tries again this much later. */
const AGAIN_MS = 15 * 60_000;
/** While noting is off, it looks again this often. */
const LOOK_AGAIN_MS = 30 * 60_000;
/** While an ask on Alignable goes first, it looks again after this. */
const ASK_FIRST_MS = 2 * 60_000;

const tab = new WorkTab('window', alignable);
/** Alignable's runner's window's tab, while it's open: what the person sees there isn't theirs to note. */
export const alignableRunnerTabId = (): number | null => tab.tabId;

let busy = false;
/** Alignable's Stop for today, or another computer working now: a job under way ends at its next page. */
let stopAsked = false;
let again = false;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const now = () => new Date().toISOString();
const pickGap = (random: number) =>
  Math.round(ALIGNABLE_GAP_MS.least + random * (ALIGNABLE_GAP_MS.most - ALIGNABLE_GAP_MS.least));

// ------------------------------------------------------------------------------------------------- state

async function stateNow(): Promise<AutoState> {
  try {
    const value: unknown = (await chrome.storage.local.get(ALIGNABLE_STATE_KEY))[
      ALIGNABLE_STATE_KEY
    ];
    return isState(value) ? value : freshState(null);
  } catch {
    return freshState(null);
  }
}

let writing: Promise<unknown> = Promise.resolve();
function setState(change: Partial<AutoState>): Promise<AutoState> {
  const write = writing.then(async () => {
    const next = { ...(await stateNow()), ...change };
    await chrome.storage.local.set({ [ALIGNABLE_STATE_KEY]: next });
    return next;
  });
  writing = write.catch(() => undefined);
  return write;
}

const say = (line: string, more: Partial<AutoState> = {}) =>
  setState({ line, lineAt: Date.now(), needs: false, ...more });

async function goAt(when: number | null): Promise<void> {
  if (when === null) await chrome.alarms.clear(ALIGNABLE_ALARM);
  else await chrome.alarms.create(ALIGNABLE_ALARM, { when: Math.max(when, Date.now() + 30_000) });
  await setState({ nextAt: when });
}

async function closeWindow(): Promise<void> {
  await tab.close();
  await setState({ tabId: null });
}

// ------------------------------------------------------------------------------------------------- Alignable

/**
 * What a step came to: done, passed over (handed to the person with `need`), a stop for the day, or (`again`) a stop
 * for now with nothing tried, when Alignable asked them to sign in.
 */
type Outcome =
  | { readonly done: true; readonly line: string }
  | { readonly done: false; readonly line: string; readonly need?: true }
  | { readonly stop: string }
  | { readonly again: string };

const SIGNED_OUT =
  'Stopped for now: Alignable asked you to sign in. Sign in to Alignable in this browser, and it tries again in a few minutes.';

/** Stops for the day on Alignable's warning on the page, noting it in HandsFreeOS once as Alignable's. */
async function warnedOn(page: AlignablePage, businessId: string): Promise<string | null> {
  if (!page.warnings.length) return null;
  const fresh = await keepWarning(page.warnings, PLATFORM);
  if (fresh.length)
    await answer({
      type: 'hfos-warning',
      input: warningInput(businessId, fresh, page.url, PLATFORM),
    });
  return warnedLine(page.warnings, NAME);
}

const read = () => readAlignableIn(tab);

/** Their business as kept: by Alignable's id for it when the link carries one, else its address in its town. */
function wantOf(profileUrl: string | null): ProfileRef | null {
  const url = urlOf(profileUrl, ALIGNABLE);
  return url ? businessRef(url, idIn(url)) : null;
}

/**
 * What a comment's send (./comments.ts, decision 92) borrows: this window's tab, and a look at the page it opened for
 * Alignable's warning or its sign-in.
 */
const commenting: CommentRunner = {
  platform: PLATFORM,
  tab,
  async onPage(businessId) {
    await setState({ tabId: tab.tabId });
    const page = await read();
    const stop = await warnedOn(page, businessId);
    if (stop) return { stop };
    return page.signedOut ? { again: SIGNED_OUT } : null;
  },
};

/**
 * Opens their business page (a look they may see) and checks it's theirs, by Alignable's id for it: the page, and the
 * business to note against.
 */
async function openBusiness(
  item: TodayListItem,
  businessId: string,
): Promise<
  | { readonly page: AlignablePage; readonly want: ProfileRef; readonly noted: ProfileRef }
  | { readonly outcome: Outcome }
> {
  const want = wantOf(item.profileUrl);
  if (!want) return { outcome: { done: false, line: `${item.name}: no Alignable page kept` } };
  await tab.open(want.url);
  await setState({ tabId: tab.tabId });
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { outcome: { stop } };
  if (page.signedOut) return { outcome: { again: SIGNED_OUT } };
  const shown = page.found.business;
  if (!shown?.profile || !isTheirs(shown, want))
    return {
      outcome: { done: false, line: `${item.name}: Alignable showed a different page`, need: true },
    };
  const noted = {
    id: want.id ?? shown.profile.id,
    username: want.username ?? shown.profile.username,
    url: want.url,
  };
  return { page, want, noted };
}

/** Where a warm-up leads: the connection request, or for a partner (decision 81) the ask about partnering. */
type After = ReturnType<typeof afterWarmUp>;
const afterWarmUp = (item: TodayListItem) =>
  item.kind === 'partner_warm_up'
    ? {
        without: 'the ask about partnering goes without',
        next: 'the ask comes tomorrow',
        now: 'the ask about partnering can go next',
      }
    : {
        without: 'the connection request goes without',
        next: 'the connection request comes tomorrow',
        now: 'the connection request can go next',
      };

/** Tells HandsFreeOS there was nothing to like: what comes after the warm-up needn't wait for one. */
async function missed(item: TodayListItem, businessId: string): Promise<void> {
  await call(
    api().POST('/v1/commands/outreach.warm_up.missed', {
      body: { workspaceId: businessId, profileId: item.profileId! },
    }),
    businessId,
  );
}

/** Plainly old: months or years ago, or more than four weeks. A post of unknown age is taken as the page orders it. */
export function longAgo(when: string | null): boolean {
  if (!when) return false;
  if (/\d+\s*(mo|mos|months?|y|yrs?|years?)\b/i.test(when)) return true;
  const weeks = /(\d+)\s*(w|wks?|weeks?)\b/i.exec(when);
  return weeks !== null && Number(weeks[1]) > 4;
}

/**
 * The like on the post they were found by (decision 92), on that post's own page (/biz/discussions/<id>, wherever
 * Alignable opens it): their post, by its discussion's id, when nothing rules it out (never one about grief, illness or
 * trouble). One liked already counts. Null when the post is gone, isn't theirs or isn't one to like: then their
 * business page's warm-up goes instead.
 */
async function likeFoundPost(
  item: TodayListItem,
  businessId: string,
  after: After,
): Promise<Outcome | null> {
  const want = wantOf(item.profileUrl);
  const id = discussionIdOf(item.postUrl);
  if (!want || !id) return null;
  const url = `${ALIGNABLE}/biz/discussions/${id}`;
  await tab.open(url);
  await setState({ tabId: tab.tabId });
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { stop };
  if (page.signedOut) return { again: SIGNED_OUT };
  const theirs = await tab.ask({ type: 'hfos-their-posts', profile: want, most: LIKE_POSTS_READ });
  if (!theirs.ok) throw new Error(theirs.error);
  const index = theirs.posts.findIndex((post) => discussionIdOf(post.url) === id);
  const found = theirs.posts[index];
  if (!found || neverLike({ text: found.text, pictures: [] })) return null;
  if (!found.liked) {
    const liked = await tab.ask({ type: 'hfos-like-post', profile: want, index, url: found.url });
    if (!liked.ok) throw new Error(liked.error);
    if (liked.result === 'none' || liked.result === 'not_sent') {
      await missed(item, businessId);
      return { done: false, line: `Couldn’t like ${item.name}’s post: ${after.without}` };
    }
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
      : `Liked ${item.name}’s post that was found for you: ${after.next}`,
  };
}

/**
 * A look at their business page, and a like on a recent post of theirs when the page shows one, a day before the
 * request: the first that nothing rules out (never one about grief, illness or trouble), not liked yet. One liked
 * already counts. With no recent post of theirs, or none right to like, the look alone is the warm-up, and HandsFreeOS
 * hears there was nothing to like, so the request needn't wait. For a writer found by their post (decision 92), the
 * like goes on that post, on its own page, and their business page's warm-up only when that post's gone.
 */
async function warmUp(item: TodayListItem, businessId: string): Promise<Outcome> {
  const after = afterWarmUp(item);
  if (item.postUrl) {
    const found = await likeFoundPost(item, businessId, after);
    if (found) return found;
    await pause(SETTLE_MS);
  }
  const opened = await openBusiness(item, businessId);
  if ('outcome' in opened) return opened.outcome;
  const lookOnly = async (why: string): Promise<Outcome> => {
    await missed(item, businessId);
    return {
      done: true,
      line: `Looked at ${item.name}’s business page, ${why}: the look is the warm-up, so ${after.now}`,
    };
  };
  const theirs = await tab.ask({
    type: 'hfos-their-posts',
    profile: opened.noted,
    most: LIKE_POSTS_READ,
  });
  if (!theirs.ok) throw new Error(theirs.error);
  const recent = theirs.posts
    .map((post, index) => ({ post, index }))
    .filter(({ post }) => !longAgo(post.when));
  if (!recent.length) return lookOnly('with no recent post of theirs to like');
  const likedAlready = recent.find(({ post }) => post.liked);
  const picked = fallbackLikePick(
    recent.map(({ post }) => ({ text: post.text, pictures: [], when: post.when })),
  ).pick;
  const chosen = likedAlready ?? (picked === null ? null : recent[picked]!);
  if (!chosen) return lookOnly('and none of their posts were right to like');
  let postUrl = chosen.post.url;
  if (!likedAlready) {
    const liked = await tab.ask({
      type: 'hfos-like-post',
      profile: opened.noted,
      index: chosen.index,
      url: chosen.post.url,
    });
    if (!liked.ok) throw new Error(liked.error);
    if (liked.result === 'none' || liked.result === 'not_sent') {
      await missed(item, businessId);
      return { done: false, line: `Couldn’t like ${item.name}’s post: ${after.without}` };
    }
    postUrl = liked.postUrl ?? chosen.post.url;
    await pause(SETTLE_MS);
    const stop = await warnedOn(await read(), businessId);
    if (stop) return { stop };
  }
  await takeNote(
    {
      type: 'hfos-noted',
      step: {
        kind: 'like',
        to: { name: item.name, profile: opened.noted },
        group: null,
        postUrl,
        thread: null,
        replying: null,
        auto: true,
        postText: likedText({ text: chosen.post.text, pictures: [] }),
      },
      at: now(),
    },
    PLATFORM,
  );
  return {
    done: true,
    line: likedAlready
      ? `${item.name}’s post was liked already: ${after.next}`
      : `Looked at ${item.name}’s business page and liked a post of theirs: ${after.next}`,
  };
}

/**
 * Someone their page shows they're connected with, kept in HandsFreeOS as one of their Alignable connections, as Save
 * my connections keeps them (a list of one, as Instagram's follow-backs are): Today then never offers the request
 * again. If HandsFreeOS can't keep it now, the next save of their connections does.
 */
async function keepConnection(item: TodayListItem, profile: ProfileRef, businessId: string) {
  const built = alignableListSave([{ name: item.name, profile }], 'friends', businessId);
  if (!built.ok) return;
  for (const input of built.input) await answer({ type: 'hfos-save-friends', input });
}

/**
 * A connection request, with their business page's own Connect: a link that makes the request at once, carrying
 * Alignable's id for their business, which is checked first. Their page is opened again after, to see it went. A
 * business their page shows they're connected with already (its own Remove Connection, 0.94.0) is passed over, and
 * kept as a connection.
 */
async function connect(item: TodayListItem, businessId: string): Promise<Outcome> {
  const opened = await openBusiness(item, businessId);
  if ('outcome' in opened) return opened.outcome;
  const shown = opened.page.found.business!;
  if (shown.connected) {
    await keepConnection(item, opened.noted, businessId);
    return { done: false, line: `${item.name}: you’re connected already` };
  }
  if (!opened.noted.id)
    return {
      done: false,
      line: `${item.name}: Alignable didn’t show their business’s id, so Connect wasn’t pressed`,
      need: true,
    };
  if (!shown.connect)
    return shown.message
      ? {
          done: false,
          line: `${item.name}: no Connect on their page: you’re connected already, or asked`,
        }
      : { done: false, line: `${item.name}: couldn’t find Connect on their page`, need: true };
  const went = await tab.ask({ type: 'hfos-connect', profile: opened.noted });
  if (!went.ok) throw new Error(went.error);
  if (went.result === 'already')
    return { done: false, line: `${item.name}: you’re connected already, or asked` };
  if (went.result !== 'done')
    return { done: false, line: `${item.name}: couldn’t find Connect on their page`, need: true };
  // The press may have opened another page: once it's loaded, their page again shows whether the request went.
  await pause(SETTLE_MS);
  if (tab.tabId !== null) await tab.loaded(tab.tabId);
  await tab.open(opened.want.url);
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { stop };
  const after = page.found.business;
  // It went once their own Connect is gone, or their page shows you're connected now (its Remove Connection).
  const taken =
    after !== null && isTheirs(after, opened.want) && (after.connected || !after.connect);
  if (page.signedOut || !taken)
    return { done: false, line: `${item.name}: Alignable didn’t take the request`, need: true };
  await takeNote(
    {
      type: 'hfos-noted',
      step: {
        kind: 'friend_request',
        to: { name: item.name, profile: opened.noted },
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
  return { done: true, line: `Sent ${item.name} a connection request` };
}

// ------------------------------------------------------------------------------------------------- messages

/** A job in the runner's window, for the look-up and the once-a-day jobs, noting Alignable's warnings as its own. */
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

/**
 * Opens the conversation with them in Alignable's messages, by their business's id (its kit's `chatUrl`): the chat's
 * own key when it's kept, the id their link carries, else the one their business page shows. It must be with them.
 */
async function openChat(
  item: TodayListItem,
  businessId: string,
): Promise<
  { readonly profile: ProfileRef; readonly thread: ThreadRef } | { readonly outcome: Outcome }
> {
  let want = wantOf(item.profileUrl);
  let id = item.threadKey ?? want?.id ?? null;
  if (!id) {
    const opened = await openBusiness(item, businessId);
    if ('outcome' in opened) return opened;
    want = opened.noted;
    id = opened.noted.id;
    if (!id)
      return {
        outcome: { done: false, line: `${item.name}: Alignable didn’t show their business’s id` },
      };
  }
  const url = chatUrlOn(PLATFORM, id)!;
  await tab.open(url);
  await setState({ tabId: tab.tabId });
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { outcome: { stop } };
  if (page.signedOut) return { outcome: { again: SIGNED_OUT } };
  const chat = page.found.chat;
  // By their business's id when its header links to it; else by the name it shows.
  const them = chat?.profile?.id
    ? chat.profile.id === id
    : chat?.name != null && chat.name.trim().toLowerCase() === item.name.trim().toLowerCase();
  if (!chat || !them)
    return {
      outcome: { done: false, line: `${item.name}: Alignable showed a different conversation` },
    };
  const profile =
    want ?? chat.profile ?? businessRef(new URL(`${ALIGNABLE}/biz/businesses/${id}`), id)!;
  return {
    profile: { ...profile, id: profile.id ?? id },
    thread: { id, encrypted: false, url },
  };
}

/**
 * Drafts a message with the AI after looking their business page up on Alignable, and hands it to HandsFreeOS to wait
 * or go. A reply is drafted from what HandsFreeOS knows: their conversation as the day's Read my chats last brought it
 * in (0.84.0). A comment on a good post is drafted from the post (decision 92).
 */
async function draftMessage(item: TodayListItem, businessId: string): Promise<Outcome> {
  if (item.kind === 'comment') return draftComment(item, businessId);
  const looked = await lookUpOnAlignable(jobFor(businessId), item.name, item.profileUrl);
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

/**
 * Sends a message OK'd in Alignable's messages, as a few short texts when the person texts that way, and notes it. A
 * comment OK'd, or past the hold, goes on its post's own page (decision 92).
 */
async function sendMessage(
  item: TodayListItem,
  businessId: string,
  split: boolean,
): Promise<Outcome> {
  if (item.kind === 'comment')
    return sendComment(item, wantOf(item.profileUrl), businessId, commenting);
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
  const chat = await openChat(item, businessId);
  if ('outcome' in chat) return 'done' in chat.outcome ? failed(chat.outcome.line) : chat.outcome;
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
            ? 'Alignable didn’t take the message'
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
        thread: chat.thread,
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
      return connect(work.item, businessId);
    default:
      // Never on its list for it (`ALIGNABLE_AUTO`): comments and answers go as sends, drafted and sent above.
      return Promise.resolve({
        done: false,
        line: `${work.item.name}: that’s yours to do on Alignable`,
      });
  }
}

const DOING: Readonly<Partial<Record<TodayKind, string>>> = {
  warm_up: 'Looking at the business page of',
  partner_warm_up: 'Looking at the business page of',
  friend_request: 'Sending a connection request to',
};

const doing = (work: Work) =>
  commentDoing(work) ??
  (work.do === 'step'
    ? (work.item.kind === 'warm_up' || work.item.kind === 'partner_warm_up') && work.item.postUrl
      ? `Liking ${work.item.name}’s post that was found for you…`
      : `${DOING[work.item.kind] ?? 'Working on'} ${work.item.name}…`
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

/** What's left on Alignable's list for it today: only the kinds it does there. */
export function alignableWorkLeft(
  list: Pick<TodayList, 'items' | 'auto' | 'messages' | 'sending'> & {
    readonly partners?: readonly TodayListItem[];
  },
  tried: readonly string[],
): Work[] {
  return workLeft({ ...list, auto: list.auto.filter((k) => ALIGNABLE_AUTO.includes(k)) }, tried);
}

// ------------------------------------------------------------------------------------------------- the once-a-day jobs

/** The once-a-day job to do next on Alignable: the first not done today. */
export const nextAlignableDaily = (state: Pick<AutoState, 'daily'>): AlignableDaily | null =>
  ALIGNABLE_DAILY.find((job) => state.daily?.[job] === undefined) ?? null;

/**
 * A job that says what it couldn't find with the page's outline (decision 74): the jobs from 0.95.0, whose pages are
 * drawn from guessed markup till the owner's next Check (decision 92).
 */
const reporting = (job: Job, kind: AlignableDaily): Job => ({
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

/** Does one of Alignable's once-a-day jobs. */
export async function runAlignableDaily(kind: AlignableDaily, job: Job): Promise<JobEnd> {
  switch (kind) {
    case 'my_groups':
      return readMyGroups(reporting(job, kind));
    case 'requests':
      return checkRequests(job);
    case 'checks':
      return checkConnections(job, NETWORKS.alignable.checksPerDay);
    case 'chats':
      return readAlignableChats(job, {
        most: DAILY_CHATS,
        memory: chatMemory,
        again: 'The rest wait for tomorrow.',
      });
    case 'partners':
      return checkPartners(job, PARTNER_CHECKS_PER_DAY, {
        platform: PLATFORM,
        read: readThemOnAlignable,
        search: searchAlignable,
      });
    case 'posts':
      return findPostsInTown(job);
    case 'search':
      return searchForCustomers(reporting(job, kind));
    case 'group_checks':
      return checkGroupsOn(reporting(job, kind), GROUP_CHECKS_DAILY);
    case 'join':
      return joinGroupsOn(reporting(job, kind));
    case 'members':
      return readMembers(reporting(job, kind));
    case 'group_posts':
      return readGroupPosts(reporting(job, kind));
    case 'helpful':
      return readWarmLeads(job);
    case 'found_checks':
      return checkFound(job, { platform: PLATFORM, read: readThemOnAlignable });
  }
}

// ------------------------------------------------------------------------------------------------- the day

/** Whether Alignable's day is started today, as the beat last said; null when HandsFreeOS hasn't said. */
const dayOf = (kept: Kept | null) => kept?.days?.alignable ?? null;

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
  const choices = settings.networks.alignable;
  let state = await stateNow();
  const at = Date.now();
  const today = businessDay(at, timezone);
  if (state.day !== today) state = await setState(freshState(today, state.tabId));
  await tab.adopt(state.tabId);
  const kept = await keptFor(to);
  // Off on Alignable, or Chrome hasn't let it on: nothing runs there.
  if (!isWorking(alignable, await statesNow()) || choices.sending === 'off') {
    await goAt(null);
    return closeWindow();
  }
  if (kept && !kept.working) {
    await closeWindow();
    await say(standDownWords(kept.workingName));
    return goAt(null);
  }
  const day = dayOf(kept);
  if (!day || day.date !== today || day.state !== 'started') {
    await closeWindow();
    await setState({
      started: false,
      stopped: day?.date === today && day.state === 'stopped' ? (day.why ?? 'person') : null,
    });
    await say(
      day?.date === today && day.state === 'stopped'
        ? `Stopped on ${NAME} for today. It starts again when you press Start my day for ${NAME}.`
        : `Waiting for you to start your day on ${NAME}: press Start my day for ${NAME} on Today in HandsFreeOS.`,
    );
    // The beat says when the day starts (`days.alignable`), and wakes this.
    return goAt(null);
  }
  if (!state.started) state = await setState({ started: true, stopped: null });
  if (state.stopped === 'warning' || (await warnedNow(PLATFORM))) {
    const warned = await warnedNow(PLATFORM);
    await closeWindow();
    await say(
      `Stopped: ${NAME} warned you today${warned ? ` (“${warned.words[0]}”)` : ''}. The extension stops on ${NAME} until tomorrow.`,
      { stopped: 'warning' },
    );
    return goAt(null);
  }
  if (!(await isNoting())) {
    await closeWindow();
    await say(
      `Turn on noting your steps in Social Outreach → Settings in HandsFreeOS: the extension works on its own on ${NAME} only while it notes.`,
      { needs: true },
    );
    return goAt(at + LOOK_AGAIN_MS);
  }
  // What the person asked on Alignable goes first: this looks again in a couple of minutes.
  if (askInLine(PLATFORM)) {
    await say(ASK_FIRST_WORDS);
    return goAt(at + ASK_FIRST_MS);
  }
  const random = Math.random();
  const soon = () => goAt(Date.now() + pickGap(random));

  // Lists first (decision 60), Alignable's own.
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
      return goAt(null);
    }
    void feed('job', `${NAME}: ${line}`);
    if (before.do === 'save' && before.first && end.failed) {
      await closeWindow();
      await say(
        `${line} Your first day on ${NAME} starts once your connections and connection requests are saved, so it tries again in a few minutes.`,
        { needs: true },
      );
      return goAt(Date.now() + AGAIN_MS);
    }
    await say(line);
    return soon();
  }

  const daily = choices.collect ? nextAlignableDaily(state) : null;
  if (daily) {
    const end = await inTurn('runner', () => collect(daily, to.businessId), PLATFORM);
    if (end.warned) {
      await closeWindow();
      await say(end.line, { stopped: 'warning' });
      return goAt(null);
    }
    const line = `${DAILY_NAMES[daily]}: ${end.line}`;
    await say(line);
    void feed('job', `${NAME}: ${line}`);
    return soon();
  }

  const list: TodayList = await call(
    api().POST('/v1/queries/outreach.today', {
      body: { workspaceId: to.businessId, platform: PLATFORM },
    }),
    to.businessId,
  );
  const left = alignableWorkLeft(list, state.tried);
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
  // Alignable asked them to sign in: nothing tried, and it looks again in a while.
  if ('again' in outcome) {
    await closeWindow();
    await say(outcome.again, { needs: true });
    return goAt(Date.now() + AGAIN_MS);
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
    return goAt(null);
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
    gapAfter({ now: Date.now(), until: null, left: left.length - 1, started: true, random }),
  );
  if (gap > KEEP_WINDOW_MS) await closeWindow();
  await goAt(Date.now() + gap);
}

/** Does what's due before Alignable's day, and keeps how it went. */
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
  // The morning's requests, and the first check, stand for today's once-a-day ones.
  const stands =
    !end.failed && (key === 'requests' || key === 'checks')
      ? { daily: { ...state.daily, [key]: end.line } }
      : {};
  await setState({ before: { ...state.before, [key]: end.line }, ...stands });
  return end;
}

/** Does a once-a-day job, and keeps how it went: one that went wrong isn't tried again today. */
async function collect(kind: AlignableDaily, businessId: string): Promise<JobEnd> {
  await say(DAILY_DOING[kind], { working: true });
  let end: JobEnd;
  try {
    end = await runAlignableDaily(kind, jobFor(businessId));
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

/** The alarm went off, or Alignable's day changed: one go, never two at once. */
export async function alignableTick(): Promise<void> {
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
      void alignableTick();
    }
  }
}

const tick = alignableTick;

/** When the background starts: it looks once, and the beat wakes it after. */
export async function wakeAlignable(): Promise<void> {
  const alarm = await chrome.alarms.get(ALIGNABLE_ALARM);
  if (!alarm) await alignableTick();
}

/** Alignable's day as the last beat said it: a change starts it, or ends what it's doing at its next page. */
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
  // Stop for today on Alignable ends Alignable's ask under way too, as LinkedIn's does LinkedIn's.
  if (day?.state === 'stopped' && day.why !== 'warning')
    haltAsk(PLATFORM, `Stopped: you pressed Stop for today on ${NAME}.`);
  void alignableTick();
});

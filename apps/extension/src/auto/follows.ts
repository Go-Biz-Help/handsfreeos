/**
 * Threads' and X's runners (decision 163): the extension on its own on each, as Instagram's is on Instagram
 * (./instagram.ts), beside the other networks' runners and never waiting on any. Each has its own line (its own turn
 * with its network's asks, ./turns.ts), its own window, its own alarm and its own state (`hfos.auto.threads`,
 * `hfos.auto.x`).
 *
 * - **In the working hours, or once its day is started,** as every network's: at random times spread over the hours,
 *   or at a person's pace after its Start my day (`days.threads`, `days.x`). Stop for today ends it at its next page.
 *   It works only while the network is on for the person and Chrome allows it, while noting is on, while this computer
 *   is the one that works, and while the network's Sending choice isn't Off.
 * - **Lists first** (decision 60): before its first day, the person's newest followers are saved (the newest 200), and
 *   who to unfollow worked out (./lists.ts).
 * - **Every hour, its main work** (the owner's "search often for new posts related to our niche and comment on them",
 *   answer 2a): its search with the hour's phrases from the playbooks (`outreach.posts.words`), newest first, the posts
 *   under 2 days old sent for the AI's check (../jobs/follows/search.ts), while the person's Collect choice is on;
 *   and with it, their notifications read for replies to their comments (../jobs/follows/replies.ts, answer 8a).
 * - **Once a day,** while the network's Collect choice is on: their newest followers since the last save, the accounts
 *   they followed looked at for who followed back, unfollowing who didn't once the warm-up's wait is over as the person
 *   chose (decision 98), who replied to good posts (../jobs/follows/post-people.ts), the people found checked for good
 *   fits from their own profiles (../jobs/found-checks.ts), and their own profile read on the 1st of the month. On
 *   Threads (decision 167), their chats read for the AI too (../jobs/follows/chats.ts), as Instagram's are.
 * - **Then its list for today** (`outreach.today` for the network), by turns with the reading above (decision 123):
 *   the warm-up (decision 161: a look at their profile and a like on the post they were found by, or their reply to a
 *   good post, and one of their latest while the day's likes have room; the visits after, while they decide on
 *   following back), a follow a day after, and comments on good posts and answers to replies, drafted by the AI and
 *   sent once OK'd or past the hold (./comments.ts), only in the post's own box. A comment pitches only when a post asks
 *   for what the business offers (decision 79, answer 5a).
 * - **On Threads, messages as on Instagram** (decision 167, the owner's picks 1a 2a 3a): a first message once they
 *   follow back, or to a good fit who follows the person already, drafted by the AI and sent as the Sending choice
 *   says; follow-ups; and answers to whoever writes back, read every minute (./watch.ts), any time of day as on every
 *   network (decision 133). Each goes only in their own chat, opened by its number or their profile's own Message.
 *   Nothing is ever written in anyone's messages on X.
 * - **At a careful pace:** a few minutes between steps, within the kit's limits (30 comments and 80 likes a day, and on
 *   Threads 10 first messages and 15 follow-ups, halved while the account is new and for a week after a warning), which
 *   HandsFreeOS keeps.
 * - **Stops on any warning** of the network's, for the day, on that network alone: the others go on.
 *
 * - **HandsFreeOS says what's next** (decision 195, step 2, from 0.156.0): once its own checks let it work (this is
 *   the computer that works, its Sending isn't Off, no warning, noting on, nothing the person asked in line), it asks
 *   HandsFreeOS for its next move (../hfos/plan.ts `planNext`) with what only this computer knows (whether they're
 *   away, the reads put off till they are, a comment research that reads), and does the move it's sent, exactly as it
 *   does its own: the same read, step, pace and limits (`asTold`). Whenever HandsFreeOS doesn't decide for it, can't
 *   be reached, or sends a move this build can't do, it plans the go itself by the same rules, as it always has.
 *
 * Each step is noted as the extension's own (`auto`), as the network's. Anything its page doesn't let it do is handed
 * to the person (`noteNeed`), never guessed.
 */
import { businessDay, type MessageKind } from '@hfos/core/addons/outreach/automation';
import { ASK_FIRST_WORDS } from '@hfos/core/addons/outreach/asks';
import { LIST_MARKS_ON } from '@hfos/core/addons/outreach/lists';
import { buttonFor } from '@hfos/core/addons/outreach/helper';
import { visitLine } from '@hfos/core/addons/outreach/keep-warm';
import { LIKE_POSTS_READ, likedText, neverLike } from '@hfos/core/addons/outreach/like-pick';
import { standDownWords } from '@hfos/core/addons/outreach/live';
import { chatUrlOn } from '@hfos/core/addons/outreach/network-words';
import { NETWORKS } from '@hfos/core/addons/outreach/networks';
import { messageParts, partPauseMs } from '@hfos/core/addons/outreach/voice';
import type { ProblemHelper } from '@hfos/core/problem-report';
import { haltAsk } from '../asks/run';
import { awayNow } from '../away';
import { follow, loadSettings } from '../hfos/follow';
import { feed, jobKind, keptFor, onBeat, outcomeKind, type Kept } from '../hfos/live';
import type { Drafts, TodayList, TodayListItem } from '../hfos/messages';
import { isNoting, noteNeed, takeNote } from '../hfos/noting';
import { changeKept, planNext, type ToldNext } from '../hfos/plan';
import { chatCollect, NOTHING_TO_ANSWER } from '../hfos/saves';
import { answer, api, call, Refused, savingTo } from '../hfos/session';
import { keepWarning, warnedNow, warningInput } from '../hfos/warned';
import { chatMemory } from '../jobs/chats';
import { checkFound } from '../jobs/found-checks';
import { followChatPage, readFollowChats } from '../jobs/follows/chats';
import { saveFollowers, lookForFollowBacks } from '../jobs/follows/people';
import { readPostRepliers } from '../jobs/follows/post-people';
import {
  accountIn,
  isTheirs,
  readFollowIn,
  readThemOn,
  sameAs,
  type FollowPage,
} from '../jobs/follows/read';
import { readCommentReplies } from '../jobs/follows/replies';
import { hourlySearch } from '../jobs/follows/search';
import { unfollowOnItsOwn } from '../jobs/follows/unfollow';
import { followAsk } from '../jobs/follows';
import { lookForResearch, researchNext } from '../jobs/comment-research';
import { readFollowComments } from '../jobs/follows/comment-research';
import { valueOf, warnedLine, type Hfos, type Job, type JobEnd } from '../jobs/job';
import { readProfileOnItsOwn } from '../jobs/own-read';
import { reporter } from '../jobs/report';
import { threads, x } from '../networks';
import type { ProfileRef, ThreadRef } from '../networks/facebook/types';
import type { FollowPlatform } from '../networks/follows/types';
import { isWorking, statesNow } from '../networks/on';
import { WorkTab } from '../tab';
import {
  commentDoing,
  draftComment,
  isCommentWork,
  sendComment,
  type LookingRunner,
} from './comments';
import { DAILY_CHATS } from './daily';
import { helpAfter, stepHelp } from './helper';
import {
  beforeDay,
  beforeDayDoing,
  beforeDayLine,
  doBeforeDay,
  holdsTheDay,
  markOf,
  type BeforeDay,
} from './lists';
import { AWAY_AGAIN_MS, awayEnd, isNotAway, PutOff, waitingFor, waitingWords } from './on-screen';
import {
  afterDaily,
  AGAIN_WORDS,
  answersAnyTime,
  ANSWERING,
  freshState,
  gapAfter,
  isState,
  listSays,
  listTurn,
  lookOutsideAt,
  needOf,
  networkDay,
  networkWaitWords,
  nextRound,
  nextStart,
  repliedAfter,
  replyWaiting,
  retryWake,
  roundDue,
  soonestAgain,
  stillReplied,
  THREADS_STATE_KEY,
  waitsAgain,
  withReplied,
  workKey,
  workLeft,
  X_STATE_KEY,
  type AutoState,
  type DoneKind,
  type NetworkDay,
  type Work,
} from './plan';
import { clearRetried, handsOver, retryAfterUpdate } from './retry';
import { askInLine, inTurn } from './turns';

import {
  FOLLOW_AUTO,
  FOLLOW_DAILY,
  FOLLOW_DAILY_NAMES,
  FOLLOW_FINDING,
  FOLLOW_GAP_MS,
  followDailyOn,
  type FollowDaily,
} from '@hfos/core/addons/outreach/runners';

// What it does on its own there, its once-a-day jobs in order, their names and its pace are HandsFreeOS's from 0.155.0
// (packages/core/src/addons/outreach/runners.ts, decision 195), so the app plans the same day. Its search isn't a
// once-a-day job: it goes every hour (`searchDue`).
export {
  FOLLOW_AUTO,
  FOLLOW_DAILY,
  FOLLOW_FINDING,
  FOLLOW_GAP_MS,
  followDailyOn,
  type FollowDaily,
};
const DAILY_NAMES = FOLLOW_DAILY_NAMES;

/** While the network draws what a press opened. */
const SETTLE_MS = 2_000;
/** After something went wrong, or the network asked them to sign in, it tries again this much later. */
const AGAIN_MS = 15 * 60_000;
/** While noting is off, it looks again this often. */
const LOOK_AGAIN_MS = 30 * 60_000;
/** While an ask on the network goes first, it looks again after this. */
const ASK_FIRST_MS = 2 * 60_000;
/** Of their latest posts, the most a warm-up likes: one, or two while the day's likes have room. */
const LIKES_MOST = 2;
/** How far either way of its hour the search may go: never on the minute, the way a person looks. */
const SEARCH_JITTER = 0.1;

const DAILY_DOING = (name: string): Readonly<Record<FollowDaily, string>> => ({
  requests: `Reading your newest followers on ${name}…`,
  follow_backs: `Looking at the accounts you followed on ${name} for who followed you back…`,
  tidy: `Unfollowing who didn’t follow you back on ${name}…`,
  chats: `Reading your ${name} chats for the AI…`,
  post_people: `Reading who replied to good posts on ${name}…`,
  found_checks: `Checking the people found on ${name} for good fits…`,
  comment_research: `Reading replies under posts on ${name} for HandsFreeOS’s comment research…`,
  profile: `Reading your ${name} profile, as it does on the 1st of each month…`,
});
/** The once-a-day job to do next on a network: the first not done today. */
export const nextFollowDaily = (
  platform: FollowPlatform,
  state: Pick<AutoState, 'daily' | 'againAt'>,
  passOver: readonly FollowDaily[] = [],
  now = Date.now(),
): FollowDaily | null =>
  followDailyOn(platform).find(
    (job) =>
      state.daily?.[job] === undefined && !passOver.includes(job) && !waitsAgain(state, job, now),
  ) ?? null;

/** Whether its hourly search is due: never done today, or its hour is up (`watchAt`). */
export const searchDue = (state: Pick<AutoState, 'watchAt'>, now: number): boolean =>
  (state.watchAt ?? 0) <= now;

/** When it searches next after one at `now`: its kit's hour, give or take a few minutes (`random` 0 to 1). */
export function nextSearch(platform: FollowPlatform, now: number, random: number): number {
  const minutes = NETWORKS[platform].postSearch?.everyMinutes ?? 60;
  return now + Math.round(minutes * 60_000 * (1 - SEARCH_JITTER + random * 2 * SEARCH_JITTER));
}

/**
 * What's left on the network's list for it today: only the kinds it does there. Messages only where it writes in them
 * (`messages`: Threads', decision 167); on X, only its steps and comments.
 */
export function followWorkLeft(
  list: Pick<TodayList, 'items' | 'auto' | 'messages' | 'sending'> & {
    readonly partners?: readonly TodayListItem[];
    readonly newMessagesWait?: boolean;
  },
  tried: readonly string[],
  replied: readonly string[] = [],
  messages = false,
): Work[] {
  return workLeft(
    { ...list, auto: list.auto.filter((k) => FOLLOW_AUTO.includes(k)) },
    tried,
    replied,
  ).filter((w) => messages || w.do === 'step' || isCommentWork(w));
}

/** The likes the day has room for past one each for the warm-ups still to do (and a visit's own). */
export function spareLikes(list: Pick<TodayList, 'limits'>, left: readonly Work[]): number {
  const warmUps = left.reduce(
    (n, w) =>
      w.do === 'step' && (w.item.kind === 'warm_up' || w.item.kind === 'partner_warm_up')
        ? n + (w.item.keepWarm?.likes ?? 1)
        : n,
    0,
  );
  return Math.max(0, list.limits.like.most - list.limits.like.done - warmUps);
}

/** What a step came to, as Instagram's runner's (./instagram.ts). */
export type Outcome =
  | { readonly done: true; readonly line: string; readonly helper?: ProblemHelper }
  | {
      readonly done: false;
      readonly line: string;
      readonly need?: true;
      readonly look?: true;
      readonly skip?: true;
      readonly helper?: ProblemHelper;
    }
  | { readonly stop: string }
  | { readonly again: string };

type Liked = 'liked' | 'already' | 'not' | { readonly stop: string } | { readonly again: string };

/** A network's runner: what the background starts, wakes and asks about. */
export interface FollowRunner {
  readonly alarm: string;
  readonly tick: () => Promise<void>;
  readonly wake: () => Promise<void>;
  readonly replied: (profileIds: readonly string[]) => Promise<void>;
  readonly tabId: () => number | null;
  /**
   * A piece of the list's work, one of its once-a-day jobs, and its hour's search, each as its go does them. `split`
   * sends a message as a few short texts, when the person texts that way.
   */
  readonly doWork: (
    work: Work,
    businessId: string,
    spare?: number,
    split?: boolean,
  ) => Promise<Outcome>;
  readonly runDaily: (kind: FollowDaily, job: Job) => Promise<JobEnd>;
  readonly searchHour: (businessId: string) => Promise<JobEnd>;
}

/** The person's choices, as HandsFreeOS last said them. */
type Settings = NonNullable<Awaited<ReturnType<typeof loadSettings>>>['settings'];

function followRunner(platform: FollowPlatform): FollowRunner {
  const kit = platform === 'x' ? x : threads;
  const NAME = NETWORKS[platform].name;
  const STATE_KEY = platform === 'x' ? X_STATE_KEY : THREADS_STATE_KEY;
  const ALARM = `hfos-auto-${platform}`;
  const doingDaily = DAILY_DOING(NAME);
  const SIGNED_OUT = `Stopped for now: ${NAME} asked you to sign in. Sign in to ${NAME} in this browser, and it tries again in a few minutes.`;

  // Its reads that need the screen come in front only while the person is away, put off till then (decision 120).
  const tab = new WorkTab('window', kit, { front: 'away', waits: false });
  const putOff = new PutOff<FollowDaily>();
  let busy = false;
  let stopAsked = false;
  let again = false;

  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const now = () => new Date().toISOString();
  const pickGap = (random: number) =>
    Math.round(FOLLOW_GAP_MS.least + random * (FOLLOW_GAP_MS.most - FOLLOW_GAP_MS.least));

  // ----------------------------------------------------------------------------------------------- state

  async function stateNow(): Promise<AutoState> {
    try {
      const value: unknown = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
      return isState(value) ? value : freshState(null);
    } catch {
      return freshState(null);
    }
  }

  let writing: Promise<unknown> = Promise.resolve();
  function setState(change: Partial<AutoState>): Promise<AutoState> {
    const write = writing.then(async () => {
      const next = { ...(await stateNow()), ...change };
      await chrome.storage.local.set({ [STATE_KEY]: next });
      return next;
    });
    writing = write.catch(() => undefined);
    return write;
  }

  const say = (line: string, more: Partial<AutoState> = {}) =>
    setState({ line, lineAt: Date.now(), needs: false, ...more });

  async function goAt(when: number | null): Promise<void> {
    if (when === null) await chrome.alarms.clear(ALARM);
    else await chrome.alarms.create(ALARM, { when: Math.max(when, Date.now() + 30_000) });
    await setState({ nextAt: when });
  }

  async function closeWindow(): Promise<void> {
    await tab.close();
    await setState({ tabId: null });
  }

  // ----------------------------------------------------------------------------------------------- the network

  const read = () => readFollowIn(tab, platform);

  /** Stops for the day on the network's warning on the page, noting it in HandsFreeOS once as the network's. */
  async function warnedOn(page: FollowPage, businessId: string): Promise<string | null> {
    if (!page.warnings.length) return null;
    const fresh = await keepWarning(page.warnings, platform);
    if (fresh.length)
      await answer({
        type: 'hfos-warning',
        input: warningInput(businessId, fresh, page.url, platform),
      });
    return warnedLine(page.warnings, NAME);
  }

  /** Their account as kept: by the name in its address. */
  function wantOf(profileUrl: string | null): ProfileRef | null {
    const account = accountIn(platform, profileUrl);
    return account ? { id: null, username: account.username, url: account.url } : null;
  }

  const commenting: LookingRunner = {
    platform,
    tab,
    async onPage(businessId) {
      await setState({ tabId: tab.tabId });
      const page = await read();
      const stop = await warnedOn(page, businessId);
      if (stop) return { stop };
      return page.signedOut ? { again: SIGNED_OUT } : null;
    },
  };

  /** Opens their profile and checks it's theirs, by the name in its address. */
  async function openAccount(
    item: TodayListItem,
    businessId: string,
  ): Promise<
    | { readonly page: FollowPage; readonly noted: ProfileRef; readonly name: string }
    | { readonly outcome: Outcome }
  > {
    const want = wantOf(item.profileUrl);
    if (!want) return { outcome: { done: false, line: `${item.name}: no ${NAME} account kept` } };
    await tab.open(want.url);
    await setState({ tabId: tab.tabId });
    const page = await read();
    const stop = await warnedOn(page, businessId);
    if (stop) return { outcome: { stop } };
    if (page.signedOut) return { outcome: { again: SIGNED_OUT } };
    const shown = page.found.profile;
    if (!shown || !isTheirs(shown, { username: want.username!, url: want.url }))
      return {
        outcome: {
          done: false,
          line: `${item.name}: ${NAME} showed a different account`,
          need: true,
        },
      };
    return { page, noted: want, name: shown.name ?? item.name };
  }

  /** Tells HandsFreeOS there was nothing to like: the follow needn't wait for one. */
  async function missed(item: TodayListItem, businessId: string): Promise<void> {
    await call(
      api().POST('/v1/commands/outreach.warm_up.missed', {
        body: { workspaceId: businessId, profileId: item.profileId! },
      }),
      businessId,
    );
  }

  /** Likes one post of theirs on its own page, and notes it: whether it's liked now, or the step's end. */
  async function likeOne(
    item: TodayListItem,
    businessId: string,
    them: ProfileRef,
    post: { readonly url: string; readonly text: string },
  ): Promise<Liked> {
    await tab.open(post.url);
    await setState({ tabId: tab.tabId });
    const page = await read();
    const stop = await warnedOn(page, businessId);
    if (stop) return { stop };
    if (page.signedOut) return { again: SIGNED_OUT };
    const liked = await tab.ask({ type: 'hfos-like-post', profile: them, index: 0, url: post.url });
    if (!liked.ok) throw new Error(liked.error);
    if (liked.result === 'none' || liked.result === 'not_sent') return 'not';
    if (liked.result === 'done') {
      await pause(SETTLE_MS);
      const after = await warnedOn(await read(), businessId);
      if (after) return { stop: after };
    }
    await takeNote(
      {
        type: 'hfos-noted',
        step: {
          kind: 'like',
          to: { name: item.name, profile: them },
          group: null,
          postUrl: liked.postUrl ?? post.url,
          thread: null,
          replying: null,
          auto: true,
          postText: likedText({ text: post.text, pictures: [] }),
        },
        at: now(),
      },
      platform,
    );
    return liked.result === 'done' ? 'liked' : 'already';
  }

  /** The day a reply that couldn't be found to like was last noted with its page's outline: once a day at most. */
  let replyNotedOn: string | null = null;

  /**
   * What they were found by, liked first, on its own page: the post they wrote (found by the search), or their reply to
   * a good post (found by who replied), found again under that post by who wrote it and liked on its own page, as a
   * reply is a post of its own there. Null when there's none to like (gone, or about grief, illness or trouble), so
   * their latest is liked in its place.
   */
  async function likeFound(item: TodayListItem, businessId: string): Promise<Liked | null> {
    const them = wantOf(item.profileUrl);
    if (!item.postUrl || !them) return null;
    if (!item.likeComment) {
      const text = item.post ?? '';
      if (neverLike({ text, pictures: [] })) return null;
      const went = await likeOne(item, businessId, them, { url: item.postUrl, text });
      return went === 'not' ? null : went;
    }
    await tab.open(item.postUrl);
    await setState({ tabId: tab.tabId });
    const page = await read();
    const stop = await warnedOn(page, businessId);
    if (stop) return { stop };
    if (page.signedOut) return { again: SIGNED_OUT };
    const theirs = page.found.replies.find((r) => sameAs(r.author.username, them.username));
    if (!theirs) {
      const state = await stateNow();
      if (replyNotedOn !== state.day) {
        replyNotedOn = state.day;
        await reporter(tab, answer as Hfos, {
          businessId,
          platform,
          askId: null,
          job: 'warm_up.comment',
        })({ note: 'Couldn’t find their reply to like.', outline: true });
      }
      return null;
    }
    if (neverLike({ text: `${item.post ?? ''}\n${theirs.text}`, pictures: [] })) return null;
    if (theirs.liked === true) return 'already';
    await pause(SETTLE_MS);
    const went = await likeOne(item, businessId, them, { url: theirs.url, text: theirs.text });
    return went === 'not' ? null : went;
  }

  /** What a warm-up's likes came to, in words. */
  function warmedLine(item: TodayListItem, found: Liked | null, liked: number): string {
    const what = item.likeComment ? 'reply' : 'post';
    const next = 'the follow comes tomorrow';
    if (found === 'liked')
      return `Liked ${item.name}’s ${what} it found${liked ? ' and a post of theirs' : ''}: ${next}`;
    if (found === 'already')
      return liked
        ? `Liked a post of ${item.name}’s, the ${what} it found liked already: ${next}`
        : `${item.name}’s ${what} it found was liked already: ${next}`;
    return liked
      ? `Looked at ${item.name}’s ${NAME} and liked ${liked === 1 ? 'a post' : `${liked} posts`} of theirs: ${next}`
      : `${item.name}’s post was liked already: ${next}`;
  }

  /**
   * The warm-up, a day before the follow (decision 161): what they were found by liked first, then one of their latest
   * while the day's likes have room past the warm-ups still to come (`spare`), the first that nothing rules out. With
   * nothing to see or right to like, the look alone is the warm-up, and HandsFreeOS hears there was nothing to like.
   */
  async function warmUp(item: TodayListItem, businessId: string, spare: number): Promise<Outcome> {
    if (item.keepWarm) return visit(item, businessId, item.keepWarm.likes);
    const found = await likeFound(item, businessId);
    if (typeof found === 'object' && found !== null) return found;
    const done = (liked: number): Outcome => ({ done: true, line: warmedLine(item, found, liked) });
    const room = (spare > 0 ? LIKES_MOST : 1) - (found ? 1 : 0);
    if (room <= 0) return done(0);
    const opened = await openAccount(item, businessId);
    if ('outcome' in opened) return found && 'done' in opened.outcome ? done(0) : opened.outcome;
    const lookOnly = async (why: string): Promise<Outcome> => {
      if (found) return done(0);
      await missed(item, businessId);
      return {
        done: true,
        line: `Looked at ${item.name}’s ${NAME}, ${why}: the look is the warm-up, so the follow can go next`,
      };
    };
    const theirs = await tab.ask({
      type: 'hfos-their-posts',
      profile: opened.noted,
      most: LIKE_POSTS_READ,
    });
    if (!theirs.ok) throw new Error(theirs.error);
    const posts = theirs.posts.flatMap((p) =>
      p.url && p.url !== item.postUrl && !p.liked ? [{ url: p.url, text: p.text }] : [],
    );
    if (!posts.length) return lookOnly('with no post of theirs to see');
    const safe = posts.filter((post) => !neverLike({ text: post.text, pictures: [] }));
    if (!safe.length) return lookOnly('and none of their posts were right to like');
    let liked = 0;
    let already = found ? 1 : 0;
    for (const post of safe.slice(0, room)) {
      if (liked + already > 0) await pause(SETTLE_MS);
      const went = await likeOne(item, businessId, opened.noted, post);
      if (typeof went === 'object') return went;
      if (went === 'liked') liked++;
      else if (went === 'already') already++;
      else if (liked + already === 0) {
        await missed(item, businessId);
        return {
          done: false,
          line: `Couldn’t like ${item.name}’s post: the follow goes without`,
          look: true,
        };
      } else break;
    }
    return done(liked);
  }

  /**
   * A visit while they decide whether to follow back (decision 161): a look at their profile and up to `likes` new
   * likes on their recent posts. Nothing to like: HandsFreeOS hears it, and the visit counts.
   */
  async function visit(item: TodayListItem, businessId: string, likes: number): Promise<Outcome> {
    const opened = await openAccount(item, businessId);
    if ('outcome' in opened) return opened.outcome;
    const theirs = await tab.ask({
      type: 'hfos-their-posts',
      profile: opened.noted,
      most: LIKE_POSTS_READ,
    });
    if (!theirs.ok) throw new Error(theirs.error);
    const safe = theirs.posts.flatMap((p) =>
      p.url && !p.liked && !neverLike({ text: p.text, pictures: [] })
        ? [{ url: p.url, text: p.text }]
        : [],
    );
    let liked = 0;
    let tried = 0;
    for (const post of safe) {
      if (liked >= likes) break;
      if (tried++) await pause(SETTLE_MS);
      const went = await likeOne(item, businessId, opened.noted, post);
      if (typeof went === 'object') return went;
      if (went === 'liked') liked++;
      else if (went === 'not') {
        if (liked) break;
        await missed(item, businessId);
        return { done: false, line: `Couldn’t like ${item.name}’s post on this visit`, look: true };
      }
    }
    if (!liked) await missed(item, businessId);
    return { done: true, line: visitLine(item.name, platform, liked, item.keepWarm?.hi === true) };
  }

  /** A follow, with their profile's own Follow (or Follow back), then their profile read again to see it went. */
  async function followThem(item: TodayListItem, businessId: string): Promise<Outcome> {
    const opened = await openAccount(item, businessId);
    if ('outcome' in opened) return opened.outcome;
    const standing = opened.page.found.profile!.following;
    if (standing === 'following' || standing === 'requested')
      return {
        done: false,
        line: `${item.name}: you follow them already, or asked to`,
        skip: true,
      };
    const pressFollow = async () => {
      const went = await tab.ask({ type: 'hfos-connect', profile: opened.noted });
      if (!went.ok) throw new Error(went.error);
      return went.result;
    };
    let result = await pressFollow();
    if (result === 'already')
      return {
        done: false,
        line: `${item.name}: you follow them already, or asked to`,
        skip: true,
      };
    // Follow moved, or something's over it: the AI helper finds it on their profile (decision 142).
    const help = stepHelp(tab, answer as Hfos, {
      businessId,
      platform,
      step: item.kind,
      theirName: item.name,
      button: buttonFor(platform, 'friend_request')!,
    });
    const missing = 'couldn’t find Follow on their profile';
    if (
      result === 'none' &&
      (await help.press(missing, async () => (await pressFollow()) === 'done'))
    )
      result = 'done';
    if (result === 'none')
      return {
        done: false,
        line: `${item.name}: ${missing}`,
        need: true,
        helper: await help.end(false),
      };
    await pause(SETTLE_MS);
    const page = await read();
    const stop = await warnedOn(page, businessId);
    if (stop) return { stop };
    const standingNow = page.found.profile?.following;
    if (result !== 'done' || (standingNow !== 'following' && standingNow !== 'requested'))
      return {
        done: false,
        line: `${item.name}: ${NAME} didn’t take the follow`,
        need: true,
        helper: await help.end(false),
      };
    const helper = await help.end(true);
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
      platform,
    );
    return {
      done: true,
      line:
        standingNow === 'requested'
          ? `Asked to follow ${item.name}: their account is private`
          : `Followed ${item.name}`,
      helper,
    };
  }

  // ----------------------------------------------------------------------------------------------- its messages

  /**
   * Opens their chat (Threads', decision 167): its own page by its number when it's kept, else their profile's own
   * Message, which shows once they follow the person. It must be with them, by the name in their profile's address.
   */
  async function openChat(
    item: TodayListItem,
    businessId: string,
  ): Promise<
    | { readonly profile: ProfileRef; readonly thread: ThreadRef | null }
    | { readonly outcome: Outcome }
  > {
    const want = wantOf(item.profileUrl);
    const url = item.threadKey ? chatUrlOn(platform, item.threadKey) : null;
    if (item.threadKey && url) {
      await tab.open(url);
      await setState({ tabId: tab.tabId });
      let page = await read();
      if (!page.found.chat?.with && !page.warnings.length && !page.signedOut) {
        // Its messages draw a moment after the page.
        await pause(SETTLE_MS);
        page = await read();
      }
      const stop = await warnedOn(page, businessId);
      if (stop) return { outcome: { stop } };
      if (page.signedOut) return { outcome: { again: SIGNED_OUT } };
      const chat = page.found.chat;
      const profile =
        want ??
        (chat?.with ? { id: null, username: chat.with.username, url: chat.with.url } : null);
      if (!chat?.with || !profile || !sameAs(chat.with.username, profile.username!))
        return { outcome: { done: false, line: `${item.name}: ${NAME} showed a different chat` } };
      return { profile, thread: { id: item.threadKey, encrypted: false, url } };
    }
    const opened = await openAccount(item, businessId);
    if ('outcome' in opened) return opened;
    const pressed = await tab.ask({ type: 'hfos-open-message', profile: opened.noted });
    if (!pressed.ok) {
      // Their Follow, not Follow back, says they don't follow the person: no Message till they do.
      const shown = opened.page.found.profile;
      const notYet = shown?.following === 'no' && shown.followsYou === false;
      return {
        outcome: {
          done: false,
          line: notYet
            ? `${item.name}: ${NAME} shows Message only once they follow you`
            : `${item.name}: couldn’t find Message on their profile`,
        },
      };
    }
    await pause(SETTLE_MS);
    // Their chat's own page: its number is in its address.
    const page = await read();
    const stop = await warnedOn(page, businessId);
    if (stop) return { outcome: { stop } };
    const id = page.found.chat?.thread ?? null;
    const at = id ? chatUrlOn(platform, id) : null;
    return {
      profile: opened.noted,
      thread: id && at ? { id, encrypted: false, url: at } : null,
    };
  }

  /** Their chat as it is now, before a reply is drafted: brought into HandsFreeOS as the network's. */
  async function bringInChat(item: TodayListItem, businessId: string): Promise<Outcome | null> {
    if (!item.threadKey) return null;
    const opened = await openChat(item, businessId);
    if ('outcome' in opened) return 'done' in opened.outcome ? null : opened.outcome;
    const { found } = await read();
    const chat = found.chat;
    const page = chat ? followChatPage(platform, chat) : null;
    // Its messages carry no time: its row in the list beside it says when it last moved, as the chats read takes it.
    const row = chat ? found.chats.find((r) => r.thread === chat.thread) : undefined;
    const built = page ? chatCollect(page, new Date(), row?.when ?? null, platform) : null;
    if (built)
      await answer({
        type: 'hfos-collect-chats',
        input: { workspaceId: businessId, platform, chats: [built] },
      });
    if (chat?.last === 'me')
      return { done: false, line: `${item.name}: ${NOTHING_TO_ANSWER}`, skip: true };
    return null;
  }

  /**
   * Drafts a message with the AI after reading their profile, and hands it to HandsFreeOS to wait or go, as Instagram's
   * runner does; a comment on a good post is drafted from the post (decision 92).
   */
  async function draftMessage(item: TodayListItem, businessId: string): Promise<Outcome> {
    if (item.kind === 'reply' || item.kind === 'partner_reply') {
      const stopped = await bringInChat(item, businessId);
      if (stopped) return stopped;
    }
    const looked = item.profileUrl
      ? await readThemOn(platform)(jobFor(businessId), {
          profileId: item.profileId ?? '',
          name: item.name,
          url: item.profileUrl,
        })
      : { lines: [], missing: true, followers: null };
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
    const { drafts, opener, simple, unanswered, kind: draftedKind } = drafted.value as Drafts;
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
          // Something Knowledge doesn't answer: it waits for the person (decision 122).
          unanswered: kind === 'reply' ? (unanswered ?? null) : null,
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
   * Sends a message OK'd (or on its own, as Sending says) in their chat, as a few short texts when the person texts
   * that way, and notes it. One to their requests goes as one text.
   */
  async function sendMessage(
    item: TodayListItem,
    businessId: string,
    split: boolean,
  ): Promise<Outcome> {
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
    const parts = messageParts(send.text, split && item.requests !== true);
    let partly: string | null = null;
    for (const [i, part] of parts.entries()) {
      if (i > 0) await pause(partPauseMs(part, Math.random()));
      const wrote = await tab.ask({ type: 'hfos-message', text: part, profile: chat.profile });
      const why = !wrote.ok
        ? wrote.error
        : wrote.result === 'none'
          ? 'couldn’t find the box to write in'
          : wrote.result === 'not_theirs'
            ? `its typing didn’t stay in their chat, so it took it out${i === 0 ? ' and sent nothing' : ''}`
            : wrote.result !== 'done'
              ? `${NAME} didn’t take the message`
              : null;
      if (why === null) continue;
      if (i === 0) return failed(`${item.name}: ${why}`);
      partly = `Sent ${item.name} ${i} of ${parts.length} texts, then: ${why}`;
      break;
    }
    // The chat's number, once its own page shows it.
    const after = await read();
    const id = chat.thread?.id ?? after.found.chat?.thread ?? null;
    const at = id ? chatUrlOn(platform, id) : null;
    await takeNote(
      {
        type: 'hfos-noted',
        step: {
          kind: 'message',
          to: { name: item.name, profile: chat.profile },
          group: null,
          postUrl: null,
          thread: id && at ? { id, encrypted: false, url: at } : null,
          replying: item.kind === 'reply' || item.kind === 'partner_reply',
          auto: true,
        },
        at: now(),
      },
      platform,
    );
    await sendDone(send.sendId, businessId, true, null);
    await pause(SETTLE_MS);
    const stop = await warnedOn(await read(), businessId);
    if (stop) return { stop };
    return { done: true, line: partly ?? `Sent ${item.name} a message` };
  }

  /** A job in the runner's window, for the hourly search and the once-a-day jobs, noting warnings as the network's. */
  function jobFor(businessId: string): Job {
    return {
      tab,
      hfos: answer as Hfos,
      businessId,
      stopped: () => stopAsked,
      progress: (line) => void say(line, { working: true }).catch(() => undefined),
      async warn(words, url) {
        const fresh = await keepWarning(words, platform);
        if (fresh.length)
          await answer({
            type: 'hfos-warning',
            input: warningInput(businessId, fresh, url, platform),
          });
      },
    };
  }

  /** A job that notes a page it couldn't read with its outline (decision 74). */
  const reporting = (job: Job, kind: string): Job => ({
    ...job,
    report:
      job.report ??
      reporter(job.tab, job.hfos, { businessId: job.businessId, platform, askId: null, job: kind }),
  });

  /** Does a piece of work: a step on the list, or a comment's or a message's draft or send. */
  function doWork(work: Work, businessId: string, spare = 0, split = true): Promise<Outcome> {
    if (work.do === 'draft')
      // A comment's post's picture or video goes with its draft (decision 172, from 0.144.0).
      return isCommentWork(work)
        ? draftComment(work.item, businessId, {
            runner: commenting,
            them: wantOf(work.item.profileUrl),
          })
        : draftMessage(work.item, businessId);
    if (work.do === 'send')
      return isCommentWork(work)
        ? sendComment(work.item, wantOf(work.item.profileUrl), businessId, commenting)
        : sendMessage(work.item, businessId, split);
    switch (work.item.kind) {
      case 'warm_up':
      case 'partner_warm_up':
        return warmUp(work.item, businessId, spare);
      case 'friend_request':
        return followThem(work.item, businessId);
      default:
        return Promise.resolve({
          done: false,
          line: `${work.item.name}: that’s yours to do on ${NAME}`,
        });
    }
  }

  const doing = (work: Work) =>
    commentDoing(work) ??
    (work.do === 'step'
      ? `${work.item.kind === 'friend_request' ? 'Following' : `Looking at the ${NAME} of`} ${work.item.name}…`
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

  // ----------------------------------------------------------------------------------------------- its jobs

  /** Does one of its once-a-day jobs. */
  async function runDaily(kind: FollowDaily, job: Job): Promise<JobEnd> {
    switch (kind) {
      case 'requests':
        return saveFollowers(job, platform);
      case 'follow_backs':
        return lookForFollowBacks(job, platform);
      case 'tidy':
        return unfollowOnItsOwn(job, platform);
      case 'chats':
        return readFollowChats(job, platform, {
          most: DAILY_CHATS,
          memory: chatMemory,
          again: 'The rest wait for tomorrow.',
        });
      case 'post_people':
        return readPostRepliers(reporting(job, kind), platform);
      case 'found_checks':
        return checkFound(job, { platform, read: readThemOn(platform) });
      case 'comment_research':
        return readFollowComments(job, platform);
      case 'profile':
        return readProfileOnItsOwn(job, platform, (j) =>
          followAsk(platform)({ kind: 'profile_read' }, j),
        );
    }
  }

  /** The hour's search, then the replies to their comments: its main work, done every hour (answer 2a, 8a). */
  async function searchHour(businessId: string): Promise<JobEnd> {
    await say(`Searching ${NAME} for new posts about your business…`, { working: true });
    const job = reporting(jobFor(businessId), 'posts');
    let end: JobEnd;
    try {
      end = await hourlySearch(job, platform);
      if (!end.warned && !end.failed && !stopAsked) {
        const replies = await readCommentReplies(job, platform);
        end = replies.warned ? replies : { ...end, line: `${end.line} ${replies.line}` };
      }
    } catch (error) {
      if (error instanceof Refused) throw error;
      end = {
        line: error instanceof Error ? error.message : String(error),
        warned: false,
        failed: true,
      };
    } finally {
      await setState({ working: false, tabId: tab.tabId });
    }
    // Searched or not, the next look is an hour on: one that went wrong isn't tried again at once.
    await setState({ watchAt: nextSearch(platform, Date.now(), Math.random()) });
    return end;
  }

  // ----------------------------------------------------------------------------------------------- the day

  const dayOf = (kept: Kept | null) => kept?.days?.[platform] ?? null;

  /** What's left on a list for the runner, with what the list says kept for its day (`listSays`). */
  async function leftOf(
    list: TodayList,
    tried: readonly string[],
    replied: readonly string[] = [],
  ): Promise<Work[]> {
    const says = listSays(list);
    const kept = await stateNow();
    if (kept.more !== says.more || (kept.retryAt ?? null) !== says.retryAt) await setState(says);
    return followWorkLeft(list, tried, replied, NETWORKS[platform].messages);
  }

  async function listNow(
    businessId: string,
    tried: readonly string[],
    replied: readonly string[] = [],
  ): Promise<{ readonly list: TodayList; readonly left: Work[] }> {
    const list: TodayList = await call(
      api().POST('/v1/queries/outreach.today', { body: { workspaceId: businessId, platform } }),
      businessId,
    );
    return { list, left: await leftOf(list, tried, replied) };
  }

  // ----------------------------------------------------------------------------------------------- a go's moves

  /** What a go works with, once its own checks let it work. */
  interface Going {
    readonly businessId: string;
    readonly settings: Settings;
    readonly timezone: string;
    /** From 0 to 1, the go's own: every wait it picks keeps one pace. */
    readonly random: number;
    /** When the go began. */
    readonly at: number;
  }

  const tomorrowFor = (g: Going) => nextStart(g.settings.hours, g.timezone, Date.now(), g.random);
  /**
   * The next go after a part of the day's reading: its own pace, or the wait HandsFreeOS sent with the move, never
   * sooner than its pace's least.
   */
  const goAfter = (g: Going, gap?: number) =>
    goAt(Date.now() + (gap === undefined ? pickGap(g.random) : Math.max(gap, FOLLOW_GAP_MS.least)));

  /** The network warned: it stops there for the day. */
  async function warnedEnd(line: string, g: Going): Promise<void> {
    await closeWindow();
    await say(line, { stopped: 'warning' });
    return goAt(tomorrowFor(g));
  }

  /** Its hour's search, and what follows it. */
  async function searchGo(g: Going, gap?: number): Promise<void> {
    const end = await inTurn('runner', () => searchHour(g.businessId), platform);
    if (end.warned) return warnedEnd(end.line, g);
    await say(end.line, { readLast: true, ...(end.failed ? { needs: true } : {}) });
    void feed(jobKind(end), `${NAME}: ${end.line}`);
    return goAfter(g, gap);
  }

  /** A step before the day (their followers saved, who to unfollow worked out), and what follows it. */
  async function beforeGo(before: BeforeDay, g: Going, gap?: number): Promise<void> {
    const end = await inTurn('runner', () => beforeTheDay(before, g.businessId), platform);
    const line = beforeDayLine(before, end, platform);
    if (end.warned) return warnedEnd(end.line, g);
    if (end.away) {
      await say(line, { readLast: true });
      return goAfter(g, gap);
    }
    await setState({ readLast: true });
    void feed(jobKind(end), `${NAME}: ${line}`);
    if (before.do === 'save' && before.first && end.failed) {
      await closeWindow();
      await say(
        `${line} Your first day on ${NAME} starts once your followers are saved, so it tries again in a few minutes.`,
        { needs: true },
      );
      return goAt(Date.now() + AGAIN_MS);
    }
    await say(line);
    return goAfter(g, gap);
  }

  /**
   * One of its once-a-day jobs, and what follows it. In the hours it takes turns with the list (`turn`, decision
   * 123); outside them only a comment research reads, and the list has no turn to take.
   */
  async function dailyGo(daily: FollowDaily, g: Going, turn: boolean, gap?: number): Promise<void> {
    const end = await inTurn('runner', () => collect(daily, g.businessId), platform);
    if (end.warned) return warnedEnd(end.line, g);
    const line = `${DAILY_NAMES[daily]}: ${end.line}`;
    await say(line, turn ? { readLast: true } : {});
    if (end.away) putOff.off(daily);
    else void feed(jobKind(end), `${NAME}: ${line}`);
    return goAfter(g, gap);
  }

  /**
   * Nothing's left for it now: it says so, and looks again within the hour, sooner for a read put off till the
   * person's away, the next batch of checks, its search or a message tried again; or when HandsFreeOS said (`until`).
   */
  async function idleGo(
    state: AutoState,
    collects: boolean,
    passOver: readonly FollowDaily[],
    g: Going,
    until?: number | null,
  ): Promise<void> {
    const { at } = g;
    await closeWindow();
    const waiting = collects ? waitingWords(waitingFor(passOver, state.daily, DAILY_NAMES)) : null;
    const later = collects ? soonestAgain(await stateNow(), at) : null;
    const searchAt = collects ? ((await stateNow()).watchAt ?? null) : null;
    await say(
      `${
        waiting
          ? `${state.tried.length ? `The rest of today on ${NAME} is done.` : `Nothing on your ${NAME} list for it to do yet.`} ${waiting}`
          : state.tried.length
            ? `Done for now on ${NAME}. It searches again within the hour for new posts.`
            : `Nothing on your ${NAME} list for it to do yet. It searches again within the hour for new posts.`
      }${later !== null ? ` ${AGAIN_WORDS}` : ''}`,
    );
    return goAt(
      until ??
        Math.min(
          at + (waiting ? AWAY_AGAIN_MS : 60 * 60_000),
          ...(later !== null ? [later] : []),
          ...(searchAt !== null ? [searchAt] : []),
          ...retryWake(await stateNow(), at),
        ),
    );
  }

  // ----------------------------------------------------------------------------------------------- as it's told

  /**
   * Waits as HandsFreeOS said (decision 195, step 2), with the words its own go says for each wait. What HandsFreeOS
   * knows and this computer doesn't yet (a warning noted on another of their computers, Stop for today pressed a
   * moment ago) holds it till it's asked again: its own state is left to what this computer sees.
   */
  async function waitAsTold(
    move: Extract<ToldNext['move'], { do: 'wait' }>,
    g: Going,
    here: {
      readonly state: AutoState;
      readonly collects: boolean;
      readonly passOver: readonly FollowDaily[];
    },
  ): Promise<void> {
    const { settings, timezone, at } = g;
    switch (move.why) {
      case 'off':
        await goAt(null);
        return closeWindow();
      case 'asks':
        await say(ASK_FIRST_WORDS);
        return goAt(move.until ?? at + ASK_FIRST_MS);
      case 'noting':
        await closeWindow();
        await say(notingOffWords, { needs: true });
        return goAt(move.until ?? at + LOOK_AGAIN_MS);
      case 'warned':
        await closeWindow();
        await say(warnedWords(await warnedNow(platform)));
        return goAt(move.until);
      case 'screen':
        await closeWindow();
        await say(firstDayWaits);
        return goAt(move.until ?? Date.now() + AWAY_AGAIN_MS);
      case 'idle':
        return idleGo(here.state, here.collects, here.passOver, g, move.until);
      case 'stopped':
      case 'hours':
        await closeWindow();
        await say(
          networkWaitWords(
            NAME,
            { stopped: move.why === 'stopped' ? 'person' : null },
            settings.hours,
            timezone,
            at,
          ),
        );
        return goAt(move.until);
    }
  }

  /**
   * Does the move HandsFreeOS sent (decision 195, step 2), each as its own go does it: the same read, the same step
   * on the list, at its own pace, within every limit it keeps. False for a move this build can't do as it stands (a
   * job that isn't this network's, a save of their lists while they're at their computer, a piece of work that isn't
   * on its list): the runner then plans the go itself.
   */
  async function asTold(
    told: ToldNext,
    g: Going,
    here: {
      readonly state: AutoState;
      readonly away: boolean;
      readonly passOver: readonly FollowDaily[];
      readonly collects: boolean;
      /** In its hours, where the day's reading takes turns with the list. */
      readonly turn: boolean;
    },
  ): Promise<boolean> {
    const { move, change } = told;
    const keep = async () => {
      if (change) await setState(changeKept(here.state, change));
    };
    switch (move.do) {
      case 'wait':
        await keep();
        await waitAsTold(move, g, here);
        return true;
      case 'search':
        await keep();
        await searchGo(g, move.gap);
        return true;
      case 'before': {
        const step = move.step as BeforeDay;
        if (!LIST_MARKS_ON[platform].includes(markOf(step))) return false;
        // A save of their lists reads with its window on screen: never while they're at their computer (decision 120).
        if (step.do === 'save' && !here.away) return false;
        await keep();
        await beforeGo(step, g, move.gap);
        return true;
      }
      case 'daily': {
        const job = followDailyOn(platform).find((mine) => mine === move.job);
        if (!job) return false;
        await keep();
        await dailyGo(job, g, here.turn, move.gap);
        return true;
      }
      case 'work': {
        if (!told.list) return false;
        const all = await leftOf(told.list, here.state.tried, here.state.replied);
        // Outside its hours only a reply to someone who wrote back goes (decision 133).
        const left = move.answering ? all.filter(answersAnyTime) : all;
        const pick = left.find((work) => workKey(work) === move.key);
        if (!pick) return false;
        await keep();
        await workNext([pick, ...left.filter((work) => work !== pick)], told.list, {
          businessId: g.businessId,
          settings: g.settings,
          timezone: g.timezone,
          own: { go: true, started: move.day.started, until: move.day.until },
          reading: move.reading,
          random: g.random,
        });
        return true;
      }
      default:
        return false;
    }
  }

  // ----------------------------------------------------------------------------------------------- a go

  const notingOffWords = `Turn on noting your steps in Social Outreach → Settings in HandsFreeOS: the extension works on its own on ${NAME} only while it notes.`;
  const firstDayWaits = `Your first day on ${NAME} starts once your followers are saved. That needs its window on screen, so it waits till you’ve been away from your computer for 2 minutes.`;
  const warnedWords = (warned: Awaited<ReturnType<typeof warnedNow>>) =>
    `Stopped: ${NAME} warned you today${warned ? ` (“${warned.words[0]}”)` : ''}. The extension stops on ${NAME} until tomorrow.`;

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
    await retryAfterUpdate(to.businessId);
    const { settings, timezone } = found;
    const choices = settings.networks[platform];
    let state = await stateNow();
    const at = Date.now();
    const today = businessDay(at, timezone);
    if (state.day !== today)
      state = await setState({ ...freshState(today, state.tabId), watchAt: state.watchAt ?? null });
    await tab.adopt(state.tabId);
    const kept = await keptFor(to);
    if (!isWorking(kit, await statesNow()) || choices.sending === 'off') {
      await goAt(null);
      return closeWindow();
    }
    if (kept && !kept.working) {
      await closeWindow();
      await say(standDownWords(kept.workingName));
      return goAt(null);
    }
    const random = Math.random();
    const own = networkDay({
      day: dayOf(kept),
      today,
      hours: settings.hours,
      timeZone: timezone,
      now: at,
      random,
    });
    const g: Going = { businessId: to.businessId, settings, timezone, random, at };
    const researchAsk = {
      hfos: answer as Hfos,
      businessId: to.businessId,
      platform,
      setState,
    } as const;
    if (!own.go) {
      await setState({ started: false, stopped: own.stopped });
      // Outside the hours a reply to someone who wrote back still goes, where it writes in their messages (Threads'),
      // and nothing new does (decision 133): never after Stop for today or a warning, nor while noting's off or an ask
      // of theirs is in line.
      const free =
        own.stopped === null &&
        !(await warnedNow(platform)) &&
        (await isNoting()) &&
        !askInLine(platform);
      // A comment research this person started reads outside the hours too, as it only reads (decision 194): never
      // after Stop for today or a warning, as nothing does.
      const away = free ? await awayNow() : false;
      const passOut = free && choices.collect ? putOff.passOver(away) : [];
      let reads = false;
      if (free && choices.collect) {
        const research = await researchNext({ ...researchAsk, state, now: at, passOver: passOut });
        state = research.state;
        reads = research.reads;
      }
      // Free to work: HandsFreeOS says what's next, where it decides (decision 195).
      if (free) {
        const told = await planNext(platform, to, {
          state,
          now: at,
          random,
          here: { away, passOver: passOut, research: reads, asking: false },
        });
        const here = { state, away, passOver: passOut, collects: choices.collect, turn: false };
        if (told && (await asTold(told, g, here))) return;
      }
      // By itself, as it always has.
      const answering =
        NETWORKS[platform].messages && free
          ? await listNow(to.businessId, state.tried, state.replied)
          : null;
      const answers = answering?.left.filter(answersAnyTime) ?? [];
      if (answers[0])
        return workNext(answers, answering!.list, {
          businessId: to.businessId,
          settings,
          timezone,
          own: ANSWERING,
          reading: false,
          random,
        });
      if (reads) return dailyGo('comment_research', g, false);
      await closeWindow();
      await say(networkWaitWords(NAME, own, settings.hours, timezone, at));
      const latest = await stateNow();
      const look = lookOutsideAt(
        !!answering && replyWaiting(answering.list),
        at,
        own.next,
        answering ? retryWake(latest, at) : [],
      );
      return goAt(free && choices.collect ? lookForResearch(look, latest, at, passOut) : look);
    }
    if (own.started && !state.started) state = await setState({ started: true, stopped: null });
    if (state.stopped === 'warning' || (await warnedNow(platform))) {
      const warned = await warnedNow(platform);
      await closeWindow();
      await say(warnedWords(warned), { stopped: 'warning' });
      return goAt(tomorrowFor(g));
    }
    if (!(await isNoting())) {
      await closeWindow();
      await say(notingOffWords, { needs: true });
      return goAt(at + LOOK_AGAIN_MS);
    }
    if (askInLine(platform)) {
      await say(ASK_FIRST_WORDS);
      return goAt(at + ASK_FIRST_MS);
    }

    // Lists first (decision 60), its own.
    const lists = valueOf(
      await (answer as Hfos)({ type: 'hfos-lists', workspaceId: to.businessId, platform }),
    );
    if (JSON.stringify(state.lists) !== JSON.stringify(lists)) state = await setState({ lists });
    const away = await awayNow();
    const passOver = putOff.passOver(away);
    // HandsFreeOS's own comment research (decision 172) is only for whoever of its staff started one: asked without a
    // word, and for anyone else it's done for the day before a line of it is ever shown. While one runs, its batch goes
    // first whenever it's due (decision 194).
    let reads = false;
    if (choices.collect) {
      const research = await researchNext({ ...researchAsk, state, now: at, passOver });
      state = research.state;
      reads = research.reads;
    }
    // Free to work: HandsFreeOS says what's next, where it decides (decision 195).
    const told = await planNext(platform, to, {
      state,
      now: at,
      random,
      here: { away, passOver, research: reads, asking: false },
    });
    if (
      told &&
      (await asTold(told, g, { state, away, passOver, collects: choices.collect, turn: true }))
    )
      return;

    // By itself, as it always has.
    const before = beforeDay(lists, state.before ?? {}, at, timezone, platform);
    if (before?.do === 'save' && before.first && !away) {
      await closeWindow();
      await say(firstDayWaits);
      return goAt(Date.now() + AWAY_AGAIN_MS);
    }
    let daily: FollowDaily | null = !choices.collect
      ? null
      : reads
        ? 'comment_research'
        : nextFollowDaily(platform, state, passOver, at);
    if (
      choices.collect &&
      !before &&
      !daily &&
      !passOver.some((job) => state.daily?.[job] === undefined) &&
      roundDue(state, at)
    ) {
      state = await setState(nextRound(state, FOLLOW_FINDING, at));
      daily = nextFollowDaily(platform, state, passOver, at);
    }
    // Its search, every hour, once its first day's followers are saved: what it's there for.
    const searching = choices.collect && !holdsTheDay(before) && searchDue(state, at);
    const reading =
      (before !== null && (away || before.do !== 'save')) || daily !== null || searching;
    // The reading and the list take turns (decision 123).
    if (listTurn(state, reading, holdsTheDay(before))) {
      const { list, left } = await listNow(to.businessId, state.tried, state.replied);
      const replied = stillReplied(state.replied ?? [], left);
      if (replied.length !== (state.replied ?? []).length) state = await setState({ replied });
      if (left[0])
        return workNext(left, list, {
          businessId: to.businessId,
          settings,
          timezone,
          own,
          reading,
          random,
        });
    }

    if (searching) return searchGo(g);
    if (before && (away || before.do !== 'save')) return beforeGo(before, g);
    if (daily) return dailyGo(daily, g, true);

    const { list, left } = await listNow(to.businessId, state.tried, state.replied);
    if (!left[0]) return idleGo(state, choices.collect, passOver, g);
    return workNext(left, list, {
      businessId: to.businessId,
      settings,
      timezone,
      own,
      reading,
      random,
    });
  }

  async function workNext(
    left: readonly Work[],
    list: TodayList,
    at: {
      readonly businessId: string;
      readonly settings: Settings;
      readonly timezone: string;
      readonly own: Extract<NetworkDay, { go: true }>;
      readonly reading: boolean;
      readonly random: number;
    },
  ): Promise<void> {
    const work = left[0]!;
    const { businessId, settings, own } = at;
    const tomorrow = () => nextStart(settings.hours, at.timezone, Date.now(), at.random);
    const { item } = work;
    await say(doing(work), { working: true, readLast: false });
    const run = () =>
      inTurn(
        'runner',
        () => doWork(work, businessId, spareLikes(list, left), settings.voice?.split ?? true),
        platform,
      );
    let outcome: Outcome;
    try {
      outcome = await run();
    } catch (error) {
      if (error instanceof Refused) throw error;
      outcome = {
        done: false,
        line: `${item.name}: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      await setState({ working: false });
    }
    const helped = await helpAfter({
      tab,
      hfos: answer as Hfos,
      businessId,
      platform,
      work,
      job: work.do === 'step' ? work.item.kind : work.do,
      outcome,
      again: work.do === 'step' ? run : null,
      say: (line) => say(line, { working: true, readLast: false }),
    });
    outcome = helped.outcome;
    await setState({ working: false });
    if ('again' in outcome) {
      await closeWindow();
      await say(outcome.again, { needs: true });
      return goAt(Date.now() + AGAIN_MS);
    }
    const state = await stateNow();
    const kind = doneAs(work);
    const done =
      'done' in outcome && outcome.done
        ? { ...state.done, [kind]: (state.done[kind] ?? 0) + 1 }
        : state.done;
    await setState({
      tried: [...state.tried, workKey(work)],
      done,
      replied: repliedAfter(state.replied ?? [], work),
    });
    if ('stop' in outcome) {
      await closeWindow();
      await say(outcome.stop, { stopped: 'warning' });
      return goAt(tomorrow());
    }
    await say(outcome.line);
    const need =
      work.do === 'step' && handsOver(item, outcome)
        ? needOf(item, outcome.line, businessId, helped.reportId)
        : null;
    if (need) void noteNeed(need);
    if (work.do === 'step') void clearRetried(item, outcome, businessId);
    void feed(outcomeKind(outcome), `${NAME}: ${outcome.line}`);
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
        started: own.started || at.reading,
        random: at.random,
      }),
    );
    // Never past its next search: the hour's search goes on time.
    const searchAt = (await stateNow()).watchAt ?? null;
    await goAt(
      Math.min(Date.now() + gap, ...(searchAt !== null && searchAt > Date.now() ? [searchAt] : [])),
    );
  }

  async function beforeTheDay(step: BeforeDay, businessId: string): Promise<JobEnd> {
    const key = markOf(step);
    await setState({ beforeNow: key });
    await say(beforeDayDoing(step, platform), { working: true });
    let end: JobEnd;
    try {
      end = await doBeforeDay(step, jobFor(businessId), platform);
    } catch (error) {
      if (error instanceof Refused) throw error;
      end = isNotAway(error)
        ? awayEnd()
        : {
            line: error instanceof Error ? error.message : String(error),
            warned: false,
            failed: true,
          };
    } finally {
      await setState({ working: false, tabId: tab.tabId, beforeNow: null });
    }
    if (end.away) return end;
    const state = await stateNow();
    // The newest followers saved stand for today's.
    const stands =
      !end.failed && key === 'friends'
        ? afterDaily(state, 'requests', end, Date.now(), Math.random())
        : {};
    await setState({ before: { ...state.before, [key]: end.line }, ...stands });
    return end;
  }

  async function collect(kind: FollowDaily, businessId: string): Promise<JobEnd> {
    await say(doingDaily[kind], { working: true });
    let end: JobEnd;
    try {
      end = await runDaily(kind, { ...jobFor(businessId), round: (await stateNow()).round ?? 0 });
    } catch (error) {
      if (error instanceof Refused) throw error;
      end = isNotAway(error)
        ? awayEnd()
        : { line: error instanceof Error ? error.message : String(error), warned: false };
    } finally {
      await setState({ working: false, tabId: tab.tabId });
    }
    if (end.away) return end;
    await setState(afterDaily(await stateNow(), kind, end, Date.now(), Math.random()));
    return end;
  }

  async function tick(): Promise<void> {
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
      await say(`Stopped for now: ${words} It tries again in a few minutes.`, {
        needs: true,
      }).catch(() => undefined);
      await goAt(Date.now() + AGAIN_MS).catch(() => undefined);
    } finally {
      // Its tab closes the moment the go's work is done; the next step opens a fresh one (decision 171).
      if (tab.tabId !== null) await closeWindow().catch(() => undefined);
      busy = false;
      if (again) {
        again = false;
        void tick();
      }
    }
  }

  /** The day as the last beat said it: a change starts it, or ends what it's doing at its next page. */
  let lastDay: string | null = null;
  onBeat((kept) => {
    const day = dayOf(kept);
    const said = day ? `${day.date}:${day.state}` : null;
    if (said === lastDay) return;
    const was = lastDay;
    lastDay = said;
    if (was === null && said !== null && day?.state !== 'started') return;
    if (day?.state === 'stopped' || !kept.working) stopAsked = true;
    if (day?.state === 'stopped' && day.why !== 'warning')
      haltAsk(platform, `Stopped: you pressed Stop for today on ${NAME}.`);
    void tick();
  });

  return {
    alarm: ALARM,
    tick,
    async wake() {
      const alarm = await chrome.alarms.get(ALARM);
      if (!alarm) await tick();
    },
    // Someone answered a comment: its answer is drafted next (decision 125).
    async replied(profileIds) {
      const state = await stateNow();
      await setState({ replied: withReplied(state.replied ?? [], profileIds) });
      void tick();
    },
    tabId: () => tab.tabId,
    doWork,
    runDaily,
    searchHour,
  };
}

/** Threads' runner and X's, each on its own. */
export const FOLLOW_RUNNERS: Readonly<Record<FollowPlatform, FollowRunner>> = {
  threads: followRunner('threads'),
  x: followRunner('x'),
};

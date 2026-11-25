/**
 * Instagram's runner (the Instagram and Alignable plan's part 14, "On its own"): the extension on its own on Instagram,
 * as LinkedIn's (./linkedin.ts) and Alignable's (./alignable.ts) runners are on theirs, beside them and Facebook's
 * (./run.ts) and never waiting on any. It has its own line (its own turn with Instagram's asks, ./turns.ts), its own
 * window, its own alarm and its own state (`hfos.auto.instagram`).
 *
 * - **In the working hours, or once its day is started.** From 0.96.0 it starts on its own in the person's working
 *   hours, in the business's time zone, at random times spread over the day as Facebook's does (./plan.ts,
 *   `networkDay`); Instagram's Start my day, pressed in HandsFreeOS or on the phone, which the beat brings
 *   (`days.instagram`), starts it straight away at a person's pace. Stop for today there ends what it's doing at its
 *   next page, and its asks' too, until its next working hours.
 *   It works only while Instagram is on for the person and Chrome allows it, while noting is on, while this computer
 *   is the one that works, and while the person's Instagram Sending choice isn't Off.
 * - **Lists first** (decision 60): before Instagram's first day, its newest followers are saved (the newest 200, the
 *   owner's design of 21 Oct 2026), who to unfollow worked out for the person to tick, and the followers checked once
 *   (./lists.ts); after that the followers new since, weekly.
 * - **Once a day,** as the person's Instagram choices say (`collect`): the followers new since the last save (a
 *   follow-back is its accepting, so their first message comes), then up to 30 accounts the person followed looked at
 *   for who follows them back (../jobs/instagram/follow-backs.ts), so the first message, the one to their Requests and
 *   the unfollow list never wait on the whole list of followers; the followers checked for good fits (20 accounts a day
 *   to start, its kit's `checksPerDay`), their chats read for the AI with who wrote last noted, Find partners
 *   (Instagram's search, its hashtags and the accounts it suggests, then those found read for the AI's partner check),
 *   and from part 15 the day's hashtags and places, made from the playbooks' area and words, whose posts go for the
 *   AI's check (a good one's author gets a like, then a follow), and their notifications' warm leads (whoever followed
 *   them is followed back; whoever liked or commented gets a like back, then a follow).
 * - **Then Instagram's list for today,** a step after each part of the reading above while it's left (decision 123)
 *   (`outreach.today` with `platform: 'instagram'`), the kinds it does on its own (`auto`): a look at their account and
 *   a like on one or two of their recent posts (the warm-up), the first that nothing rules out (never one about grief,
 *   illness or trouble), a second only while the day's likes have room past the warm-ups still to come; from 0.103.0
 *   their story, when their account shows one, watched and liked as one of those likes, up to 20 a day (decision 111);
 *   a follow a day after, with their account's own Follow; and the messages: drafted after a look-up of their account,
 *   and sent once OK'd in their chat, typing only into its own box. The first message goes once they follow back; the
 *   one to their Requests (part 12's rule) as one text, never split; follow-ups only in a chat they've answered or
 *   accepted, as HandsFreeOS lists them. From 0.95.0 a comment on a good post is drafted by the AI and goes through
 *   Waiting for you as messages do (decision 92, ./comments.ts): it waits for the person's OK while the comment hold or
 *   training wheels are on, then goes on its own, only in the post's own box. Unfollowing stays the person's ticks, as
 *   withdrawing old requests does on the other networks.
 * - **At Instagram's pace:** a few minutes between steps, slower than LinkedIn's, within Instagram's low limits, which
 *   HandsFreeOS keeps (its list holds only what they have room for).
 * - **Stops on any Instagram warning** ("Action blocked", "Try again later"), for the day, on Instagram alone: the
 *   other networks go on. HandsFreeOS halves its limits for a week and takes follows off its list for two days.
 * - **HandsFreeOS says what's next** (decision 195, step 2, from 0.158.0): once its own checks let it work (this is
 *   the computer that works, its Sending isn't Off, no warning, noting on, Stop for today not pressed, nothing the
 *   person asked in line), it asks HandsFreeOS for its next move (../hfos/plan.ts `planNext`) with what only this
 *   computer knows (whether they're away, the reads put off till they are, a comment research that reads), and does
 *   the move it's sent, exactly as it does its own: the same read, step, pace and limits (`asTold`). A piece of work
 *   comes from the same list for today, so who it may message is still HandsFreeOS's list's to say (never someone who
 *   doesn't follow them, decision 159). Whenever HandsFreeOS doesn't decide for it, can't be reached, or sends a move
 *   this build can't do, it plans the go itself by the same rules, as it always has. It never saves their followers
 *   while they're at their computer, whatever it's sent (decision 120).
 *
 * Each step is noted as the extension's own (`auto`), as Instagram's (`platform: 'instagram'`). Anything its page
 * doesn't let it do is handed to the person (`noteNeed`), never guessed.
 */
import { businessDay } from '@hfos/core/addons/outreach/automation';
import type { MessageKind } from '@hfos/core/addons/outreach/automation';
import { ASK_FIRST_WORDS } from '@hfos/core/addons/outreach/asks';
import { LIST_MARKS_ON } from '@hfos/core/addons/outreach/lists';
import { LIKE_POSTS_READ, likedText, neverLike } from '@hfos/core/addons/outreach/like-pick';
import { visitLine } from '@hfos/core/addons/outreach/keep-warm';
import { standDownWords } from '@hfos/core/addons/outreach/live';
import { chatUrlOn } from '@hfos/core/addons/outreach/network-words';
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import { PARTNER_CHECKS_PER_DAY } from '@hfos/core/addons/outreach/partners';
import { messageParts, partPauseMs } from '@hfos/core/addons/outreach/voice';
import type { TodayKind } from '@hfos/core/addons/outreach/today';
import { buttonFor } from '@hfos/core/addons/outreach/helper';
import type { ProblemHelper } from '@hfos/core/problem-report';
import { haltAsk } from '../asks/run';
import { follow, loadSettings } from '../hfos/follow';
import { feed, jobKind, keptFor, onBeat, outcomeKind, type Kept } from '../hfos/live';
import type { Drafts, TodayList, TodayListItem } from '../hfos/messages';
import { isNoting, noteNeed, takeNote } from '../hfos/noting';
import { changeKept, planNext, type ToldNext } from '../hfos/plan';
import { clearRetried, handsOver, retryAfterUpdate } from './retry';
import { chatCollect, NOTHING_TO_ANSWER } from '../hfos/saves';
import { answer, api, call, Refused, savingTo } from '../hfos/session';
import { keepWarning, warnedNow, warningInput } from '../hfos/warned';
import { chatMemory } from '../jobs/chats';
import { chatPageOf, isRow, readInstagramChats } from '../jobs/instagram/chats';
import { accountIn, checkFollowers, isTheirs, readThemOnInstagram } from '../jobs/instagram/checks';
import { readInstagramWarmLeads } from '../jobs/instagram/engaged';
import { lookUpOnInstagram } from '../jobs/instagram/lookup';
import { searchInstagram } from '../jobs/instagram/partner-search';
import { lookForFollowBacks } from '../jobs/instagram/follow-backs';
import { saveFollowers } from '../jobs/instagram/people';
import { readLikeYours } from '../jobs/instagram/like-yours';
import { lookForResearch, researchNext } from '../jobs/comment-research';
import { readCommentsForResearch } from '../jobs/instagram/comment-research';
import { readPostPeople } from '../jobs/instagram/post-people';
import { lookAtTagsAndPlaces } from '../jobs/instagram/posts';
import { unfollowOnItsOwn } from '../jobs/instagram/unfollow';
import { readInstagramIn, type InstagramPage } from '../jobs/instagram/read';
import { valueOf, warnedLine, type Hfos, type Job, type JobEnd } from '../jobs/job';
import { checkFound } from '../jobs/found-checks';
import { instagramProfileRead } from '../jobs/looking';
import { readProfileOnItsOwn } from '../jobs/own-read';
import { checkPartners } from '../jobs/partners';
import { reporter } from '../jobs/report';
import { askWeeklyPost } from '../jobs/weekly-post';
import { instagram } from '../networks';
import { instagramUrl, postOf, storyUrl } from '../networks/instagram/urls';
import type { ProfileRef, ThreadRef } from '../networks/facebook/types';
import { isWorking, statesNow } from '../networks/on';
import { awayNow } from '../away';
import { WorkTab } from '../tab';
import {
  commentDoing,
  draftComment,
  isCommentWork,
  sendComment,
  type LookingRunner,
} from './comments';
import { DAILY_CHATS } from './daily';
import { AWAY_AGAIN_MS, awayEnd, isNotAway, PutOff, waitingFor, waitingWords } from './on-screen';
import {
  beforeDay,
  beforeDayDoing,
  beforeDayLine,
  doBeforeDay,
  holdsTheDay,
  markOf,
  type BeforeDay,
} from './lists';
import {
  afterDaily,
  AGAIN_WORDS,
  ANSWERING,
  answersAnyTime,
  freshState,
  gapAfter,
  INSTAGRAM_STATE_KEY,
  isState,
  listTurn,
  lookOutsideAt,
  needOf,
  networkDay,
  networkWaitWords,
  nextRound,
  nextStart,
  repliedAfter,
  replyWaiting,
  roundDue,
  soonestAgain,
  stillReplied,
  waitsAgain,
  withReplied,
  workKey,
  workLeft,
  type AutoState,
  type DailyJob,
  type DoneKind,
  type NetworkDay,
  type Work,
  listSays,
  retryWake,
} from './plan';
import { helpAfter, stepHelp } from './helper';
import { askInLine, inTurn } from './turns';
import {
  INSTAGRAM_AUTO,
  INSTAGRAM_DAILY,
  INSTAGRAM_DAILY_NAMES,
  INSTAGRAM_FINDING,
  INSTAGRAM_GAP_MS,
  type InstagramDaily,
} from '@hfos/core/addons/outreach/runners';

const PLATFORM: Platform = 'instagram';
const NAME = NETWORKS.instagram.name;

export const INSTAGRAM_ALARM = 'hfos-auto-instagram';

// What it does on its own on Instagram, its once-a-day jobs in order, their names and its pace are HandsFreeOS's from
// 0.155.0 (packages/core/src/addons/outreach/runners.ts, decision 195), so the app plans the same day.
export { INSTAGRAM_AUTO, INSTAGRAM_DAILY, INSTAGRAM_FINDING, INSTAGRAM_GAP_MS };
const DAILY_NAMES = INSTAGRAM_DAILY_NAMES;

const DAILY_DOING: Readonly<Record<InstagramDaily, string>> = {
  requests: 'Reading your newest followers on Instagram…',
  follow_backs: 'Looking at the accounts you followed on Instagram for who followed you back…',
  tidy: 'Unfollowing who didn’t follow you back on Instagram…',
  checks: 'Checking your followers for good fits…',
  chats: 'Reading your Instagram chats for the AI…',
  partners: 'Searching Instagram for people who could partner with you, then reading them…',
  posts: 'Looking at your hashtags and your area’s places on Instagram for the AI…',
  like_yours: 'Reading an account like yours on Instagram, its posts and its followers…',
  helpful: 'Reading your notifications for who followed you, or liked or commented on your posts…',
  weekly_post: 'Asking for this week’s helpful post for Instagram…',
  post_people: 'Reading who liked and commented on good posts on Instagram…',
  found_checks: 'Checking the people found on Instagram for good fits…',
  comment_research: 'Reading comments under public posts for HandsFreeOS’s comment research…',
  profile: 'Reading your Instagram profile, as it does on the 1st of each month…',
};
/** While Instagram draws what a press opened. */
const SETTLE_MS = 2_000;
/** After something went wrong, or Instagram asked them to sign in, it tries again this much later. */
const AGAIN_MS = 15 * 60_000;
/** While noting is off, it looks again this often. */
const LOOK_AGAIN_MS = 30 * 60_000;
/** While an ask on Instagram goes first, it looks again after this. */
const ASK_FIRST_MS = 2 * 60_000;
/** Of their latest posts, the most a warm-up likes: one, or two while the day's likes have room. */
const LIKES_MOST = 2;
/** The stories its warm-ups like in a day (decision 111): the kit's. */
const STORY_LIKES_MOST = NETWORKS.instagram.storyLikesPerDay ?? 0;

// Its reads that need the screen come in front only while the person is away, put off till then (decision 120).
const tab = new WorkTab('window', instagram, { front: 'away', waits: false });
/** Its once-a-day jobs put off till the person is away (decision 120). */
const putOff = new PutOff<InstagramDaily>();
/** Instagram's runner's window's tab, while it's open: what the person sees there isn't theirs to note. */
export const instagramRunnerTabId = (): number | null => tab.tabId;

let busy = false;
/** Instagram's Stop for today, or another computer working now: a job under way ends at its next page. */
let stopAsked = false;
let again = false;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const now = () => new Date().toISOString();
const pickGap = (random: number) =>
  Math.round(INSTAGRAM_GAP_MS.least + random * (INSTAGRAM_GAP_MS.most - INSTAGRAM_GAP_MS.least));

// ------------------------------------------------------------------------------------------------- state

async function stateNow(): Promise<AutoState> {
  try {
    const value: unknown = (await chrome.storage.local.get(INSTAGRAM_STATE_KEY))[
      INSTAGRAM_STATE_KEY
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
    await chrome.storage.local.set({ [INSTAGRAM_STATE_KEY]: next });
    return next;
  });
  writing = write.catch(() => undefined);
  return write;
}

const say = (line: string, more: Partial<AutoState> = {}) =>
  setState({ line, lineAt: Date.now(), needs: false, ...more });

async function goAt(when: number | null): Promise<void> {
  if (when === null) await chrome.alarms.clear(INSTAGRAM_ALARM);
  else await chrome.alarms.create(INSTAGRAM_ALARM, { when: Math.max(when, Date.now() + 30_000) });
  await setState({ nextAt: when });
}

async function closeWindow(): Promise<void> {
  await tab.close();
  await setState({ tabId: null });
}

// ------------------------------------------------------------------------------------------------- Instagram

/**
 * What a step came to: done, passed over (handed to the person with `need`), a stop for the day, or (`again`) a stop
 * for now with nothing tried, when Instagram asked them to sign in.
 */
type Outcome =
  | { readonly done: true; readonly line: string; readonly helper?: ProblemHelper }
  | {
      readonly done: false;
      readonly line: string;
      readonly need?: true;
      /** Worth the AI helper's look though it isn't handed over: a like it couldn't press (decision 142). */
      readonly look?: true;
      /** Found done already (connected, asked, friends already): nothing's left to do, so it's no failure (decision 145). */
      readonly skip?: true;
      /** What the AI helper did inside the step, for its report (decision 142). */
      readonly helper?: ProblemHelper;
    }
  | { readonly stop: string }
  | { readonly again: string };

const SIGNED_OUT =
  'Stopped for now: Instagram asked you to sign in. Sign in to Instagram in this browser, and it tries again in a few minutes.';

/** Stops for the day on Instagram's warning on the page, noting it in HandsFreeOS once as Instagram's. */
async function warnedOn(page: InstagramPage, businessId: string): Promise<string | null> {
  if (!page.warnings.length) return null;
  const fresh = await keepWarning(page.warnings, PLATFORM);
  if (fresh.length)
    await answer({
      type: 'hfos-warning',
      input: warningInput(businessId, fresh, page.url, PLATFORM),
    });
  return warnedLine(page.warnings, NAME);
}

const read = () => readInstagramIn(tab);

/** Their account as kept: by the name in its address. */
function wantOf(profileUrl: string | null): ProfileRef | null {
  const account = accountIn(profileUrl);
  return account ? { id: null, username: account.username, url: account.url } : null;
}

/**
 * What a comment's send (./comments.ts, decision 92) borrows: this window's tab, and a look at the page it opened for
 * Instagram's warning or its sign-in.
 */
const commenting: LookingRunner = {
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

/** Opens their account (a look they may see) and checks it's theirs, by the name in its address. */
async function openAccount(
  item: TodayListItem,
  businessId: string,
): Promise<
  | { readonly page: InstagramPage; readonly noted: ProfileRef; readonly name: string }
  | { readonly outcome: Outcome }
> {
  const want = wantOf(item.profileUrl);
  if (!want) return { outcome: { done: false, line: `${item.name}: no Instagram account kept` } };
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
        line: `${item.name}: Instagram showed a different account`,
        need: true,
      },
    };
  return { page, noted: want, name: shown.name ?? item.name };
}

/** Where a warm-up leads: the follow, or for a partner (decision 81) the ask about partnering. */
const afterWarmUp = (item: TodayListItem) =>
  item.kind === 'partner_warm_up'
    ? {
        without: 'the ask about partnering goes without',
        next: 'the ask comes tomorrow',
        now: 'the ask about partnering can go next',
      }
    : {
        without: 'the follow goes without',
        next: 'the follow comes tomorrow',
        now: 'the follow can go next',
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

/** Likes one post of theirs on its own page, and notes it: whether it's liked now, or the step's end. */
async function likeOne(
  item: TodayListItem,
  businessId: string,
  them: ProfileRef,
  post: { readonly url: string; readonly text: string },
): Promise<'liked' | 'already' | 'not' | { readonly stop: string } | { readonly again: string }> {
  await tab.open(post.url);
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
    PLATFORM,
  );
  return liked.result === 'done' ? 'liked' : 'already';
}

/** Whether two links are the same post, however each was written. */
function samePost(a: string, b: string): boolean {
  const one = instagramUrl(a);
  const two = instagramUrl(b);
  return !!one && !!two && postOf(one) !== null && postOf(one) === postOf(two);
}

/**
 * The post a poster found by topic wrote (decision 92), liked first, on its own page: `liked`, `already`, or null when
 * there's none to like there (it isn't right to like, or it's gone or isn't theirs now), so their latest is liked in
 * its place, as anyone's is.
 */
async function likeFoundPost(
  item: TodayListItem,
  businessId: string,
): Promise<'liked' | 'already' | null | { readonly stop: string } | { readonly again: string }> {
  const them = wantOf(item.profileUrl);
  if (!item.postUrl || !them) return null;
  const text = item.post ?? '';
  if (neverLike({ text, pictures: [] })) return null;
  const went = await likeOne(item, businessId, them, { url: item.postUrl, text });
  await setState({ tabId: tab.tabId });
  return went === 'not' ? null : went;
}

/** The day a comment that couldn't be liked was last noted with its page's outline (decision 74): once a day at most. */
let commentNotedOn: string | null = null;

/**
 * Their comment on the good post they were found by (decision 116), liked first, on that post's own page, found again
 * by who wrote it (more of its comments shown once when the page doesn't show it yet: View all comments pressed, or
 * the comments scrolled): `liked`, `already`, or null when there's none to like there (gone, about grief, illness or
 * trouble, or no Like on it: the page is noted with its outline once a day), so their latest is liked in its place, as
 * anyone's is. Noted as a like with the comment's own link, so the follow waits a day as for a post.
 */
async function likeFoundComment(
  item: TodayListItem,
  businessId: string,
): Promise<'liked' | 'already' | null | { readonly stop: string } | { readonly again: string }> {
  const them = wantOf(item.profileUrl);
  const postUrl = item.postUrl;
  if (!postUrl || !them) return null;
  await tab.open(postUrl);
  await setState({ tabId: tab.tabId });
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { stop };
  if (page.signedOut) return { again: SIGNED_OUT };
  const look = async () => {
    const seen = await tab.ask({ type: 'hfos-their-comment', profile: them, postUrl });
    if (!seen.ok) throw new Error(seen.error);
    return seen.comment;
  };
  let theirs = await look();
  // Theirs may be past the comments the post shows first: more of them, once, as a person would look.
  if (!theirs && (await tab.ask({ type: 'hfos-more-comments' })).ok) {
    await pause(SETTLE_MS);
    theirs = await look();
  }
  const noteMissed = async () => {
    const state = await stateNow();
    if (commentNotedOn === state.day) return;
    commentNotedOn = state.day;
    await reporter(tab, answer as Hfos, {
      businessId,
      platform: PLATFORM,
      askId: null,
      job: 'warm_up.comment',
    })({ note: 'Couldn’t like their comment.', outline: true });
  };
  if (!theirs || theirs.liked === null) {
    await noteMissed();
    return null;
  }
  // Never one about grief, illness or trouble, nor on a post that is.
  if (neverLike({ text: `${item.post ?? ''}\n${theirs.text ?? ''}`, pictures: [] })) return null;
  let went: 'liked' | 'already' = 'already';
  if (!theirs.liked) {
    const liked = await tab.ask({ type: 'hfos-like-comment', profile: them, postUrl });
    if (!liked.ok) throw new Error(liked.error);
    if (liked.result === 'none' || liked.result === 'not_sent') {
      await noteMissed();
      return null;
    }
    if (liked.result === 'done') {
      await pause(SETTLE_MS);
      const after = await warnedOn(await read(), businessId);
      if (after) return { stop: after };
      went = 'liked';
    }
  }
  await takeNote(
    {
      type: 'hfos-noted',
      step: {
        kind: 'like',
        to: { name: item.name, profile: them },
        group: null,
        postUrl: theirs.commentUrl ?? postUrl,
        thread: null,
        replying: null,
        auto: true,
        postText: likedText({ text: `Their comment: ${theirs.text ?? ''}`, pictures: [] }),
      },
      at: now(),
    },
    PLATFORM,
  );
  return went;
}

/**
 * What a warm-up's likes came to, in words: the post it found first (or their comment on it, decision 116), their
 * story, then any of their latest.
 */
function warmedLine(
  item: TodayListItem,
  found: 'liked' | 'already' | null,
  liked: number,
  next: string,
  story: 'liked' | 'already' | null = null,
): string {
  const what = item.likeComment ? 'comment' : 'post';
  if (story) {
    // Their story first (decision 111), then whatever else it liked.
    const more = [
      found === 'liked' ? `the ${what} it found` : null,
      liked ? (found || liked === 1 ? 'a post of theirs' : `${liked} posts of theirs`) : null,
    ].filter((part): part is string => part !== null);
    const others = more.join(' and ');
    const watched =
      story === 'liked'
        ? `Watched ${item.name}’s story and liked it${others ? `, and ${others} too` : ''}`
        : `Watched ${item.name}’s story, liked already${others ? `, and liked ${others}` : ''}`;
    return `${watched}${found === 'already' ? `, the ${what} it found liked already` : ''}: ${next}`;
  }
  if (found === 'liked')
    return `Liked ${item.name}’s ${what} it found${liked ? (item.likeComment ? ' and a post of theirs' : ' and another of theirs') : ''}: ${next}`;
  if (found === 'already')
    return liked
      ? item.likeComment
        ? `Liked a post of ${item.name}’s, their comment it found liked already: ${next}`
        : `Liked another of ${item.name}’s posts, the one it found liked already: ${next}`
      : `${item.name}’s ${what} it found was liked already: ${next}`;
  return !liked
    ? `${item.name}’s post was liked already: ${next}`
    : `Looked at ${item.name}’s Instagram and liked ${liked === 1 ? 'a post' : `${liked} posts`} of theirs: ${next}`;
}

/** The day a story that couldn't be liked was last noted with its page's outline (decision 74): once a day at most. */
let storyNotedOn: string | null = null;

/**
 * Their story (decision 111), while the day's story likes have room: opened at its own address, watched a few seconds
 * and liked with the viewer's own Like, then closed, and noted as a like with the story's address, so what comes after
 * the warm-up waits a day as for a post. `liked`, `already`, or null when it couldn't be (gone, or no Like: the page is
 * noted with its outline once a day); a stop for the day on Instagram's warning.
 */
async function likeStory(
  item: TodayListItem,
  businessId: string,
  them: ProfileRef,
): Promise<'liked' | 'already' | null | { readonly stop: string } | { readonly again: string }> {
  const state = await stateNow();
  if (!them.username || (state.done.story_like ?? 0) >= STORY_LIKES_MOST) return null;
  await tab.open(storyUrl(them.username));
  await setState({ tabId: tab.tabId });
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { stop };
  if (page.signedOut) return { again: SIGNED_OUT };
  const went = await tab.ask({ type: 'hfos-like-story', profile: them });
  if (!went.ok || went.result === 'none' || went.result === 'not_sent') {
    if (storyNotedOn !== state.day) {
      storyNotedOn = state.day;
      await reporter(tab, answer as Hfos, {
        businessId,
        platform: PLATFORM,
        askId: null,
        job: 'warm_up.story',
      })({ note: 'Couldn’t like their story.', outline: true });
    }
    return null;
  }
  if (went.result === 'done') {
    await pause(SETTLE_MS);
    const after = await warnedOn(await read(), businessId);
    if (after) return { stop: after };
    const now = await stateNow();
    await setState({ done: { ...now.done, story_like: (now.done.story_like ?? 0) + 1 } });
  }
  await takeNote(
    {
      type: 'hfos-noted',
      step: {
        kind: 'like',
        to: { name: item.name, profile: them },
        group: null,
        postUrl: went.storyUrl,
        thread: null,
        replying: null,
        auto: true,
        postText: 'Their story',
      },
      at: now(),
    },
    PLATFORM,
  );
  return went.result === 'done' ? 'liked' : 'already';
}

/**
 * A look at their account, and a like on one or two of their recent posts, a day before the follow: the first that
 * nothing rules out (never one about grief, illness or trouble), and the next one too while the day's likes have room
 * past the warm-ups still to come (`spare`). One liked already counts. With no post to see (a private account, or none
 * yet), or none right to like, the look alone is the warm-up, and HandsFreeOS hears there was nothing to like, so the
 * follow needn't wait. From 0.95.0 (decision 92) someone found by a post they wrote gets the like on that post first,
 * on its own page (`postUrl`), and one of their latest beside it only while the day's likes have room; when that post
 * is gone, or isn't right to like, their latest is liked in its place. From 0.103.0 (decision 111), when their account
 * shows a story and the day's story likes have room, their story is watched and liked first, as one of those likes.
 * From 0.108.0 (decision 116) someone found by their comment on a good post gets the like on that comment first, on
 * the post's own page, in the same way: their latest in its place when it's gone or not right to like.
 */
async function warmUp(item: TodayListItem, businessId: string, spare: number): Promise<Outcome> {
  if (item.keepWarm) return visit(item, businessId, item.keepWarm.likes);
  const after = afterWarmUp(item);
  const found = item.likeComment
    ? await likeFoundComment(item, businessId)
    : await likeFoundPost(item, businessId);
  if (typeof found === 'object' && found !== null) return found;
  let story: 'liked' | 'already' | null = null;
  const done = (liked: number): Outcome => ({
    done: true,
    line: warmedLine(item, found, liked, after.next, story),
  });
  // The warm-up's likes: one, or two while the day's likes have room; the post it found is one of them.
  const room = (spare > 0 ? LIKES_MOST : 1) - (found ? 1 : 0);
  if (room <= 0) return done(0);
  const opened = await openAccount(item, businessId);
  if ('outcome' in opened) return found && 'done' in opened.outcome ? done(0) : opened.outcome;
  const lookOnly = async (why: string): Promise<Outcome> => {
    if (found || story) return done(0);
    await missed(item, businessId);
    return {
      done: true,
      line: `Looked at ${item.name}’s Instagram, ${why}: the look is the warm-up, so ${after.now}`,
    };
  };
  const theirs = await tab.ask({
    type: 'hfos-their-posts',
    profile: opened.noted,
    most: LIKE_POSTS_READ,
  });
  if (!theirs.ok) throw new Error(theirs.error);
  // Their story first, while their account shows one: it opens a page of its own, so their posts are read before it.
  if (opened.page.found.profile?.story) {
    const went = await likeStory(item, businessId, opened.noted);
    if (typeof went === 'object' && went !== null) return went;
    story = went;
  }
  const most = room - (story ? 1 : 0);
  if (most <= 0) return done(0);
  // Never the post it found again.
  const posts = theirs.posts.flatMap((p) =>
    p.url && !(item.postUrl && samePost(p.url, item.postUrl)) ? [{ url: p.url, text: p.text }] : [],
  );
  if (!posts.length) return lookOnly('with no post of theirs to see');
  // The first that nothing rules out, then the next after it that nothing rules out either.
  const safe = posts.filter((post) => !neverLike({ text: post.text, pictures: [] }));
  if (!safe.length) return lookOnly('and none of their posts were right to like');
  let liked = 0;
  let already = (found ? 1 : 0) + (story ? 1 : 0);
  for (const post of safe.slice(0, most)) {
    if (liked + already > 0) await pause(SETTLE_MS);
    const went = await likeOne(item, businessId, opened.noted, post);
    if (typeof went === 'object') return went;
    if (went === 'liked') liked++;
    else if (went === 'already') already++;
    else if (liked + already === 0) {
      await missed(item, businessId);
      return {
        done: false,
        line: `Couldn’t like ${item.name}’s post: ${after.without}`,
        look: true,
      };
    } else break;
  }
  return done(liked);
}

/**
 * A visit while they decide whether to follow back (decision 161): a look at their account and up to `likes` new likes
 * on their recent posts, each on its own page, the newest first that nothing rules out; one liked already isn't counted,
 * and the next is tried in its place. Nothing to like: HandsFreeOS hears it, and the visit counts. No follow after it.
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
    p.url && !neverLike({ text: p.text, pictures: [] }) ? [{ url: p.url, text: p.text }] : [],
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
  if (!liked) {
    await missed(item, businessId);
    return { done: true, line: visitLine(item.name, PLATFORM, 0, item.keepWarm?.hi === true) };
  }
  return { done: true, line: visitLine(item.name, PLATFORM, liked, item.keepWarm?.hi === true) };
}

/** A follow, with their account's own Follow (or Follow Back), then their account read again to see it went. */
async function followThem(item: TodayListItem, businessId: string): Promise<Outcome> {
  const opened = await openAccount(item, businessId);
  if ('outcome' in opened) return opened.outcome;
  const standing = opened.page.found.profile!.following;
  if (standing === 'following' || standing === 'requested')
    return { done: false, line: `${item.name}: you follow them already, or asked to`, skip: true };
  const pressFollow = async () => {
    const went = await tab.ask({ type: 'hfos-connect', profile: opened.noted });
    if (!went.ok) throw new Error(went.error);
    return went.result;
  };
  let result = await pressFollow();
  if (result === 'already')
    return { done: false, line: `${item.name}: you follow them already, or asked to`, skip: true };
  // Follow moved, or something's over it: the AI helper finds it on their account, checked as theirs (decision 142).
  const help = stepHelp(tab, answer as Hfos, {
    businessId,
    platform: PLATFORM,
    step: item.kind,
    theirName: item.name,
    button: buttonFor(PLATFORM, 'friend_request')!,
  });
  const missing = 'couldn’t find Follow on their account';
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
      line: `${item.name}: Instagram didn’t take the follow`,
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
    PLATFORM,
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

// ------------------------------------------------------------------------------------------------- messages

/** A job in the runner's window, for the look-up and the once-a-day jobs, noting Instagram's warnings as its own. */
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
 * Follows back someone who follows the person, when their account shows no Message: Instagram shows it only on
 * accounts the person follows (the owner's sends of 30 Oct 2026, on 0.117.0, to followers not followed back), so
 * they're followed back first, then messaged (decision 135). Noted as a follow, like one the runner makes. An outcome
 * when it can't: they don't follow the person, Instagram didn't take it, or the account is private (Requested).
 */
async function followBack(
  item: TodayListItem,
  opened: { readonly page: InstagramPage; readonly noted: ProfileRef; readonly name: string },
  businessId: string,
): Promise<{ readonly outcome: Outcome } | null> {
  const shown = opened.page.found.profile;
  if (shown?.following !== 'no' || shown.followsYou !== true)
    return {
      outcome: { done: false, line: `${item.name}: couldn’t find Message on their account` },
    };
  const didnt = {
    outcome: {
      done: false,
      line: `${item.name}: Instagram shows Message only on accounts you follow, and following them back didn’t go`,
    },
  };
  const went = await tab.ask({ type: 'hfos-connect', profile: opened.noted });
  if (!went.ok || went.result !== 'done') return didnt;
  await pause(SETTLE_MS);
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { outcome: { stop } };
  const standing = page.found.profile?.following;
  if (standing === 'requested')
    return {
      outcome: {
        done: false,
        line: `${item.name}: their account is private, so Instagram shows Message once they let you follow them`,
      },
    };
  if (standing !== 'following') return didnt;
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
  return null;
}

/**
 * Opens the chat with them: its own page by the chat's id when it's kept, else their account's Message, which opens
 * it over the page or on a page of its own, once they're followed back when it shows none (`followBack`). It must be
 * with them, by the name in their account's address.
 */
async function openChat(
  item: TodayListItem,
  businessId: string,
): Promise<
  | { readonly profile: ProfileRef; readonly thread: ThreadRef | null }
  | { readonly outcome: Outcome }
> {
  const want = wantOf(item.profileUrl);
  if (item.threadKey) {
    const url = chatUrlOn(PLATFORM, item.threadKey)!;
    await tab.open(url);
    await setState({ tabId: tab.tabId });
    const page = await read();
    const stop = await warnedOn(page, businessId);
    if (stop) return { outcome: { stop } };
    if (page.signedOut) return { outcome: { again: SIGNED_OUT } };
    const chat = page.found.chat;
    const them = chat?.with
      ? !want || chat.with.username.toLowerCase() === want.username!.toLowerCase()
      : chat?.name != null && chat.name.trim().toLowerCase() === item.name.trim().toLowerCase();
    const profile =
      want ?? (chat?.with ? { id: null, username: chat.with.username, url: chat.with.url } : null);
    if (!chat || !them || !profile)
      return {
        outcome: { done: false, line: `${item.name}: Instagram showed a different chat` },
      };
    return { profile, thread: { id: item.threadKey, encrypted: false, url } };
  }
  const opened = await openAccount(item, businessId);
  if ('outcome' in opened) return opened;
  let pressed = await tab.ask({ type: 'hfos-open-message', profile: opened.noted });
  if (!pressed.ok) {
    const back = await followBack(item, opened, businessId);
    if (back) return back;
    pressed = await tab.ask({ type: 'hfos-open-message', profile: opened.noted });
  }
  if (!pressed.ok)
    return {
      outcome: { done: false, line: `${item.name}: couldn’t find Message on their account` },
    };
  await pause(SETTLE_MS);
  // On a page of its own, the chat's id is in its address.
  const page = await read();
  const id = page.found.chat?.thread ?? null;
  return {
    profile: opened.noted,
    thread: id ? { id, encrypted: false, url: chatUrlOn(PLATFORM, id)! } : null,
  };
}

/** Their chat as it is now, before a reply is drafted: brought into HandsFreeOS as Instagram's. */
async function bringInChat(
  item: TodayListItem,
  businessId: string,
): Promise<{ readonly stop: string } | Outcome | null> {
  if (!item.threadKey) return null;
  const opened = await openChat(item, businessId);
  if ('outcome' in opened) return 'stop' in opened.outcome ? opened.outcome : null;
  const { found } = await read();
  const chat = found.chat;
  const page = chat ? chatPageOf(chat) : null;
  // Its messages carry no time on Instagram: its row in the list beside it says when it last moved, as the chats read
  // takes it (../jobs/instagram/chats.ts). Without one, nothing of it could be kept.
  const row = chat ? found.chats.find((r) => isRow(chat, r)) : undefined;
  const built = page ? chatCollect(page, new Date(), row?.when ?? null, PLATFORM) : null;
  if (built)
    await answer({
      type: 'hfos-collect-chats',
      input: { workspaceId: businessId, platform: PLATFORM, chats: [built] },
    });
  // The last message whose side shows, a photo or a sticker among them, is the person's.
  if (chat?.last === 'me')
    return { done: false, line: `${item.name}: ${NOTHING_TO_ANSWER}`, skip: true };
  return null;
}

/**
 * Drafts a message with the AI after looking them up on Instagram, and hands it to HandsFreeOS to wait or go; a comment
 * on a good post is drafted from the post (decision 92).
 */
async function draftMessage(item: TodayListItem, businessId: string): Promise<Outcome> {
  // The post is looked at first (decision 166): its picture, or frames of its video, go with the draft.
  if (item.kind === 'comment')
    return draftComment(item, businessId, { runner: commenting, them: wantOf(item.profileUrl) });
  if (item.kind === 'reply' || item.kind === 'partner_reply') {
    const stopped = await bringInChat(item, businessId);
    if (stopped) return stopped;
  }
  const looked = await lookUpOnInstagram(jobFor(businessId), item.name, item.profileUrl);
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
 * Sends a message OK'd in their Instagram chat, as a few short texts when the person texts that way, and notes it.
 * One to their Requests goes as one text: Instagram passes only one till they accept it. A comment OK'd, or past the
 * hold, goes on its post's own page (decision 92).
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
            ? 'Instagram didn’t take the message'
            : null;
    if (why === null) continue;
    if (i === 0) return failed(`${item.name}: ${why}`);
    partly = `Sent ${item.name} ${i} of ${parts.length} texts, then: ${why}`;
    break;
  }
  // The chat's id, once its own page shows it.
  const after = await read();
  const id = chat.thread?.id ?? after.found.chat?.thread ?? null;
  await takeNote(
    {
      type: 'hfos-noted',
      step: {
        kind: 'message',
        to: { name: item.name, profile: chat.profile },
        group: null,
        postUrl: null,
        thread: id ? { id, encrypted: false, url: chatUrlOn(PLATFORM, id)! } : null,
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

/**
 * Does a piece of work: a step on the list, a draft, or a send. `spare` is how many likes the day has room for past
 * the warm-ups still on the list, for a warm-up's second like.
 */
export function doWork(
  work: Work,
  businessId: string,
  split: boolean,
  spare = 0,
): Promise<Outcome> {
  if (work.do === 'draft') return draftMessage(work.item, businessId);
  if (work.do === 'send') return sendMessage(work.item, businessId, split);
  switch (work.item.kind) {
    case 'warm_up':
    case 'partner_warm_up':
      return warmUp(work.item, businessId, spare);
    case 'friend_request':
      return followThem(work.item, businessId);
    default:
      // Never on its list for it (`INSTAGRAM_AUTO`): comments go as sends, drafted and sent above.
      return Promise.resolve({
        done: false,
        line: `${work.item.name}: that’s yours to do on Instagram`,
      });
  }
}

const DOING: Readonly<Partial<Record<TodayKind, string>>> = {
  warm_up: 'Looking at the Instagram of',
  partner_warm_up: 'Looking at the Instagram of',
  friend_request: 'Following',
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

/** What's left on Instagram's list for it today: only the kinds it does there. */
export function instagramWorkLeft(
  list: Pick<TodayList, 'items' | 'auto' | 'messages' | 'sending'> & {
    readonly partners?: readonly TodayListItem[];
    readonly newMessagesWait?: boolean;
  },
  tried: readonly string[],
  replied: readonly string[] = [],
): Work[] {
  return workLeft(
    { ...list, auto: list.auto.filter((k) => INSTAGRAM_AUTO.includes(k)) },
    tried,
    replied,
  );
}

/**
 * The likes the day has room for past one each for the warm-ups still to do, and a visit's own (decision 161, its
 * `keepWarm.likes`): a warm-up's second like takes one.
 */
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

// ------------------------------------------------------------------------------------------------- the once-a-day jobs

/** The once-a-day job to do next on Instagram: the first not done today. */
export const nextInstagramDaily = (
  state: Pick<AutoState, 'daily' | 'againAt'>,
  passOver: readonly InstagramDaily[] = [],
  now = Date.now(),
): InstagramDaily | null =>
  INSTAGRAM_DAILY.find(
    (job) =>
      state.daily?.[job] === undefined && !passOver.includes(job) && !waitsAgain(state, job, now),
  ) ?? null;

/** A job that notes a page it couldn't read with its outline (decision 74): its own way to, or the runner's. */
const reporting = (job: Job, kind: InstagramDaily): Job => ({
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

/** Does one of Instagram's once-a-day jobs. */
export async function runInstagramDaily(kind: InstagramDaily, job: Job): Promise<JobEnd> {
  switch (kind) {
    case 'requests':
      return saveFollowers(job);
    case 'follow_backs':
      return lookForFollowBacks(job);
    case 'tidy':
      return unfollowOnItsOwn(job);
    case 'checks':
      return checkFollowers(job, NETWORKS.instagram.checksPerDay);
    case 'chats':
      return readInstagramChats(job, {
        most: DAILY_CHATS,
        memory: chatMemory,
        again: 'The rest wait for tomorrow.',
      });
    case 'partners':
      return checkPartners(job, PARTNER_CHECKS_PER_DAY, {
        platform: PLATFORM,
        read: readThemOnInstagram,
        search: searchInstagram,
      });
    case 'posts':
      // A page with no posts, or a post it couldn't read, is noted with its outline (decision 74).
      return lookAtTagsAndPlaces(
        reporting(job, kind),
        valueOf(
          await job.hfos({
            type: 'hfos-post-words',
            workspaceId: job.businessId,
            platform: PLATFORM,
            ...(job.round ? { round: job.round } : {}),
          }),
        ),
      );
    case 'like_yours':
      // An account whose followers' box didn't open is noted with its outline (decision 74).
      return readLikeYours(reporting(job, kind));
    case 'helpful':
      return readInstagramWarmLeads(job);
    case 'weekly_post':
      return askWeeklyPost(job, 'instagram');
    case 'post_people':
      // A post it couldn't read, or whose Likes box didn't open, is noted with its outline (decision 74).
      return readPostPeople(reporting(job, kind));
    case 'found_checks':
      return checkFound(job, { platform: PLATFORM, read: readThemOnInstagram });
    case 'comment_research':
      return readCommentsForResearch(job);
    case 'profile':
      return readProfileOnItsOwn(job, PLATFORM, (j) => instagramProfileRead(j));
  }
}

// ------------------------------------------------------------------------------------------------- the day

/** Whether Instagram's day is started today, as the beat last said; null when HandsFreeOS hasn't said. */
const dayOf = (kept: Kept | null) => kept?.days?.instagram ?? null;

/** What's left on a list for the runner, with what the list says kept for its day (`listSays`). */
async function leftOf(
  list: TodayList,
  tried: readonly string[],
  replied: readonly string[] = [],
): Promise<Work[]> {
  // Whether Instagram needs more good fits today (decision 126): it finds people again once the day's reading is done.
  // And when a message tried again may go (decision 132): it looks again by then.
  const says = listSays(list);
  const kept = await stateNow();
  if (kept.more !== says.more || (kept.retryAt ?? null) !== says.retryAt) await setState(says);
  return instagramWorkLeft(list, tried, replied);
}

/** Instagram's list for today, and what's left on it for its runner, in its order. */
async function listNow(
  businessId: string,
  tried: readonly string[],
  replied: readonly string[] = [],
): Promise<{ readonly list: TodayList; readonly left: Work[] }> {
  const list: TodayList = await call(
    api().POST('/v1/queries/outreach.today', {
      body: { workspaceId: businessId, platform: PLATFORM },
    }),
    businessId,
  );
  return { list, left: await leftOf(list, tried, replied) };
}

// ------------------------------------------------------------------------------------------------- a go's moves

/** The person's choices, as HandsFreeOS last said them. */
type Settings = NonNullable<Awaited<ReturnType<typeof loadSettings>>>['settings'];

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
  goAt(
    Date.now() + (gap === undefined ? pickGap(g.random) : Math.max(gap, INSTAGRAM_GAP_MS.least)),
  );

/** Instagram warned: it stops there for the day. */
async function warnedEnd(line: string, g: Going): Promise<void> {
  await closeWindow();
  await say(line, { stopped: 'warning' });
  return goAt(tomorrowFor(g));
}

/** A step before the day (their followers saved, the first checks), and what follows it. */
async function beforeGo(before: BeforeDay, g: Going, gap?: number): Promise<void> {
  const end = await inTurn('runner', () => beforeTheDay(before, g.businessId), PLATFORM);
  const line = beforeDayLine(before, end, PLATFORM);
  if (end.warned) return warnedEnd(end.line, g);
  // Put off till they're away, or done: the list has its turn next either way (decision 123).
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
 * One of its once-a-day jobs, and what follows it. In the hours it takes turns with the list (`turn`, decision 123);
 * outside them only a comment research reads, and the list has no turn to take.
 */
async function dailyGo(
  daily: InstagramDaily,
  g: Going,
  turn: boolean,
  gap?: number,
): Promise<void> {
  const end = await inTurn('runner', () => collect(daily, g.businessId), PLATFORM);
  if (end.warned) return warnedEnd(end.line, g);
  const line = `${DAILY_NAMES[daily]}: ${end.line}`;
  await say(line, turn ? { readLast: true } : {});
  if (end.away) putOff.off(daily);
  else void feed(jobKind(end), `${NAME}: ${line}`);
  return goAfter(g, gap);
}

/**
 * Nothing's left for it now: it says so, and looks again within the hour, sooner for a read put off till the
 * person's away, the next batch of checks or a message tried again; or when HandsFreeOS said (`until`).
 */
async function idleGo(
  state: AutoState,
  collects: boolean,
  passOver: readonly InstagramDaily[],
  g: Going,
  until?: number | null,
): Promise<void> {
  const { at } = g;
  await closeWindow();
  // What waits for them to be away is looked at again sooner.
  const waiting = collects ? waitingWords(waitingFor(passOver, state.daily, DAILY_NAMES)) : null;
  // The checks' next batch, when one's to come today (decision 126).
  const later = collects ? soonestAgain(await stateNow(), at) : null;
  await say(
    `${
      waiting
        ? `${state.tried.length ? `The rest of today on ${NAME} is done.` : `Nothing on your ${NAME} list for it to do yet.`} ${waiting}`
        : state.tried.length
          ? `Done for today on ${NAME}. It looks again within the hour for anything new.`
          : `Nothing on your ${NAME} list for it to do yet.`
    }${later !== null ? ` ${AGAIN_WORDS}` : ''}`,
  );
  return goAt(
    until ??
      Math.min(
        at + (waiting ? AWAY_AGAIN_MS : 60 * 60_000),
        ...(later !== null ? [later] : []),
        // A message tried again that waits its turn (decision 132).
        ...retryWake(await stateNow(), at),
      ),
  );
}

// ------------------------------------------------------------------------------------------------- as it's told

const notingOffWords = `Turn on noting your steps in Social Outreach → Settings in HandsFreeOS: the extension works on its own on ${NAME} only while it notes.`;
const firstDayWaits = `Your first day on ${NAME} starts once your followers are saved. That needs its window on screen, so it waits till you’ve been away from your computer for 2 minutes.`;
const warnedWords = (warned: Awaited<ReturnType<typeof warnedNow>>) =>
  `Stopped: ${NAME} warned you today${warned ? ` (“${warned.words[0]}”)` : ''}. The extension stops on ${NAME} until tomorrow.`;

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
    readonly passOver: readonly InstagramDaily[];
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
      await say(warnedWords(await warnedNow(PLATFORM)));
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
 * Does the move HandsFreeOS sent (decision 195, step 2), each as its own go does it: the same read, the same step on
 * the list, at its own pace, within every limit it keeps. False for a move this build can't do as it stands (a job or
 * a list that isn't Instagram's, a save of their followers while they're at their computer, a piece of work that isn't
 * on its list): the runner then plans the go itself.
 */
async function asTold(
  told: ToldNext,
  g: Going,
  here: {
    readonly state: AutoState;
    readonly away: boolean;
    readonly passOver: readonly InstagramDaily[];
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
    case 'before': {
      const step = move.step as BeforeDay;
      if (!LIST_MARKS_ON.instagram.includes(markOf(step))) return false;
      // Saving their followers reads its box on screen: never while they're at their computer (decision 120).
      if (step.do === 'save' && !here.away) return false;
      await keep();
      await beforeGo(step, g, move.gap);
      return true;
    }
    case 'daily': {
      const job = INSTAGRAM_DAILY.find((mine) => mine === move.job);
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

// ------------------------------------------------------------------------------------------------- a go

/**
 * One go: where things stand, the next step when it's time, and when to go next. Its own checks come first; then,
 * free to work, it asks HandsFreeOS for its next move (decision 195, step 2) and does it (`asTold`); and it plans the
 * go itself, as it always has, whenever HandsFreeOS leaves the order to it, can't be reached, or sends a move it can't
 * do.
 */
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
  // Updated since it last went: what was handed over before is tried again, once (decision 145).
  await retryAfterUpdate(to.businessId);
  const { settings, timezone } = found;
  const choices = settings.networks.instagram;
  let state = await stateNow();
  const at = Date.now();
  const today = businessDay(at, timezone);
  if (state.day !== today) state = await setState(freshState(today, state.tabId));
  await tab.adopt(state.tabId);
  const kept = await keptFor(to);
  // Off on Instagram, or Chrome hasn't let it on: nothing runs there.
  if (!isWorking(instagram, await statesNow()) || choices.sending === 'off') {
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
  const g: Going = { businessId: to.businessId, settings, timezone, random, at };
  const researchAsk = {
    hfos: answer as Hfos,
    businessId: to.businessId,
    platform: PLATFORM,
    setState,
  } as const;
  if (!own.go) {
    await setState({ started: false, stopped: own.stopped });
    // Outside the hours a reply to someone who wrote back still goes, and nothing new does (decision 133): never after
    // Stop for today or a warning, nor while noting's off or an ask of theirs is in line.
    const free =
      own.stopped === null &&
      !(await warnedNow(PLATFORM)) &&
      (await isNoting()) &&
      !askInLine(PLATFORM);
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
      const told = await planNext(PLATFORM, to, {
        state,
        now: at,
        random,
        here: { away, passOver: passOut, research: reads, asking: false },
      });
      const here = { state, away, passOver: passOut, collects: choices.collect, turn: false };
      if (told && (await asTold(told, g, here))) return;
    }
    // By itself, as it always has.
    const answering = free ? await listNow(to.businessId, state.tried, state.replied) : null;
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
    // The beat says when it's pressed (`days.instagram`), and wakes this before then; a reply waiting for an OK, or a message tried again, sooner; and the comment research’s next batch.
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
  if (state.stopped === 'warning' || (await warnedNow(PLATFORM))) {
    const warned = await warnedNow(PLATFORM);
    await closeWindow();
    await say(warnedWords(warned), { stopped: 'warning' });
    return goAt(tomorrowFor(g));
  }
  if (!(await isNoting())) {
    await closeWindow();
    await say(notingOffWords, { needs: true });
    return goAt(at + LOOK_AGAIN_MS);
  }
  // What the person asked on Instagram goes first: this looks again in a couple of minutes.
  if (askInLine(PLATFORM)) {
    await say(ASK_FIRST_WORDS);
    return goAt(at + ASK_FIRST_MS);
  }

  // Lists first (decision 60), Instagram's own.
  const lists = valueOf(
    await (answer as Hfos)({ type: 'hfos-lists', workspaceId: to.businessId, platform: PLATFORM }),
  );
  if (JSON.stringify(state.lists) !== JSON.stringify(lists)) state = await setState({ lists });
  // Reads that need the screen wait till the person is away from their computer (decision 120).
  const away = await awayNow();
  const passOver = putOff.passOver(away);
  // HandsFreeOS's own comment research (decision 166) is only for whoever of its staff started one: asked without a
  // word, and for anyone else it's done for the day before a line of it is ever shown. While one runs, its batch goes
  // first whenever it's due (decision 194).
  let reads = false;
  if (choices.collect) {
    const research = await researchNext({ ...researchAsk, state, now: at, passOver });
    state = research.state;
    reads = research.reads;
  }
  // Free to work: HandsFreeOS says what's next, where it decides (decision 195).
  const told = await planNext(PLATFORM, to, {
    state,
    now: at,
    random,
    here: { away, passOver, research: reads, asking: false },
  });
  const here = { state, away, passOver, collects: choices.collect, turn: true };
  if (told && (await asTold(told, g, here))) return;

  // By itself, as it always has. Saving their followers reads its box on screen, so their first day waits for it,
  // and a weekly save is passed over till they're away.
  const before = beforeDay(lists, state.before ?? {}, at, timezone, PLATFORM);
  if (before?.do === 'save' && before.first && !away) {
    await closeWindow();
    await say(firstDayWaits);
    return goAt(Date.now() + AWAY_AGAIN_MS);
  }
  let daily: InstagramDaily | null = !choices.collect
    ? null
    : reads
      ? 'comment_research'
      : nextInstagramDaily(state, passOver, at);
  // Short of good fits once the day's reading is done (decision 126, answer 6a): it finds people again, with the next
  // search words, and checks them.
  if (
    choices.collect &&
    !before &&
    !daily &&
    !passOver.some((job) => state.daily?.[job] === undefined) &&
    roundDue(state, at)
  ) {
    state = await setState(nextRound(state, INSTAGRAM_FINDING, at));
    daily = nextInstagramDaily(state, passOver, at);
  }
  const beforeGoes = before !== null && (away || before.do !== 'save');
  const reading = beforeGoes || daily !== null;
  // The morning's reading and the list take turns (decision 123): a step on the list now, when there's one, after a
  // part of the reading went last.
  if (listTurn(state, reading, holdsTheDay(before))) {
    const { list, left } = await listNow(to.businessId, state.tried, state.replied);
    // Who wrote back and isn't on what's left gives the reading its turn back (decision 125).
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
  if (before && beforeGoes) return beforeGo(before, g);
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

/**
 * Does the first of what's left on Instagram's list, notes how it went, and sets when to go next: at Instagram's
 * pace, the day's steps spread out over what's left of the hours, or a person's pace while the morning's reading is
 * left (decision 123) or after Start my day.
 */
async function workNext(
  left: readonly Work[],
  list: TodayList,
  at: {
    readonly businessId: string;
    readonly settings: NonNullable<Awaited<ReturnType<typeof loadSettings>>>['settings'];
    readonly timezone: string;
    readonly own: Extract<NetworkDay, { go: true }>;
    /** Some of the morning's reading is left: the list's turn goes back to it. */
    readonly reading: boolean;
    readonly random: number;
  },
): Promise<void> {
  const work = left[0]!;
  const { businessId, settings, own } = at;
  const tomorrow = () => nextStart(settings.hours, at.timezone, Date.now(), at.random);
  const { item } = work;
  await say(doing(work), { working: true, readLast: false });
  let outcome: Outcome;
  try {
    outcome = await inTurn(
      'runner',
      () => doWork(work, businessId, settings.voice?.split ?? true, spareLikes(list, left)),
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
  // A step that didn't go: the AI helper looks first, clearing the way and saying what it sees (decision 142); then
  // the page it ended on, outline, why and all, noted while the window still shows it (decision 74). A stop for now
  // goes by untouched.
  const helped = await helpAfter({
    tab,
    hfos: answer as Hfos,
    businessId,
    platform: PLATFORM,
    work,
    job: work.do === 'step' ? work.item.kind : work.do,
    outcome,
    again:
      work.do === 'step'
        ? () =>
            inTurn(
              'runner',
              () => doWork(work, businessId, settings.voice?.split ?? true, spareLikes(list, left)),
              PLATFORM,
            )
        : null,
    say: (line) => say(line, { working: true, readLast: false }),
  });
  outcome = helped.outcome;
  await setState({ working: false });
  // Instagram asked them to sign in: nothing tried, and it looks again in a while.
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
  // A step tried again that it found done already is cleared (decision 145).
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
      // A person's pace while the morning's reading is left: the list's turn and the reading's go by turns.
      started: own.started || at.reading,
      random: at.random,
    }),
  );
  await goAt(Date.now() + gap);
}

/** Does what's due before Instagram's day, and keeps how it went. */
async function beforeTheDay(step: BeforeDay, businessId: string): Promise<JobEnd> {
  const key = markOf(step);
  await setState({ beforeNow: key });
  await say(beforeDayDoing(step, PLATFORM), { working: true });
  let end: JobEnd;
  try {
    end = await doBeforeDay(step, jobFor(businessId), PLATFORM);
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
  // Put off till they're away: tried again then.
  if (end.away) return end;
  const state = await stateNow();
  // The newest followers saved, and the first check, stand for today's newest followers and checks.
  const daily =
    key === 'friends' ? 'requests' : key === 'checks' ? 'checks' : (null as DailyJob | null);
  const stands =
    !end.failed && daily ? afterDaily(state, daily, end, Date.now(), Math.random()) : {};
  await setState({ before: { ...state.before, [key]: end.line }, ...stands });
  return end;
}

/** Does a once-a-day job, and keeps how it went: one that went wrong isn't tried again today. */
async function collect(kind: InstagramDaily, businessId: string): Promise<JobEnd> {
  await say(DAILY_DOING[kind], { working: true });
  let end: JobEnd;
  try {
    // A round of finding again asks for the next search words (decision 126).
    end = await runInstagramDaily(kind, {
      ...jobFor(businessId),
      round: (await stateNow()).round ?? 0,
    });
  } catch (error) {
    if (error instanceof Refused) throw error;
    end = isNotAway(error)
      ? awayEnd()
      : { line: error instanceof Error ? error.message : String(error), warned: false };
  } finally {
    await setState({ working: false, tabId: tab.tabId });
  }
  // Put off till they're away (decision 120): not done for the day, so it's tried again then.
  if (end.away) return end;
  const state = await stateNow();
  // A batch of checks with more of today's room left: the next later on (decision 126).
  await setState(afterDaily(state, kind, end, Date.now(), Math.random()));
  return end;
}

/** The alarm went off, or Instagram's day changed: one go, never two at once. */
export async function instagramTick(): Promise<void> {
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
    // Its tab closes the moment the go's work is done; the next step opens a fresh one (decision 171).
    if (tab.tabId !== null) await closeWindow().catch(() => undefined);
    busy = false;
    if (again) {
      again = false;
      void instagramTick();
    }
  }
}

const tick = instagramTick;

/**
 * Someone wrote back on Instagram (decision 125, ../hfos/replies.ts): their reply is drafted next, now, before the next
 * step's time, or as soon as the go under way ends. The day's own rules still say whether it goes at all.
 */
export async function instagramReplied(profileIds: readonly string[]): Promise<void> {
  const state = await stateNow();
  await setState({ replied: withReplied(state.replied ?? [], profileIds) });
  void tick();
}

/** When the background starts: it looks once, and the beat wakes it after. */
export async function wakeInstagram(): Promise<void> {
  const alarm = await chrome.alarms.get(INSTAGRAM_ALARM);
  if (!alarm) await instagramTick();
}

/** Instagram's day as the last beat said it: a change starts it, or ends what it's doing at its next page. */
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
  // Stop for today on Instagram ends Instagram's ask under way too, as LinkedIn's does LinkedIn's.
  if (day?.state === 'stopped' && day.why !== 'warning')
    haltAsk(PLATFORM, `Stopped: you pressed Stop for today on ${NAME}.`);
  void instagramTick();
});

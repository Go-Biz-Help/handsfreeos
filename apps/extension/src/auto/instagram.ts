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
 *
 * Each step is noted as the extension's own (`auto`), as Instagram's (`platform: 'instagram'`). Anything its page
 * doesn't let it do is handed to the person (`noteNeed`), never guessed.
 */
import { businessDay } from '@hfos/core/addons/outreach/automation';
import type { MessageKind } from '@hfos/core/addons/outreach/automation';
import { ASK_FIRST_WORDS } from '@hfos/core/addons/outreach/asks';
import { LIKE_POSTS_READ, likedText, neverLike } from '@hfos/core/addons/outreach/like-pick';
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
import { chatCollect } from '../hfos/saves';
import { answer, api, call, Refused, savingTo } from '../hfos/session';
import { keepWarning, warnedNow, warningInput } from '../hfos/warned';
import { chatMemory } from '../jobs/chats';
import { chatPageOf, readInstagramChats } from '../jobs/instagram/chats';
import { accountIn, checkFollowers, isTheirs, readThemOnInstagram } from '../jobs/instagram/checks';
import { readInstagramWarmLeads } from '../jobs/instagram/engaged';
import { lookUpOnInstagram } from '../jobs/instagram/lookup';
import { searchInstagram } from '../jobs/instagram/partner-search';
import { lookForFollowBacks } from '../jobs/instagram/follow-backs';
import { saveFollowers } from '../jobs/instagram/people';
import { readLikeYours } from '../jobs/instagram/like-yours';
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
  type CommentRunner,
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
  type OwnDailyJob,
  type Work,
  listSays,
  retryWake,
} from './plan';
import { askInLine, inTurn } from './turns';

const PLATFORM: Platform = 'instagram';
const NAME = NETWORKS.instagram.name;

export const INSTAGRAM_ALARM = 'hfos-auto-instagram';

/**
 * The kinds it does on its own on Instagram, in order (its kit's `runs.auto`): comments go through `sends`, as
 * messages do (./comments.ts), and follow requests from private accounts are theirs to confirm.
 */
export const INSTAGRAM_AUTO: readonly TodayKind[] = ['warm_up', 'friend_request'];
/**
 * The once-a-day jobs on Instagram, in order: the newest followers first (`requests`: on Instagram, who followed back
 * is who accepted), then who followed back seen on their own accounts (`follow_backs`), from 0.97.0 unfollowing who
 * didn't follow back as the person chose (`tidy`, decision 98), the checks, the chats, Find
 * partners, and from part 15 the day's hashtags and places (`posts`) and the notifications' warm leads (`helpful`, as
 * Alignable's are). From 0.95.0 (decision 92) who liked and commented on the good posts the hashtags found
 * (`post_people`), and last the people found by topic checked for good fits (`found_checks`). From 0.101.0 the week's
 * helpful post asked for after the warm leads (`weekly_post`, decision 109). From 0.102.0 accounts like the business's
 * after the hashtags (`like_yours`, decision 110): searched for, and one read, its posts and its followers.
 */
export const INSTAGRAM_DAILY = [
  'requests',
  'follow_backs',
  'tidy',
  'checks',
  'chats',
  'partners',
  'posts',
  'like_yours',
  'helpful',
  'weekly_post',
  'post_people',
  'found_checks',
  'profile',
] as const satisfies readonly (DailyJob | OwnDailyJob)[];
type InstagramDaily = (typeof INSTAGRAM_DAILY)[number];

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
  profile: 'Reading your Instagram profile, as it does on the 1st of each month…',
};
const DAILY_NAMES: Readonly<Record<InstagramDaily, string>> = {
  requests: 'Your newest followers',
  follow_backs: 'Who followed you back',
  tidy: 'Tidy up',
  checks: 'Check my followers',
  chats: 'Read my chats',
  partners: 'Find partners',
  posts: 'Your hashtags and places',
  like_yours: 'Accounts like yours',
  helpful: 'Who engaged with you',
  weekly_post: 'This week’s helpful post',
  post_people: 'Who liked and commented',
  found_checks: 'Check the people found',
  profile: 'Read my profile',
};

/** Instagram's pace between steps: slower than LinkedIn's, as Instagram blocks fast (the plan's "The risk"). */
export const INSTAGRAM_GAP_MS = { least: 3 * 60_000, most: 8 * 60_000 } as const;
/** While Instagram draws what a press opened. */
const SETTLE_MS = 2_000;
/** A gap longer than this closes its window until the next step. */
const KEEP_WINDOW_MS = 5 * 60_000;
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
  | { readonly done: true; readonly line: string }
  | { readonly done: false; readonly line: string; readonly need?: true }
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
 * by who wrote it (its View all comments pressed once when the page doesn't show it yet): `liked`, `already`, or null
 * when there's none to like there (gone, about grief, illness or trouble, or no Like on it: the page is noted with its
 * outline once a day), so their latest is liked in its place, as anyone's is. Noted as a like with the comment's own
 * link, so the follow waits a day as for a post.
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
      return { done: false, line: `Couldn’t like ${item.name}’s post: ${after.without}` };
    } else break;
  }
  return done(liked);
}

/** A follow, with their account's own Follow (or Follow Back), then their account read again to see it went. */
async function followThem(item: TodayListItem, businessId: string): Promise<Outcome> {
  const opened = await openAccount(item, businessId);
  if ('outcome' in opened) return opened.outcome;
  const standing = opened.page.found.profile!.following;
  if (standing === 'following' || standing === 'requested')
    return { done: false, line: `${item.name}: you follow them already, or asked to` };
  const went = await tab.ask({ type: 'hfos-connect', profile: opened.noted });
  if (!went.ok) throw new Error(went.error);
  if (went.result === 'already')
    return { done: false, line: `${item.name}: you follow them already, or asked to` };
  if (went.result === 'none')
    return { done: false, line: `${item.name}: couldn’t find Follow on their account`, need: true };
  await pause(SETTLE_MS);
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { stop };
  const standingNow = page.found.profile?.following;
  if (went.result !== 'done' || (standingNow !== 'following' && standingNow !== 'requested'))
    return { done: false, line: `${item.name}: Instagram didn’t take the follow`, need: true };
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
): Promise<{ readonly stop: string } | null> {
  if (!item.threadKey) return null;
  const opened = await openChat(item, businessId);
  if ('outcome' in opened) return 'stop' in opened.outcome ? opened.outcome : null;
  const chat = (await read()).found.chat;
  const page = chat ? chatPageOf(chat) : null;
  const built = page ? chatCollect(page, new Date(), null, PLATFORM) : null;
  if (built)
    await answer({
      type: 'hfos-collect-chats',
      input: { workspaceId: businessId, platform: PLATFORM, chats: [built] },
    });
  return null;
}

/**
 * Drafts a message with the AI after looking them up on Instagram, and hands it to HandsFreeOS to wait or go; a comment
 * on a good post is drafted from the post (decision 92).
 */
async function draftMessage(item: TodayListItem, businessId: string): Promise<Outcome> {
  if (item.kind === 'comment') return draftComment(item, businessId);
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

/** The likes the day has room for past one each for the warm-ups still to do: a warm-up's second like takes one. */
export function spareLikes(list: Pick<TodayList, 'limits'>, left: readonly Work[]): number {
  const warmUps = left.filter(
    (w) => w.do === 'step' && (w.item.kind === 'warm_up' || w.item.kind === 'partner_warm_up'),
  ).length;
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

/**
 * Instagram's jobs that find people, done again in a round while it needs more good fits (decision 126, plan.ts
 * `nextRound`): its hashtags with the next words, an account like yours, who liked and commented on good posts, and their checks.
 */
export const INSTAGRAM_FINDING: readonly InstagramDaily[] = [
  'posts',
  'like_yours',
  'post_people',
  'found_checks',
];

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
    case 'profile':
      return readProfileOnItsOwn(job, PLATFORM, (j) => instagramProfileRead(j));
  }
}

// ------------------------------------------------------------------------------------------------- the day

/** Whether Instagram's day is started today, as the beat last said; null when HandsFreeOS hasn't said. */
const dayOf = (kept: Kept | null) => kept?.days?.instagram ?? null;

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
  const tomorrow = () => nextStart(settings.hours, timezone, Date.now(), random);
  if (!own.go) {
    await setState({ started: false, stopped: own.stopped });
    // Outside the hours a reply to someone who wrote back still goes, and nothing new does (decision 133): never after
    // Stop for today or a warning, nor while noting's off or an ask of theirs is in line.
    const answering =
      own.stopped === null &&
      !(await warnedNow(PLATFORM)) &&
      (await isNoting()) &&
      !askInLine(PLATFORM)
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
    await closeWindow();
    await say(networkWaitWords(NAME, own, settings.hours, timezone, at));
    // The beat says when it's pressed (`days.instagram`), and wakes this before then; a reply waiting for an OK, or a message tried again, sooner.
    return goAt(
      lookOutsideAt(
        !!answering && replyWaiting(answering.list),
        at,
        own.next,
        answering ? retryWake(await stateNow(), at) : [],
      ),
    );
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
  // What the person asked on Instagram goes first: this looks again in a couple of minutes.
  if (askInLine(PLATFORM)) {
    await say(ASK_FIRST_WORDS);
    return goAt(at + ASK_FIRST_MS);
  }
  const soon = () => goAt(Date.now() + pickGap(random));

  // Lists first (decision 60), Instagram's own.
  const lists = valueOf(
    await (answer as Hfos)({ type: 'hfos-lists', workspaceId: to.businessId, platform: PLATFORM }),
  );
  if (JSON.stringify(state.lists) !== JSON.stringify(lists)) state = await setState({ lists });
  // Reads that need the screen wait till the person is away from their computer (decision 120): saving their
  // followers reads its box on screen, so their first day waits for it, and a weekly save is passed over till then.
  const away = await awayNow();
  const before = beforeDay(lists, state.before ?? {}, at, timezone, PLATFORM);
  if (before?.do === 'save' && before.first && !away) {
    await closeWindow();
    await say(
      `Your first day on ${NAME} starts once your followers are saved. That needs its window on screen, so it waits till you’ve been away from your computer for 2 minutes.`,
    );
    return goAt(Date.now() + AWAY_AGAIN_MS);
  }
  const passOver = putOff.passOver(away);
  let daily = choices.collect ? nextInstagramDaily(state, passOver, at) : null;
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
  const reading = (before !== null && (away || before.do !== 'save')) || daily !== null;
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
  if (before && (away || before.do !== 'save')) {
    const end = await inTurn('runner', () => beforeTheDay(before, to.businessId), PLATFORM);
    const line = beforeDayLine(before, end, PLATFORM);
    if (end.warned) {
      await closeWindow();
      await say(end.line, { stopped: 'warning' });
      return goAt(tomorrow());
    }
    // Put off till they're away, or done: the list has its turn next either way (decision 123).
    if (end.away) {
      await say(line, { readLast: true });
      return soon();
    }
    await setState({ readLast: true });
    void feed('job', `${NAME}: ${line}`);
    if (before.do === 'save' && before.first && end.failed) {
      await closeWindow();
      await say(
        `${line} Your first day on ${NAME} starts once your followers are saved, so it tries again in a few minutes.`,
        { needs: true },
      );
      return goAt(Date.now() + AGAIN_MS);
    }
    await say(line);
    return soon();
  }

  if (daily) {
    const end = await inTurn('runner', () => collect(daily, to.businessId), PLATFORM);
    if (end.warned) {
      await closeWindow();
      await say(end.line, { stopped: 'warning' });
      return goAt(tomorrow());
    }
    const line = `${DAILY_NAMES[daily]}: ${end.line}`;
    await say(line, { readLast: true });
    if (end.away) putOff.off(daily);
    else void feed('job', `${NAME}: ${line}`);
    return soon();
  }

  const { list, left } = await listNow(to.businessId, state.tried, state.replied);
  if (!left[0]) {
    await closeWindow();
    // What waits for them to be away is looked at again sooner.
    const waiting = choices.collect
      ? waitingWords(waitingFor(passOver, state.daily, DAILY_NAMES))
      : null;
    // The checks' next batch, when one's to come today (decision 126).
    const again = choices.collect ? soonestAgain(await stateNow(), at) : null;
    await say(
      `${
        waiting
          ? `${state.tried.length ? `The rest of today on ${NAME} is done.` : `Nothing on your ${NAME} list for it to do yet.`} ${waiting}`
          : state.tried.length
            ? `Done for today on ${NAME}. It looks again within the hour for anything new.`
            : `Nothing on your ${NAME} list for it to do yet.`
      }${again !== null ? ` ${AGAIN_WORDS}` : ''}`,
    );
    return goAt(
      Math.min(
        at + (waiting ? AWAY_AGAIN_MS : 60 * 60_000),
        ...(again !== null ? [again] : []),
        // A message tried again that waits its turn (decision 132).
        ...retryWake(await stateNow(), at),
      ),
    );
  }
  return workNext(left, list, {
    businessId: to.businessId,
    settings,
    timezone,
    own,
    reading,
    random,
  });
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
  // Whether Instagram needs more good fits today (decision 126): it finds people again once the day's reading is done.
  // And when a message tried again may go (decision 132): it looks again by then.
  const says = listSays(list);
  const kept = await stateNow();
  if (kept.more !== says.more || (kept.retryAt ?? null) !== says.retryAt) await setState(says);
  return { list, left: instagramWorkLeft(list, tried, replied) };
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
  // Instagram asked them to sign in: nothing tried, and it looks again in a while.
  if ('again' in outcome) {
    await closeWindow();
    await say(outcome.again, { needs: true });
    return goAt(Date.now() + AGAIN_MS);
  }
  // A step that didn't go: the page it ended on, outline and all, noted while the window still shows it (decision 74).
  if ('done' in outcome && !outcome.done)
    await reporter(tab, answer as Hfos, {
      businessId,
      platform: PLATFORM,
      askId: null,
      job: work.do === 'step' ? work.item.kind : work.do,
    })({ note: 'The step didn’t go.', outline: true });
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
    'need' in outcome && work.do === 'step' ? needOf(item, outcome.line, businessId) : null;
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
      // A person's pace while the morning's reading is left: the list's turn and the reading's go by turns.
      started: own.started || at.reading,
      random: at.random,
    }),
  );
  if (gap > KEEP_WINDOW_MS) await closeWindow();
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

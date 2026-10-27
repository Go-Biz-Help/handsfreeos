/**
 * The extension on its own (docs/outreach.md, decisions 26 to 33), in the background worker: once the person picks
 * **Friend requests, likes and comments on their own** in the panel, it goes down their list for today
 * (packages/core/src/addons/outreach/today.ts) by itself, a step at a time: it confirms requests from people who fit
 * a playbook well, likes a post of someone's a day before their friend request, sends friend requests, and writes
 * comments on good posts with the AI's draft.
 *
 * Messages too, once the person picks a Sending choice (packages/core/src/addons/outreach/sends.ts): it looks each
 * person up on Facebook and drafts a first message, follow-up or reply with the AI, which then waits for their OK in
 * the panel or on the web (one tap, or Approve all), or goes as it is with Everything on its own once their training
 * wheels are off. A reply follows the person's Replies (decision 27): with (b) it goes when the AI found it simple,
 * with (c) always, but never to someone who needs them, who is handed over with a push instead. What's OK'd it sends in Messenger: in the chat when HandsFreeOS knows
 * it, else from their profile's Message; it notes it as its own, and says when one couldn't go and why.
 *
 * It goes in their working hours, in the business's time zone, at random times spread over the day, or straight away
 * at a person's pace once they press **Start my day** (./plan.ts). Each step wakes the background with an alarm, opens
 * the page in a window of its own beside the person's (../tab.ts), checks it's the right person and where things
 * stand, presses the button (../networks/facebook/auto.ts), checks it worked, and notes it in HandsFreeOS as the extension's
 * own (`auto`), which takes it off the list and counts it against the daily limits: the list only ever holds what
 * today's limits have room for. It stops for the day on any warning from Facebook, and when the person presses
 * **Stop for today**. It works only while someone is signed in with somewhere to save and noting is on, and only while
 * Chrome is open.
 *
 * Once a day, at the start of the working day or after Start my day, it first does the jobs that fill that list
 * (./daily.ts, decision 32): it checks their friend requests, saves their groups' members, finds posts and reads their
 * chats, one job a go, a few minutes apart. Then, in the working hours, every hour or two, it looks at the newest
 * posts at the top of their best groups (decision 49), between the day's steps; and when the person lets it post on
 * its own, it puts up today's helpful post once the AI has written it (decision 50).
 *
 * It tells HandsFreeOS what it's doing and each step it takes (../hfos/live.ts, decision 41), and follows the day
 * HandsFreeOS keeps: Start my day and Stop for today pressed in the app, on the phone or here. Only the person's most
 * recently used computer works; on any other it stands by and says why.
 *
 * It takes turns on Facebook with what the person asks of the extension from HandsFreeOS (../asks/run.ts, decision
 * 43), through ./turns.ts: an ask goes first, and the runner carries on after.
 */
import { businessDay, workWindow, type MessageKind } from '@hfos/core/addons/outreach/automation';
import { ASK_FIRST_WORDS } from '@hfos/core/addons/outreach/asks';
import { standDownWords } from '@hfos/core/addons/outreach/live';
import { DAILY_STEPS, pastLimitWords, type DailyStep } from '@hfos/core/addons/outreach/limits';
import {
  fallbackLikePick,
  LIKE_POSTS_READ,
  likedText,
  LikePickInput,
  type LikePickOutput,
} from '@hfos/core/addons/outreach/like-pick';
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import { messageParts, partPauseMs } from '@hfos/core/addons/outreach/voice';
import {
  AUTO_PLANS,
  sameByKey,
  samePerson,
  withTheirName,
  type AutoJob,
} from '../networks/facebook/auto';
import { linesOf, pageHeading, POSTS_READ } from '../networks/facebook/lookup';
import type { FetchStep } from '../networks/facebook/fetch';
import { facebook } from '../networks/facebook/kit';
import { FRIENDSHIP_WORDS } from '../networks/facebook/tidy';
import type { ProfileRef, ReadResult, ThreadRef } from '../networks/facebook/types';
import { valueOf, type Hfos, type Job, type JobEnd } from '../jobs/job';
import { reporter } from '../jobs/report';
import { nameForms, sameName } from '../networks/facebook/people';
import { FACEBOOK, profileFromUrl } from '../networks/facebook/urls';
import type {
  AutoStatus,
  Drafts,
  HfosAnswer,
  HfosAsk,
  ReadyShown,
  TodayList,
  TodayListItem,
  TodaySoFar,
} from '../hfos/messages';
import { config } from '../hfos/config';
import { follow, loadSettings } from '../hfos/follow';
import { chatCollect } from '../hfos/saves';
import {
  beatSoon,
  dayChange,
  feed,
  keptFor,
  liveNow,
  onWake,
  pressDay,
  pressWaiting,
} from '../hfos/live';
import { isNoting, noteNeed, takeNote } from '../hfos/noting';
import { answer, answerWith, api, call, Refused, savingTo } from '../hfos/session';
import { keepWarning, warnedNow, warningInput } from '../hfos/warned';
import { WorkTab } from '../tab';
import { WATCH_GROUPS } from '@hfos/core/addons/outreach/posts';
import { groupsToWork, watchPosts } from '../jobs/posts';
import { postHelpful } from '../jobs/helpful';
import { DAILY_DOING, DAILY_NAMES, postSender, runDaily } from './daily';
import {
  beforeDay,
  beforeDayDoing,
  beforeDayLine,
  doBeforeDay,
  markOf,
  type BeforeDay,
} from './lists';
import { askInLine, inTurn } from './turns';
import {
  AUTO_STATE_KEY,
  freshState,
  gapAfter,
  HELPFUL_AGAIN_MS,
  helpfulDue,
  IDLE_MS,
  isState,
  needOf,
  nextDaily,
  nextStart,
  nextWatch,
  watchDue,
  workKey,
  workLeft,
  type AutoKind,
  type AutoState,
  type DailyJob,
  type DoneKind,
  type Work,
} from './plan';

export const AUTO_ALARM = 'hfos-auto';

/** While Facebook draws what a press opened. */
const SETTLE_MS = 1_500;
/** How long a button is looked for; the box asking to be sure, less. */
const WAIT_MS = 8_000;
const WAIT_OPTIONAL_MS = 3_000;
/** A gap longer than this closes its window until the next step. */
const KEEP_WINDOW_MS = 5 * 60_000;
/** After something went wrong, it tries again this much later. */
const AGAIN_MS = 15 * 60_000;
/** While noting is off, or nobody has picked a business, it looks again this often. */
const LOOK_AGAIN_MS = 30 * 60_000;
/** While an ask the person made goes first, the runner looks again after this. */
const ASK_FIRST_MS = 2 * 60_000;

const tab = new WorkTab('window');
/** The runner's window's tab, while it's open: what the person sees there isn't theirs to note. */
export const runnerTabId = (): number | null => tab.tabId;
let busy = false;
/**
 * Stop for today was pressed (here, in the app or on the phone), or another computer works now: a once-a-day job
 * under way ends at its next page.
 */
let stopAsked = false;
/** A beat's answer asked it to end what it was doing while a go was under way: one more go once that ends. */
let haltAgain = false;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------------------------------------- state

async function stateNow(): Promise<AutoState> {
  try {
    const value: unknown = (await chrome.storage.local.get(AUTO_STATE_KEY))[AUTO_STATE_KEY];
    return isState(value) ? value : freshState(null);
  } catch {
    return freshState(null);
  }
}

/** The last change to the state, which the next waits for: a job's progress lines never land over what came after. */
let writing: Promise<unknown> = Promise.resolve();

function setState(change: Partial<AutoState>): Promise<AutoState> {
  const write = writing.then(async () => {
    const next = { ...(await stateNow()), ...change };
    await chrome.storage.local.set({ [AUTO_STATE_KEY]: next });
    return next;
  });
  writing = write.catch(() => undefined);
  // HandsFreeOS hears what changed within a couple of seconds (../hfos/live.ts).
  beatSoon();
  return write;
}

/** A new line for the person; one that needs them says so (`needs`), and the next line clears it. */
const say = (line: string, more: Partial<AutoState> = {}) =>
  setState({ line, lineAt: Date.now(), needs: false, ...more });

/** Goes next at `when`, or not at all. */
async function goAt(when: number | null): Promise<void> {
  if (when === null) await chrome.alarms.clear(AUTO_ALARM);
  else await chrome.alarms.create(AUTO_ALARM, { when: Math.max(when, Date.now() + 30_000) });
  await setState({ nextAt: when });
}

async function closeWindow(): Promise<void> {
  await tab.close();
  await setState({ tabId: null });
}

// ------------------------------------------------------------------------------------------------- Facebook

/**
 * What a step came to: done, or passed over and why, with `need` when it's one the person can do themselves (a button
 * or box it couldn't find, a different page, Facebook not taking it: handed to them, decision 42); or a reason to stop
 * for the day.
 */
type Outcome =
  | { readonly done: true; readonly line: string }
  | { readonly done: false; readonly line: string; readonly need?: true }
  | { readonly stop: string };

async function read(): Promise<ReadResult> {
  const answered = await tab.ask({ type: 'hfos-read' });
  if (!answered.ok) throw new Error(answered.error);
  return answered.result;
}

/** Stops for the day on a warning on the page, noting it in HandsFreeOS once. */
async function warnedOn(page: ReadResult, businessId: string): Promise<string | null> {
  if (!page.warnings.length) return null;
  const fresh = await keepWarning(page.warnings);
  if (fresh.length)
    await answer({ type: 'hfos-warning', input: warningInput(businessId, fresh, page.url) });
  return `Stopped: Facebook says “${page.warnings[0]}”. The extension stops for today, and your daily limits are halved for a week.`;
}

/** Presses the way along a path, the furthest step on the page each time. Whether it got to the end. */
async function pressPath(steps: readonly FetchStep[]): Promise<boolean> {
  let from = 0;
  while (from < steps.length) {
    const went = await tab.ask({
      type: 'hfos-fetch-path',
      steps,
      from,
      waitMs: WAIT_MS,
      tidy: true,
    });
    if (!went.ok) throw new Error(went.error);
    if (went.at === undefined) return false;
    from = went.at + 1;
    await pause(SETTLE_MS);
  }
  return true;
}

/** The box asking to be sure, when Facebook shows one. */
async function sure(steps: readonly FetchStep[]): Promise<void> {
  for (const step of steps) {
    const went = await tab.ask({
      type: 'hfos-fetch-step',
      step,
      waitMs: step.optional ? WAIT_OPTIONAL_MS : WAIT_MS,
      tidy: true,
    });
    if (!went.ok) throw new Error(went.error);
    if (went.result === 'done') await pause(SETTLE_MS);
  }
}

const profileOf = (url: string | null): ProfileRef | null => {
  try {
    return url ? profileFromUrl(new URL(url)) : null;
  } catch {
    return null;
  }
};

/**
 * Opens someone's profile and checks it's them: the page and its profile, and the profile to note the step against
 * (the one kept, with what the page added); or what stopped it.
 */
async function openProfile(
  item: TodayListItem,
  businessId: string,
): Promise<
  | { readonly page: ReadResult; readonly profile: ProfileRef; readonly noted: ProfileRef }
  | { readonly outcome: Outcome }
> {
  const want = profileOf(item.profileUrl);
  if (!want) return { outcome: { done: false, line: `${item.name}: no profile link kept` } };
  await tab.open(want.url);
  await setState({ tabId: tab.tabId });
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { outcome: { stop } };
  const shown = page.profile?.profile ?? null;
  if (!page.profile || !shown || !samePerson(shown, page.profile.name, want, item.name))
    return {
      outcome: { done: false, line: `${item.name}: Facebook showed a different page`, need: true },
    };
  const noted = {
    id: want.id ?? shown.id,
    username: want.username ?? shown.username,
    url: want.url,
  };
  return { page, profile: shown, noted };
}

const now = () => new Date().toISOString();

/** Add friend, or Confirm their request, on their profile. */
async function onProfile(item: TodayListItem, job: AutoJob, businessId: string): Promise<Outcome> {
  const plan = AUTO_PLANS[job];
  const opened = await openProfile(item, businessId);
  if ('outcome' in opened) return opened.outcome;
  const { friendship } = opened.page.profile!;
  if (friendship === plan.after) return { done: false, line: `${item.name}: done already` };
  if (friendship !== plan.before)
    return { done: false, line: `${item.name}: Facebook says ${FRIENDSHIP_WORDS[friendship]}` };
  if (!(await pressPath(withTheirName(plan.path, [opened.page.profile!.name, item.name]))))
    return {
      done: false,
      line: `${item.name}: couldn’t find “${plan.path[0]!.words[0]}”`,
      need: true,
    };
  await sure(plan.then);
  await pause(SETTLE_MS);
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { stop };
  if (page.profile?.friendship !== plan.after)
    return { done: false, line: `${item.name}: Facebook didn’t take it`, need: true };
  const to = { name: page.profile.name ?? item.name, profile: opened.noted };
  if (job === 'confirm') {
    await takeNote({
      type: 'hfos-answered',
      answered: { answer: 'confirm', to, mutualFriends: page.profile.mutualFriends },
      at: now(),
    });
    return { done: true, line: `Confirmed ${item.name}’s friend request` };
  }
  await takeNote({
    type: 'hfos-noted',
    step: {
      kind: 'friend_request',
      to,
      group: null,
      postUrl: null,
      thread: null,
      replying: null,
      auto: true,
    },
    at: now(),
  });
  return { done: true, line: `Sent ${item.name} a friend request` };
}

/** Comments the day's limit still has room for, as the list said this pass: a warm-up comment takes one. */
let commentsLeft = 0;

/**
 * Likes one of their latest posts, a day before their friend request (decision 33): the AI picks one to do with the
 * business, else about them, never one about grief, illness or trouble (`outreach.like.pick`; the words alone pick
 * when it can't be asked). None, or none fit: the request goes without. A post to do with the business gets the AI's
 * short comment under it too, while the day's comments have room (the main offer plan's warm-up).
 */
async function warmUp(item: TodayListItem, businessId: string): Promise<Outcome> {
  // A partner's warm-up comes before the ask about partnering (decision 81), not a friend request.
  const after =
    item.kind === 'partner_warm_up'
      ? { without: 'the ask about partnering goes without', next: 'the ask comes tomorrow' }
      : {
          without: 'their friend request goes without',
          next: 'their friend request comes tomorrow',
        };
  const opened = await openProfile(item, businessId);
  if ('outcome' in opened) return opened.outcome;
  const theirs = await tab.ask({
    type: 'hfos-their-posts',
    profile: opened.profile,
    most: LIKE_POSTS_READ,
  });
  if (!theirs.ok) throw new Error(theirs.error);
  const missed = async (line: string): Promise<Outcome> => {
    await call(
      api().POST('/v1/commands/outreach.warm_up.missed', {
        body: { workspaceId: businessId, profileId: item.profileId! },
      }),
      businessId,
    );
    return { done: false, line };
  };
  if (!theirs.posts.length) return missed(`No post of ${item.name}’s to like: ${after.without}`);
  const posts = theirs.posts.map((p) => ({
    text: p.text,
    pictures: [...p.pictures],
    when: p.when,
  }));
  // One they liked already warms them up as well as a new one.
  const likedAlready = theirs.posts.findIndex((p) => p.liked);
  let pick: LikePickOutput;
  if (likedAlready >= 0)
    pick = { pick: likedAlready, about: null, why: null, by: 'words', comment: null };
  else {
    const asked = await answer({
      type: 'hfos-like-pick',
      workspaceId: businessId,
      input: { profileId: item.profileId!, posts },
    });
    pick = asked.ok
      ? (asked.value as LikePickOutput)
      : fallbackLikePick(LikePickInput.parse({ profileId: item.profileId!, posts }).posts);
  }
  if (pick.pick === null)
    return missed(`None of ${item.name}’s posts were right to like: ${after.without}`);
  const chosen = theirs.posts[pick.pick]!;
  const liked = await tab.ask({
    type: 'hfos-like-post',
    profile: opened.profile,
    index: pick.pick,
    url: chosen.url,
  });
  if (!liked.ok) throw new Error(liked.error);
  if (liked.result === 'none' || liked.result === 'not_sent')
    return missed(`Couldn’t like ${item.name}’s post: ${after.without}`);
  await pause(SETTLE_MS);
  const stop = await warnedOn(await read(), businessId);
  if (stop) return { stop };
  await takeNote({
    type: 'hfos-noted',
    step: {
      kind: 'like',
      to: { name: opened.page.profile!.name ?? item.name, profile: opened.noted },
      group: null,
      postUrl: liked.postUrl ?? chosen.url ?? null,
      thread: null,
      replying: null,
      auto: true,
      postText: likedText(chosen),
      why: pick.why,
    },
    at: now(),
  });
  const about = pick.why ? ` (${pick.why.replace(/[.!]$/, '')})` : '';
  const commented =
    pick.comment && commentsLeft > 0
      ? await warmComment(item, businessId, opened.noted, {
          url: liked.postUrl ?? chosen.url ?? null,
          text: pick.comment,
          postText: likedText(chosen),
        })
      : null;
  if (commented && 'stop' in commented) return commented;
  return {
    done: true,
    line:
      liked.result === 'already'
        ? `${item.name}’s post was liked already: ${after.next}`
        : commented
          ? `Liked and commented on a post of ${item.name}’s${about}: ${after.next}`
          : `Liked a post of ${item.name}’s${about}: ${after.next}`,
  };
}

/**
 * The warm-up comment under the post just liked, noted as a comment like any other (it counts against the day's
 * comments). Null when it couldn't go: the like stands on its own.
 */
async function warmComment(
  item: TodayListItem,
  businessId: string,
  author: ProfileRef,
  post: { readonly url: string | null; readonly text: string; readonly postText: string | null },
): Promise<{ readonly stop: string } | { readonly done: true } | null> {
  if (!post.url) return null;
  await tab.open(post.url);
  await setState({ tabId: tab.tabId });
  const stop = await warnedOn(await read(), businessId);
  if (stop) return { stop };
  const wrote = await tab.ask({ type: 'hfos-comment', text: post.text });
  if (!wrote.ok || wrote.result !== 'done') return null;
  await pause(SETTLE_MS);
  const after = await warnedOn(await read(), businessId);
  if (after) return { stop: after };
  commentsLeft--;
  await takeNote({
    type: 'hfos-noted',
    step: {
      kind: 'comment',
      to: { name: item.name, profile: author },
      group: null,
      postUrl: post.url,
      thread: null,
      replying: null,
      auto: true,
      postText: post.postText,
      commentText: post.text,
    },
    at: now(),
  });
  return { done: true };
}

/** Writes the AI's comment under a good post in their groups (decision 20). */
async function comment(item: TodayListItem, businessId: string): Promise<Outcome> {
  const author = profileOf(item.profileUrl);
  if (!author || !item.postUrl || !item.postId)
    return { done: false, line: `${item.name}’s post: no link kept` };
  const drafted = await answer({
    type: 'hfos-draft',
    workspaceId: businessId,
    input: { kind: 'comment', postId: item.postId },
  });
  if (!drafted.ok) return { done: false, line: `${item.name}’s post: ${drafted.problem.message}` };
  const text = (drafted.value as { drafts: readonly string[] }).drafts[0];
  if (!text) return { done: false, line: `${item.name}’s post: the AI had nothing to say on it` };
  await tab.open(item.postUrl);
  await setState({ tabId: tab.tabId });
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { stop };
  const wrote = await tab.ask({ type: 'hfos-comment', text });
  if (!wrote.ok) throw new Error(wrote.error);
  if (wrote.result === 'none')
    return {
      done: false,
      line: `${item.name}’s post: couldn’t find the box to comment in`,
      need: true,
    };
  if (wrote.result !== 'done')
    return {
      done: false,
      line: `${item.name}’s post: Facebook didn’t take the comment`,
      need: true,
    };
  await pause(SETTLE_MS);
  const after = await warnedOn(await read(), businessId);
  if (after) return { stop: after };
  await takeNote({
    type: 'hfos-noted',
    step: {
      kind: 'comment',
      to: { name: item.name, profile: author },
      group: null,
      postUrl: item.postUrl,
      thread: null,
      replying: null,
      auto: true,
      // The AI's words, not the person's: kept for the Results tab.
      postText: item.post,
      commentText: text,
    },
    at: now(),
  });
  return { done: true, line: `Commented on ${item.name}’s post` };
}

// ------------------------------------------------------------------------------------------------- messages

/**
 * What their profile and business page say, for the AI (decision 21), read in the runner's window; empty when it
 * couldn't look, which still lets the draft be written from what HandsFreeOS knows. A warning stops it.
 */
async function lookUpIn(
  item: TodayListItem,
  businessId: string,
): Promise<{ readonly lines: string[] } | { readonly stop: string }> {
  if (!item.profileUrl) return { lines: [] };
  const opened = await openProfile(item, businessId);
  if ('outcome' in opened) return 'stop' in opened.outcome ? opened.outcome : { lines: [] };
  const lines = linesOf(opened.page, null, POSTS_READ);
  const business = opened.page.pages?.[0];
  if (business?.profile) {
    await tab.open(business.profile.url);
    const page = await read();
    const stop = await warnedOn(page, businessId);
    if (stop) return { stop };
    lines.push(pageHeading(opened.page, business), ...linesOf(page, business.name, 1));
  }
  return { lines: [...new Set(lines.filter(Boolean))].slice(0, LOOKUP_LINES) };
}

/**
 * Their chat as it is now, before a reply to them is drafted (docs/outreach.md, decisions 65 to 67): opened in
 * Messenger and brought into HandsFreeOS, so the AI reads what they answered. A reply seen in the list carries no
 * words (src/hfos/replies.ts), so this is where they come from. One that can't be opened is drafted from what
 * HandsFreeOS has; a warning stops it.
 */
async function bringInChat(
  item: TodayListItem,
  businessId: string,
): Promise<{ readonly stop: string } | null> {
  if (!item.threadKey) return null;
  const opened = await openChat(item, businessId);
  if ('outcome' in opened) return 'stop' in opened.outcome ? opened.outcome : null;
  const page = await read();
  const built = page.chat ? chatCollect(page.chat, new Date(), null) : null;
  if (built)
    await answer({
      type: 'hfos-collect-chats',
      input: { workspaceId: businessId, platform: facebook.platform, chats: [built] },
    });
  return null;
}

/**
 * Drafts a message to someone on the list with the AI, after looking them up (and, for a reply, bringing in their
 * chat), and hands it to HandsFreeOS: it waits for the person's OK, or goes as it is. A reply to someone who said yes
 * comes back as the next step, the video or the link, and goes as that.
 */
async function draftMessage(item: TodayListItem, businessId: string): Promise<Outcome> {
  if (item.kind === 'reply' || item.kind === 'partner_reply') {
    const stopped = await bringInChat(item, businessId);
    if (stopped) return stopped;
  }
  const looked = await lookUpIn(item, businessId);
  if ('stop' in looked) return looked;
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
  // What the drafts are for: the kind asked for, or after a yes, the next step.
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

/**
 * Opens the chat with them: theirs in Messenger when it's known, else their profile's Message. With the name Facebook
 * showed for them, on the chat or their profile, checked as theirs. To send in (`sending`), a chat in Messenger counts
 * only when it links to them by a key HandsFreeOS keeps too, by number or by username: by its name alone it could be
 * someone else's with the same name, so their profile's Message opens their chat instead, and the chat kept is noted
 * with the message when it showed their name. One that links to someone else is someone else's.
 */
async function openChat(
  item: TodayListItem,
  businessId: string,
  sending = false,
): Promise<
  | {
      readonly profile: ProfileRef;
      readonly thread: ThreadRef | null;
      readonly name: string | null;
    }
  | { readonly outcome: Outcome }
> {
  const want = profileOf(item.profileUrl);
  let kept: ThreadRef | null = null;
  if (item.threadKey) {
    await tab.open(`${FACEBOOK}/messages/t/${encodeURIComponent(item.threadKey)}/`);
    await setState({ tabId: tab.tabId });
    const page = await read();
    const stop = await warnedOn(page, businessId);
    if (stop) return { outcome: { stop } };
    const chat = page.chat;
    const keyed = sameByKey(chat?.profile ?? null, want);
    const named = chat?.name != null && sameNames(chat.name, item.name);
    const profile = want ?? chat?.profile ?? null;
    const different = {
      outcome: { done: false, line: `${item.name}: Messenger showed a different chat` },
    };
    if (chat && profile && keyed) return { profile, thread: chat.thread, name: chat.name };
    if (!sending) {
      if (!chat || !(keyed ?? named) || !profile) return different;
      return { profile, thread: chat.thread, name: chat.name };
    }
    if (keyed === false) return different;
    if (chat && named) kept = chat.thread;
  }
  const opened = await openProfile(item, businessId);
  if ('outcome' in opened) return opened;
  // The chat windows open before it are noted first: none of those is taken for theirs by a name (../networks/facebook/auto.ts).
  const pressed = await tab.ask({ type: 'hfos-open-message', profile: opened.noted });
  if (!pressed.ok)
    return {
      outcome: { done: false, line: `${item.name}: couldn’t find “Message” on their profile` },
    };
  await pause(SETTLE_MS);
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { outcome: { stop } };
  const name = opened.page.profile!.name;
  // Message may take the tab to their chat in Messenger, which links to them by number: the chat their own profile's
  // Message opened, when it shows the name their profile does, so its key is theirs too.
  const chat = page.chat;
  const learned =
    chat?.profile &&
    name &&
    chat.name &&
    sameByKey(chat.profile, opened.noted) === null &&
    sameNames(chat.name, name)
      ? {
          ...opened.noted,
          id: opened.noted.id ?? chat.profile.id,
          username: opened.noted.username ?? chat.profile.username,
        }
      : opened.noted;
  return { profile: learned, thread: chat?.thread ?? kept, name };
}

/** Whether two names are the same person's as Facebook shows them: whole, or without a nickname. */
const sameNames = (a: string, b: string) =>
  nameForms(a).some((one) => nameForms(b).some((other) => sameName(one, other)));

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
 * Sends a message OK'd (or let go as it is) in Messenger, and notes it as its own: as a few short texts, a few seconds
 * apart, when the person texts that way (@hfos/core/addons/outreach/voice), each part between blank lines its own.
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
  const chat = await openChat(item, businessId, true);
  if ('outcome' in chat) return 'stop' in chat.outcome ? chat.outcome : failed(chat.outcome.line);
  const parts = messageParts(send.text, split);
  // Whose chat it goes in: the tab types only into one it shows is with them, by their profile, or by the name
  // Facebook showed for them where a chat links to nobody.
  const names = chat.name ? [chat.name] : [];
  // Once a text has gone, the message has: the rest is said, not tried again.
  let partly: string | null = null;
  for (const [i, part] of parts.entries()) {
    // The next text a few seconds after, as long as typing it takes.
    if (i > 0) await pause(partPauseMs(part, Math.random()));
    const wrote = await tab.ask({ type: 'hfos-message', text: part, profile: chat.profile, names });
    const why = !wrote.ok
      ? wrote.error
      : wrote.result === 'none'
        ? `couldn’t find a chat open with them${i === 0 ? ', so nothing was sent' : ''}`
        : wrote.result === 'not_theirs' && wrote.left
          ? `its typing went into ${wrote.left.with ? `the chat box with ${wrote.left.with}` : 'another chat’s box'} too and couldn’t be taken out, so delete it there before you send that chat${i === 0 ? '; nothing was sent' : ''}`
          : wrote.result === 'not_theirs'
            ? `its typing didn’t stay in their chat, so it took it out${i === 0 ? ' and sent nothing' : ''}`
            : wrote.result !== 'done'
              ? 'Facebook didn’t take the message'
              : null;
    if (why === null) continue;
    if (i === 0) return failed(`${item.name}: ${why}`);
    partly = `Sent ${item.name} ${i} of ${parts.length} texts, then: ${why}`;
    break;
  }
  await takeNote({
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
  });
  await sendDone(send.sendId, businessId, true, null);
  await pause(SETTLE_MS);
  const stop = await warnedOn(await read(), businessId);
  if (stop) return { stop };
  return { done: true, line: partly ?? `Sent ${item.name} a message` };
}

function doItem(item: TodayListItem, businessId: string): Promise<Outcome> {
  switch (item.kind) {
    case 'confirm':
      return onProfile(item, 'confirm', businessId);
    case 'friend_request':
      return onProfile(item, 'friend_request', businessId);
    case 'warm_up':
    case 'partner_warm_up':
      return warmUp(item, businessId);
    default:
      return comment(item, businessId);
  }
}

const DOING: Record<AutoKind, string> = {
  confirm: 'Confirming the friend request from',
  warm_up: 'Liking a post of',
  friend_request: 'Sending a friend request to',
  comment: 'Commenting on a post of',
};

/** A step's kind as the day counts it: a partner's warm-up is a like (decision 81). */
const stepKind = (kind: TodayListItem['kind']): AutoKind =>
  kind === 'partner_warm_up' ? 'warm_up' : (kind as AutoKind);

const doing = (work: Work) =>
  work.do === 'step'
    ? `${DOING[stepKind(work.item.kind)]} ${work.item.name}…`
    : work.do === 'draft'
      ? `Writing a message to ${work.item.name}…`
      : `Sending ${work.item.name} a message…`;

/** What a piece of work counts as, done. */
const doneAs = (work: Work): DoneKind =>
  work.do === 'step' ? stepKind(work.item.kind) : work.do === 'draft' ? 'drafted' : 'sent';

/** Does a piece of work: a step on the list, a draft, or a send. */
export function doWork(work: Work, businessId: string, split: boolean): Promise<Outcome> {
  if (work.do === 'draft') return draftMessage(work.item, businessId);
  if (work.do === 'send') return sendMessage(work.item, businessId, split);
  return doItem(work.item, businessId);
}

/** A once-a-day job, in the runner's window, noting any warning it sees as the runner does. */
function jobFor(businessId: string): Job {
  return {
    tab,
    hfos: answer as Hfos,
    businessId,
    stopped: () => stopAsked,
    progress: (line) => void say(line, { working: true }).catch(() => undefined),
    async warn(words, url) {
      const fresh = await keepWarning(words);
      if (fresh.length)
        await answer({ type: 'hfos-warning', input: warningInput(businessId, fresh, url) });
    },
  };
}

/** Does a once-a-day job, and keeps how it went: a job that went wrong isn't tried again today. */
async function collect(kind: DailyJob, businessId: string): Promise<JobEnd> {
  await say(DAILY_DOING[kind], { working: true });
  let end: JobEnd;
  try {
    end = await runDaily(kind, jobFor(businessId));
  } catch (error) {
    if (error instanceof Refused) throw error;
    end = {
      line: `${DAILY_NAMES[kind]}: ${error instanceof Error ? error.message : String(error)}`,
      warned: false,
    };
  } finally {
    await setState({ working: false, tabId: tab.tabId });
  }
  const state = await stateNow();
  await setState({
    daily: { ...state.daily, [kind]: end.line },
    // Find posts just read the groups: the newest posts wait an hour or two.
    ...(kind === 'posts' ? { watchAt: nextWatch(Date.now(), Math.random()) } : {}),
  });
  return end;
}

/**
 * Does what's due before the day (./lists.ts) and keeps how it went: a refresh that went wrong isn't tried again
 * today. The morning's friend requests, and the first check of friends, stand for today's once-a-day ones.
 */
async function beforeTheDay(step: BeforeDay, businessId: string): Promise<JobEnd> {
  const key = markOf(step);
  // The panel's live checklist shows the step under way, with the job's progress lines.
  await setState({ beforeNow: key });
  await say(beforeDayDoing(step), { working: true });
  let end: JobEnd;
  try {
    end = await doBeforeDay(step, jobFor(businessId));
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
  const stands =
    !end.failed && (key === 'requests' || key === 'checks' || key === 'group_checks')
      ? { daily: { ...state.daily, [key]: end.line } }
      : {};
  const lists = await (answer as Hfos)({ type: 'hfos-lists', workspaceId: businessId });
  await setState({
    before: { ...state.before, [key]: end.line },
    ...stands,
    ...(lists.ok ? { lists: lists.value } : {}),
  });
  return end;
}

/** The look at the newest posts in the best groups (decision 49), and when the next is. */
async function watch(businessId: string): Promise<JobEnd> {
  await say('Looking at the newest posts in your groups…', { working: true });
  let end: JobEnd;
  try {
    const job = jobFor(businessId);
    const groups = await groupsToWork(job, WATCH_GROUPS);
    end =
      typeof groups === 'string'
        ? { line: groups, warned: false }
        : await watchPosts(job, groups, postSender(job, 'watch'));
  } catch (error) {
    if (error instanceof Refused) throw error;
    end = { line: error instanceof Error ? error.message : String(error), warned: false };
  } finally {
    await setState({
      working: false,
      tabId: tab.tabId,
      watchAt: nextWatch(Date.now(), Math.random()),
    });
  }
  return end;
}

// ------------------------------------------------------------------------------------------------- the day

/** The person's choices and the business's time zone, from HandsFreeOS, followed live from now on (../hfos/follow.ts). */
async function automationOf(businessId: string) {
  const found = await loadSettings(businessId);
  if (!found) throw new Error('Sign in to HandsFreeOS in the panel, and the extension carries on.');
  void follow(() => void tick()).catch(() => undefined);
  return found;
}

/** One go: works out where things stand, does the next step when it's time, and sets when to go next. */
async function go(): Promise<void> {
  // A stop asked for before this go is in the day it reads below; one asked for from here on ends a job under way.
  stopAsked = false;
  const to = await savingTo();
  if (!to) {
    await goAt(null);
    await closeWindow();
    return void (await say('Sign in to HandsFreeOS in the panel, and the extension carries on.'));
  }
  const { settings, timezone } = await automationOf(to.businessId);
  let state = await stateNow();
  const at = Date.now();
  const day = businessDay(at, timezone);
  if (state.day !== day) {
    stopAsked = false;
    state = await setState(freshState(day, state.tabId));
  }
  // HandsFreeOS keeps the day, pressed anywhere, and says whether this computer is the one that works (decision 41).
  // With no word from it ever, this goes on as it did before.
  const live = await liveNow(to);
  if (live) {
    const change = dayChange(state, live.day, await pressWaiting(to));
    if (change) {
      stopAsked = change.stopped != null;
      state = await setState(change);
    }
  }
  await tab.adopt(state.tabId);
  if (settings.sending === 'off') {
    await goAt(null);
    return closeWindow();
  }
  // Another computer of theirs works: this one stands by, and says why, until the person uses it again.
  if (live && !live.working) {
    await closeWindow();
    await say(standDownWords(live.workingName));
    return goAt(null);
  }
  const random = Math.random();
  const tomorrow = () => nextStart(settings.hours, timezone, at, random);
  if (state.stopped) {
    await closeWindow();
    return goAt(tomorrow());
  }
  const warned = await warnedNow();
  if (warned) {
    await closeWindow();
    await say(
      `Stopped: Facebook warned you today (“${warned.words[0]}”). The extension stops until tomorrow.`,
      {
        stopped: 'warning',
      },
    );
    return goAt(tomorrow());
  }
  if (!(await isNoting())) {
    await closeWindow();
    await say(
      'Turn on “Note my steps on Facebook” in Social Outreach → Settings in HandsFreeOS: the extension works on its own only while it notes.',
      { needs: true },
    );
    return goAt(at + LOOK_AGAIN_MS);
  }
  const window = workWindow(settings.hours, timezone, at);
  const inHours = window !== null && at >= window.from && at < window.to;
  if (!state.started && !inHours) {
    await closeWindow();
    return goAt(tomorrow());
  }

  // What the person asked from HandsFreeOS goes first (../asks/run.ts): the runner looks again in a couple of minutes.
  if (askInLine()) {
    await say(ASK_FIRST_WORDS);
    return goAt(at + ASK_FIRST_MS);
  }

  // Before the day, the person's own lists (./lists.ts): the first time, nothing else runs till they're saved; then
  // the requests each morning and the friends list weekly; and after the first full save, Tidy up and one check.
  const lists = valueOf(await (answer as Hfos)({ type: 'hfos-lists', workspaceId: to.businessId }));
  if (JSON.stringify(state.lists) !== JSON.stringify(lists)) state = await setState({ lists });
  const before = beforeDay(lists, state.before ?? {}, at, timezone);
  if (before) {
    const end = await inTurn('runner', () => beforeTheDay(before, to.businessId));
    if (end.warned) {
      await closeWindow();
      await say(end.line, { stopped: 'warning' });
      return goAt(tomorrow());
    }
    const line = beforeDayLine(before, end);
    void feed('job', line);
    if (((before.do === 'save' && before.first) || before.do === 'group_checks') && end.failed) {
      // The first time, the day waits for the lists and the groups: it tries again in a few minutes.
      await closeWindow();
      await say(
        `${line} Your day starts once your friends list, friend requests and groups are saved and checked, so it tries again in a few minutes.`,
        { needs: true },
      );
      return goAt(Date.now() + AGAIN_MS);
    }
    await say(line);
    if ((await stateNow()).stopped) {
      await closeWindow();
      return goAt(tomorrow());
    }
    return goAt(
      Date.now() + gapAfter({ now: Date.now(), until: null, left: 0, started: true, random }),
    );
  }

  const daily = settings.collect ? nextDaily(state) : null;
  if (daily) {
    const end = await inTurn('runner', () => collect(daily, to.businessId));
    if (end.warned) {
      await closeWindow();
      await say(end.line, { stopped: 'warning' });
      return goAt(tomorrow());
    }
    await say(`${DAILY_NAMES[daily]}: ${end.line}`);
    void feed('job', `${DAILY_NAMES[daily]}: ${end.line}`);
    if ((await stateNow()).stopped) {
      await closeWindow();
      return goAt(tomorrow());
    }
    // A person's pace to the next: the list waits on these.
    return goAt(
      Date.now() + gapAfter({ now: Date.now(), until: null, left: 0, started: true, random }),
    );
  }

  // Today's helpful post, when the person lets it post on its own (decision 50): once the AI has written it.
  if (
    settings.posting === 'own' &&
    inHours &&
    (!settings.collect || state.daily?.helpful !== undefined) &&
    helpfulDue(state, at)
  ) {
    await say('Looking for today’s helpful post…', { working: true });
    let end: Awaited<ReturnType<typeof postHelpful>>;
    try {
      end = await inTurn('runner', () => postHelpful(jobFor(to.businessId), null));
    } catch (error) {
      if (error instanceof Refused) throw error;
      end = { line: error instanceof Error ? error.message : String(error), warned: false };
    } finally {
      await setState({ working: false, tabId: tab.tabId });
    }
    // Up, or it couldn't go: done for today. None written yet: it looks again in a while.
    const settled = end.posted === true || end.failed === true;
    await setState({ helpfulUp: settled, helpfulAt: Date.now() + HELPFUL_AGAIN_MS });
    if (end.warned) {
      await closeWindow();
      await say(end.line, { stopped: 'warning' });
      return goAt(tomorrow());
    }
    if (settled) {
      await say(`Helpful post: ${end.line}`);
      void feed(end.posted ? 'done' : 'passed', `Helpful post: ${end.line}`);
      return goAt(
        Date.now() + gapAfter({ now: Date.now(), until: null, left: 0, started: true, random }),
      );
    }
  }

  // In the working hours, every hour or two, the newest posts at the top of the best groups (decision 49).
  if (settings.watchPosts && inHours && watchDue(state, at)) {
    const end = await inTurn('runner', () => watch(to.businessId));
    if (end.warned) {
      await closeWindow();
      await say(end.line, { stopped: 'warning' });
      return goAt(tomorrow());
    }
    await say(`Newest posts: ${end.line}`);
    void feed('job', `Newest posts: ${end.line}`);
    if ((await stateNow()).stopped) {
      await closeWindow();
      return goAt(tomorrow());
    }
    return goAt(
      Date.now() + gapAfter({ now: Date.now(), until: null, left: 0, started: true, random }),
    );
  }

  const list: TodayList = await call(
    api().POST('/v1/queries/outreach.today', { body: { workspaceId: to.businessId } }),
    to.businessId,
  );
  const left = workLeft(list, state.tried);
  const work = left[0];
  commentsLeft = Math.max(0, list.limits.comment.most - list.limits.comment.done);
  if (!work) {
    await closeWindow();
    await say(
      state.tried.length
        ? 'Done for today. It looks again later for new requests to confirm.'
        : 'Nothing on your list for it to do yet.',
    );
    // In the hours, it looks again within the hour, or when the newest posts are due, whichever is first.
    const watchAt = settings.watchPosts ? ((await stateNow()).watchAt ?? null) : null;
    return goAt(
      inHours
        ? Math.min(at + IDLE_MS, window!.to, ...(watchAt !== null ? [Math.max(watchAt, at)] : []))
        : tomorrow(),
    );
  }

  const { item } = work;
  await say(doing(work), { working: true });
  let outcome: Outcome;
  try {
    // A few texts unless they said otherwise; one HandsFreeOS from before the voice says nothing of it.
    outcome = await inTurn('runner', () =>
      doWork(work, to.businessId, settings.voice?.split ?? true),
    );
  } catch (error) {
    // The page went somewhere else, or the window was closed: passed over for today, not tried again and again.
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
      platform: facebook.platform,
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
  // One the person can do themselves goes to their Waiting for you; done another day, or by them, it clears.
  const need =
    'need' in outcome && work.do === 'step' ? needOf(item, outcome.line, to.businessId) : null;
  if (need) void noteNeed(need);
  // The feed of today's steps in HandsFreeOS. A stop on a warning isn't one: HandsFreeOS writes that line itself.
  void feed(outcome.done ? 'done' : 'passed', outcome.line);
  // Stop for today, pressed while that step went.
  if (state.stopped) {
    await closeWindow();
    return goAt(tomorrow());
  }
  const gap = gapAfter({
    now: Date.now(),
    until: inHours ? window!.to : null,
    left: left.length - 1,
    started: state.started,
    random: Math.random(),
  });
  if (gap > KEEP_WINDOW_MS) await closeWindow();
  await goAt(Date.now() + gap);
}

/** The alarm went off, or something changed: one go, never two at once. */
export async function tick(): Promise<void> {
  if (busy) return;
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
    console.error('HandsFreeOS Social couldn’t work on its own', error);
    await setState({ working: false }).catch(() => undefined);
    await say(`Stopped for now: ${words} It tries again in a few minutes.`, { needs: true }).catch(
      () => undefined,
    );
    await goAt(Date.now() + AGAIN_MS).catch(() => undefined);
  } finally {
    busy = false;
    // The day stopped, or another computer took over, while that go went: it looks again now, and stops or stands
    // by, rather than at the next step's time.
    if (haltAgain) {
      haltAgain = false;
      void tick();
    }
  }
}

// A beat's answer that moves the day, or which computer works, has it look again. One that ends what it's doing
// (stopped in the app or in the panel, or another computer works now) ends a once-a-day job under way at its next page, and has it
// look again as soon as the step under way is done.
onWake((halt) => {
  if (halt) stopAsked = true;
  if (!busy) return void tick();
  if (halt) haltAgain = true;
});

/** Makes sure it's going: when the background starts, there's an alarm unless it has stopped for good. */
export async function wake(): Promise<void> {
  const alarm = await chrome.alarms.get(AUTO_ALARM);
  if (!alarm) await tick();
}

// ------------------------------------------------------------------------------------------------- the panel

/** How many of the day's steps the panel lists under Done today. */
const DONE_SHOWN = 4;

/**
 * Today in HandsFreeOS (its live answer): each step against its daily limit, for Next up, and the newest steps, for
 * Done today. Null when HandsFreeOS can't say.
 */
async function todayOf(businessId: string): Promise<TodaySoFar | null> {
  try {
    const live = await call(
      api().POST('/v1/queries/outreach.live', { body: { workspaceId: businessId } }),
      businessId,
    );
    return {
      limits: live.limits,
      steps: live.steps.slice(0, DONE_SHOWN).map((s) => ({ at: s.at, line: s.line, kind: s.kind })),
    };
  } catch {
    return null;
  }
}

/** Get ready (decision 63): what's left before the extension reaches anyone for the person. Null when HandsFreeOS can't say. */
async function readyOf(businessId: string): Promise<ReadyShown | null> {
  try {
    const got = await call(
      api().POST('/v1/queries/outreach.readiness', { body: { workspaceId: businessId } }),
      businessId,
    );
    return {
      ready: got.ready,
      items: got.items.map((i) => ({ item: i.item, state: i.state, left: i.left })),
    };
  } catch {
    return null;
  }
}

/**
 * The warning when the person's own steps today go past a daily limit: the limits count, they don't stop, so the
 * panel says so where the steps happen. Null within them, or when HandsFreeOS can't say.
 */
function pastLimitOf(today: TodaySoFar | null): string | null {
  if (!today) return null;
  const counts = (pick: 'done' | 'most') =>
    Object.fromEntries(DAILY_STEPS.map((step) => [step, today.limits[step][pick]])) as Record<
      DailyStep,
      number
    >;
  return pastLimitWords(counts('done'), counts('most'));
}

async function status(): Promise<AutoStatus> {
  const noting = await isNoting();
  const to = await savingTo();
  const state = await stateNow();
  const webUrl = config.webUrl;
  const warned = (await warnedNow())?.words ?? null;
  const none = {
    automation: null,
    trouble: null,
    live: null,
    pastLimit: null,
    today: null,
    warned,
    noting,
    state,
    webUrl,
  };
  if (!to) return { ...none, businessId: null };
  const kept = await keptFor(to);
  const live = kept ? { working: kept.working, workingName: kept.workingName } : null;
  const today = todayOf(to.businessId);
  const ready = readyOf(to.businessId);
  try {
    const automation = await automationOf(to.businessId);
    const day = await today;
    return {
      ...none,
      automation,
      businessId: to.businessId,
      live,
      pastLimit: pastLimitOf(day),
      today: day,
      ready: await ready,
    };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return {
      ...none,
      trouble: error.problem.message,
      businessId: to.businessId,
      live,
      pastLimit: pastLimitOf(await today),
      today: await today,
    };
  }
}

/** The panel's asks about working on its own. Never throws: what went wrong comes back as a problem. */
export function answerAuto(
  ask: Extract<HfosAsk, { readonly type: 'hfos-auto' | 'hfos-auto-start' | 'hfos-auto-stop' }>,
): Promise<HfosAnswer<unknown>> {
  return answerWith(ask.type, async () => {
    switch (ask.type) {
      // Kept in HandsFreeOS, with this computer's id, which makes it the one that works. A start refused there (a
      // warning today, or nothing to do on its own) changes nothing here and the panel says why; a stop stops here
      // whatever HandsFreeOS says. With no connection, it waits to be sent and the day goes as pressed here meanwhile.
      case 'hfos-auto-start': {
        const pressed = await pressDay('start');
        if (pressed.kind === 'refused') throw new Refused(pressed.problem);
        stopAsked = false;
        await setState({ started: true, stopped: null });
        void tick();
        break;
      }
      case 'hfos-auto-stop': {
        await pressDay('stop');
        stopAsked = true;
        const { stopped } = await stateNow();
        await setState({ started: false, stopped: stopped === 'warning' ? 'warning' : 'person' });
        await say('Stopped for today. It starts again in your next working hours.');
        void tick();
        break;
      }
    }
    return status();
  });
}

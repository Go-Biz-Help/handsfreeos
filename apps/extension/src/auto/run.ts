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
 * stand, presses the button (../facebook/auto.ts), checks it worked, and notes it in HandsFreeOS as the extension's
 * own (`auto`), which takes it off the list and counts it against the daily limits: the list only ever holds what
 * today's limits have room for. It stops for the day on any warning from Facebook, and when the person presses
 * **Stop for today**. It works only while someone is signed in with somewhere to save and noting is on, and only while
 * Chrome is open.
 *
 * Once a day, at the start of the working day or after Start my day, it first does the jobs that fill that list
 * (./daily.ts, decision 32): it checks their friend requests, saves their groups' members, finds posts and reads their
 * chats, one job a go, a few minutes apart.
 *
 * It tells HandsFreeOS what it's doing and each step it takes (../hfos/live.ts, decision 41), and follows the day
 * HandsFreeOS keeps: Start my day and Stop for today pressed in the app, on the phone or here. Only the person's most
 * recently used computer works; on any other it stands by and says why.
 */
import { businessDay, workWindow, type MessageKind } from '@hfos/core/addons/outreach/automation';
import { standDownWords } from '@hfos/core/addons/outreach/live';
import { LOOKUP_LINES } from '@hfos/core/addons/outreach/today';
import { AUTO_PLANS, MESSAGE_PATH, sameRef, type AutoJob } from '../facebook/auto';
import { line as lookupLine, linesOf, POSTS_READ } from '../facebook/lookup';
import type { FetchStep } from '../facebook/fetch';
import { FRIENDSHIP_WORDS } from '../facebook/tidy';
import type { ProfileRef, ReadResult, ThreadRef } from '../facebook/types';
import type { Hfos, Job, JobEnd } from '../jobs/job';
import { sameName } from '../facebook/people';
import { FACEBOOK, profileFromUrl } from '../facebook/urls';
import type {
  AutoStatus,
  Drafts,
  HfosAnswer,
  HfosAsk,
  TodayList,
  TodayListItem,
} from '../hfos/messages';
import { config } from '../hfos/config';
import { follow, loadSettings } from '../hfos/follow';
import { beatSoon, dayChange, feed, liveNow, onWake, pressDay, pressWaiting } from '../hfos/live';
import { isNoting, takeNote } from '../hfos/noting';
import { answer, answerWith, api, call, Refused, savingTo } from '../hfos/session';
import { keepWarning, warnedNow, warningInput } from '../hfos/warned';
import { WorkTab } from '../tab';
import { DAILY_DOING, DAILY_NAMES, runDaily } from './daily';
import {
  AUTO_STATE_KEY,
  freshState,
  gapAfter,
  IDLE_MS,
  isState,
  nextDaily,
  nextStart,
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

const tab = new WorkTab('window');
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

/** What a step came to: done, or passed over and why; or a reason to stop for the day. */
type Outcome =
  | { readonly done: true; readonly line: string }
  | { readonly done: false; readonly line: string }
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
 * Whether the profile on the page is the one on the list: by number, or by username, when both have one; else by
 * name, as someone saved by number from a group may open at their username.
 */
function samePerson(shown: ProfileRef, shownName: string | null, want: ProfileRef, name: string) {
  if ((shown.id && want.id) || (shown.username && want.username)) return sameRef(shown, want);
  return shownName !== null && sameName(shownName, name);
}

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
    return { outcome: { done: false, line: `${item.name}: Facebook showed a different page` } };
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
  if (!(await pressPath(plan.path)))
    return { done: false, line: `${item.name}: couldn’t find “${plan.path[0]!.words[0]}”` };
  await sure(plan.then);
  await pause(SETTLE_MS);
  const page = await read();
  const stop = await warnedOn(page, businessId);
  if (stop) return { stop };
  if (page.profile?.friendship !== plan.after)
    return { done: false, line: `${item.name}: Facebook didn’t take it` };
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

/** Likes their latest post, a day before their friend request (decision 33); with none, the request goes without. */
async function warmUp(item: TodayListItem, businessId: string): Promise<Outcome> {
  const opened = await openProfile(item, businessId);
  if ('outcome' in opened) return opened.outcome;
  const liked = await tab.ask({ type: 'hfos-like-latest', profile: opened.profile });
  if (!liked.ok) throw new Error(liked.error);
  if (liked.result === 'none') {
    await call(
      api().POST('/v1/commands/outreach.warm_up.missed', {
        body: { workspaceId: businessId, profileId: item.profileId! },
      }),
      businessId,
    );
    return {
      done: false,
      line: `No post of ${item.name}’s to like: their friend request goes without`,
    };
  }
  await pause(SETTLE_MS);
  const stop = await warnedOn(await read(), businessId);
  if (stop) return { stop };
  await takeNote({
    type: 'hfos-noted',
    step: {
      kind: 'like',
      to: { name: opened.page.profile!.name ?? item.name, profile: opened.noted },
      group: null,
      postUrl: liked.postUrl ?? null,
      thread: null,
      replying: null,
      auto: true,
    },
    at: now(),
  });
  return {
    done: true,
    line:
      liked.result === 'already'
        ? `${item.name}’s post was liked already: their friend request comes tomorrow`
        : `Liked a post of ${item.name}’s: their friend request comes tomorrow`,
  };
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
    return { done: false, line: `${item.name}’s post: couldn’t find the box to comment in` };
  if (wrote.result !== 'done')
    return { done: false, line: `${item.name}’s post: Facebook didn’t take the comment` };
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
    lines.push(
      `Their business page: ${lookupLine(business.name)}`,
      ...linesOf(page, business.name, 1),
    );
  }
  return { lines: [...new Set(lines.filter(Boolean))].slice(0, LOOKUP_LINES) };
}

/**
 * Drafts a message to someone on the list with the AI, after looking them up, and hands it to HandsFreeOS: it waits
 * for the person's OK, or goes as it is.
 */
async function draftMessage(item: TodayListItem, businessId: string): Promise<Outcome> {
  const looked = await lookUpIn(item, businessId);
  if ('stop' in looked) return looked;
  const kind = item.kind as MessageKind;
  const drafted = await answer({
    type: 'hfos-draft',
    workspaceId: businessId,
    input: { kind, profileId: item.profileId, chatId: item.chatId, lookup: looked.lines },
  });
  if (!drafted.ok) return { done: false, line: `${item.name}: ${drafted.problem.message}` };
  const { drafts, opener, simple } = drafted.value as Drafts;
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

/** Opens the chat with them: theirs in Messenger when it's known, else their profile's Message. */
async function openChat(
  item: TodayListItem,
  businessId: string,
): Promise<
  | { readonly profile: ProfileRef; readonly thread: ThreadRef | null }
  | { readonly outcome: Outcome }
> {
  const want = profileOf(item.profileUrl);
  if (item.threadKey) {
    await tab.open(`${FACEBOOK}/messages/t/${encodeURIComponent(item.threadKey)}/`);
    await setState({ tabId: tab.tabId });
    const page = await read();
    const stop = await warnedOn(page, businessId);
    if (stop) return { outcome: { stop } };
    const chat = page.chat;
    const them =
      chat?.profile && want
        ? samePerson(chat.profile, chat.name, want, item.name)
        : chat?.name != null && sameName(chat.name, item.name);
    const profile = want ?? chat?.profile ?? null;
    if (!chat || !them || !profile)
      return { outcome: { done: false, line: `${item.name}: Messenger showed a different chat` } };
    return { profile, thread: chat.thread };
  }
  const opened = await openProfile(item, businessId);
  if ('outcome' in opened) return opened;
  if (!(await pressPath(MESSAGE_PATH)))
    return {
      outcome: { done: false, line: `${item.name}: couldn’t find “Message” on their profile` },
    };
  await pause(SETTLE_MS);
  return { profile: opened.noted, thread: null };
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

/** Sends a message OK'd (or let go as it is) in Messenger, and notes it as its own. */
async function sendMessage(item: TodayListItem, businessId: string): Promise<Outcome> {
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
  if ('outcome' in chat) return 'stop' in chat.outcome ? chat.outcome : failed(chat.outcome.line);
  const wrote = await tab.ask({ type: 'hfos-message', text: send.text });
  if (!wrote.ok) return failed(`${item.name}: ${wrote.error}`);
  if (wrote.result === 'none') return failed(`${item.name}: couldn’t find the box to write in`);
  if (wrote.result !== 'done') return failed(`${item.name}: Facebook didn’t take the message`);
  await takeNote({
    type: 'hfos-noted',
    step: {
      kind: 'message',
      to: { name: item.name, profile: chat.profile },
      group: null,
      postUrl: null,
      thread: chat.thread,
      replying: item.kind === 'reply',
      auto: true,
    },
    at: now(),
  });
  await sendDone(send.sendId, businessId, true, null);
  await pause(SETTLE_MS);
  const stop = await warnedOn(await read(), businessId);
  if (stop) return { stop };
  return { done: true, line: `Sent ${item.name} a message` };
}

function doItem(item: TodayListItem, businessId: string): Promise<Outcome> {
  switch (item.kind) {
    case 'confirm':
      return onProfile(item, 'confirm', businessId);
    case 'friend_request':
      return onProfile(item, 'friend_request', businessId);
    case 'warm_up':
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

const doing = (work: Work) =>
  work.do === 'step'
    ? `${DOING[work.item.kind as AutoKind]} ${work.item.name}…`
    : work.do === 'draft'
      ? `Writing a message to ${work.item.name}…`
      : `Sending ${work.item.name} a message…`;

/** What a piece of work counts as, done. */
const doneAs = (work: Work): DoneKind =>
  work.do === 'step' ? (work.item.kind as AutoKind) : work.do === 'draft' ? 'drafted' : 'sent';

function doWork(work: Work, businessId: string): Promise<Outcome> {
  if (work.do === 'draft') return draftMessage(work.item, businessId);
  if (work.do === 'send') return sendMessage(work.item, businessId);
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
  await setState({ daily: { ...state.daily, [kind]: end.line } });
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

  const daily = settings.collect ? nextDaily(state) : null;
  if (daily) {
    const end = await collect(daily, to.businessId);
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

  const list: TodayList = await call(
    api().POST('/v1/queries/outreach.today', { body: { workspaceId: to.businessId } }),
    to.businessId,
  );
  const left = workLeft(list, state.tried);
  const work = left[0];
  if (!work) {
    await closeWindow();
    await say(
      state.tried.length
        ? 'Done for today. It looks again later for new requests to confirm.'
        : 'Nothing on your list for it to do yet.',
    );
    return goAt(inHours ? Math.min(at + IDLE_MS, window!.to) : tomorrow());
  }

  const { item } = work;
  await say(doing(work), { working: true });
  let outcome: Outcome;
  try {
    outcome = await doWork(work, to.businessId);
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
// (stopped in the app, or another computer works now) ends a once-a-day job under way at its next page, and has it
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

async function status(): Promise<AutoStatus> {
  const noting = await isNoting();
  const to = await savingTo();
  const state = await stateNow();
  const webUrl = config.webUrl;
  if (!to) return { automation: null, trouble: null, businessId: null, noting, state, webUrl };
  try {
    return {
      automation: await automationOf(to.businessId),
      trouble: null,
      businessId: to.businessId,
      noting,
      state,
      webUrl,
    };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return {
      automation: null,
      trouble: error.problem.message,
      businessId: to.businessId,
      noting,
      state,
      webUrl,
    };
  }
}

/** The panel's asks about working on its own. Never throws: what went wrong comes back as a problem. */
export function answerAuto(
  ask: Extract<
    HfosAsk,
    {
      readonly type:
        'hfos-auto' | 'hfos-auto-start' | 'hfos-auto-stop' | 'hfos-send-ok' | 'hfos-send-skip';
    }
  >,
): Promise<HfosAnswer<unknown>> {
  return answerWith(ask.type, async () => {
    switch (ask.type) {
      // A message OK'd goes next: the runner looks now.
      case 'hfos-send-ok': {
        const ok = await call(
          api().POST('/v1/commands/outreach.send.approve', { body: ask.input }),
          ask.input.workspaceId,
        );
        void tick();
        return ok;
      }
      case 'hfos-send-skip':
        return call(
          api().POST('/v1/commands/outreach.send.skip', { body: ask.input }),
          ask.input.workspaceId,
        );
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

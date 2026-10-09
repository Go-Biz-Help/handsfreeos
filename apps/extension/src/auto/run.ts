/**
 * The extension on its own (docs/outreach.md, decisions 26 to 33), in the background worker: once the person picks
 * **Friend requests, likes and comments on their own** in the panel, it goes down their list for today
 * (packages/core/src/addons/outreach/today.ts) by itself, a step at a time: it confirms requests from people who fit
 * a playbook well, likes a post of someone's a day before their friend request, sends friend requests, and writes
 * comments on good posts with the AI's draft. Messages wait for the person.
 *
 * It goes in their working hours, in the business's time zone, at random times spread over the day, or straight away
 * at a person's pace once they press **Start my day** (./plan.ts). Each step wakes the background with an alarm, opens
 * the page in a window of its own beside the person's (../tab.ts), checks it's the right person and where things
 * stand, presses the button (../facebook/auto.ts), checks it worked, and notes it in HandsFreeOS as the extension's
 * own (`auto`), which takes it off the list and counts it against the daily limits: the list only ever holds what
 * today's limits have room for. It stops for the day on any warning from Facebook, and when the person presses
 * **Stop for today**. It works only while someone is signed in with somewhere to save and noting is on, and only while
 * Chrome is open.
 */
import { businessDay, workWindow } from '@hfos/core/addons/outreach/automation';
import { AUTO_PLANS, sameRef, type AutoJob } from '../facebook/auto';
import type { FetchStep } from '../facebook/fetch';
import { FRIENDSHIP_WORDS } from '../facebook/tidy';
import type { ProfileRef, ReadResult } from '../facebook/types';
import { sameName } from '../facebook/people';
import { profileFromUrl } from '../facebook/urls';
import type {
  AutomationSaveInput,
  AutoStatus,
  HfosAnswer,
  HfosAsk,
  TodayList,
  TodayListItem,
} from '../hfos/messages';
import { isNoting, takeNote } from '../hfos/noting';
import { answer, answerWith, api, call, Refused, savingTo } from '../hfos/session';
import { keepWarning, warnedNow, warningInput } from '../hfos/warned';
import { WorkTab } from '../tab';
import {
  AUTO_STATE_KEY,
  freshState,
  gapAfter,
  IDLE_MS,
  isState,
  itemKey,
  itemsLeft,
  nextStart,
  type AutoKind,
  type AutoState,
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

async function setState(change: Partial<AutoState>): Promise<AutoState> {
  const next = { ...(await stateNow()), ...change };
  await chrome.storage.local.set({ [AUTO_STATE_KEY]: next });
  return next;
}

const say = (line: string, more: Partial<AutoState> = {}) =>
  setState({ line, lineAt: Date.now(), ...more });

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

// ------------------------------------------------------------------------------------------------- the day

/** The person's choices and the business's time zone. */
function automationOf(businessId: string) {
  return call(
    api().POST('/v1/queries/outreach.automation', { body: { workspaceId: businessId } }),
    businessId,
  );
}

/** One go: works out where things stand, does the next step when it's time, and sets when to go next. */
async function go(): Promise<void> {
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
    state = freshState(day, state.tabId);
    await chrome.storage.local.set({ [AUTO_STATE_KEY]: state });
  }
  await tab.adopt(state.tabId);
  if (settings.sending === 'off') {
    await goAt(null);
    return closeWindow();
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
      'Turn on “Note what I do on Facebook” below: the extension works on its own only while it notes.',
    );
    return goAt(at + LOOK_AGAIN_MS);
  }
  const window = workWindow(settings.hours, timezone, at);
  const inHours = window !== null && at >= window.from && at < window.to;
  if (!state.started && !inHours) {
    await closeWindow();
    return goAt(tomorrow());
  }

  const list: TodayList = await call(
    api().POST('/v1/queries/outreach.today', { body: { workspaceId: to.businessId } }),
    to.businessId,
  );
  const left = itemsLeft(list.items, list.auto, state.tried);
  const item = left[0];
  if (!item) {
    await closeWindow();
    await say(
      state.tried.length
        ? 'Done for today. It looks again later for new requests to confirm.'
        : 'Nothing on your list for it to do yet.',
    );
    return goAt(inHours ? Math.min(at + IDLE_MS, window!.to) : tomorrow());
  }

  await say(`${DOING[item.kind as AutoKind]} ${item.name}…`, { working: true });
  let outcome: Outcome;
  try {
    outcome = await doItem(item, to.businessId);
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
  const kind = item.kind as AutoKind;
  const done =
    'done' in outcome && outcome.done
      ? { ...state.done, [kind]: (state.done[kind] ?? 0) + 1 }
      : state.done;
  await setState({ tried: [...state.tried, itemKey(item)], done });
  if ('stop' in outcome) {
    await closeWindow();
    await say(outcome.stop, { stopped: 'warning' });
    return goAt(tomorrow());
  }
  await say(outcome.line);
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
    await say(`Stopped for now: ${words} It tries again in a few minutes.`).catch(() => undefined);
    await goAt(Date.now() + AGAIN_MS).catch(() => undefined);
  } finally {
    busy = false;
  }
}

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
  if (!to) return { automation: null, trouble: null, businessId: null, noting, state };
  try {
    return {
      automation: await automationOf(to.businessId),
      trouble: null,
      businessId: to.businessId,
      noting,
      state,
    };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return {
      automation: null,
      trouble: error.problem.message,
      businessId: to.businessId,
      noting,
      state,
    };
  }
}

/** The panel's asks about working on its own. Never throws: what went wrong comes back as a problem. */
export function answerAuto(
  ask: Extract<
    HfosAsk,
    { readonly type: 'hfos-auto' | 'hfos-auto-save' | 'hfos-auto-start' | 'hfos-auto-stop' }
  >,
): Promise<HfosAnswer<unknown>> {
  return answerWith(ask.type, async () => {
    switch (ask.type) {
      case 'hfos-auto-save': {
        const input: AutomationSaveInput = ask.input;
        await call(
          api().POST('/v1/commands/outreach.automation.save', { body: input }),
          input.workspaceId,
        );
        if (input.settings.sending === 'off') await setState({ started: false });
        void tick();
        break;
      }
      case 'hfos-auto-start':
        await setState({ started: true, stopped: null });
        void tick();
        break;
      case 'hfos-auto-stop':
        await setState({ started: false, stopped: 'person' });
        await say('Stopped for today. It starts again in your next working hours.');
        void tick();
        break;
    }
    return status();
  });
}

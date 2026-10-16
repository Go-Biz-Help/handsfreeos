/**
 * LinkedIn's runner (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "LinkedIn, part by part", 5): the extension
 * on its own on LinkedIn, beside Facebook's runner (./run.ts) and never waiting on it. It has its own line (its own
 * turn with LinkedIn's asks, ./turns.ts), its own window, its own alarm and its own state (`hfos.auto.linkedin`).
 *
 * - **Only while LinkedIn's day is started.** LinkedIn's Start my day, pressed in HandsFreeOS or on the phone, which the
 *   beat brings (`days.linkedin`); Stop for today there ends what it's doing at its next page, and its asks' too. It
 *   works only while LinkedIn is on for the person and Chrome allows it, while noting is on, while this computer is the
 *   one that works, and while the person's LinkedIn Sending choice isn't Off.
 * - **Lists first** (decision 60): before LinkedIn's first day, its connections and the invitations either way are
 *   saved to their end, the old invitations to withdraw worked out and the connections checked once (./lists.ts);
 *   after that the invitations each morning and the connections weekly.
 * - **Once a day,** as the person's LinkedIn choices say (`collect`): the invitations, the connections checked for good
 *   fits (40 profiles a day: each is seen), their chats read for the AI, and posts found with LinkedIn's post search.
 * - **Then LinkedIn's list for today** (`outreach.today` with `platform: 'linkedin'`), the kinds it does on its own
 *   (`auto`): a look at their profile and a like on a post of theirs (warm-up), an invitation to connect without a
 *   note (Chris), a comment in the post's own box, and the messages: drafted after a look-up, and sent once OK'd, in
 *   LinkedIn messaging, typing only into that conversation's box. Invitations they sent you are left for them to
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
import { fallbackLikePick, LIKE_POSTS_READ, likedText } from '@hfos/core/addons/outreach/like-pick';
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
import { checkConnections, isThem } from '../jobs/linkedin/checks';
import { lookUpOnLinkedIn } from '../jobs/linkedin/lookup';
import { checkInvitations } from '../jobs/linkedin/people';
import { findPostsBySearch } from '../jobs/linkedin/posts';
import { LINKEDIN, readLinkedIn } from '../jobs/linkedin/read';
import { linkedin, type LinkedInRead } from '../networks';
import type { ProfileRef, ThreadRef } from '../networks/linkedin/types';
import { comparable, profileRefOf, sameMember } from '../networks/linkedin/urls';
import { isWorking, statesNow } from '../networks/on';
import { WorkTab } from '../tab';
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
  isState,
  LINKEDIN_STATE_KEY,
  needOf,
  workKey,
  workLeft,
  type AutoState,
  type DailyJob,
  type DoneKind,
  type Work,
} from './plan';
import { askInLine, inTurn } from './turns';
import { haltAsk } from '../asks/run';

const PLATFORM: Platform = 'linkedin';
const NAME = NETWORKS.linkedin.name;

export const LINKEDIN_ALARM = 'hfos-auto-linkedin';

/** The kinds it does on its own on LinkedIn, in order: invitations they sent are theirs to accept. */
export const LINKEDIN_AUTO: readonly TodayKind[] = ['warm_up', 'friend_request', 'comment'];
/** The once-a-day jobs on LinkedIn, in order. */
export const LINKEDIN_DAILY = [
  'requests',
  'checks',
  'chats',
  'posts',
] as const satisfies readonly DailyJob[];
type LinkedInDaily = (typeof LINKEDIN_DAILY)[number];

const DAILY_DOING: Readonly<Record<LinkedInDaily, string>> = {
  requests: 'Checking your invitations on LinkedIn…',
  checks: 'Checking your connections for good fits…',
  chats: 'Reading your LinkedIn chats for the AI…',
  posts: 'Finding posts with LinkedIn’s post search…',
};
const DAILY_NAMES: Readonly<Record<LinkedInDaily, string>> = {
  requests: 'Invitations',
  checks: 'Check my connections',
  chats: 'Read my chats',
  posts: 'Find posts',
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

/**
 * A look at their profile, and a like on a post of theirs, a day before the invitation: the first post of theirs that
 * nothing rules out (never one about grief, illness or trouble), not liked yet. One liked already counts.
 */
async function warmUp(item: TodayListItem, businessId: string): Promise<Outcome> {
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
    return missed(
      item,
      businessId,
      `No post of ${item.name}’s to like: the invitation goes without`,
    );
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
      `None of ${item.name}’s posts were right to like: the invitation goes without`,
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
      return missed(
        item,
        businessId,
        `Couldn’t like ${item.name}’s post: the invitation goes without`,
      );
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
        ? `${item.name}’s post was liked already: the invitation comes tomorrow`
        : `Looked at ${item.name}’s profile and liked a post of theirs: the invitation comes tomorrow`,
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

/** Writes the AI's comment under a good post LinkedIn's post search found, in the post's own box. */
async function comment(item: TodayListItem, businessId: string): Promise<Outcome> {
  const author = item.profileUrl ? profileRefOf(item.profileUrl) : null;
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
  const stop = await warnedOn(await read(), businessId);
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
      line: `${item.name}’s post: LinkedIn didn’t take the comment`,
      need: true,
    };
  await pause(SETTLE_MS);
  const after = await warnedOn(await read(), businessId);
  if (after) return { stop: after };
  await takeNote(
    {
      type: 'hfos-noted',
      step: {
        kind: 'comment',
        to: { name: item.name, profile: author },
        group: null,
        postUrl: item.postUrl,
        thread: null,
        replying: null,
        auto: true,
        postText: item.post,
        commentText: text,
      },
      at: now(),
    },
    PLATFORM,
  );
  return { done: true, line: `Commented on ${item.name}’s post` };
}

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

/** Opens the conversation with them: theirs in messaging when it's known, else their profile's Message. */
async function openChat(
  item: TodayListItem,
  businessId: string,
): Promise<
  | { readonly profile: ProfileRef; readonly thread: ThreadRef | null }
  | { readonly outcome: Outcome }
> {
  const want = item.profileUrl ? profileRefOf(item.profileUrl) : null;
  if (item.threadKey) {
    await tab.open(threadUrl(item.threadKey));
    await setState({ tabId: tab.tabId });
    const page = await read();
    const stop = await warnedOn(page, businessId);
    if (stop) return { outcome: { stop } };
    const chat = page.chat;
    // By the link to them when both say the same kind of thing; else by the name the conversation shows.
    const them =
      chat?.profile && want && comparable(chat.profile, want)
        ? sameMember(chat.profile, want)
        : chat?.name != null && chat.name.trim().toLowerCase() === item.name.trim().toLowerCase();
    const profile = want ?? chat?.profile ?? null;
    if (!chat || !them || !profile)
      return {
        outcome: { done: false, line: `${item.name}: LinkedIn showed a different conversation` },
      };
    return { profile, thread: chat.thread };
  }
  const opened = await openProfile(item, businessId);
  if ('outcome' in opened) return opened;
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
  if (item.kind === 'reply') {
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
  const parts = messageParts(send.text, split);
  let partly: string | null = null;
  for (const [i, part] of parts.entries()) {
    if (i > 0) await pause(partPauseMs(part, Math.random()));
    const wrote = await tab.ask({ type: 'hfos-message', text: part, profile: chat.profile });
    const why = !wrote.ok
      ? wrote.error
      : wrote.result === 'none'
        ? 'couldn’t find the box to write in'
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
        replying: item.kind === 'reply',
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
      return warmUp(work.item, businessId);
    case 'friend_request':
      return invite(work.item, businessId);
    default:
      return comment(work.item, businessId);
  }
}

const DOING: Readonly<Partial<Record<TodayKind, string>>> = {
  warm_up: 'Looking at the profile of',
  friend_request: 'Inviting',
  comment: 'Commenting on a post of',
};

const doing = (work: Work) =>
  work.do === 'step'
    ? `${DOING[work.item.kind] ?? 'Working on'} ${work.item.name}…`
    : work.do === 'draft'
      ? `Writing a message to ${work.item.name}…`
      : `Sending ${work.item.name} a message…`;

const doneAs = (work: Work): DoneKind =>
  work.do === 'step' ? (work.item.kind as DoneKind) : work.do === 'draft' ? 'drafted' : 'sent';

/** What's left on LinkedIn's list for it today: only the kinds it does there. */
export function linkedInWorkLeft(
  list: Pick<TodayList, 'items' | 'auto' | 'messages' | 'sending'>,
  tried: readonly string[],
): Work[] {
  return workLeft({ ...list, auto: list.auto.filter((k) => LINKEDIN_AUTO.includes(k)) }, tried);
}

// ------------------------------------------------------------------------------------------------- the once-a-day jobs

/** The once-a-day job to do next on LinkedIn: the first not done today. */
export const nextLinkedInDaily = (state: Pick<AutoState, 'daily'>): LinkedInDaily | null =>
  LINKEDIN_DAILY.find((job) => state.daily?.[job] === undefined) ?? null;

/** Does one of LinkedIn's once-a-day jobs. */
export async function runLinkedInDaily(kind: LinkedInDaily, job: Job): Promise<JobEnd> {
  switch (kind) {
    case 'requests':
      return checkInvitations(job);
    case 'checks':
      return checkConnections(job, CHECKS_PER_DAY);
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
    // The beat says when the day starts (`days.linkedin`), and wakes this.
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
  // What the person asked on LinkedIn goes first: this looks again in a couple of minutes.
  if (askInLine(PLATFORM)) {
    await say(ASK_FIRST_WORDS);
    return goAt(at + ASK_FIRST_MS);
  }
  const random = Math.random();
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
      return goAt(null);
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

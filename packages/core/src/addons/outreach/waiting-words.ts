/**
 * Waiting for you (docs/outreach.md, decisions 40 and 42): the words and rules the web, the phone, the worker and the
 * extension all show and follow, once. One list, the same everywhere, of five kinds:
 *
 * - **Your computer needs you**: something the person asked of their computer from HandsFreeOS (./asks.ts) handed
 *   them a step it can't find, or waits for their password on Facebook. It pushed at once.
 * - **Replies handed over to you**: a reply the extension drafted that waits because it needs the person, with
 *   Replies (b) or (c) (./sends.ts, `handedOver`). Each waits for an OK of its own, never Approve all.
 * - **Messages to OK**: every other message waiting for the person's OK, and comments on good posts where a network's
 *   comments wait at first (decision 92). Approve all OKs them, except one to someone who needs the person, or an
 *   answer to an Alignable post asking for what the business offers (`needsYou`), which waits for an OK of its own
 *   too (`oneByOne`).
 * - **Steps it needs you for**: a step the extension couldn't do there and then (a button or box it couldn't find, a
 *   different page, the network not taking it, a message that didn't go), handed to the person to do or let go. Each is
 *   marked with its network, in that network's words, and links to their page there (or the post, or the chat).
 * - **Friend requests to decide**: requests the person got in the last two weeks that Today doesn't have them confirm.
 *
 * How the phone hears of it is the person's `pushes` (./automation.ts): one bundled push at most every 2 hours in
 * their working hours (the default), or one for each; a reply handed over always pushes at once. The extension's
 * pop-ups follow the same rule on the computer, and its icon shows the number. Friend requests are never pushed:
 * Facebook tells people of those itself.
 *
 * Browser-safe and without zod of its own, and with nothing from ./sends.ts but its types, so the extension's pages
 * stay small: the schemas are in ./waiting.ts.
 */
import { inWorkingHours, nextInHours, underAPost, type WorkingHours } from './automation';
import type { FitLevel } from './fit';
import { networkOfLink, NETWORKS, PLATFORMS, withArticle, type Platform } from './networks';

export const WAITING_KINDS = {
  ask: 'Your computer needs you',
  reply: 'Replies handed over to you',
  message: 'Messages to OK',
  need: 'Steps it needs you for',
  request: 'Friend requests to decide',
} as const;
export type WaitingKind = keyof typeof WAITING_KINDS;
/** The list's order. */
export const WAITING_KIND_KEYS = [
  'ask',
  'reply',
  'message',
  'need',
  'request',
] as const satisfies readonly WaitingKind[];
/**
 * What pushes and pop-ups tell of. Friend requests aren't: Facebook tells people of those itself. Nor is an ask that
 * needs the person (./asks.ts): it pushed at once on its own, and the computer it's on shows its own pop-up.
 */
export const NUDGE_KINDS = ['reply', 'message', 'need'] as const satisfies readonly WaitingKind[];
/**
 * What the bundled push tells of: messages and needs. A reply handed over pushed at once on its own (owner answer 15),
 * so it's never told again in a bundle, nor makes one go.
 */
export const BUNDLE_KINDS = ['message', 'need'] as const satisfies readonly WaitingKind[];

/** What the extension was doing: Today's kind for a step, or a message that didn't go. */
export const NEED_STEPS = ['confirm', 'friend_request', 'warm_up', 'comment', 'message'] as const;
export type NeedStep = (typeof NEED_STEPS)[number];
/** The steps the extension notes itself: a message that didn't go is HandsFreeOS's own (`outreach.send.done`). */
export const NOTED_NEED_STEPS = ['confirm', 'friend_request', 'warm_up', 'comment'] as const;
export const NEED_STATES = ['open', 'done', 'dismissed'] as const;
export type NeedState = (typeof NEED_STATES)[number];
/** How a person clears one: they did it, or let it go. */
export const NEED_CLEARS = { done: 'I did it', dismissed: 'Let it go' } as const;
export type NeedClear = keyof typeof NEED_CLEARS;

/** A need leaves the list a week after the extension last couldn't do it. */
export const NEED_SHOWN_DAYS = 7;
/** After Let it go, the same step for the same person isn't handed over again for a week. */
export const NEED_QUIET_DAYS = 7;
/**
 * An open need off the list (not seen for `NEED_SHOWN_DAYS`) this many days more goes (the worker's
 * `outreach.live_prune`): noted again after that, it's a new one, as it would be anyway.
 */
export const NEED_GONE_DAYS = 7;
/** Requests that came in the last two weeks. */
export const REQUEST_SHOWN_DAYS = 14;
/** Needs and requests listed (each counted in full); messages are listed up to `SENDS_MOST`. */
export const WAITING_SHOWN_MOST = 50;
/** Why a need couldn't be done, at most. */
export const NEED_WHY_MOST = 300;
/** The bundled push goes at most this often. */
export const BUNDLE_HOURS = 2;
/** It waits this long after the first new thing, to gather the rest into one. */
export const BUNDLE_GATHER_MINUTES = 10;
/** The extension's pop-ups at once with "one for each"; more go as one. */
export const EACH_POPUPS_MOST = 3;
/** The extension asks again this often with nothing heard on the live channel. */
export const WAITING_REFRESH_MINUTES = 10;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * A message that waits for an OK of its own: a reply handed over, or one to someone who needs the person, or a forum
 * answer.
 */
export const oneByOne = (send: {
  readonly handedOver: boolean;
  readonly needsYou: string | null;
}): boolean => send.handedOver || send.needsYou !== null;

/**
 * How many messages Approve all OKs, for its button: those listed that can go together, or, when more wait than are
 * listed, all the messages less those listed that wait on their own. Needs you on the web says it.
 */
export function approveAllCount(
  items: readonly {
    readonly kind: string;
    readonly send?: { readonly handedOver: boolean; readonly needsYou: string | null };
  }[],
  messages: number,
): number {
  const sends = items.filter((item) => item.kind === 'message' && item.send);
  const alone = sends.filter((item) => oneByOne(item.send!)).length;
  return Math.max(sends.length - alone, messages - alone);
}

/** Under a group cut short: "And 3 more: the oldest are listed first." Messages wait oldest first, the rest newest. */
export function moreWords(kind: WaitingKind, more: number): string {
  const first = kind === 'reply' || kind === 'message' ? 'oldest' : 'newest';
  return `And ${more.toLocaleString('en-US')} more: the ${first} are listed first.`;
}

/** What I did it or Let it go did: off the list, or still there when the extension couldn't do it again since. */
export function needClearedWords(how: NeedClear, state: NeedState): string {
  if (state === 'open')
    return 'The extension couldn’t do it again after you pressed, so it still waits for you.';
  return how === 'done'
    ? 'Done. It’s off your list.'
    : 'Let go. It won’t be handed to you for a week.';
}

/**
 * Retry, and Retry all, on a message or comment the extension couldn't send (decision 133): it goes again, OK'd as it
 * was, each a few minutes after the one before, so they never all go at once.
 */
export const NEED_RETRY = { one: 'Retry', all: 'Retry all' } as const;
/** The least and most minutes between one send tried again and the next: a person's pace, at random. */
export const RETRY_GAP_MINUTES = { least: 3, most: 7 } as const;

/** Whether a step handed to the person can be tried again: a message or comment that didn't go, with its words. */
export const needRetryable = (need: {
  readonly step: NeedStep;
  readonly sendId: string | null;
}): boolean => (need.step === 'message' || need.step === 'comment') && need.sendId !== null;

/** What Retry or Retry all did: how many go again, and how many couldn't, as one already waits or went since. */
export function retriedWords(retried: number, passed: number): string {
  const n = (count: number) => count.toLocaleString('en-US');
  const going =
    retried === 0
      ? 'Nothing to try again.'
      : retried === 1
        ? 'Trying it again: it goes next, when the extension is working.'
        : `Trying ${n(retried)} again, a few minutes apart, when the extension is working.`;
  if (!passed) return going;
  return `${going} ${n(passed)} ${passed === 1 ? 'wasn’t' : 'weren’t'} tried again: a newer message to them waits already, or it went since.`;
}

/** Why the extension couldn't do a step, as a need shows it: its own words, with a capital to start. */
export const needWhyWords = (why: string): string =>
  why ? `${why[0]!.toUpperCase()}${why.slice(1)}` : why;

/** A chat in Messenger, by the number in its link (`threadKey`): where to answer them. Null without one. */
export const messengerChatUrl = (threadKey: string | null): string | null =>
  threadKey ? `https://www.facebook.com/messages/t/${encodeURIComponent(threadKey)}` : null;

/**
 * What each network calls the steps that connect, either side of the person's name, where its kit's words don't say
 * it: saying yes to their ask on its own buttons (LinkedIn's Accept and Ignore), and asking to connect where "Send a
 * friend request" doesn't fit (a follow on Instagram).
 */
const NEED_CONNECT: Readonly<
  Record<
    Platform,
    { readonly confirm: readonly [string, string]; readonly request?: readonly [string, string] }
  >
> = {
  facebook: { confirm: ['Confirm or delete ', '’s friend request yourself'] },
  linkedin: { confirm: ['Accept or ignore ', '’s invitation to connect yourself'] },
  instagram: {
    confirm: ['Confirm or delete ', '’s follow request yourself'],
    request: ['Follow ', ' yourself'],
  },
  alignable: { confirm: ['Accept ', '’s connection request yourself'] },
};

/**
 * A step handed over, in its network's words, either side of the person's name, so a screen can put the name, the
 * person menu's button (decision 91), between the two parts: ["Send ", " a connection request yourself"] on Alignable.
 */
export function needTitleAround(step: NeedStep, platform: Platform): readonly [string, string] {
  switch (step) {
    case 'confirm':
      return NEED_CONNECT[platform].confirm;
    case 'friend_request':
      return (
        NEED_CONNECT[platform].request ?? [
          'Send ',
          ` ${withArticle(NETWORKS[platform].words.friendRequest)} yourself`,
        ]
      );
    case 'warm_up':
      return ['Like a post of ', '’s yourself'];
    case 'comment':
      return ['Comment on ', '’s post yourself'];
    case 'message':
      return ['Send ', ' the message yourself'];
  }
}

/**
 * "Confirm or delete Dana Reyes’s friend request yourself" on Facebook, "Send Dana Reyes an invitation to connect
 * yourself" on LinkedIn, "Follow Dana Reyes yourself" on Instagram: each network's own words.
 */
export function needTitle(step: NeedStep, name: string, platform: Platform): string {
  const [before, after] = needTitleAround(step, platform);
  return `${before}${name}${after}`;
}

/** A need's link, at most: as the database keeps it. */
const NEED_URL_MOST = 500;

/**
 * Where a step handed over opens (decision 42): the first address given that's on the person's own network (the
 * extension's, a comment's post, a message's chat), or else their page there, so every step links to where it's
 * done. Never an address on another network, which would open the wrong site. Null only with none on it.
 */
export function needUrlOf(
  platform: Platform,
  ...links: readonly (string | null | undefined)[]
): string | null {
  for (const link of links) {
    const url = link?.trim();
    if (url && url.length <= NEED_URL_MOST && networkOfLink(url) === platform) return url;
  }
  return null;
}

/**
 * A step handed over's address when it's their page, for the person menu's Open on {Network} (decision 91): never a
 * comment's or a like's post, nor a message's, which may be the chat. Null for those, and for an address on a network
 * the add-on doesn't know; the menu then takes their page from where they stand (`outreach.profile.marks`).
 */
export function needPageOf(need: {
  readonly url: string | null;
  readonly postId: string | null;
  readonly step: NeedStep;
}): string | null {
  if (need.postId !== null || need.step === 'message') return null;
  return need.url && networkOfLink(need.url) ? need.url : null;
}

/** Why a request that fits well is still the person's to decide, rather than Today's to confirm. */
export const REQUEST_HELD = {
  no_playbook: 'Fits, but the business has no playbook in use yet',
  dont_pitch: 'On Don’t pitch, or tagged Friend or family: yours to decide',
} as const;
export type RequestHeld = keyof typeof REQUEST_HELD;

/** Why a friend request is the person's to decide: how they fit, or that nothing does. */
export function requestWhy(
  reasons: readonly string[],
  level: FitLevel,
  held: RequestHeld | null = null,
): string[] {
  const why = [...reasons];
  if (held) why.push(REQUEST_HELD[held]);
  else if (level !== 'skip' && !reasons.length)
    why.push('Nothing on their profile fits a playbook');
  return why;
}

/** "Nothing waits for you." · "1 thing waits for you." · "5 things wait for you." */
export function waitingWords(count: number): string {
  if (count <= 0) return 'Nothing waits for you.';
  return count === 1
    ? '1 thing waits for you.'
    : `${count.toLocaleString('en-US')} things wait for you.`;
}

/** The extension's icon: nothing for none, the number up to 99, then "99+". */
export const badgeText = (count: number): string =>
  count <= 0 ? '' : count > 99 ? '99+' : String(Math.floor(count));

/** How many of each kind wait, and when the newest of each began to. */
export type WaitingKinds = Record<
  WaitingKind,
  { readonly count: number; readonly newestAt: string | null }
>;

export const NO_KINDS: WaitingKinds = {
  ask: { count: 0, newestAt: null },
  reply: { count: 0, newestAt: null },
  message: { count: 0, newestAt: null },
  need: { count: 0, newestAt: null },
  request: { count: 0, newestAt: null },
};

/** Everything waiting. */
export const waitingCount = (kinds: WaitingKinds): number =>
  kinds.ask.count +
  kinds.reply.count +
  kinds.message.count +
  kinds.need.count +
  kinds.request.count;

/** What the bundled push tells of: messages and needs, not replies handed over (they pushed on their own). */
export const nudgeCount = (kinds: WaitingKinds): number =>
  BUNDLE_KINDS.reduce((n, kind) => n + kinds[kind].count, 0);

/** When the newest message or need began to wait (reached HandsFreeOS): null with none. */
export function newestNudgeAt(kinds: WaitingKinds): number | null {
  const times = BUNDLE_KINDS.map((kind) => kinds[kind].newestAt)
    .filter((at): at is string => at !== null)
    .map((at) => Date.parse(at));
  return times.length ? Math.max(...times) : null;
}

export interface BundleTiming {
  readonly now: number;
  /** When the person last got the bundled push. */
  readonly lastAt: number | null;
  readonly hours: WorkingHours;
  readonly timeZone: string;
}

/**
 * When the bundled push about something new should go: 10 minutes on, to gather the rest, and no sooner than 2 hours
 * after the last one; moved to the start of the person's next working hours when that falls outside them.
 */
export function bundleAt({ now, lastAt, hours, timeZone }: BundleTiming): number {
  const at = Math.max(
    now + BUNDLE_GATHER_MINUTES * MINUTE,
    lastAt === null ? -Infinity : lastAt + BUNDLE_HOURS * HOUR,
  );
  return nextInHours(hours, timeZone, at) ?? at;
}

/** Whether the bundled push may go now: in working hours, and 2 hours or more after the last one. */
export const bundleDue = ({ now, lastAt, hours, timeZone }: BundleTiming): boolean =>
  inWorkingHours(hours, timeZone, now) && (lastAt === null || now - lastAt >= BUNDLE_HOURS * HOUR);

const things = (n: number, one: string, many: string) =>
  n === 1 ? `1 ${one}` : `${n.toLocaleString('en-US')} ${many}`;

/**
 * The bundled push, in the owner's words, messages first: "5 messages wait for your OK"; null with nothing to tell.
 * Replies handed over aren't in it, since each pushed at once on its own, unless `withReplies` (the extension's first
 * look after a sign-in, which tells of all that was there).
 */
export function bundlePushWords(
  kinds: WaitingKinds,
  withReplies = false,
): { title: string; body: string } | null {
  const messages = kinds.message.count + (withReplies ? kinds.reply.count : 0);
  const needs = kinds.need.count;
  if (messages)
    return {
      title: `${things(messages, 'message waits', 'messages wait')} for your OK`,
      body: needs
        ? `And ${things(needs, 'step', 'steps')} the extension couldn’t do. Open Today.`
        : `Open Today to OK, change or skip ${messages === 1 ? 'it' : 'them'}.`,
    };
  if (needs)
    return {
      title: needs === 1 ? '1 step needs you' : `${needs.toLocaleString('en-US')} steps need you`,
      body:
        needs === 1
          ? 'The extension couldn’t do it. Do it yourself, or let it go, on Today.'
          : 'The extension couldn’t do them. Do them yourself, or let them go, on Today.',
    };
  return null;
}

/** A line as a sentence: its first letter capital, no stop at the end. */
const sentence = (line: string) => {
  const t = line.trim().replace(/[.!\s]+$/, '');
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}` : t;
};

/**
 * A push for one message, comment or need, with "one for each": "Dana Reyes: a message waits for your OK", "A comment
 * on Quinn Harper’s post waits for your OK". A need's says its network when it's known: "Dana Reyes: the extension
 * needs you on Alignable".
 */
export function eachPushWords(
  kind: 'message' | 'comment' | 'need',
  name: string,
  why: string | null = null,
  platform: Platform | null = null,
): { title: string; body: string } {
  if (kind === 'message')
    return {
      title: `${name}: a message waits for your OK`,
      body: 'OK it, change it or skip it on Today.',
    };
  if (kind === 'comment')
    return {
      title: `A comment on ${name}’s post waits for your OK`,
      body: 'OK it, change it or skip it on Today.',
    };
  const said = why ? sentence(why) : '';
  return {
    title: `${name}: the extension needs you${platform ? ` on ${PLATFORMS[platform]}` : ''}`,
    body: `${said ? `${said}. ` : ''}Do it yourself, or let it go, on Today.`,
  };
}

/** The push, and the extension's pop-up, for a reply handed over: "Dana Reyes needs you". */
export function handOverPushWords(
  name: string,
  why: string | null,
): { title: string; body: string } {
  return {
    title: `${name} needs you`,
    body: `Their reply waits for your OK on Today${why ? `: ${why}` : ': it isn’t a simple one'}.`,
  };
}

/**
 * Approve all's button: "Approve all 5 messages", or with comments among them (decision 92) "Approve all 5", since
 * they go together.
 */
export const approveAllWords = (count: number, comments = false) =>
  comments
    ? `Approve all ${count.toLocaleString('en-US')}`
    : `Approve all ${count.toLocaleString('en-US')} ${count === 1 ? 'message' : 'messages'}`;

/** Messages to OK's heading: "Messages and comments to OK" while a comment waits among them (decision 92). */
export const messagesTitle = (comments: boolean): string =>
  comments ? 'Messages and comments to OK' : WAITING_KINDS.message;

/**
 * A comment waiting's heading either side of the person's name, so a screen can put the name, the person menu's
 * button (decision 91), between the two parts.
 */
export const COMMENT_TITLE_AROUND = ['Comment on ', '’s post'] as const;
/** A reply in a group waiting's (decision 114), as `COMMENT_TITLE_AROUND`: "Answer Dana Reyes’s question". */
export const GROUP_REPLY_TITLE_AROUND = ['Answer ', '’s question'] as const;

/** The heading either side of the name for what goes under a post: a comment, or a reply in a group. */
export const postTitleAround = (kind: string) =>
  kind === 'group_reply' ? GROUP_REPLY_TITLE_AROUND : COMMENT_TITLE_AROUND;

/**
 * A comment waiting, as Waiting for you heads it, its post's first words above the comment: "Comment on Dana Reyes’s
 * post"; a reply in a group, "Answer Dana Reyes’s question".
 */
export const commentTitle = (name: string, kind = 'comment'): string => {
  const [before, after] = postTitleAround(kind);
  return `${before}${name}${after}`;
};

/**
 * Whether a send waiting is an answer to an Alignable post asking for what the business offers (decision 79): a
 * comment that waits for an OK of its own (`needsYou`, set for nothing else on a comment), which Approve all leaves.
 */
export const forumAnswer = (send: {
  readonly kind: string;
  readonly needsYou: string | null;
}): boolean => send.kind === 'comment' && send.needsYou !== null;

/**
 * Whether Approve all takes a comment among the messages waiting (decision 92), or a reply in a group (decision 114):
 * one that doesn't wait for an OK of its own (`oneByOne`, so never a forum answer). Its button and what it says after are "messages and comments" only then.
 * Today, Waiting for you and the phone all ask it.
 */
export const approveAllTakesComments = (
  sends: readonly {
    readonly kind: string;
    readonly handedOver: boolean;
    readonly needsYou: string | null;
  }[],
): boolean => sends.some((send) => underAPost(send.kind) && !oneByOne(send));

/**
 * Whether Messages to OK says what the comments-only hold is (decision 92's 13): while a comment Approve all takes
 * waits on a network whose hold HandsFreeOS says is on (`outreach.waiting`'s `commentHolds`). Each comment's own
 * network decides, never the training wheels Waiting for you shows; from a server before it said, never.
 */
export function commentHoldShown(
  sends: readonly {
    readonly kind: string;
    readonly handedOver: boolean;
    readonly needsYou: string | null;
    readonly profileUrl: string | null;
  }[],
  holds: readonly Platform[] | undefined,
): boolean {
  if (!holds?.length) return false;
  return sends.some((send) => {
    if (!underAPost(send.kind) || oneByOne(send) || !send.profileUrl) return false;
    const on = networkOfLink(send.profileUrl);
    return on !== null && holds.includes(on);
  });
}

/** Beside Approve all while forum answers wait among the messages: why it leaves them (decision 92). */
export const forumAnswersLeftWords = (count: number): string =>
  `Approve all leaves ${
    count === 1 ? 'the forum answer' : `the ${count.toLocaleString('en-US')} forum answers`
  }: an answer to a post asking for what you offer always waits for an OK of its own.`;

/** Why a message waits for an OK of its own, under it: "Handed over: they sound upset". */
export function oneByOneWords(send: {
  readonly handedOver: boolean;
  readonly needsYou: string | null;
}): string | null {
  if (send.handedOver)
    return `Handed over to you${send.needsYou ? `: ${send.needsYou}` : ': it isn’t a simple one'}.`;
  return send.needsYou ? `It waits for you on its own: ${send.needsYou}.` : null;
}

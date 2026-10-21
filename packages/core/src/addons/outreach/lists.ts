/**
 * The person's own lists, saved before their day (docs/outreach.md, "Lists first"): their friends, the friend requests
 * they've got, the ones they've sent, and their groups. The owner's decision (settled): **first day only**. The first
 * time, Start my day waits until all four are saved to their end. After that, the requests are saved again each
 * morning before the day starts, and the friends list and the groups once a week. Right after the first full save,
 * the groups are checked (decision 48), the Tidy up suggestions are worked out (decisions 10, 12 and 17), then the
 * good fits among friends are checked once (decision 46); from then on the group checks and the friend checks run
 * daily with their caps. While it gets ready, the web, the phone and the extension show each step as a live
 * checklist (`preDaySteps`).
 *
 * HandsFreeOS keeps when each was last saved to its end, each person's own (`outreach.lists`, `outreach.lists.saved`);
 * the extension does the saving (apps/extension/src/auto/lists.ts). Browser-safe: the extension, the web and the
 * phone read these.
 *
 * Each network has its own lists and its own first day (Chris: each network on its own). LinkedIn's are the person's
 * connections and their invitations either way, then the old invitations to withdraw and the good fits among their
 * connections; it has no groups to save first (`LIST_SAVES_ON`, `LIST_MARKS_ON`). Alignable's (its runner, part 5) are
 * the person's connections and the connection requests they've got, then the good fits among their connections: no
 * reader of the requests they've sent is built, so there's nothing to work out for withdrawing. Instagram's (its runner,
 * part 14) are the person's followers, then who to unfollow (those who didn't follow back in the business's wait), then
 * the good fits among their followers.
 */
import { z } from 'zod';
import { businessDay } from './automation';
import { PLATFORM_KEYS, type Platform } from './networks';

/** The lists saved before the day, in the order they're saved: the person's groups last. */
export const LIST_SAVE_KEYS = ['friends', 'requests', 'sent', 'groups'] as const;
export type ListSave = (typeof LIST_SAVE_KEYS)[number];

/**
 * What's noted as done, in the order it's done before the first day: a list saved to its end, the first check of the
 * groups (decision 48), the Tidy up suggestions worked out, the first good-fits check.
 */
export const LIST_MARK_KEYS = [...LIST_SAVE_KEYS, 'group_checks', 'tidy', 'checks'] as const;
export type ListMark = (typeof LIST_MARK_KEYS)[number];

/** The lists each network saves before its first day, in order. */
export const LIST_SAVES_ON: Readonly<Record<Platform, readonly ListSave[]>> = {
  facebook: LIST_SAVE_KEYS,
  linkedin: ['friends', 'requests', 'sent'],
  // Its runner (part 14): the person's followers, its friends list; it reads no follow requests.
  instagram: ['friends'],
  alignable: ['friends', 'requests'],
};
/** What each network notes as done before its first day, in order. */
export const LIST_MARKS_ON: Readonly<Record<Platform, readonly ListMark[]>> = {
  facebook: LIST_MARK_KEYS,
  linkedin: ['friends', 'requests', 'sent', 'tidy', 'checks'],
  instagram: ['friends', 'tidy', 'checks'],
  alignable: ['friends', 'requests', 'checks'],
};

/** The friends list, and the groups, are saved again once their last full save is this old. */
export const FRIENDS_AGAIN_DAYS = 7;
/** Saved again weekly, like the friends list; the requests are saved again each morning. */
const WEEKLY: ReadonlySet<ListSave> = new Set(['friends', 'groups']);

const DAY = 86_400_000;
const moment = z.iso.datetime().nullable();

/** When each was last saved to its end, and when the first tidy-up and check were done: null for never. */
export const ListsSaved = z.object({
  friendsAt: moment,
  requestsAt: moment,
  sentAt: moment,
  /** Missing from an API from before groups were saved first: read as never. */
  groupsAt: moment.default(null),
  groupChecksAt: moment.default(null),
  tidyAt: moment,
  checksAt: moment,
});
export type ListsSaved = z.output<typeof ListsSaved>;

export const NO_LISTS: ListsSaved = {
  friendsAt: null,
  requestsAt: null,
  sentAt: null,
  groupsAt: null,
  groupChecksAt: null,
  tidyAt: null,
  checksAt: null,
};

export const ListsInput = z.object({
  workspaceId: z.uuid(),
  /** The network whose lists: Facebook's when left out. */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
});
export type ListsInput = z.input<typeof ListsInput>;
export const ListsOutput = ListsSaved;

export const ListSavedInput = z.object({
  workspaceId: z.uuid(),
  /** The network the list is on: Facebook's when left out. */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  /** What was done: a list saved to its very end, the tidy-up worked out, or the first check run. */
  list: z.enum(LIST_MARK_KEYS),
});
export type ListSavedInput = z.input<typeof ListSavedInput>;
export const ListSavedOutput = ListsSaved;

const AT_KEY: Readonly<Record<ListMark, keyof ListsSaved>> = {
  friends: 'friendsAt',
  requests: 'requestsAt',
  sent: 'sentAt',
  groups: 'groupsAt',
  group_checks: 'groupChecksAt',
  tidy: 'tidyAt',
  checks: 'checksAt',
};
export const atKey = (mark: ListMark): keyof ListsSaved => AT_KEY[mark];

/**
 * Whether the first full save is done on a network: on Facebook, friends, received and sent requests, and groups,
 * each saved once; on LinkedIn, connections and invitations either way.
 */
export const firstSaveDone = (lists: ListsSaved, platform: Platform = 'facebook'): boolean =>
  LIST_SAVES_ON[platform].every((list) => lists[AT_KEY[list]] !== null);

/**
 * The lists to save before the day, in order: any never saved; the requests, either way, unless saved already on the
 * business's day today; and the friends list and the groups once their last full save is FRIENDS_AGAIN_DAYS old.
 */
export function listsDue(
  lists: ListsSaved,
  now: number,
  timeZone: string,
  platform: Platform = 'facebook',
): ListSave[] {
  const today = businessDay(now, timeZone);
  return LIST_SAVES_ON[platform].filter((list) => {
    const at = lists[AT_KEY[list]];
    if (at === null) return true;
    const ms = new Date(at).getTime();
    return WEEKLY.has(list)
      ? now - ms >= FRIENDS_AGAIN_DAYS * DAY
      : businessDay(ms, timeZone) < today;
  });
}

/**
 * What's left once the first full save is done: check the groups, work out the Tidy up suggestions, then check
 * friends once; each only where the network does it (Alignable has nothing to tidy up first).
 */
export function afterFirstSave(
  lists: ListsSaved,
  platform: Platform = 'facebook',
): 'group_checks' | 'tidy' | 'checks' | null {
  if (!firstSaveDone(lists, platform)) return null;
  const marks = LIST_MARKS_ON[platform];
  if (marks.includes('group_checks') && lists.groupChecksAt === null) return 'group_checks';
  if (marks.includes('tidy') && lists.tidyAt === null) return 'tidy';
  if (marks.includes('checks') && lists.checksAt === null) return 'checks';
  return null;
}

/** What the extension says while it saves each, before the day. */
export const LIST_DOING: Readonly<Record<ListSave, string>> = {
  friends: 'Saving your friends list first…',
  requests: 'Saving your friend requests first…',
  sent: 'Saving the friend requests you’ve sent first…',
  groups: 'Saving your groups first…',
};

/** What each is called, in "Your friends list: Saved 412 friends." */
export const LIST_NAMES: Readonly<Record<ListSave, string>> = {
  friends: 'Your friends list',
  requests: 'Friend requests',
  sent: 'Sent requests',
  groups: 'Your groups',
};

/** Each network's lists as "It's saving … first" names them: one of them, or all of them at once. */
const WAIT_NAMES_ON: Readonly<
  Record<Platform, { readonly each: Readonly<Record<ListSave, string>>; readonly all: string }>
> = {
  facebook: {
    each: {
      friends: 'your friends list',
      requests: 'the friend requests you’ve got',
      sent: 'the ones you’ve sent',
      groups: 'your groups',
    },
    all: 'your friends list, friend requests and groups',
  },
  linkedin: {
    each: {
      friends: 'your connections',
      requests: 'the invitations you’ve got',
      sent: 'the ones you’ve sent',
      groups: 'your groups',
    },
    all: 'your connections and invitations',
  },
  instagram: {
    each: {
      friends: 'your followers',
      requests: 'the follow requests you’ve got',
      sent: 'the ones you’ve sent',
      groups: 'your groups',
    },
    all: 'your followers',
  },
  alignable: {
    each: {
      friends: 'your connections',
      requests: 'the connection requests you’ve got',
      sent: 'the ones you’ve sent',
      groups: 'your groups',
    },
    all: 'your connections and connection requests',
  },
};

/** "a, b and c". */
const listed = (words: readonly string[]): string =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;

/**
 * Why a network's day started isn't under way yet (Facebook's when left out), under Start my day: the first time,
 * until its lists are saved. Empty once they are, or when the day isn't started.
 */
export function listsWaitWords(
  lists: ListsSaved | null | undefined,
  started: boolean,
  platform: Platform = 'facebook',
): string {
  if (!started || !lists || firstSaveDone(lists, platform)) return '';
  const saves = LIST_SAVES_ON[platform];
  const names = WAIT_NAMES_ON[platform];
  const left = saves.filter((list) => lists[AT_KEY[list]] === null);
  const what =
    left.length === saves.length ? names.all : listed(left.map((list) => names.each[list]));
  return `It’s saving ${what} first, the first time only. Your day starts once they’re saved.`;
}

// ------------------------------------------------------------------------------------------------- the checklist

/** Each step before the first day, as the live checklist names it, in the order they're done. */
export const PRE_DAY_WORDS: Readonly<Record<ListMark, string>> = {
  friends: 'Save your friends list',
  requests: 'Save friend requests you got',
  sent: 'Save friend requests you sent',
  groups: 'Save your groups',
  group_checks: 'Check your groups',
  tidy: 'Work out who to unfriend',
  checks: 'Check your friends for good fits',
};

/** Each network's steps before its first day, in its own words. */
export const PRE_DAY_WORDS_ON: Readonly<Record<Platform, Readonly<Record<ListMark, string>>>> = {
  facebook: PRE_DAY_WORDS,
  linkedin: {
    ...PRE_DAY_WORDS,
    friends: 'Save your connections',
    requests: 'Save invitations you got',
    sent: 'Save invitations you sent',
    tidy: 'Work out which old invitations to withdraw',
    checks: 'Check your connections for good fits',
  },
  instagram: {
    ...PRE_DAY_WORDS,
    friends: 'Save your followers',
    requests: 'Save follow requests you got',
    sent: 'Save follow requests you sent',
    tidy: 'Work out who to unfollow',
    checks: 'Check your followers for good fits',
  },
  alignable: {
    ...PRE_DAY_WORDS,
    friends: 'Save your connections',
    requests: 'Save connection requests you got',
    sent: 'Save connection requests you sent',
    tidy: 'Work out which old requests to withdraw',
    checks: 'Check your connections for good fits',
  },
};

/** The checklist's heading. */
export const PRE_DAY_TITLE = 'Getting ready for your first day';

/** Whether every step before a network's first day is done: the checklist goes once it is. */
export const preDayDone = (lists: ListsSaved, platform: Platform = 'facebook'): boolean =>
  LIST_MARKS_ON[platform].every((mark) => lists[AT_KEY[mark]] !== null);

export interface PreDayStep {
  readonly key: ListMark;
  readonly label: string;
  /** Ticked, the one under way, or still to come. */
  readonly state: 'done' | 'now' | 'next';
  /** On the one under way, how far it's got: "Reading your friends… 1,240 friends so far." Else null. */
  readonly progress: string | null;
}

/**
 * The live checklist of the steps before the first day (docs/outreach.md, "Lists first"), for the web, the phone and
 * the extension's panel: each step in order, ticked once noted, with the one under way and its progress. `doing` is
 * the step under way when the extension says (else the first not done), and `line` what it says now while it works
 * (else null). Empty once every step is done: the checklist is for the first day only.
 */
export function preDaySteps(
  lists: ListsSaved | null | undefined,
  now: { readonly doing?: ListMark | null; readonly line?: string | null } = {},
  platform: Platform = 'facebook',
): PreDayStep[] {
  if (!lists || preDayDone(lists, platform)) return [];
  const marks = LIST_MARKS_ON[platform];
  const done = (mark: ListMark) => lists[AT_KEY[mark]] !== null;
  const current =
    now.doing && marks.includes(now.doing) && !done(now.doing)
      ? now.doing
      : marks.find((mark) => !done(mark));
  return marks.map((key) => {
    const state = done(key) ? 'done' : key === current ? 'now' : 'next';
    return {
      key,
      label: PRE_DAY_WORDS_ON[platform][key],
      state,
      progress: state === 'now' ? now.line?.trim() || null : null,
    };
  });
}

/** "2 of 7 done", beside the checklist's heading. */
export const preDayCount = (steps: readonly PreDayStep[]): string =>
  `${steps.filter((step) => step.state === 'done').length} of ${steps.length} done`;

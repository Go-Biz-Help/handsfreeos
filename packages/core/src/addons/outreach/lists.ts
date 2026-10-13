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
 */
import { z } from 'zod';
import { businessDay } from './automation';

/** The lists saved before the day, in the order they're saved: the person's groups last. */
export const LIST_SAVE_KEYS = ['friends', 'requests', 'sent', 'groups'] as const;
export type ListSave = (typeof LIST_SAVE_KEYS)[number];

/**
 * What's noted as done, in the order it's done before the first day: a list saved to its end, the first check of the
 * groups (decision 48), the Tidy up suggestions worked out, the first good-fits check.
 */
export const LIST_MARK_KEYS = [...LIST_SAVE_KEYS, 'group_checks', 'tidy', 'checks'] as const;
export type ListMark = (typeof LIST_MARK_KEYS)[number];

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

export const ListsInput = z.object({ workspaceId: z.uuid() });
export type ListsInput = z.input<typeof ListsInput>;
export const ListsOutput = ListsSaved;

export const ListSavedInput = z.object({
  workspaceId: z.uuid(),
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

/** Whether the first full save is done: friends, received and sent requests, and groups, each saved once. */
export const firstSaveDone = (lists: ListsSaved): boolean =>
  LIST_SAVE_KEYS.every((list) => lists[AT_KEY[list]] !== null);

/**
 * The lists to save before the day, in order: any never saved; the requests, either way, unless saved already on the
 * business's day today; and the friends list and the groups once their last full save is FRIENDS_AGAIN_DAYS old.
 */
export function listsDue(lists: ListsSaved, now: number, timeZone: string): ListSave[] {
  const today = businessDay(now, timeZone);
  return LIST_SAVE_KEYS.filter((list) => {
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
 * friends once.
 */
export function afterFirstSave(lists: ListsSaved): 'group_checks' | 'tidy' | 'checks' | null {
  if (!firstSaveDone(lists)) return null;
  if (lists.groupChecksAt === null) return 'group_checks';
  if (lists.tidyAt === null) return 'tidy';
  if (lists.checksAt === null) return 'checks';
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

const WAIT_NAMES: Readonly<Record<ListSave, string>> = {
  friends: 'your friends list',
  requests: 'the friend requests you’ve got',
  sent: 'the ones you’ve sent',
  groups: 'your groups',
};

/** "a, b and c". */
const listed = (words: readonly string[]): string =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;

/**
 * Why a day started isn't under way yet, under Start my day: the first time, until the lists and groups are saved.
 * Empty once they are, or when the day isn't started.
 */
export function listsWaitWords(lists: ListsSaved | null | undefined, started: boolean): string {
  if (!started || !lists || firstSaveDone(lists)) return '';
  const left = LIST_SAVE_KEYS.filter((list) => lists[AT_KEY[list]] === null);
  const what =
    left.length === LIST_SAVE_KEYS.length
      ? 'your friends list, friend requests and groups'
      : listed(left.map((list) => WAIT_NAMES[list]));
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

/** The checklist's heading. */
export const PRE_DAY_TITLE = 'Getting ready for your first day';

/** Whether every step before the first day is done: the checklist goes once it is. */
export const preDayDone = (lists: ListsSaved): boolean =>
  LIST_MARK_KEYS.every((mark) => lists[AT_KEY[mark]] !== null);

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
): PreDayStep[] {
  if (!lists || preDayDone(lists)) return [];
  const done = (mark: ListMark) => lists[AT_KEY[mark]] !== null;
  const current =
    now.doing && !done(now.doing) ? now.doing : LIST_MARK_KEYS.find((mark) => !done(mark));
  return LIST_MARK_KEYS.map((key) => {
    const state = done(key) ? 'done' : key === current ? 'now' : 'next';
    return {
      key,
      label: PRE_DAY_WORDS[key],
      state,
      progress: state === 'now' ? now.line?.trim() || null : null,
    };
  });
}

/** "2 of 7 done", beside the checklist's heading. */
export const preDayCount = (steps: readonly PreDayStep[]): string =>
  `${steps.filter((step) => step.state === 'done').length} of ${steps.length} done`;

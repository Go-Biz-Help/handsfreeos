/**
 * The person's own lists, saved before their day (docs/outreach.md, "Lists first"): their friends, the friend requests
 * they've got, and the ones they've sent. The owner's decision (settled): **first day only**. The first time, Start my
 * day waits until all three are saved to their end. After that, the requests are saved again each morning before the
 * day starts, and the friends list once a week. Right after the first full save, the Tidy up suggestions are worked
 * out (decisions 10, 12 and 17), then the good fits among friends are checked once (decision 46), and from then on
 * the checks run daily with their cap.
 *
 * HandsFreeOS keeps when each was last saved to its end, each person's own (`outreach.lists`, `outreach.lists.saved`);
 * the extension does the saving (apps/extension/src/auto/lists.ts). Browser-safe: the extension, the web and the
 * phone read these.
 */
import { z } from 'zod';
import { businessDay } from './automation';

/** The lists saved before the day, in the order they're saved. */
export const LIST_SAVE_KEYS = ['friends', 'requests', 'sent'] as const;
export type ListSave = (typeof LIST_SAVE_KEYS)[number];

/** What's noted as done: a list saved to its end, the Tidy up suggestions worked out, the first good-fits check. */
export const LIST_MARK_KEYS = [...LIST_SAVE_KEYS, 'tidy', 'checks'] as const;
export type ListMark = (typeof LIST_MARK_KEYS)[number];

/** The friends list is saved again once its last full save is this old. */
export const FRIENDS_AGAIN_DAYS = 7;

const DAY = 86_400_000;
const moment = z.iso.datetime().nullable();

/** When each was last saved to its end, and when the first tidy-up and check were done: null for never. */
export const ListsSaved = z.object({
  friendsAt: moment,
  requestsAt: moment,
  sentAt: moment,
  tidyAt: moment,
  checksAt: moment,
});
export type ListsSaved = z.output<typeof ListsSaved>;

export const NO_LISTS: ListsSaved = {
  friendsAt: null,
  requestsAt: null,
  sentAt: null,
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
  tidy: 'tidyAt',
  checks: 'checksAt',
};
export const atKey = (mark: ListMark): keyof ListsSaved => AT_KEY[mark];

/** Whether the first full save is done: friends, received and sent requests each saved to their end once. */
export const firstSaveDone = (lists: ListsSaved): boolean =>
  LIST_SAVE_KEYS.every((list) => lists[AT_KEY[list]] !== null);

/**
 * The lists to save before the day, in order: any never saved; the requests, either way, unless saved already on the
 * business's day today; and the friends list once its last full save is FRIENDS_AGAIN_DAYS old.
 */
export function listsDue(lists: ListsSaved, now: number, timeZone: string): ListSave[] {
  const today = businessDay(now, timeZone);
  return LIST_SAVE_KEYS.filter((list) => {
    const at = lists[AT_KEY[list]];
    if (at === null) return true;
    const ms = new Date(at).getTime();
    return list === 'friends'
      ? now - ms >= FRIENDS_AGAIN_DAYS * DAY
      : businessDay(ms, timeZone) < today;
  });
}

/** What's left once the first full save is done: work out the Tidy up suggestions, then check friends once. */
export function afterFirstSave(lists: ListsSaved): 'tidy' | 'checks' | null {
  if (!firstSaveDone(lists)) return null;
  if (lists.tidyAt === null) return 'tidy';
  if (lists.checksAt === null) return 'checks';
  return null;
}

/** What the extension says while it saves each, before the day. */
export const LIST_DOING: Readonly<Record<ListSave, string>> = {
  friends: 'Saving your friends list first…',
  requests: 'Saving your friend requests first…',
  sent: 'Saving the friend requests you’ve sent first…',
};

/** What each is called, in "Your friends list: Saved 412 friends." */
export const LIST_NAMES: Readonly<Record<ListSave, string>> = {
  friends: 'Your friends list',
  requests: 'Friend requests',
  sent: 'Sent requests',
};

/**
 * Why a day started isn't under way yet, under Start my day: the first time, until the lists are saved. Empty once
 * they are, or when the day isn't started.
 */
export function listsWaitWords(lists: ListsSaved | null | undefined, started: boolean): string {
  if (!started || !lists || firstSaveDone(lists)) return '';
  const left = LIST_SAVE_KEYS.filter((list) => lists[AT_KEY[list]] === null);
  const what =
    left.length === LIST_SAVE_KEYS.length
      ? 'your friends list and friend requests'
      : left
          .map((list) =>
            list === 'friends'
              ? 'your friends list'
              : list === 'requests'
                ? 'the friend requests you’ve got'
                : 'the ones you’ve sent',
          )
          .join(' and ');
  return `It’s saving ${what} first, the first time only. Your day starts once they’re saved.`;
}

/**
 * Waiting for you (docs/outreach.md, decisions 40 and 42): the shapes of the one list, the same in the extension, the
 * web and the phone, and of the operations on it (./ops/waiting.ts). Its words and rules are in ./waiting-words.ts,
 * which the extension reads without these.
 *
 * Browser-safe.
 */
import { z } from 'zod';
import { AskShown } from './asks';
import { clipLine } from './live';
import { PUSH_MODE_KEYS, WheelsState, WorkingHours } from './automation';
import { FIT_LEVEL_KEYS } from './fit';
import { PLATFORM_KEYS } from './networks';
import { Send } from './sends';
import {
  NEED_CLEARS,
  NEED_STATES,
  NEED_STEPS,
  NOTED_NEED_STEPS,
  REQUEST_HELD,
  type NeedClear,
  type RequestHeld,
} from './waiting-words';

export * from './waiting-words';

export const WaitingInput = z.object({
  workspaceId: z.uuid(),
  /** False answers the counts alone, for a tab's label or a push. */
  items: z.boolean().default(true),
});
export type WaitingInput = z.input<typeof WaitingInput>;

/** A step the extension couldn't do, handed to the person. */
export const WaitingNeed = z.object({
  needId: z.uuid(),
  step: z.enum(NEED_STEPS),
  profileId: z.uuid(),
  postId: z.uuid().nullable(),
  sendId: z.uuid().nullable(),
  /** The network it's on: their profile's. Its words and its link are that network's. */
  platform: z.enum(PLATFORM_KEYS),
  /**
   * Who, and where to do it, on their network: the post, the chat, or else their page there (`needUrlOf`). Null only
   * for one whose profile has no address on its network.
   */
  name: z.string(),
  url: z.string().nullable(),
  /** Why it couldn't, in the extension's words. */
  why: z.string(),
  /**
   * For a message that didn't go: its words, and the chat when it's known. For a comment that didn't (decision 92):
   * its words.
   */
  text: z.string().nullable(),
  threadKey: z.string().nullable(),
  /** The last time it couldn't. */
  seenAt: z.iso.datetime(),
});
export type WaitingNeed = z.output<typeof WaitingNeed>;

const HELD_KEYS = Object.keys(REQUEST_HELD) as [RequestHeld, ...RequestHeld[]];

/** A friend request the person got that didn't fit a playbook, or isn't Today's to confirm: theirs to decide. */
export const WaitingRequest = z.object({
  profileId: z.uuid(),
  name: z.string(),
  url: z.string(),
  fit: z.enum(FIT_LEVEL_KEYS),
  /** Why it's theirs to decide (`requestWhy`). */
  why: z.array(z.string()),
  /** It fits well, but isn't Today's to confirm: why not (no playbook in use, or Don't pitch). */
  held: z.enum(HELD_KEYS).nullable(),
  /** When they asked. */
  since: z.iso.datetime(),
  mutualFriends: z.number().int().nullable(),
});
export type WaitingRequest = z.output<typeof WaitingRequest>;

export const WaitingItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ask'), at: z.iso.datetime(), ask: AskShown }),
  z.object({ kind: z.literal('reply'), at: z.iso.datetime(), send: Send }),
  z.object({ kind: z.literal('message'), at: z.iso.datetime(), send: Send }),
  z.object({ kind: z.literal('need'), at: z.iso.datetime(), need: WaitingNeed }),
  z.object({ kind: z.literal('request'), at: z.iso.datetime(), request: WaitingRequest }),
]);
export type WaitingItem = z.output<typeof WaitingItem>;

const kind = z.object({
  count: z.number().int().min(0),
  /** When the newest one began to wait: null with none. */
  newestAt: z.iso.datetime().nullable(),
});

export const WaitingOutput = z.object({
  /** Everything waiting: what the icon, the tab and the Live tab show. */
  count: z.number().int().min(0),
  kinds: z.object({ ask: kind, reply: kind, message: kind, need: kind, request: kind }),
  /** In the list's order (`WAITING_KIND_KEYS`): empty when only the counts were asked for. */
  items: z.array(WaitingItem),
  /** Their training wheels, for Approve all's words. */
  wheels: WheelsState,
  /** How their phone hears of it, their working hours and the business's time zone: the pushes and pop-ups follow them. */
  pushes: z.enum(PUSH_MODE_KEYS),
  hours: WorkingHours,
  timezone: z.string(),
});
export type WaitingOutput = z.output<typeof WaitingOutput>;

/** The extension couldn't do a step on the person's list: it's handed to them. */
export const NeedNoteInput = z.object({
  workspaceId: z.uuid(),
  step: z.enum(NOTED_NEED_STEPS),
  profileId: z.uuid(),
  postId: z.uuid().nullable().default(null),
  name: z.string().trim().min(1).max(200),
  /** Where to do it: kept when it's on their profile's network, else their page there is, never refused. */
  url: z.string().trim().max(500).nullable().default(null),
  /** Why, in the extension's words: cut short, never refused. */
  why: z
    .string()
    .trim()
    .min(1)
    .transform((w) => clipLine(w)),
});
export type NeedNoteInput = z.input<typeof NeedNoteInput>;
export const NeedNoteOutput = z.object({
  /** Null when the person let the same step go lately: nothing is kept. */
  needId: z.uuid().nullable(),
  /** New to the list: the person hears of it as their pushes say. */
  fresh: z.boolean(),
});

const CLEAR_KEYS = Object.keys(NEED_CLEARS) as [NeedClear, ...NeedClear[]];

/** The person did a step themselves, or let it go. */
export const NeedClearInput = z.object({
  workspaceId: z.uuid(),
  needId: z.uuid(),
  how: z.enum(CLEAR_KEYS),
});
export type NeedClearInput = z.input<typeof NeedClearInput>;
export const NeedClearOutput = z.object({
  needId: z.uuid(),
  /** `open` when the extension couldn't do it again after the person pressed: it stays. */
  state: z.enum(NEED_STATES),
});

/** The person set a friend request aside: off Waiting for you until they ask again. */
export const RequestSetAsideInput = z.object({ workspaceId: z.uuid(), profileId: z.uuid() });
export type RequestSetAsideInput = z.input<typeof RequestSetAsideInput>;
export const RequestSetAsideOutput = z.object({ profileId: z.uuid() });

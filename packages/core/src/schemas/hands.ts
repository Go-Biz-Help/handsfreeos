/**
 * In your hands (messaging/hands.ts, 20261027029800): the shapes of Take over, Give back to the AI, and the list of
 * customers someone on the team has taken on.
 */
import { z } from 'zod';

export const HANDS_HOW_KEYS = ['wrote', 'called', 'took_over'] as const;

/** The most customers one Give back takes by name; Give all back takes everyone in the business's list. */
export const HAND_BACK_MOST = 500;

export const PersonTakeOverInput = z.object({
  workspaceId: z.uuid(),
  personId: z.uuid(),
});
export type PersonTakeOverInput = z.input<typeof PersonTakeOverInput>;

export const PersonTakeOverOutput = z.object({
  personId: z.uuid(),
  /** They were in someone's hands already: nothing changed. */
  already: z.boolean(),
  /** The AI teammate's replies waiting for an OK that were let go. */
  draftsCancelled: z.number().int(),
});

/** A message someone on the team wrote to a customer themselves where HandsFreeOS only hears of it: an add-on's network. */
export const PersonNoteByHandInput = z.object({
  workspaceId: z.uuid(),
  personId: z.uuid(),
  /** Where: the network, as the add-on names it ("facebook"). */
  place: z.string().regex(/^[a-z_]{1,40}$/),
  /** When it was written. */
  at: z.iso.datetime().optional(),
});
export type PersonNoteByHandInput = z.input<typeof PersonNoteByHandInput>;

export const PersonNoteByHandOutput = z.object({
  personId: z.uuid(),
  /** They've just come into someone's hands. */
  fresh: z.boolean(),
});

export const PersonHandBackInput = z.object({
  workspaceId: z.uuid(),
  /** The customers to give back. */
  personIds: z
    .array(z.uuid())
    .max(HAND_BACK_MOST, `Give back up to ${HAND_BACK_MOST} at a time.`)
    .default([]),
  /** Give all back: everyone in the business's list (or only yours, with `mine`). */
  all: z.boolean().default(false),
  /** With `all`: only the customers in your own hands. */
  mine: z.boolean().default(false),
});
export type PersonHandBackInput = z.input<typeof PersonHandBackInput>;

export const PersonHandBackOutput = z.object({
  /** Customers who were in someone's hands and now aren't. */
  handedBack: z.number().int(),
  /** Their conversations the AI teammate answers again. */
  toAi: z.number().int(),
});

export const PersonInHandsInput = z.object({
  workspaceId: z.uuid(),
  /** One customer: whether they're in someone's hands (none or one row). */
  personId: z.uuid().optional(),
  /** Only the customers in your own hands. */
  mine: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(100),
});
export type PersonInHandsInput = z.input<typeof PersonInHandsInput>;

export const InHandsRow = z.object({
  personId: z.uuid(),
  name: z.string(),
  /** Whose hands, and their name; null for someone outside HandsFreeOS, or someone who has left. */
  user: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
  how: z.enum(HANDS_HOW_KEYS),
  /** Where they last reached them by hand: a channel, 'call', or a network; null for Take over. */
  place: z.string().nullable(),
  since: z.iso.datetime(),
  lastAt: z.iso.datetime(),
  /** Since when a message of theirs waits on a reply, in any conversation; null when none does. */
  waitingSince: z.iso.datetime().nullable(),
});
export type InHandsRow = z.output<typeof InHandsRow>;

export const PersonInHandsOutput = z.object({
  people: z.array(InHandsRow),
  /** Everyone in the list, more than `people` when it's cut at the limit. */
  total: z.number().int(),
});
export type PersonInHandsOutput = z.output<typeof PersonInHandsOutput>;

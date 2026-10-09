import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { ListInput } from './crm';

/**
 * The Deleted bin (20261027000400): customers, conversations and bookings deleted for good wait here 30 days, and
 * can be brought back until then. Owners only, unless an owner gives "Delete for good" to a role or a person.
 */
export const BinKind = z.enum(['person', 'conversation', 'appointment']);
export type BinKind = z.infer<typeof BinKind>;

/** How many to delete at once: a page of the Contacts list or the inbox. */
const MAX_AT_ONCE = 100;
const ids = (what: string) =>
  z
    .array(uuid)
    .min(1, `Pick at least one ${what}.`)
    .max(MAX_AT_ONCE, `Delete up to ${MAX_AT_ONCE} at a time.`)
    .transform((list) => [...new Set(list)]);

/**
 * How much goes with something deleted, for the delete box and the bin's list. Each count is there only when it
 * isn't zero; `bills` stay behind with the customer's name, and `upcoming` bookings are cancelled first.
 */
export const BinContents = z.object({
  conversations: z.number().int().optional(),
  messages: z.number().int().optional(),
  calls: z.number().int().optional(),
  notes: z.number().int().optional(),
  tasks: z.number().int().optional(),
  leads: z.number().int().optional(),
  bookings: z.number().int().optional(),
  upcoming: z.number().int().optional(),
  files: z.number().int().optional(),
  forms: z.number().int().optional(),
  bills: z.number().int().optional(),
  /** A conversation's channel ("sms", "email", "messenger"...). */
  channel: z.string().optional(),
  /** A booking's start, and who was on it. */
  startsAt: isoDateTime.optional(),
  who: z.array(z.string().nullable()).optional(),
});
export type BinContents = z.infer<typeof BinContents>;

export const BinPreviewInput = z.object({
  workspaceId: uuid,
  kind: BinKind,
  ids: ids('thing'),
});
/** One thing the delete box lists: what goes with it, or why it can't go (`rule`, `message`). */
export const BinPreviewItem = z.object({
  id: uuid,
  name: z.string().nullable(),
  contents: BinContents,
  rule: z.string().nullable(),
  message: z.string().nullable(),
});
export const BinPreviewOutput = z.object({ items: z.array(BinPreviewItem) });

/** What a delete put in the bin, one entry per thing deleted. */
const Binned = z.object({ id: uuid, binItemId: uuid, name: z.string() });

export const PersonDeleteInput = z.object({ workspaceId: uuid, personIds: ids('customer') });
export const ConversationDeleteInput = z.object({
  workspaceId: uuid,
  conversationIds: ids('conversation'),
});
export const AppointmentDeleteInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  /** A booking still to come is cancelled first: text or email the customers that it's cancelled. */
  notify: z.boolean().default(true),
  reason: z.string().trim().max(500).nullable().optional(),
});
export const BinDeleteOutput = z.object({
  deleted: z.array(Binned),
  /** When it all empties for good, unless it's brought back first. */
  purgeAfter: isoDateTime,
});

export const BinRestoreInput = z.object({ workspaceId: uuid, binItemId: uuid });
export const BinRestoreOutput = z.object({
  kind: BinKind,
  recordId: uuid,
  name: z.string(),
  /** Conversations whose line had a new thread since, so they joined it. */
  joined: z.number().int(),
});

/** "Delete now" on some of the bin, or all of it. */
export const BinEmptyInput = z
  .object({
    workspaceId: uuid,
    binItemIds: ids('item').optional(),
    all: z.boolean().default(false),
  })
  .refine((v) => v.all || !!v.binItemIds, {
    message: 'Pick what to delete now, or empty the whole bin.',
    path: ['binItemIds'],
  });
export const BinEmptyOutput = z.object({ emptying: z.number().int() });

export const BinListInput = ListInput.extend({ workspaceId: uuid });
export const BinListItem = z.object({
  id: uuid,
  kind: BinKind,
  recordId: uuid,
  name: z.string(),
  contents: BinContents,
  deletedBy: z.object({ id: uuid, name: z.string() }).nullable(),
  deletedAt: isoDateTime,
  purgeAfter: isoDateTime,
  /** Being emptied now: it can't be brought back. */
  emptying: z.boolean(),
});
export const BinListOutput = z.object({
  items: z.array(BinListItem),
  nextCursor: z.string().nullable(),
});

/**
 * HandsFreeOS support let into a business's private records (Real Estate, step 4): asked for from support's look at
 * the business, or given unasked, for 24 hours, as what the person who gave it sees.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

export const SUPPORT_ACCESS_STATUSES = ['requested', 'active', 'declined', 'ended'] as const;
export type SupportAccessStatus = (typeof SUPPORT_ACCESS_STATUSES)[number];

export const SupportAccessRequestInput = z.object({
  workspaceId: uuid,
  /** What they need to look at, for the people asked: "the 45 Oak Ave duties show the wrong closing date". */
  note: z.string().trim().min(1).max(500),
});
export const SupportAccessRequestOutput = z.object({ requestId: uuid });

export const SupportAccessGrantInput = z.object({
  workspaceId: uuid,
  /** The request answered; absent to let support in unasked (on a call, say). */
  requestId: uuid.optional(),
});
export const SupportAccessGrantOutput = z.object({ grantId: uuid, expiresAt: isoDateTime });

export const SupportAccessDeclineInput = z.object({ workspaceId: uuid, requestId: uuid });
export const SupportAccessEndInput = z.object({ workspaceId: uuid, grantId: uuid });
export const SupportAccessDoneOutput = z.object({ id: uuid });

export const SupportAccessListInput = z.object({ workspaceId: uuid });
const Who = z.object({ id: uuid, fullName: z.string() }).nullable();
export const SupportAccessRow = z.object({
  id: uuid,
  status: z.enum(SUPPORT_ACCESS_STATUSES),
  /** Active, but past its 24 hours: it no longer opens anything. */
  expired: z.boolean(),
  requestedBy: Who,
  requestNote: z.string().nullable(),
  grantedBy: Who,
  grantedAt: isoDateTime.nullable(),
  expiresAt: isoDateTime.nullable(),
  endedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export const SupportAccessListOutput = z.object({
  /** Whether this person may answer a request or let support in: an owner or admin, or a record's main person. */
  canLetIn: z.boolean(),
  items: z.array(SupportAccessRow),
});

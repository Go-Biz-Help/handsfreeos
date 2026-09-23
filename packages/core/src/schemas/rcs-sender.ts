/**
 * A business's RCS sender (0101): what Settings shows and what the commands take. Browser-safe.
 *
 * Apart from the rich-text schemas (schemas/rcs.ts) because `phone.setup_status` returns a sender, and the
 * rich-text schemas import the telephony ones for a call button's number: one module for both would be a cycle.
 */
import { z } from 'zod';
import { RCS_SENDER_ID, rcsSenderIdOf } from '../messaging/rcs';
import { isoDateTime, uuid } from './common';

export const rcsSenderStatus = z.enum([
  'connecting',
  'in_review',
  'active',
  'offline',
  'failed',
  'disconnecting',
  'disconnected',
]);
export type RcsSenderStatus = z.infer<typeof rcsSenderStatus>;

/** A sender's id as people paste it — `rcs:lonestar_agent` or `lonestar_agent` — kept without the `rcs:`. */
export const rcsSenderIdInput = z
  .string()
  .trim()
  .min(1, 'Enter the sender’s id from Twilio.')
  .max(104)
  .transform(rcsSenderIdOf)
  .refine((v) => RCS_SENDER_ID.test(v), {
    error: 'Use the sender’s id from Twilio, like lonestar_hvac_agent.',
  });

export const RcsSenderOut = z.object({
  id: uuid,
  senderId: z.string(),
  status: rcsSenderStatus,
  enabled: z.boolean(),
  /** Where a customer's first RCS message starts its thread; null is the default number. */
  phoneNumberId: uuid.nullable(),
  /** The name customers see at the top of the thread on their phone. */
  displayName: z.string().nullable(),
  /** Twilio's own word for where it stands (ONLINE, TWILIO_REVIEW …), for support. */
  providerStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  checkedAt: isoDateTime.nullable(),
  connectedAt: isoDateTime.nullable(),
  /** Texts go RCS first right now: approved, switched on, and on the business's messaging service. */
  sending: z.boolean(),
});
export type RcsSenderOut = z.infer<typeof RcsSenderOut>;

export const RcsSenderConnectInput = z.object({
  workspaceId: uuid,
  senderId: rcsSenderIdInput,
  /** Where a customer's first RCS message starts its thread. Left out: the default number. */
  phoneNumberId: uuid.nullable().optional(),
});
export const RcsSenderUpdateInput = z
  .object({
    workspaceId: uuid,
    /** Off sends every text as SMS or MMS and keeps the sender connected. */
    enabled: z.boolean().optional(),
    phoneNumberId: uuid.nullable().optional(),
  })
  .refine((v) => v.enabled !== undefined || v.phoneNumberId !== undefined, {
    path: ['enabled'],
    error: 'Say what to change.',
  });
export const RcsSenderWorkspaceInput = z.object({ workspaceId: uuid });
export const RcsSenderRefOutput = z.object({ rcsSenderId: uuid, status: rcsSenderStatus });

/** Worker: what Twilio said about the sender, and when to ask again. */
export const RcsSenderRecordStateInput = z.object({
  workspaceId: uuid,
  rcsSenderId: uuid,
  status: rcsSenderStatus,
  accountId: uuid.nullable().optional(),
  providerSid: z.string().trim().min(3).max(64).nullable().optional(),
  providerStatus: z.string().trim().max(60).nullable().optional(),
  displayName: z.string().trim().max(120).nullable().optional(),
  inService: z.boolean().optional(),
  lastError: z.string().trim().max(2000).nullable().optional(),
  nextPollAt: isoDateTime.nullable().optional(),
});

/** What Twilio holds in a business's own account, for Settings to offer before anything is connected. */
export const RcsSenderFound = z.object({
  sid: z.string(),
  senderId: z.string(),
  displayName: z.string().nullable(),
  /** online, in_review, offline or failed: where Twilio says it stands. */
  state: z.enum(['online', 'in_review', 'offline', 'failed']),
  providerStatus: z.string(),
});
export type RcsSenderFound = z.infer<typeof RcsSenderFound>;

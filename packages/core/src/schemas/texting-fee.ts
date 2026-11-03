/**
 * What registering a local number for texting costs a business (0105): what Settings shows and what the worker
 * writes back. Browser-safe.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

export const textingFeeStatus = z.enum([
  'pending',
  'open',
  'paid',
  'failed',
  'cancelled',
  'waived',
]);
export type TextingFeeStatus = z.infer<typeof textingFeeStatus>;
export const textingFeePurpose = z.enum(['registration', 'month']);

export const TextingFeeLineOut = z.object({ key: z.string(), name: z.string(), cents: z.int() });

export const TextingFeeOut = z.object({
  id: uuid,
  purpose: textingFeePurpose,
  status: textingFeeStatus,
  lines: z.array(TextingFeeLineOut),
  amountCents: z.int(),
  /** The Stripe page, while one is waiting to be paid. */
  checkoutUrl: z.string().nullable(),
  /** Why it isn't paid: the card said no, or the page ran out. */
  problem: z.string().nullable(),
  /** A month's fee: when that month started. */
  periodStart: isoDateTime.nullable(),
});
export type TextingFeeOut = z.infer<typeof TextingFeeOut>;

export const TextingFeesOut = z.object({
  /** The registration's fees, while they are unpaid: nothing goes to the carriers until they are. */
  due: TextingFeeOut.nullable(),
  /** A month of the campaign the card didn't pay. */
  month: TextingFeeOut.nullable(),
  /** A card is kept from an earlier payment, so later fees are charged to it. */
  card: z.boolean(),
  /** The campaign's month, when the business is charged one. */
  monthlyCents: z.int().nullable(),
  /** What is already sent or paid for: with the volume a person picks, what sending now costs (textingFeeLines). */
  paidFor: z.object({
    brandSent: z.boolean(),
    brandPaid: z.boolean(),
    vettingPaid: z.boolean(),
    campaignCovered: z.boolean(),
    /** HandsFreeOS's own business: never charged, so sending costs nothing. */
    ours: z.boolean(),
  }),
});
export type TextingFeesOut = z.infer<typeof TextingFeesOut>;

export const TextingFeePayInput = z.object({ workspaceId: uuid, textingFeeId: uuid });
export const TextingFeePayOutput = z.object({
  textingFeeId: uuid,
  /** The page, once made; read `phone.setup_status` (`textingFees`) until then. */
  checkoutUrl: z.string().nullable(),
});

// ---------- the worker's writes ----------
export const TextingFeeRecordPageInput = z.object({
  workspaceId: uuid,
  textingFeeId: uuid,
  sessionRef: z.string().trim().min(3).max(255),
  url: z.url().max(2000),
  expiresAt: isoDateTime.nullable(),
});
export const TextingFeeRecordOutcomeInput = z.object({
  workspaceId: uuid,
  textingFeeId: uuid,
  /** paid: the money is in. failed: the card said no, or the page ran out. waived: paying online is off. */
  status: z.enum(['paid', 'failed', 'waived']),
  paymentRef: z.string().trim().max(255).nullable().default(null),
  paidCents: z.int().min(0).nullable().default(null),
  customerRef: z.string().trim().max(255).nullable().default(null),
  cardRef: z.string().trim().max(255).nullable().default(null),
  problem: z.string().trim().max(1000).nullable().default(null),
});
export const TextingFeeChargeMonthInput = z.object({
  workspaceId: uuid,
  /** The approved campaign the month is for. */
  registrationId: uuid,
  monthIndex: z.int().min(0),
  periodStart: isoDateTime,
});
export const TextingFeeRecordOutput = z.object({
  textingFeeId: uuid.nullable(),
  outcome: z.enum(['recorded', 'already', 'unchanged']),
});

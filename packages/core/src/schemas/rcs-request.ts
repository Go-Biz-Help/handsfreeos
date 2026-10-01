/**
 * A business asking for an RCS sender and paying for it (0104): what the RCS card sends and shows, and what
 * the worker writes back. Browser-safe.
 */
import { z } from 'zod';
import { email, isoDateTime, uuid } from './common';

export const rcsRequestStatus = z.enum([
  'pending',
  'open',
  'paid',
  'expired',
  'failed',
  'cancelled',
]);
export type RcsRequestStatus = z.infer<typeof rcsRequestStatus>;

const link = (what: string) =>
  z
    .url({ error: `Enter the full address of ${what}, like https://example.com.` })
    .max(300, 'Keep the address under 300 characters.');

/**
 * What an RCS sender shows on a customer's phone, and what the carriers check before they approve it. The
 * logo and banner are pictures in sizes of their own, so a link to one is enough here; support asks for the
 * files on the ticket when there isn't one.
 */
export const RcsBrand = z.object({
  /** At the top of the thread on the customer's phone. */
  displayName: z
    .string()
    .trim()
    .min(1, 'Enter the name customers will see.')
    .max(40, 'Keep the name to 40 characters. Phones cut longer ones off.'),
  description: z
    .string()
    .trim()
    .min(1, 'Say in a sentence what your business does.')
    .max(100, 'Keep the description to 100 characters.'),
  /** Buttons and the header are drawn in it. */
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, { error: 'Use a color written like #1A73E8.' }),
  website: link('your website'),
  privacyUrl: link('your privacy policy'),
  termsUrl: link('your terms of service'),
  /** On the sender's profile, for customers to call. */
  phone: z
    .string()
    .trim()
    .min(7, 'Enter the phone number customers can call.')
    .max(30, 'Enter the phone number customers can call.'),
  /** On the sender's profile, for customers to write to. */
  email,
  /** Where the logo is, if it is online already. Support asks for it otherwise. */
  logoUrl: link('your logo').nullable().default(null),
  notes: z.string().trim().max(2000, 'Keep notes under 2,000 characters.').default(''),
});
export type RcsBrand = z.infer<typeof RcsBrand>;

export const RcsRequestOut = z.object({
  id: uuid,
  status: rcsRequestStatus,
  brand: z.record(z.string(), z.unknown()),
  firstYearCents: z.int(),
  yearlyCents: z.int(),
  /** The Stripe page, while it is waiting to be paid. */
  checkoutUrl: z.string().nullable(),
  /** Why a page closed without being paid. */
  problem: z.string().nullable(),
  paidAt: isoDateTime.nullable(),
  /** The end of the year paid for, when the next renewal is due. */
  paidThrough: isoDateTime.nullable(),
  /** It will be charged again at `paidThrough`: paid, not stopped, and no refused card waiting on support. */
  renews: z.boolean(),
  stoppedAt: isoDateTime.nullable(),
  /** The card refused the last renewal: why, until it is paid. */
  renewalProblem: z.string().nullable(),
  /** The page to pay that renewal on with another card, once `rcs_request.pay_renewal` has made it. */
  renewalCheckoutUrl: z.string().nullable(),
  /** The support ticket the payment opened, as the business would quote it. */
  ticketNumber: z.int().nullable(),
  createdAt: isoDateTime,
});
export type RcsRequestOut = z.infer<typeof RcsRequestOut>;

export const RcsRequestSubmitInput = z.object({ workspaceId: uuid, brand: RcsBrand });
export const RcsRequestWorkspaceInput = z.object({ workspaceId: uuid });
export const RcsRequestRefOutput = z.object({
  rcsRequestId: uuid,
  status: rcsRequestStatus,
  /** The Stripe page once the worker has made it; poll `phone.setup_status` until then. */
  checkoutUrl: z.string().nullable(),
});
export const RcsRequestPayRenewalOutput = z.object({
  rcsRequestId: uuid,
  /** The page to pay the renewal on, once made; poll `phone.setup_status` (`renewalCheckoutUrl`) until then. */
  checkoutUrl: z.string().nullable(),
});

// ---------- the worker's writes ----------
export const RcsRequestRecordOpenedInput = z.object({
  workspaceId: uuid,
  rcsRequestId: uuid,
  sessionRef: z.string().trim().min(3).max(255),
  url: z.url().max(2000),
  expiresAt: isoDateTime.nullable(),
});
export const RcsRequestRecordPaidInput = z.object({
  workspaceId: uuid,
  rcsRequestId: uuid,
  sessionRef: z.string().trim().min(3).max(255),
  paymentRef: z.string().trim().max(255).nullable(),
  paidCents: z.int().min(0),
  customerRef: z.string().trim().max(255).nullable(),
  /** The card kept for the renewal. Null when Stripe didn't say; support then bills the renewal by hand. */
  cardRef: z.string().trim().max(255).nullable(),
});
export const RcsRequestRecordClosedInput = z.object({
  workspaceId: uuid,
  rcsRequestId: uuid,
  status: z.enum(['expired', 'failed']),
  problem: z.string().trim().max(1000),
});
export const RcsRequestRecordRenewalPageInput = z.object({
  workspaceId: uuid,
  rcsRequestId: uuid,
  forPaidThrough: isoDateTime,
  sessionRef: z.string().trim().min(3).max(255),
  url: z.url().max(2000),
});
export const RcsRequestRecordRenewalInput = z.object({
  workspaceId: uuid,
  rcsRequestId: uuid,
  /** The `paidThrough` this renewal was for, so a late or repeated answer can't move the year twice. */
  forPaidThrough: isoDateTime,
  outcome: z.enum(['renewed', 'failed']),
  paymentRef: z.string().trim().max(255).nullable().default(null),
  paidCents: z.int().min(0).nullable().default(null),
  /** Why the card said no, in words for the business. */
  problem: z.string().trim().max(1000).nullable().default(null),
  /** Paid on a page with another card: that card is the one charged from now on. */
  customerRef: z.string().trim().max(255).nullable().optional(),
  cardRef: z.string().trim().max(255).nullable().optional(),
});
export const RcsRequestRecordOutput = z.object({
  rcsRequestId: uuid,
  outcome: z.enum(['recorded', 'already', 'unchanged']),
});

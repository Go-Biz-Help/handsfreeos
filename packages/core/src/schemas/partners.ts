/**
 * Partners in core (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2): the business's partner settings, its
 * partners, the clients each sent and what they earned. Commissions are worked out by the worker's commands as
 * payments and refunds land; people add partners, change their rate or status, and mark a client by hand.
 */
import { z } from 'zod';
import {
  PartnerSettings,
  PARTNER_TERMS_MOST,
  SMALLEST_PAYOUT_CENTS,
  SMALLEST_PAYOUT_LEAST_CENTS,
} from '../partners/settings';
import { isoDateTime, uuid } from './common';

export const PARTNER_STATUSES = ['active', 'paused', 'ended'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

const rateBp = z
  .int()
  .min(1, 'A share is at least 0.01%.')
  .max(10_000, 'A share can’t be more than 100%.');

// ---------- settings ----------

export const PartnersSettingsInput = z.object({ workspaceId: uuid });
export const PartnersSettingsOutput = z.object({
  settings: PartnerSettings,
  /** Whether an add-on that uses partners runs here: the screens show only while one does. */
  inUse: z.boolean(),
  /** The calendar partners' links book, as it stands: null when the business has no public calendar yet. */
  linkCalendar: z.object({ id: uuid, name: z.string() }).nullable(),
});

export const PartnersSaveSettingsInput = z.object({
  workspaceId: uuid,
  settings: z.object({
    rateBp,
    terms: z.string().trim().max(PARTNER_TERMS_MOST, 'Keep the terms under 20,000 characters.'),
    smallestPayoutCents: z
      .int()
      .min(SMALLEST_PAYOUT_LEAST_CENTS, 'The smallest payout is at least $1.')
      .max(SMALLEST_PAYOUT_CENTS, 'The smallest payout is $25 or less.'),
    calendarId: uuid.nullable(),
  }),
});
export const PartnersSaveSettingsOutput = z.object({ settings: PartnerSettings });

// ---------- a partner ----------

export const PartnerAddInput = z.object({
  workspaceId: uuid,
  /** Their contact. */
  personId: uuid,
  /** Their own share; left out or null for the business's default. */
  rateBp: rateBp.nullable().default(null),
});
export const PartnerAddOutput = z.object({
  partnerId: uuid,
  code: z.string(),
  /** False when they were a partner already (brought back if they'd ended or were paused). */
  created: z.boolean(),
});

export const PartnerUpdateInput = z.object({
  workspaceId: uuid,
  partnerId: uuid,
  /** Their own share, or null for the business's default. */
  rateBp: rateBp.nullable().optional(),
  status: z.enum(PARTNER_STATUSES).optional(),
});
export const PartnerUpdateOutput = z.object({ partnerId: uuid, updated: z.array(z.string()) });

// ---------- a client they sent ----------

export const PartnerReferralSetInput = z.object({
  workspaceId: uuid,
  /** The customer. */
  personId: uuid,
  /** The partner who sent them, or null for nobody. */
  partnerId: uuid.nullable(),
});
export const PartnerReferralSetOutput = z.object({ referralId: uuid.nullable() });

/** Worker: a booking came in, through a partner's link maybe (`appointment.booked`). */
export const PartnerReferralNoteInput = z.object({ workspaceId: uuid, appointmentId: uuid });
export const PartnerReferralNoteOutput = z.object({ referred: z.int().min(0) });

/** Worker: a payment succeeded (`payment.recorded`). */
export const PartnerCommissionNoteInput = z.object({ workspaceId: uuid, paymentId: uuid });
export const PartnerCommissionNoteOutput = z.object({ earned: z.boolean() });

/** Worker: a refund went back (`refund.recorded`). */
export const PartnerCommissionTakeBackInput = z.object({ workspaceId: uuid, refundId: uuid });
export const PartnerCommissionTakeBackOutput = z.object({ takenBack: z.boolean() });

/** Worker: a dispute on a payment closed (`dispute.closed`). */
export const PartnerCommissionDisputeNoteInput = z.object({ workspaceId: uuid, disputeId: uuid });

// ---------- what the screens read ----------

const cents = z.int();

/** What a partner earned, in cents, without payments in a provider's test mode. */
export const PartnerEarnings = z.object({
  /** Everything earned less everything taken back. */
  earnedCents: cents,
  /** Earned less than 30 days ago: not free to pay out yet. */
  waitingCents: cents,
  /** Free to pay out now. */
  payableCents: cents,
  /** On payments with a dispute open: neither waiting nor free to pay out until it's settled. */
  heldCents: cents,
});
export type PartnerEarnings = z.infer<typeof PartnerEarnings>;

export const PartnerOut = z.object({
  partnerId: uuid,
  personId: uuid,
  name: z.string(),
  email: z.string().nullable(),
  status: z.enum(PARTNER_STATUSES),
  /** What they earn now: their own rate or the business's. */
  rateBp: z.int(),
  ownRate: z.boolean(),
  code: z.string(),
  /** Their link's path on the business's address; null while the business has no public calendar. */
  linkPath: z.string().nullable(),
  clients: z.int().min(0),
  earnings: PartnerEarnings,
  /** Whether they accepted the business's latest terms. */
  termsAccepted: z.boolean(),
  addedAt: isoDateTime,
});
export type PartnerOut = z.infer<typeof PartnerOut>;

export const PartnerListInput = z.object({ workspaceId: uuid });
export const PartnerListOutput = z.object({ partners: z.array(PartnerOut) });

export const PartnerClientOut = z.object({
  referralId: uuid,
  /** Null once the customer was deleted for good. */
  personId: uuid.nullable(),
  name: z.string(),
  how: z.enum(['link', 'by_hand']),
  referredAt: isoDateTime,
  firstPaidAt: isoDateTime.nullable(),
  /** When their 12 months end; null before their first payment. */
  monthsEndAt: isoDateTime.nullable(),
  earnedCents: cents,
});
export const PartnerCommissionOut = z.object({
  commissionId: uuid,
  kind: z.enum(['earned', 'taken_back']),
  amountCents: cents,
  baseCents: cents,
  rateBp: z.int(),
  earnedAt: isoDateTime,
  payableAt: isoDateTime,
  test: z.boolean(),
  /** Its payment has a dispute open: it waits until that's settled. */
  held: z.boolean(),
  /** The client it came from: null once they were deleted for good. */
  clientName: z.string(),
  invoiceNumber: z.string().nullable(),
});

export const PartnerGetInput = z.object({ workspaceId: uuid, partnerId: uuid });
export const PartnerGetOutput = z.object({
  partner: PartnerOut,
  clients: z.array(PartnerClientOut),
  /** The latest 200, the newest first. */
  commissions: z.array(PartnerCommissionOut),
});

/** A customer's partner side: whether they're a partner, and who sent them. */
export const PartnerOfPersonInput = z.object({ workspaceId: uuid, personId: uuid });
export const PartnerOfPersonOutput = z.object({
  inUse: z.boolean(),
  partner: z.object({ partnerId: uuid, status: z.enum(PARTNER_STATUSES) }).nullable(),
  referredBy: z
    .object({
      referralId: uuid,
      partnerId: uuid,
      name: z.string(),
      how: z.enum(['link', 'by_hand']),
      referredAt: isoDateTime,
      earnedCents: cents,
    })
    .nullable(),
});

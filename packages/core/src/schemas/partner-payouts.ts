/**
 * Paying partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3): the business's card for partner payouts,
 * each partner's bank at Stripe, and each month's payout with its lines. The worker writes all of it; a person with
 * money.manage may take the card off, and staff open payouts for a business.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

const inWorkspace = { workspaceId: uuid };
const cents = z.int();
const providerId = z.string().trim().min(1).max(200);
/** A month, as its first day: "2026-11-01". */
const month = z.iso.date().refine((d) => d.endsWith('-01'), 'A month is its first day.');

export const PAYOUT_STATUSES = ['charging', 'paying', 'paid', 'failed'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const PAYOUT_LINE_STATUSES = ['pending', 'paid', 'held', 'cancelled'] as const;
export type PayoutLineStatus = (typeof PAYOUT_LINE_STATUSES)[number];
export const PAYOUT_WAITS = ['below_smallest', 'no_bank'] as const;

/** The card a business pays its partners with: the brand, last four and expiry, never more. */
export const PartnerPayoutCard = z.object({
  brand: z.string(),
  last4: z.string(),
  expiryMonth: z.int().nullable(),
  expiryYear: z.int().nullable(),
});
export type PartnerPayoutCard = z.infer<typeof PartnerPayoutCard>;

/** What a payout charges: the partners' part, then Stripe's fees, each its own line. */
export const PartnerPayoutTotals = z.object({
  owedCents: cents,
  accountFeesCents: cents,
  payoutFeesCents: cents,
  /** Stripe's fees for the partners' 1099s of a year that ended (stage 5): 0 on most payouts. */
  taxFormsCents: cents,
  cardFeeCents: cents,
  chargeCents: cents,
});

/** One partner's 1099 for a year, on the payout that charges Stripe's fee for it. */
export const PartnerTaxFormOut = z.object({
  /** "A deleted partner" once they were deleted for good. */
  name: z.string(),
  taxYear: z.int(),
  /** What the business paid them that year. */
  paidCents: cents,
  feeCents: cents,
});
export type PartnerTaxFormOut = z.infer<typeof PartnerTaxFormOut>;

export const PartnerPayoutOut = z.object({
  payoutId: uuid,
  /** The month it's paid in, as its first day. */
  month: z.string(),
  /** False for a payout made with Stripe's test keys: no real money moved. */
  livemode: z.boolean(),
  status: z.enum(PAYOUT_STATUSES),
  totals: PartnerPayoutTotals,
  /** The card it was charged to; null before the first try. */
  card: z.object({ brand: z.string(), last4: z.string() }).nullable(),
  /** How many partners it pays. */
  partners: z.int().min(0),
  attempts: z.int().min(0),
  /** While the card is tried again: when. */
  nextTryAt: isoDateTime.nullable(),
  /** What the card company said, in words, when it said no. */
  failureMessage: z.string().nullable(),
  chargedAt: isoDateTime.nullable(),
  paidAt: isoDateTime.nullable(),
  failedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type PartnerPayoutOut = z.infer<typeof PartnerPayoutOut>;

export const PartnerPayoutLineOut = z.object({
  lineId: uuid,
  /** Null once the partner was deleted for good. */
  partnerId: uuid.nullable(),
  name: z.string(),
  amountCents: cents,
  accountFeeCents: cents,
  payoutFeeCents: cents,
  status: z.enum(PAYOUT_LINE_STATUSES),
  /** Why Stripe wouldn't take it for them yet. */
  heldReason: z.string().nullable(),
  paidAt: isoDateTime.nullable(),
  /**
   * A line held for a partner deleted for good, given back to the business's card (stage 5): how much (the line and
   * its two Stripe fees), and when. The line is cancelled.
   */
  givenBackCents: cents.nullable(),
  givenBackAt: isoDateTime.nullable(),
});
export type PartnerPayoutLineOut = z.infer<typeof PartnerPayoutLineOut>;

// ---------- what the business reads ----------

export const PartnerPayoutsInput = z.object(inWorkspace);
export const PartnerPayoutsOutput = z.object({
  /** Whether HandsFreeOS has opened partner payouts for this business. Nothing is charged before. */
  open: z.boolean(),
  /** The card partner payouts are charged to. */
  card: PartnerPayoutCard.nullable(),
  /** The next payout, as it stands now: who it would pay, who waits and why, and what it would charge. */
  next: z.object({
    month: z.string(),
    /** It's worked out within the hour (this month's hasn't been yet), not on the first of next month. */
    soon: z.boolean(),
    lines: z.array(z.object({ partnerId: uuid, name: z.string(), amountCents: cents })),
    waiting: z.array(
      z.object({
        partnerId: uuid,
        name: z.string(),
        owedCents: cents,
        why: z.enum(PAYOUT_WAITS),
      }),
    ),
    /** The 1099s of a year that ended it would charge Stripe's fees for. */
    taxForms: z.array(PartnerTaxFormOut),
    totals: PartnerPayoutTotals,
  }),
  /** The latest 24, the newest first. */
  payouts: z.array(PartnerPayoutOut),
});

export const PartnerPayoutGetInput = z.object({ ...inWorkspace, payoutId: uuid });
export const PartnerPayoutGetOutput = z.object({
  payout: PartnerPayoutOut,
  lines: z.array(PartnerPayoutLineOut),
  /** The 1099s it charged Stripe's fees for. */
  taxForms: z.array(PartnerTaxFormOut),
});

/** A partner's bank at Stripe, as their page under Settings → Partners shows it. */
export const PartnerPayoutAccountOut = z.object({
  /** They finished Stripe's form, and Stripe can send their money to their bank. */
  ready: z.boolean(),
  detailsSubmitted: z.boolean(),
  /** Stripe needs something more from them. */
  needsMore: z.boolean(),
  /** Where their bank is (decision 118): a two-letter code, US for every account made before it. */
  country: z.string().length(2),
});

/** A partner's payouts, on their page under Settings → Partners (`partner.get`). */
export const PartnerPayoutsOfPartner = z.object({
  /** Null until they start setting up their bank. */
  account: PartnerPayoutAccountOut.nullable(),
  /** Their part of each payout, the newest first. */
  lines: z.array(
    PartnerPayoutLineOut.extend({ payoutId: uuid, month: z.string(), livemode: z.boolean() }),
  ),
});

// ---------- what people change ----------

export const PartnerPayoutForgetCardInput = z.object(inWorkspace);
export const PartnerPayoutCardOutput = z.object({ card: PartnerPayoutCard.nullable() });

/** Staff: open partner payouts for one business, or close them. */
export const PartnerSetPayoutsOpenInput = z.object({
  ...inWorkspace,
  open: z.boolean(),
  /** Why, in a few words. Stored on the event. */
  reason: z.string().trim().min(3).max(300),
});
export const PartnerSetPayoutsOpenOutput = z.object({
  workspaceId: uuid,
  wasOpen: z.boolean(),
  open: z.boolean(),
  /** False when it was already so. */
  changed: z.boolean(),
});

/** Staff: a business's partner payouts as /admin shows them. */
export const PlatformPartnerPayoutsGetInput = z.object(inWorkspace);
export const PlatformPartnerPayoutsGetOutput = z.object({
  workspaceId: uuid,
  open: z.boolean(),
  hasCard: z.boolean(),
  payouts: z.int().min(0),
  latestStatus: z.enum(PAYOUT_STATUSES).nullable(),
});

// ---------- what the worker writes ----------

/** Worker: a card was put on partner payouts, read back from Stripe's own page. */
export const PartnerPayoutRecordCardInput = z.strictObject({
  ...inWorkspace,
  provider: z.enum(['stripe']),
  customerRef: providerId,
  methodToken: z.string().trim().min(1).max(4000),
  cardBrand: z.string().trim().min(1).max(40).nullable(),
  cardLast4: z
    .string()
    .regex(/^[0-9]{4}$/)
    .nullable(),
  cardExpiryMonth: z.int().min(1).max(12).nullable(),
  cardExpiryYear: z.int().min(2000).max(2100).nullable(),
});

/** Worker: what Stripe says of a partner's account, when it's made and whenever it changes. */
export const PartnerPayoutRecordAccountInput = z.strictObject({
  ...inWorkspace,
  partnerId: uuid,
  accountRef: providerId,
  livemode: z.boolean(),
  detailsSubmitted: z.boolean(),
  payoutsEnabled: z.boolean(),
  transfersActive: z.boolean(),
  disabledReason: z.string().trim().max(200).nullable(),
  due: z.array(z.string().trim().min(1).max(200)).max(200),
  /** The account's country, where their bank is (decision 118). Left out, it's a US one, as every one was before. */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default('US'),
});
export const PartnerPayoutRecordAccountOutput = z.object({
  accountId: uuid,
  /** Stripe can send their money to their bank. */
  ready: z.boolean(),
  /** It couldn't before this. */
  becameReady: z.boolean(),
});

/** Worker: work out this month's payout. */
export const PartnerPayoutBuildInput = z.strictObject({
  ...inWorkspace,
  month,
  /** Whether the worker's Stripe key is a live one: a live payout pays live payments only, a test one test. */
  livemode: z.boolean(),
});
export const PartnerPayoutBuildOutput = z.object({
  payoutId: uuid.nullable(),
  /** built: a payout to charge; already: this month's was worked out before; nothing: nobody to pay this month. */
  outcome: z.enum(['built', 'already', 'not_open', 'no_card', 'nothing']),
  chargeCents: cents,
  partners: z.int().min(0),
});

/** Worker: what one try at charging the card came to. */
export const PartnerPayoutRecordChargeInput = z.strictObject({
  ...inWorkspace,
  payoutId: uuid,
  /** Which try it was: one more than the tries recorded, so a try is recorded once. */
  attempt: z.int().min(1).max(20),
  /** stopped: it wasn't tried, since payouts were closed or there's no card any more. */
  outcome: z.enum(['succeeded', 'declined', 'stopped']),
  stoppedBy: z.enum(['closed', 'no_card']).nullable().default(null),
  paymentRef: providerId.nullable().default(null),
  chargeRef: providerId.nullable().default(null),
  cardBrand: z.string().trim().min(1).max(40).nullable().default(null),
  cardLast4: z
    .string()
    .regex(/^[0-9]{4}$/)
    .nullable()
    .default(null),
  failureCode: z.string().trim().min(1).max(100).nullable().default(null),
  failureMessage: z.string().trim().min(1).max(500).nullable().default(null),
});
export const PartnerPayoutRecordChargeOutput = z.object({
  status: z.enum(PAYOUT_STATUSES),
  /** When the card is tried again, after a decline the ladder says is worth another go. */
  nextTryAt: isoDateTime.nullable(),
  /** Whether this call recorded anything: false for a try already recorded. */
  recorded: z.boolean(),
});

/** Worker: what sending one partner their part came to. */
export const PartnerPayoutRecordTransferInput = z.strictObject({
  ...inWorkspace,
  lineId: uuid,
  outcome: z.enum(['paid', 'held']),
  /** The partner's account it was sent to, when that isn't the one the payout was worked out with. */
  accountRef: providerId.nullable().default(null),
  transferRef: providerId.nullable().default(null),
  /** What Stripe said, for a held one. */
  heldReason: z.string().trim().min(1).max(500).nullable().default(null),
});
export const PartnerPayoutRecordTransferOutput = z.object({
  status: z.enum(PAYOUT_LINE_STATUSES),
  payoutStatus: z.enum(PAYOUT_STATUSES),
  recorded: z.boolean(),
});

/** A deleted partner's held line, given back to the business's card from the month's charge (stage 5). */
export const PartnerPayoutGiveBackInput = z.strictObject({
  ...inWorkspace,
  lineId: uuid,
  /** Stripe's refund that gave it back. */
  refundRef: providerId,
  /** The line and its two Stripe fees. */
  amountCents: cents.positive(),
});
export const PartnerPayoutGiveBackOutput = z.object({
  given: z.boolean(),
  payoutStatus: z.enum(PAYOUT_STATUSES),
});

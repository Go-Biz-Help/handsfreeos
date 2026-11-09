/**
 * What goes in and out of billing for a founding plan (20261027023600): the cards, the payment day, paying now, and
 * asking for more time.
 */
import { z } from 'zod';
import { uuid } from './common';

/** A day, as "2026-12-05". */
const isoDay = z.iso.date();

export const BillingCard = z.strictObject({
  id: uuid,
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  expiryMonth: z.int().nullable(),
  expiryYear: z.int().nullable(),
  isDefault: z.boolean(),
  lastDeclinedAt: z.iso.datetime().nullable(),
  lastDecline: z.string().nullable(),
  addedAt: z.iso.datetime(),
});

export const BillingTimeRequest = z.strictObject({
  id: uuid,
  status: z.enum(['pending', 'granted', 'declined']),
  payBy: isoDay,
  grantedUntil: isoDay.nullable(),
  askedAt: z.iso.datetime(),
  answeredAt: z.iso.datetime().nullable(),
});

/** Money owed after a payment failed. Null when nothing is. */
export const BillingOwed = z.strictObject({
  failedAt: z.iso.datetime(),
  amountCents: z.int(),
  problem: z.string().nullable(),
  /** The next automatic retry; null once the last has been made, or while more time runs. */
  nextRetryAt: z.iso.datetime().nullable(),
  /** Staff gave the business until then. */
  moreTimeUntil: z.iso.datetime().nullable(),
  /** When a card was last declined for it: Try my cards now waits for this to move. Null for whoever can't see cards. */
  lastTriedAt: z.iso.datetime().nullable(),
  /** The latest request for more time made since it failed. */
  timeRequest: BillingTimeRequest.nullable(),
});

export const BillingStatusInput = z.strictObject({ workspaceId: uuid });

/** What everyone in the business may know: whether money is owed, and whether they can fix it. */
export const BillingStatusOutput = z.strictObject({
  workspaceId: uuid,
  owed: BillingOwed.nullable(),
  /** This person manages billing (money.manage). */
  canManage: z.boolean(),
  /** Who to ask, when they can't: an owner's name. */
  askWho: z.string().nullable(),
});

export const BillingGetInput = z.strictObject({ workspaceId: uuid });

export const BillingGetOutput = z.strictObject({
  workspaceId: uuid,
  /** False on a business with no plan paid by card: nothing else here means anything then. */
  billed: z.boolean(),
  offerName: z.string().nullable(),
  plan: z.enum(['founding_free', 'founding_lifetime', 'monthly']).nullable(),
  priceCents: z.int(),
  /** When the next payment is due, and what it is. */
  paidThrough: z.iso.datetime().nullable(),
  nextChargeCents: z.int(),
  /** Taken off the next payment, after the payment day was moved earlier. */
  payDayCreditCents: z.int(),
  renewing: z.boolean(),
  trialEndsAt: z.iso.datetime().nullable(),
  /** A later payment day waiting on its charge, or why the last one didn't go through. */
  payDayChange: z
    .strictObject({
      to: z.iso.datetime().nullable(),
      cents: z.int().nullable(),
      problem: z.string().nullable(),
    })
    .nullable(),
  /** The days the payment day may move to now, or null when it can't move. */
  payDayBounds: z.strictObject({ earliest: isoDay, latest: isoDay }).nullable(),
  cards: z.array(BillingCard),
  owed: BillingOwed.nullable(),
});

export const BillingPayDayQuoteInput = z.strictObject({ workspaceId: uuid, day: isoDay });

export const BillingPayDayQuoteOutput = z.strictObject({
  kind: z.enum(['later', 'earlier', 'same']),
  days: z.int(),
  /** Later: paid now. Earlier: taken off the next payment. */
  cents: z.int(),
  /** What the next payment comes to, on the new day. */
  nextChargeCents: z.int(),
  newPaidThrough: z.iso.datetime().nullable(),
  earliest: isoDay.nullable(),
  latest: isoDay.nullable(),
  /** Why it can't move there, as a rule; null when it can. */
  refusal: z.string().nullable(),
  /** The same, in words. */
  refusalMessage: z.string().nullable(),
});

export const BillingCardRefInput = z.strictObject({ workspaceId: uuid, cardId: uuid });

export const BillingCardWriteOutput = z.strictObject({
  workspaceId: uuid,
  cardId: uuid,
  changed: z.boolean(),
});

export const BillingPayNowInput = z.strictObject({ workspaceId: uuid });

export const BillingPayNowOutput = z.strictObject({
  workspaceId: uuid,
  /** `trying`: the worker is charging the cards; ask billing.status for the answer. */
  outcome: z.enum(['trying', 'nothing_owed']),
});

export const BillingChangePayDayInput = z.strictObject({ workspaceId: uuid, day: isoDay });

export const BillingChangePayDayOutput = z.strictObject({
  workspaceId: uuid,
  /** `moved`: done. `charging`: the worker is charging the days added; ask billing.get for the answer. */
  outcome: z.enum(['moved', 'charging']),
  kind: z.enum(['later', 'earlier']),
  cents: z.int(),
  newPaidThrough: z.iso.datetime(),
});

export const BillingAskMoreTimeInput = z.strictObject({
  workspaceId: uuid,
  payBy: isoDay,
  note: z.string().trim().max(2000).default(''),
});

export const BillingAskMoreTimeOutput = z.strictObject({
  workspaceId: uuid,
  requestId: uuid,
  ticketNumber: z.int(),
});

// ---------- the worker's ----------

/** A card the worker put on the plan after Stripe's page, or details Stripe told it about one already there. */
export const BillingRecordCardInput = z.strictObject({
  workspaceId: uuid,
  customerRef: z.string().trim().min(1).max(100),
  cardRef: z.string().trim().min(1).max(100),
  brand: z.string().trim().max(40).nullable().default(null),
  last4: z
    .string()
    .regex(/^[0-9]{4}$/)
    .nullable()
    .default(null),
  expiryMonth: z.int().min(1).max(12).nullable().default(null),
  expiryYear: z.int().min(2000).max(2100).nullable().default(null),
  /** Make it the default. The first card is the default whatever this says. */
  makeDefault: z.boolean().default(false),
  /** Who added it, when a person did. */
  addedBy: uuid.nullable().default(null),
});

export const BillingRecordCardOutput = z.strictObject({
  workspaceId: uuid,
  cardId: uuid,
  isDefault: z.boolean(),
  /** `added`, or `updated` when the card was already there. */
  outcome: z.enum(['added', 'updated']),
});

/** What one card said when it was charged. */
export const BillingCardTry = z.strictObject({
  cardId: uuid,
  ok: z.boolean(),
  problem: z.string().trim().max(500).nullable().default(null),
});

/** What charging a later payment day did. */
export const BillingRecordPayDayInput = z.strictObject({
  workspaceId: uuid,
  /** The new paid-through date it was for. An answer about another one changes nothing. */
  to: z.iso.datetime(),
  outcome: z.enum(['paid', 'failed']),
  paymentRef: z.string().trim().max(255).nullable().default(null),
  paidCents: z.int().min(0).nullable().default(null),
  problem: z.string().trim().max(500).nullable().default(null),
  cards: z.array(BillingCardTry).max(20).default([]),
});

export const BillingRecordPayDayOutput = z.strictObject({
  workspaceId: uuid,
  outcome: z.enum(['moved', 'refused', 'already']),
});

// ---------- staff ----------

export const BillingAnswerMoreTimeInput = z.strictObject({
  requestId: uuid,
  grant: z.boolean(),
  /** The day to give them; their own day when left out. */
  until: isoDay.optional(),
});

export const BillingAnswerMoreTimeOutput = z.strictObject({
  requestId: uuid,
  workspaceId: uuid,
  status: z.enum(['granted', 'declined']),
  grantedUntil: isoDay.nullable(),
});

/** One business's plan billing, for its page in Admin. */
export const PlatformBillingBusinessInput = z.strictObject({ workspaceId: uuid });

export const PlatformBillingBusinessOutput = z.strictObject({
  workspaceId: uuid,
  owed: BillingOwed.nullable(),
  cardCount: z.int(),
  requests: z.array(
    z.strictObject({
      id: uuid,
      status: z.enum(['pending', 'granted', 'declined']),
      payBy: isoDay,
      note: z.string(),
      grantedUntil: isoDay.nullable(),
      ticketNumber: z.int().nullable(),
      askedBy: z.string().nullable(),
      askedAt: z.iso.datetime(),
      answeredAt: z.iso.datetime().nullable(),
    }),
  ),
});

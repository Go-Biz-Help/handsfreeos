/**
 * What goes in and out of the founding offers' commands (0091).
 *
 * Two lines run through all of it.
 *
 * **Nothing here decides whether a seat is free.** Not a `max(25)`, not a count read beforehand, not an
 * optimistic check in a handler. The database takes the seat under a row lock and refuses when there is none,
 * and every caller's job is to turn that refusal into words. A schema that also tried to know the cap would be
 * a second answer to a question that may only have one.
 *
 * **The claim link is shown once.** `founding.approve` returns it so an email can be sent; only its sha256 is
 * ever stored. `shownOnce` on the command keeps it out of the receipt that reaches somebody's phone.
 */
import { z } from 'zod';
import { displayName, email, uuid } from './common';

/** Offer ids are readable because they appear in URLs, in emails and in the website's own markup. */
export const offerId = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'Letters, numbers and underscores.');

export const grantStatus = z.enum(['reserved', 'active', 'revoked', 'expired']);
export const applicationStatus = z.enum([
  'pending',
  'approved',
  'declined',
  'waitlisted',
  'expired',
  'withdrawn',
]);
export const offerStatus = z.enum(['draft', 'open', 'closed']);
/** Where one attempt to pay for a seat has got to (0093). `pending` has no Stripe page yet. */
export const checkoutStatus = z.enum(['pending', 'open', 'paid', 'expired', 'failed']);
/** `once` is a founding seat, free or paid once. `monthly` is the plan: no seats, no applications (0092). */
export const offerBilling = z.enum(['once', 'monthly']);
export const planKind = z.enum(['founding_free', 'founding_lifetime', 'monthly']);
export const planStatus = z.enum(['active', 'grace', 'past_due', 'canceled']);

const shortText = (max: number) => z.string().trim().max(max);

// ---------- applying ----------

export const FoundingApplyInput = z.strictObject({
  offerId,
  businessName: displayName,
  contactName: displayName,
  email,
  phone: shortText(40).optional(),
  website: shortText(500).optional(),
  industry: shortText(120).optional(),
  teamSize: shortText(40).optional(),
  /** Their own words. The whole point of Phase 1 is reading these. */
  note: shortText(4000).default(''),
  /** utm, referrer, whatever the page knew. Never shown to them. */
  source: shortText(300).default(''),
});

export const FoundingApplyOutput = z.strictObject({
  applicationId: uuid,
  /**
   * `pending` means there was room and somebody will look at it. `waitlisted` means the offer was full or
   * closed when they pressed the button — said plainly rather than dressed up as success.
   */
  status: applicationStatus,
  offerId,
});

// ---------- deciding ----------

export const FoundingApproveInput = z.strictObject({
  applicationId: uuid,
  /** The business the seat belongs to. A seat is a business's, not a person's. */
  organizationId: uuid,
  note: shortText(2000).default(''),
});

export const FoundingApproveOutput = z.strictObject({
  grantId: uuid,
  offerId,
  expiresAt: z.iso.datetime(),
  /** The claim link's token. Returned once, stored only as a hash, kept out of the command receipt. */
  claimToken: z.string(),
  remaining: z.int(),
});

export const FoundingDecideInput = z.strictObject({
  applicationId: uuid,
  note: shortText(2000).default(''),
});

export const FoundingApplicationOutput = z.strictObject({
  applicationId: uuid,
  status: applicationStatus,
});

// ---------- claiming ----------

/** The claim link's token, exactly as the link carries it. */
const claimToken = z.string().trim().min(16).max(200);

export const FoundingClaimInput = z.strictObject({
  token: claimToken,
  workspaceId: uuid,
});

export const FoundingClaimOutput = z.strictObject({
  grantId: uuid,
  offerId,
  workspaceId: uuid,
  plan: planKind,
  /** What was put in the wallet to start them off, in cents. Zero on an offer that grants none. */
  creditedCents: z.int(),
});

export const FoundingClaimPreviewInput = z.strictObject({ token: claimToken });

/**
 * What the page a claim link opens needs to know, and nothing else: the offer, its price, the business it was
 * approved for, and where the seat stands. Only ever about the seat whose token was sent.
 */
export const FoundingClaimPreviewOutput = z.strictObject({
  /**
   * `ready` to take up or pay for, `claimed` when it already is, `expired` when the link ran out, and `gone`
   * when the seat was taken back or lapsed.
   */
  state: z.enum(['ready', 'claimed', 'expired', 'gone']),
  offerId,
  offerName: z.string(),
  priceCents: z.int(),
  /** The business the seat was approved for. Its workspaces are the only ones it can go on. */
  organizationId: uuid,
  businessName: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  /** A checkout already under way on this seat, to be picked up rather than started again. */
  checkoutId: uuid.nullable(),
  checkoutWorkspaceId: uuid.nullable(),
});

export const FoundingStartCheckoutInput = z.strictObject({
  token: claimToken,
  workspaceId: uuid,
});

export const FoundingStartCheckoutOutput = z.strictObject({
  checkoutId: uuid,
  status: checkoutStatus,
  /** Stripe's page, once the worker has made it. Null while it is being made — ask again in a moment. */
  url: z.string().nullable(),
  /** False when this picked up a checkout already under way instead of starting one. */
  created: z.boolean(),
});

export const FoundingCheckoutStatusInput = z.strictObject({ checkoutId: uuid });

export const FoundingCheckoutStatusOutput = z.strictObject({
  checkoutId: uuid,
  workspaceId: uuid,
  offerName: z.string(),
  amountCents: z.int(),
  status: checkoutStatus,
  url: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  /** True once the seat is on the workspace: what the page waits for after Stripe sends somebody back. */
  seatActive: z.boolean(),
  /** Why it did not go through, in words for the person who was paying. Empty when nothing went wrong. */
  problem: z.string(),
});

/** The worker made Stripe's page. */
export const FoundingRecordCheckoutOpenedInput = z.strictObject({
  workspaceId: uuid,
  checkoutId: uuid,
  sessionRef: z.string().trim().min(1).max(255),
  url: z.url().max(2000),
  expiresAt: z.iso.datetime().nullable(),
});

/** Stripe says the money is in. */
export const FoundingRecordCheckoutPaidInput = z.strictObject({
  workspaceId: uuid,
  checkoutId: uuid,
  sessionRef: z.string().trim().min(1).max(255),
  /** The PaymentIntent, when Stripe named one: what a refund is made against. */
  paymentRef: z.string().trim().max(255).nullable(),
  paidCents: z.int().min(0),
});

/** A checkout that will not be paid: the page lapsed, or it could not be made. */
export const FoundingRecordCheckoutClosedInput = z.strictObject({
  workspaceId: uuid,
  checkoutId: uuid,
  status: z.enum(['expired', 'failed']),
  problem: z.string().trim().max(1000).default(''),
});

export const FoundingCheckoutRecordOutput = z.strictObject({
  checkoutId: uuid,
  /**
   * `activated`: the seat is theirs. `already`: this was recorded before. `no_seat`: the money is in and the
   * seat is not — written on the checkout for staff. `opened`, `closed` and `unchanged` for the other two.
   */
  outcome: z.enum(['activated', 'already', 'no_seat', 'opened', 'closed', 'unchanged']),
});

// ---------- taking a seat back ----------

export const FoundingRevokeInput = z.strictObject({
  grantId: uuid,
  /** Required, and kept forever. A revocation nobody wrote a reason for cannot be explained later. */
  reason: z.string().trim().min(1, 'Say why.').max(1000),
});

export const FoundingGrantOutput = z.strictObject({
  grantId: uuid,
  offerId,
  organizationId: uuid,
  status: grantStatus,
  /** When the business's plan converts. Null when there is no workspace on the seat yet. */
  graceEndsAt: z.iso.datetime().nullable(),
  remaining: z.int(),
});

export const FoundingRestoreInput = z.strictObject({ grantId: uuid });

// ---------- the offer itself ----------

export const FoundingSetCapInput = z.strictObject({
  offerId,
  seatCap: z.int().min(0).max(100_000),
});

export const FoundingSetStatusInput = z.strictObject({ offerId, status: offerStatus });

export const FoundingOfferOutput = z.strictObject({
  offerId,
  name: z.string(),
  status: offerStatus,
  seatCap: z.int(),
  claimed: z.int(),
  remaining: z.int(),
  priceCents: z.int(),
  billing: offerBilling,
  /** What opens this one on its own. Null: only a person does. */
  opensAfterOfferId: offerId.nullable(),
  /** How many of that offer's seats first. Null with an offer set: when that offer is full. */
  opensAfterCount: z.int().nullable(),
  openedAt: z.iso.datetime().nullable(),
});

// ---------- reading ----------

export const FoundingCountsInput = z.strictObject({});

export const FoundingCountsOutput = z.strictObject({
  offers: z.array(
    z.strictObject({
      offerId,
      name: z.string(),
      blurb: z.string(),
      status: offerStatus,
      priceCents: z.int(),
      seatCap: z.int(),
      claimed: z.int(),
      remaining: z.int(),
      billing: offerBilling,
      /** Whether its numbers are for printing. Off for the monthly plan, whose seat count means nothing. */
      showCounter: z.boolean(),
      /**
       * A later founding offer has opened after this one, so it is no longer what is on sale — a seat freed in
       * it goes to somebody on the waitlist, not back on the website. The monthly plan never supersedes.
       */
      superseded: z.boolean(),
    }),
  ),
  generatedAt: z.iso.datetime(),
});

export const FoundingQueueInput = z.strictObject({
  offerId: offerId.optional(),
  status: applicationStatus.optional(),
  limit: z.int().min(1).max(200).default(50),
});

export const FoundingQueueOutput = z.strictObject({
  offers: z.array(FoundingOfferOutput),
  applications: z.array(
    z.strictObject({
      applicationId: uuid,
      offerId,
      businessName: z.string(),
      contactName: z.string(),
      email: z.string(),
      phone: z.string().nullable(),
      website: z.string().nullable(),
      industry: z.string().nullable(),
      teamSize: z.string().nullable(),
      note: z.string(),
      source: z.string(),
      status: applicationStatus,
      decisionNote: z.string(),
      createdAt: z.iso.datetime(),
      reviewedAt: z.iso.datetime().nullable(),
    }),
  ),
  grants: z.array(
    z.strictObject({
      grantId: uuid,
      offerId,
      organizationId: uuid,
      organizationName: z.string().nullable(),
      workspaceId: uuid.nullable(),
      status: grantStatus,
      reservedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime().nullable(),
      activatedAt: z.iso.datetime().nullable(),
      revokedAt: z.iso.datetime().nullable(),
      revokeReason: z.string(),
      graceEndsAt: z.iso.datetime().nullable(),
      /** The latest attempt to pay for this seat, if it is a paid one and somebody has started. */
      checkoutStatus: checkoutStatus.nullable(),
      /** Set when a payment needs a person: paid, but the seat could not be turned on. */
      checkoutProblem: z.string(),
    }),
  ),
});

export const FoundingMineInput = z.strictObject({ workspaceId: uuid });

export const FoundingMineOutput = z.strictObject({
  workspaceId: uuid,
  /** Null when this workspace has no plan row at all, which is every workspace until Phase 1 opens. */
  plan: planKind.nullable(),
  status: planStatus.nullable(),
  priceCents: z.int(),
  /** Set only while a revoked founding deal is working out its notice. */
  graceEndsAt: z.iso.datetime().nullable(),
  offerName: z.string().nullable(),
});

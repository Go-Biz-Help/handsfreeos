/**
 * What goes in and out of the affiliate program's commands and look-ups (20261027014000,
 * HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md).
 *
 * People who sell HandsFreeOS itself: a person applies for themselves, staff decide and set the shares, and a
 * business made through an affiliate's link is credited to them as it's made.
 */
import { z } from 'zod';
import { displayName, isoDateTime, uuid } from './common';
import { offerBilling } from './founding';

export const AFFILIATE_STATUSES = [
  'applied',
  'approved',
  'turned_down',
  'paused',
  'ended',
] as const;
export const affiliateStatus = z.enum(AFFILIATE_STATUSES);
export type AffiliateStatus = (typeof AFFILIATE_STATUSES)[number];

/** How a business came to be an affiliate's: their link, a code typed on the plan page (part 3), or staff by hand. */
export const AFFILIATE_REFERRAL_HOWS = ['link', 'code', 'by_hand'] as const;
export const affiliateReferralHow = z.enum(AFFILIATE_REFERRAL_HOWS);
export type AffiliateReferralHow = (typeof AFFILIATE_REFERRAL_HOWS)[number];

/**
 * Words a link may not carry, because they read as HandsFreeOS's own or could be mistaken for a page of ours. The
 * database checks the shape; this list is the only part it doesn't know.
 */
export const RESERVED_AFFILIATE_CODES: readonly string[] = [
  'admin',
  'affiliate',
  'affiliates',
  'api',
  'app',
  'billing',
  'founding',
  'handsfreeos',
  'handsfree',
  'help',
  'hfos',
  'official',
  'partner',
  'partners',
  'pricing',
  'staff',
  'support',
  'team',
  'www',
];

/** What an affiliate's link carries: `handsfreeos.com/?ref=<code>`. Lowercase, so a code is one code however it's typed. */
export const affiliateCode = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'A link code is at least 3 letters or digits.')
  .max(24, 'A link code is at most 24 letters or digits.')
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
    'Use letters, digits and dashes, starting and ending with a letter or digit.',
  )
  .refine((c) => !RESERVED_AFFILIATE_CODES.includes(c), {
    message: 'That word is kept for HandsFreeOS. Pick another link code, like your name.',
  });

/**
 * A discount or trial code (20261027014300): typed in any case, kept lowercase, the same shape as a link code. A kept
 * word is refused here too.
 */
export const affiliateDiscountCode = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'A code is at least 3 letters or digits.')
  .max(24, 'A code is at most 24 letters or digits.')
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
    'Use letters, digits and dashes, starting and ending with a letter or digit.',
  )
  .refine((c) => !RESERVED_AFFILIATE_CODES.includes(c), {
    message: 'That word is kept for HandsFreeOS. Pick another code.',
  });

/** The most a code takes off, in basis points: 5000 is 50%. Never past 90%, so a charge is never nothing. */
export const affiliateMaxDiscountBp = z
  .int()
  .min(100, 'The limit is at least 1% off.')
  .max(9000, 'The limit can’t be more than 90% off.');

/** A share in basis points: 4000 is 40%. */
export const affiliateRateBp = z
  .int()
  .min(1, 'A share is at least 0.01%.')
  .max(10_000, 'A share can’t be more than 100%.');

// ---------- codes (20261027014300) ----------

/** What a code gives: a percent or dollars off, for some months or for good, a trial, or a trial then a discount. */
const codeTerms = {
  code: affiliateDiscountCode,
  /** The plan it's for, or null for any plan. */
  offerId: z.string().trim().min(1).max(60).nullable().default(null),
  percentOffBp: z.int().min(1).max(9000).nullable().default(null),
  amountOffCents: z.int().min(1).max(1_000_000).nullable().default(null),
  /** How many months the discount lasts; null for good. */
  discountMonths: z.int().min(1).max(36).nullable().default(null),
  trialDays: z
    .union([z.literal(7), z.literal(14), z.literal(30)])
    .nullable()
    .default(null),
};

type CodeGives = {
  percentOffBp: number | null;
  amountOffCents: number | null;
  trialDays: number | null;
};
/** A percent or dollars off, not both. */
const notBoth = (v: CodeGives) => v.percentOffBp === null || v.amountOffCents === null;
/** A discount, a trial, or both. */
const something = (v: CodeGives) =>
  v.percentOffBp !== null || v.amountOffCents !== null || v.trialDays !== null;

/** An affiliate makes one of their own. */
export const AffiliateMakeCodeInput = z
  .strictObject(codeTerms)
  .refine(notBoth, {
    message: 'Pick a percent or dollars off, not both.',
    path: ['amountOffCents'],
  })
  .refine(something, { message: 'Pick a discount, a free trial, or both.', path: ['trialDays'] });
/** Staff make one for an affiliate, or a house code with `affiliateId` null. */
export const AffiliatesMakeCodeInput = z
  .strictObject({ affiliateId: uuid.nullable(), ...codeTerms })
  .refine(notBoth, {
    message: 'Pick a percent or dollars off, not both.',
    path: ['amountOffCents'],
  })
  .refine(something, { message: 'Pick a discount, a free trial, or both.', path: ['trialDays'] });

export const AffiliateTurnCodeInput = z.strictObject({ codeId: uuid, on: z.boolean() });

/** One affiliate's own limit, or null for everyone's. */
export const AffiliateSetMaxDiscountInput = z.strictObject({
  affiliateId: uuid,
  maxDiscountBp: affiliateMaxDiscountBp.nullable(),
});

export const AffiliateCodeRow = z.strictObject({
  codeId: uuid,
  /** Null for a house code. */
  affiliateId: uuid.nullable(),
  code: z.string(),
  offerId: z.string().nullable(),
  percentOffBp: z.int().nullable(),
  amountOffCents: z.int().nullable(),
  discountMonths: z.int().nullable(),
  trialDays: z.int().nullable(),
  status: z.enum(['on', 'off']),
  /** Staff turned it off; only staff turn it back on. */
  offByStaff: z.boolean(),
  /** Businesses that bought their plan with it. */
  paidUses: z.int(),
  createdAt: isoDateTime,
});

export type AffiliateCodeRow = z.infer<typeof AffiliateCodeRow>;

export const AffiliateCodeOutput = z.strictObject({ code: AffiliateCodeRow });

/** A plan a code can be for, for the form that makes one. */
export const AffiliateCodePlan = z.strictObject({
  offerId: z.string(),
  name: z.string(),
  priceCents: z.int(),
  billing: offerBilling,
});

// ---------- applying (the person themselves) ----------

export const AffiliateApplyInput = z.strictObject({
  /** The name we call them by, in emails and on the Admin area's list. */
  name: displayName,
  code: affiliateCode,
  /** How they'll share HandsFreeOS, in their own words. */
  pitch: z.string().trim().max(2000).default(''),
  /** Their website and social pages, one a line. */
  links: z.string().trim().max(1000).default(''),
  /** Payouts are to US bank accounts only, to start (decision 7). */
  livesInUs: z.boolean(),
  /**
   * They ticked that they agree to the affiliate terms that count now (20261027014500), which is kept with the
   * application. Optional only so a page from before the terms still sends; it's asked for again before the link.
   */
  acceptTerms: z.boolean().optional(),
});

export const AffiliateApplyOutput = z.strictObject({
  affiliateId: uuid,
  /** False when they changed an application already waiting, or applied again after being turned down. */
  created: z.boolean(),
});

/** Agreeing to the affiliate terms (20261027014500): the version they read, which must be the one that counts. */
export const AffiliateAcceptTermsInput = z.strictObject({
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export const AffiliateAcceptTermsOutput = z.strictObject({
  /** False when they'd already agreed to this version. */
  changed: z.boolean(),
});

/**
 * What an affiliate has earned (20261027014200), less what refunds took back. Each share waits 30 days for refunds
 * (decision 8), then is ready for the next monthly payout.
 */
export const AffiliateEarnings = z.strictObject({
  earnedCents: z.int(),
  /** Still in its 30 days. */
  waitingCents: z.int(),
  /** Past its 30 days and in no payout yet. */
  readyCents: z.int(),
  /** In a payout being sent, or waiting on Stripe (20261027014400). */
  onItsWayCents: z.int(),
  /** Sent to their bank. */
  paidCents: z.int(),
});

/** Where an affiliate's bank at Stripe stands (20261027014400), for their page and staff's. */
export const AffiliateBank = z.strictObject({
  state: z.enum(['none', 'unfinished', 'ready', 'stopped']),
  /** What Stripe still asks them for, by its own field names. */
  due: z.array(z.string()),
  /** Made with Stripe's test keys: it only ever takes test money. */
  test: z.boolean(),
});

/** One month's payout to an affiliate (20261027014400). */
export const AffiliatePayoutRow = z.strictObject({
  payoutId: uuid,
  /** The first of the month it's for. */
  month: z.iso.date(),
  amountCents: z.int(),
  /** sending: on its way. held: Stripe won't take it for them yet. paid: sent. */
  status: z.enum(['sending', 'held', 'paid']),
  paidAt: isoDateTime.nullable(),
  /** Made with Stripe's test keys: no real money moved. */
  test: z.boolean(),
});

/** A business that earned an affiliate something, as their own page shows it: the name, and nothing else of it. */
export const AffiliatePayingBusiness = z.strictObject({
  /** Null once the business closed its account for good. */
  name: z.string().nullable(),
  firstPaidAt: isoDateTime.nullable(),
  earnedCents: z.int(),
});

/** The signed-in person's own affiliate standing, for their page. Null when they haven't applied. */
export const AffiliateMineInput = z.strictObject({});
export const AffiliateMine = z.strictObject({
  affiliateId: uuid,
  status: affiliateStatus,
  name: z.string(),
  code: z.string(),
  pitch: z.string(),
  links: z.string(),
  /** Their share: their own when staff set one, else everyone's. */
  rateBp: z.int(),
  appliedAt: isoDateTime,
  decidedAt: isoDateTime.nullable(),
  /** When a turned-down person may apply again. Null otherwise. */
  applyAgainFrom: isoDateTime.nullable(),
  /** Clicks on their link: the last 30 days, and ever. */
  clicks30: z.int(),
  clicksAll: z.int(),
  /** Their codes, newest first. */
  codes: z.array(AffiliateCodeRow),
  /** The most their codes may take off now: their own limit or everyone's. */
  maxDiscountBp: z.int(),
  /** Businesses credited to them, paying or not. */
  signUps: z.int(),
  /** The ones that paid, newest first. */
  payingBusinesses: z.array(AffiliatePayingBusiness),
  earnings: AffiliateEarnings,
  /** Their bank at Stripe, and their payouts, newest first (20261027014400). */
  bank: AffiliateBank,
  payouts: z.array(AffiliatePayoutRow),
  /**
   * Whether they agreed to the affiliate terms that count now, and when they last agreed to any (20261027014500).
   * Until they agree, their page asks first, before their link and codes.
   */
  termsAccepted: z.boolean(),
  termsAcceptedAt: isoDateTime.nullable(),
});
export const AffiliateMineOutput = z.strictObject({
  affiliate: AffiliateMine.nullable(),
  /** Everyone's share, for the page that asks them to apply. */
  defaultRateBp: z.int(),
  /** Whether staff have turned payouts on (20261027014400). */
  payoutsOn: z.boolean(),
  /** The plans on sale, for making a code. */
  plans: z.array(AffiliateCodePlan),
});

// ---------- staff: the program ----------

export const AffiliatesSaveSettingsInput = z.strictObject({
  rateBp: affiliateRateBp,
  /** The most any affiliate's code takes off (decision 19). Left out, it stays as it is. */
  maxDiscountBp: affiliateMaxDiscountBp.optional(),
  /** Whether affiliates are paid each month (20261027014400). Left out, it stays as it is. */
  payoutsOn: z.boolean().optional(),
});
export const AffiliatesSettingsOutput = z.strictObject({
  rateBp: z.int(),
  maxDiscountBp: z.int(),
  payoutsOn: z.boolean(),
});

export const AffiliateDecideInput = z.strictObject({
  affiliateId: uuid,
  decision: z.enum(['approve', 'turn_down']),
});

/** Pausing stops new businesses being credited and new shares being earned; ending is for good. */
export const AffiliateSetStatusInput = z.strictObject({
  affiliateId: uuid,
  status: z.enum(['approved', 'paused', 'ended']),
});

/** Their own share, or null for everyone's. */
export const AffiliateSetRateInput = z.strictObject({
  affiliateId: uuid,
  rateBp: affiliateRateBp.nullable(),
});

export const AffiliateSetCodeInput = z.strictObject({ affiliateId: uuid, code: affiliateCode });

export const AffiliateRow = z.strictObject({
  affiliateId: uuid,
  userId: uuid,
  name: z.string(),
  email: z.string(),
  code: z.string(),
  status: affiliateStatus,
  pitch: z.string(),
  links: z.string(),
  /** Their own share, or null for everyone's. */
  ownRateBp: z.int().nullable(),
  /** What they earn now: their own share or everyone's. */
  rateBp: z.int(),
  appliedAt: isoDateTime,
  decidedAt: isoDateTime.nullable(),
  decidedByName: z.string().nullable(),
  clicks30: z.int(),
  clicksAll: z.int(),
  /** Businesses credited to them. */
  businesses: z.int(),
  /** Everything they've earned, less what refunds took back. */
  earnedCents: z.int(),
  /** Their own limit on codes, or null for everyone's; and the limit that counts now. */
  ownMaxDiscountBp: z.int().nullable(),
  maxDiscountBp: z.int(),
  /** The affiliate terms they agreed to, by version, and when (20261027014500); null until they have. */
  termsVersion: z.string().nullable(),
  termsAcceptedAt: isoDateTime.nullable(),
});

export const AffiliateOutput = z.strictObject({ affiliate: AffiliateRow });

export const PlatformAffiliatesInput = z.strictObject({
  limit: z.int().min(1).max(500).default(200),
});
export const PlatformAffiliatesOutput = z.strictObject({
  settings: AffiliatesSettingsOutput,
  /** Codes that belong to no affiliate, newest first. */
  houseCodes: z.array(AffiliateCodeRow),
  /** The plans on sale, for making a code. */
  plans: z.array(AffiliateCodePlan),
  /** Waiting for a decision, oldest first. */
  applications: z.array(AffiliateRow),
  /** Everyone decided: approved, paused, ended and turned down, newest first. */
  affiliates: z.array(AffiliateRow),
});

export const AffiliateBusiness = z.strictObject({
  organizationId: uuid,
  /** Its first business, for the link to its page under Admin → Businesses. Null once it has none. */
  workspaceId: uuid.nullable(),
  name: z.string(),
  how: affiliateReferralHow,
  clickedAt: isoDateTime.nullable(),
  referredAt: isoDateTime,
  markedByName: z.string().nullable(),
  /** What it has earned them, less refunds. */
  earnedCents: z.int(),
});

export const affiliateCommissionKind = z.enum(['earned', 'taken_back', 'given_back']);
export type AffiliateCommissionKind = z.infer<typeof affiliateCommissionKind>;

/** One share earned, taken back by a refund, or given back when the refund failed. */
export const AffiliateCommission = z.strictObject({
  commissionId: uuid,
  kind: affiliateCommissionKind,
  /** The business it's from; null once it closed its account for good. */
  businessName: z.string().nullable(),
  /** What was paid, or refunded, and the share it was worked out at. */
  baseCents: z.int(),
  rateBp: z.int(),
  /** Negative when taken back. */
  amountCents: z.int(),
  earnedAt: isoDateTime,
  payableAt: isoDateTime,
});

export const PlatformAffiliateInput = z.strictObject({ affiliateId: uuid });
export const PlatformAffiliateOutput = z.strictObject({
  affiliate: AffiliateRow,
  businesses: z.array(AffiliateBusiness),
  earnings: AffiliateEarnings,
  /** The last 100, newest first. */
  commissions: z.array(AffiliateCommission),
  /** Their codes, newest first, and the plans a code can be for. */
  codes: z.array(AffiliateCodeRow),
  plans: z.array(AffiliateCodePlan),
  /** Their bank at Stripe, and their payouts, newest first. */
  bank: AffiliateBank,
  payouts: z.array(AffiliatePayoutRow),
  /** Their link's clicks a day, the last 30 days that had any, newest first. */
  clicks: z.array(z.strictObject({ day: z.iso.date(), clicks: z.int() })),
});

// ---------- staff: one business's affiliate ----------

export const AffiliateSetBusinessInput = z.strictObject({
  workspaceId: uuid,
  /** Null takes the business off whoever it was credited to. */
  affiliateId: uuid.nullable(),
});
export const AffiliateOfBusiness = z.strictObject({
  affiliateId: uuid,
  name: z.string(),
  code: z.string(),
  status: affiliateStatus,
  how: affiliateReferralHow,
  clickedAt: isoDateTime.nullable(),
  referredAt: isoDateTime,
});
export const AffiliateSetBusinessOutput = z.strictObject({
  organizationId: uuid,
  affiliate: AffiliateOfBusiness.nullable(),
});

export const PlatformAffiliateOfBusinessInput = z.strictObject({ workspaceId: uuid });
export const PlatformAffiliateOfBusinessOutput = z.strictObject({
  organizationId: uuid,
  affiliate: AffiliateOfBusiness.nullable(),
  /** Approved affiliates to pick from, by name. */
  choices: z.array(z.strictObject({ affiliateId: uuid, name: z.string(), code: z.string() })),
});

// ---------- a business made through a link ----------

/** What the web hands `organization.create` from the website's link: the code, and when it was clicked. */
export const AffiliateSignup = z.strictObject({
  code: z.string().trim().toLowerCase().min(1).max(64),
  how: z.enum(['link', 'code']).default('link'),
  clickedAt: isoDateTime.nullable().default(null),
});

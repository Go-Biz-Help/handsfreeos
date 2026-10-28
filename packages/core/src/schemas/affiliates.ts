/**
 * What goes in and out of the affiliate program's commands and look-ups (20261027014000,
 * HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md).
 *
 * People who sell HandsFreeOS itself: a person applies for themselves, staff decide and set the shares, and a
 * business made through an affiliate's link is credited to them as it's made.
 */
import { z } from 'zod';
import { displayName, isoDateTime, uuid } from './common';

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

/** A share in basis points: 4000 is 40%. */
export const affiliateRateBp = z
  .int()
  .min(1, 'A share is at least 0.01%.')
  .max(10_000, 'A share can’t be more than 100%.');

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
});

export const AffiliateApplyOutput = z.strictObject({
  affiliateId: uuid,
  /** False when they changed an application already waiting, or applied again after being turned down. */
  created: z.boolean(),
});

/**
 * What an affiliate has earned (20261027014200), less what refunds took back. Each share waits 30 days for refunds
 * (decision 8), then is ready for the next monthly payout.
 */
export const AffiliateEarnings = z.strictObject({
  earnedCents: z.int(),
  /** Still in its 30 days. */
  waitingCents: z.int(),
  /** Past its 30 days and not paid yet. */
  readyCents: z.int(),
  /** Paid out to them. Payouts come in part 4, so nothing yet. */
  paidCents: z.int(),
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
  /** Businesses credited to them, paying or not. */
  signUps: z.int(),
  /** The ones that paid, newest first. */
  payingBusinesses: z.array(AffiliatePayingBusiness),
  earnings: AffiliateEarnings,
});
export const AffiliateMineOutput = z.strictObject({
  affiliate: AffiliateMine.nullable(),
  /** Everyone's share, for the page that asks them to apply. */
  defaultRateBp: z.int(),
});

// ---------- staff: the program ----------

export const AffiliatesSaveSettingsInput = z.strictObject({ rateBp: affiliateRateBp });
export const AffiliatesSettingsOutput = z.strictObject({ rateBp: z.int() });

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
});

export const AffiliateOutput = z.strictObject({ affiliate: AffiliateRow });

export const PlatformAffiliatesInput = z.strictObject({
  limit: z.int().min(1).max(500).default(200),
});
export const PlatformAffiliatesOutput = z.strictObject({
  settings: AffiliatesSettingsOutput,
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

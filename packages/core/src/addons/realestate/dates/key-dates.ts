/**
 * The dates a deal's duties rest on (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Terms and their history"):
 * each typed in with where it came from, and confirmed by a person before anything relies on it. A duty resting on a
 * contract date starts as a draft until that date is confirmed (Chris, 2026-09-30). Browser-safe and pure.
 */

/** Where a value came from. */
export const TERM_SOURCES = [
  'contract',
  'amendment',
  'counter',
  'addendum',
  'correction',
  'lender',
  'title',
  'agreement',
  'typed',
] as const;
export type TermSource = (typeof TERM_SOURCES)[number];

export interface KeyDateDef {
  readonly label: string;
  /** Which deals have it. */
  readonly sides: readonly ('buyer' | 'listing')[];
  /** Set by the purchase contract or its amendments: duties resting on it wait for it to be confirmed. */
  readonly contract: boolean;
}

export const KEY_DATES = {
  acceptance: { label: 'Contract accepted', sides: ['buyer', 'listing'], contract: true },
  offer_expiration: { label: 'Offer expires', sides: ['buyer', 'listing'], contract: false },
  emd_due: { label: 'Earnest money due', sides: ['buyer', 'listing'], contract: true },
  inspection_end: { label: 'Inspection period ends', sides: ['buyer', 'listing'], contract: true },
  financing_end: {
    label: 'Financing contingency ends',
    sides: ['buyer', 'listing'],
    contract: true,
  },
  appraisal_end: {
    label: 'Appraisal contingency ends',
    sides: ['buyer', 'listing'],
    contract: true,
  },
  title_objection_end: {
    label: 'Title objections due',
    sides: ['buyer', 'listing'],
    contract: true,
  },
  hoa_review_end: {
    label: 'HOA document review ends',
    sides: ['buyer', 'listing'],
    contract: true,
  },
  home_sale_end: {
    label: 'Home-sale contingency ends',
    sides: ['buyer', 'listing'],
    contract: true,
  },
  survey_due: { label: 'Survey due', sides: ['buyer', 'listing'], contract: true },
  walkthrough: { label: 'Final walkthrough', sides: ['buyer', 'listing'], contract: false },
  closing: { label: 'Closing', sides: ['buyer', 'listing'], contract: true },
  possession: { label: 'Possession', sides: ['buyer', 'listing'], contract: true },
  rate_lock_expiry: { label: 'Rate lock ends', sides: ['buyer'], contract: false },
  preapproval_expiry: { label: 'Preapproval ends', sides: ['buyer'], contract: false },
  cd_received: { label: 'Closing Disclosure received', sides: ['buyer'], contract: false },
  buyer_agreement_expiry: {
    label: 'Buyer agreement ends',
    sides: ['buyer'],
    contract: false,
  },
  listing_agreement_expiry: {
    label: 'Listing agreement ends',
    sides: ['listing'],
    contract: false,
  },
  listing_launch: { label: 'Listing goes live', sides: ['listing'], contract: false },
} as const satisfies Record<string, KeyDateDef>;

export type KeyDateKey = keyof typeof KEY_DATES;
export const KEY_DATE_KEYS = Object.keys(KEY_DATES) as [KeyDateKey, ...KeyDateKey[]];

/** One key date as a deal has it now. */
export interface KeyDateValue {
  /** Local date in the business's time zone. */
  readonly date: string;
  /** 'HH:MM' when the source gives a time ("5:00 PM"); otherwise it's due at 11:59 pm. */
  readonly time?: string | null;
  readonly source: TermSource;
  /** A person confirmed it (typed in by hand counts once they save it; a conflict is never confirmed). */
  readonly confirmed: boolean;
}

export type KeyDates = Readonly<Partial<Record<KeyDateKey, KeyDateValue>>>;

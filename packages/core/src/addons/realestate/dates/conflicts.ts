/**
 * Checks across a deal's dates (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Dates"): what can't be right, or
 * needs a person to look, however each date was entered. Each says which dates it's about, in plain words, and how
 * serious: a `problem` makes the deal red, a `warning` yellow (step 10). None of this is legal advice, and none of it
 * changes a date: conflicts are never resolved silently. Browser-safe and pure.
 */
import { daysBetween } from '../../../calendar/engine/zoned';
import { fmtDateShort } from '../../../calendar/when';
import { addBusinessDays, dayOff, NO_CLOSED_DAYS, type BusinessCalendar } from './business-days';
import { KEY_DATES, type KeyDateKey, type KeyDates } from './key-dates';

export const DATE_CHECKS = [
  'closing_before_acceptance',
  'contingency_after_closing',
  'rate_lock_before_closing',
  'closing_disclosure_timing',
  'closing_not_business_day',
  'preapproval_before_closing',
  'buyer_agreement_before_closing',
  'listing_agreement_before_closing',
  'linked_sale_after_purchase',
] as const;
export type DateCheck = (typeof DATE_CHECKS)[number];

export interface DateProblem {
  readonly check: DateCheck;
  readonly severity: 'problem' | 'warning';
  readonly keys: readonly KeyDateKey[];
  /** What's wrong and what to do, in the add-on's words. */
  readonly words: string;
}

export interface DealDates {
  readonly side: 'buyer' | 'listing';
  readonly keyDates: KeyDates;
  readonly calendar?: BusinessCalendar;
  /** The purchase is paid for with a loan: the Closing Disclosure applies. */
  readonly financed?: boolean;
  /** For a buyer deal linked to the client's own sale: that sale's closing. */
  readonly linkedSaleClosing?: string | null;
  /** Today, where the business is. */
  readonly today: string;
}

const CONTINGENCIES = [
  'inspection_end',
  'financing_end',
  'appraisal_end',
  'title_objection_end',
  'hoa_review_end',
  'home_sale_end',
] as const satisfies readonly KeyDateKey[];

/** "Tue, Oct 6". */
const day = fmtDateShort;

const label = (k: KeyDateKey) => KEY_DATES[k].label;

/** Every check that fails for a deal's dates, most serious first. */
export function checkDealDates(input: DealDates): DateProblem[] {
  const d = input.keyDates;
  const calendar = input.calendar ?? NO_CLOSED_DAYS;
  const closing = d.closing?.date ?? null;
  const out: DateProblem[] = [];
  const add = (p: DateProblem) => out.push(p);

  if (closing && d.acceptance && closing < d.acceptance.date)
    add({
      check: 'closing_before_acceptance',
      severity: 'problem',
      keys: ['closing', 'acceptance'],
      words: `Closing (${day(closing)}) is before the contract was accepted (${day(d.acceptance.date)}). Check both dates against the contract.`,
    });

  if (closing)
    for (const k of CONTINGENCIES) {
      const v = d[k];
      if (v && v.date > closing)
        add({
          check: 'contingency_after_closing',
          severity: 'problem',
          keys: [k, 'closing'],
          words: `${label(k)} (${day(v.date)}) is after closing (${day(closing)}). Check the contract, or an amendment that moved one of them.`,
        });
    }

  if (input.side === 'buyer' && closing && d.rate_lock_expiry && d.rate_lock_expiry.date < closing)
    add({
      check: 'rate_lock_before_closing',
      severity: 'problem',
      keys: ['rate_lock_expiry', 'closing'],
      words: `The rate lock ends ${day(d.rate_lock_expiry.date)}, before closing on ${day(closing)}. Ask the lender about extending it.`,
    });

  // The Closing Disclosure has to be in the buyer's hands three business days before closing (financed purchases).
  if (input.side === 'buyer' && input.financed && closing) {
    const latest = addBusinessDays(closing, -3, calendar).date;
    if (d.cd_received && d.cd_received.date > latest)
      add({
        check: 'closing_disclosure_timing',
        severity: 'problem',
        keys: ['cd_received', 'closing'],
        words: `The Closing Disclosure came ${day(d.cd_received.date)}, less than three business days before closing on ${day(closing)}. Ask the lender whether closing has to move.`,
      });
    else if (!d.cd_received && input.today >= latest)
      add({
        check: 'closing_disclosure_timing',
        severity: 'problem',
        keys: ['cd_received', 'closing'],
        words: `There's no Closing Disclosure yet, and closing on ${day(closing)} is three business days away or less. Ask the lender when it went out.`,
      });
  }

  if (closing) {
    const off = dayOff(closing, calendar);
    if (off)
      add({
        check: 'closing_not_business_day',
        severity: 'warning',
        keys: ['closing'],
        words: `Closing on ${day(closing)} falls on ${off.reason === 'weekend' ? 'a weekend' : off.name}. Check the title company is open.`,
      });
  }

  const endsFirst = (
    k: 'preapproval_expiry' | 'buyer_agreement_expiry' | 'listing_agreement_expiry',
    check: DateCheck,
    what: string,
  ) => {
    const v = d[k];
    if (closing && v && v.date < closing)
      add({
        check,
        severity: 'warning',
        keys: [k, 'closing'],
        words: `${what} ends ${day(v.date)}, before closing on ${day(closing)}.`,
      });
  };
  if (input.side === 'buyer') {
    endsFirst('preapproval_expiry', 'preapproval_before_closing', 'The preapproval');
    endsFirst('buyer_agreement_expiry', 'buyer_agreement_before_closing', 'The buyer agreement');
  } else
    endsFirst(
      'listing_agreement_expiry',
      'listing_agreement_before_closing',
      'The listing agreement',
    );

  if (
    input.side === 'buyer' &&
    closing &&
    input.linkedSaleClosing &&
    input.linkedSaleClosing > closing
  )
    add({
      check: 'linked_sale_after_purchase',
      severity: 'problem',
      keys: ['closing'],
      words: `The client's sale closes ${day(input.linkedSaleClosing)}, after this purchase closes on ${day(closing)}. Check how the purchase is funded, and whether either date should move.`,
    });

  return out.sort(
    (a, b) =>
      Number(b.severity === 'problem') - Number(a.severity === 'problem') ||
      DATE_CHECKS.indexOf(a.check) - DATE_CHECKS.indexOf(b.check),
  );
}

/** How many days a date is from today, for words like "in 3 days" (negative when it's past). */
export const daysUntil = (date: string, today: string): number => daysBetween(today, date);

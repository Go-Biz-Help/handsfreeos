/**
 * What RCS costs a business, and how it is said (0104). Browser-safe: the RCS card shows these lines, the
 * worker puts the same lines on the Stripe page and the receipts, and the commands write the totals down.
 *
 * **Honest on purpose.** Most of the money is the carriers' and Aegis's, passed on at what they charge; only
 * the setup and the yearly upkeep are ours, and the screen says which is which:
 *
 *   carrier onboarding   $500  once       the US carriers' fee for launching an RCS sender, passed on
 *   brand vetting        $200  a year     Aegis checks the brand for the carriers, passed on
 *   setup                $100  once       HandsFreeOS makes the sender at Twilio and sees it through review
 *   upkeep               $15   a year     from the second year, with the vetting renewal
 *
 * So the first year is $800 and every year after it $215. A price changed here moves new requests only: each
 * request keeps the totals it was sold at (`app.rcs_requests.first_year_cents` and `yearly_cents`).
 */

export interface RcsFeeLine {
  readonly key: 'carrier_onboarding' | 'brand_vetting' | 'setup' | 'upkeep';
  /** What the screen and the receipt call it. */
  readonly name: string;
  /** Who the money is for, and how often, in a few words. */
  readonly detail: string;
  readonly cents: number;
  readonly when: 'once' | 'yearly';
  /** Passed on at what the carriers or Aegis charge, with nothing added. */
  readonly passedOn: boolean;
  /** Paid in the first year; the yearly lines that aren't start with the second. */
  readonly firstYear: boolean;
  /** Paid every year after the first. */
  readonly renewal: boolean;
}

export const RCS_FEE_LINES: readonly RcsFeeLine[] = [
  {
    key: 'carrier_onboarding',
    name: 'Carrier onboarding',
    detail: 'Once. The US carriers’ fee for launching an RCS sender, passed on at cost.',
    cents: 50_000,
    when: 'once',
    passedOn: true,
    firstYear: true,
    renewal: false,
  },
  {
    key: 'brand_vetting',
    name: 'Brand vetting by Aegis',
    detail: 'Every year. Aegis checks your brand for the carriers, passed on at cost.',
    cents: 20_000,
    when: 'yearly',
    passedOn: true,
    firstYear: true,
    renewal: true,
  },
  {
    key: 'setup',
    name: 'Setup by HandsFreeOS',
    detail: 'Once. We make your sender at Twilio and see it through the carriers’ review.',
    cents: 10_000,
    when: 'once',
    passedOn: false,
    firstYear: true,
    renewal: false,
  },
  {
    key: 'upkeep',
    name: 'Yearly upkeep',
    detail: 'Every year from the second. We keep your sender and its vetting current.',
    cents: 1_500,
    when: 'yearly',
    passedOn: false,
    firstYear: false,
    renewal: true,
  },
];

const sum = (lines: readonly RcsFeeLine[]) => lines.reduce((n, l) => n + l.cents, 0);

/** The first year's lines, as the Stripe page lists them. */
export const RCS_FIRST_YEAR_LINES = RCS_FEE_LINES.filter((l) => l.firstYear);
/** Every later year's lines, as the renewal's receipt names them. */
export const RCS_RENEWAL_LINES = RCS_FEE_LINES.filter((l) => l.renewal);

/** $800: carrier onboarding, the first year's vetting, and setup. */
export const RCS_FIRST_YEAR_CENTS = sum(RCS_FIRST_YEAR_LINES);
/** $215: the vetting renewal and the upkeep. */
export const RCS_YEARLY_CENTS = sum(RCS_RENEWAL_LINES);

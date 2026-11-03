/**
 * What registering a local number for texting costs a business (0105). Browser-safe: the registration wizard
 * shows these lines before anything is sent, the command writes them down, and the worker puts them on the
 * Stripe page and the card.
 *
 * **Passed on at cost.** Every line is what The Campaign Registry and the carriers charge HandsFreeOS for the
 * business's 10DLC registration, with nothing added:
 *
 *   brand registration    $4.50   once, when the brand is first registered
 *   secondary vetting     $41.50  once, with the brand, unless it texts under 1,000 a month (Low-Volume Standard)
 *   campaign vetting      $15     each time the campaign goes to the carriers, a resubmission included
 *   campaign              $10     a month, from the month the carriers approve it
 *
 * Toll-free verification costs nothing, so it has no lines.
 *
 * The first three are paid before the registration goes to the carriers; nothing is sent until they are. The
 * campaign's month is charged to the card that paid them, on the day each month starts.
 */

export type TextingFeeKey = 'brand' | 'secondary_vetting' | 'campaign_vetting' | 'campaign_month';

export interface TextingFeeLine {
  readonly key: TextingFeeKey;
  readonly name: string;
  readonly detail: string;
  readonly cents: number;
}

export const TEXTING_FEES: Readonly<Record<TextingFeeKey, TextingFeeLine>> = {
  brand: {
    key: 'brand',
    name: 'Brand registration',
    detail: 'Once. The Campaign Registry records your business for texting.',
    cents: 450,
  },
  secondary_vetting: {
    key: 'secondary_vetting',
    name: 'Brand vetting',
    detail: 'Once. The carriers check businesses that text 1,000 or more a month.',
    cents: 4_150,
  },
  campaign_vetting: {
    key: 'campaign_vetting',
    name: 'Campaign review',
    detail: 'Each time your texting campaign goes to the carriers, a resubmission included.',
    cents: 1_500,
  },
  campaign_month: {
    key: 'campaign_month',
    name: 'Texting campaign',
    detail: 'Every month from approval, while your campaign is registered.',
    cents: 1_000,
  },
};

/** A month of the campaign: what the card is charged each month from approval. */
export const TEXTING_CAMPAIGN_MONTH_CENTS = TEXTING_FEES.campaign_month.cents;

/**
 * What the business has already sent or paid for, which is what decides what a send costs now. Worked out from
 * the registration's steps and the fees paid (or let through) before: `phone.setup_status` returns it, so the
 * wizard shows the same price the command charges.
 */
export interface TextingFeesPaidFor {
  /** The brand reached The Campaign Registry: its fees are behind it, whatever they were. */
  readonly brandSent: boolean;
  /** A fee for the brand was paid, though the brand hasn't gone yet. */
  readonly brandPaid: boolean;
  /** The brand's vetting was paid. */
  readonly vettingPaid: boolean;
  /** The campaign's next send is paid for: a review paid since the campaign last went to the carriers. */
  readonly campaignCovered: boolean;
  /** HandsFreeOS's own business (`workspaces.is_platform`): the carriers' fees are ours, so it's never charged. */
  readonly ours?: boolean;
}

/**
 * What sending a local registration now costs. The rule the command charges by and the wizard shows:
 *
 * - the brand, until it has gone or been paid for (a brand is registered once);
 * - its vetting, when it hasn't gone yet and the business texts 1,000 or more a month, unless paid already;
 * - the campaign's review, unless the send it is about is already paid for: a new campaign, or one the carriers
 *   turned down, goes again and is reviewed again.
 *
 * An unpaid fee from an earlier send isn't added on: anything still unpaid is simply still owed here. HandsFreeOS's
 * own business owes nothing.
 */
export function textingFeeLines(
  input: TextingFeesPaidFor & { readonly monthlyVolume: string },
): TextingFeeLine[] {
  if (input.ours) return [];
  const lines: TextingFeeLine[] = [];
  if (!input.brandSent && !input.brandPaid) lines.push(TEXTING_FEES.brand);
  if (!input.brandSent && !input.vettingPaid && input.monthlyVolume !== 'under_1000')
    lines.push(TEXTING_FEES.secondary_vetting);
  if (!input.campaignCovered) lines.push(TEXTING_FEES.campaign_vetting);
  return lines;
}

export const textingFeeTotal = (lines: readonly { readonly cents: number }[]): number =>
  lines.reduce((n, l) => n + l.cents, 0);

/**
 * What a seller would take home from an offer (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing
 * core"; the spec's X-04 "Seller net sheet"). An estimate, never a settlement statement: the price, less the listing's
 * fee, what the buyer's agent asks the seller to pay, the seller's credit, what's owed on the mortgage, title and
 * escrow, transfer tax and other costs. Whole cents throughout; a share of the price rounds to the nearest cent.
 * Browser-safe and pure: the agent's page, the seller's portal and the Assistant work it out the same way.
 */

/** The figures the agent keeps for the estimate. */
export interface NetFigures {
  readonly payoffCents: number;
  /** The listing's fee: a share of the price (basis points), or an amount. */
  readonly listingFeeBp: number | null;
  readonly listingFeeCents: number | null;
  readonly titleEscrowCents: number;
  readonly transferTaxBp: number;
  readonly otherCents: number;
  readonly otherNote?: string | null;
}

/** What an offer says that moves the seller's net. */
export interface OfferForNet {
  readonly priceCents: number;
  readonly sellerCreditCents: number;
  readonly buyerAgentFeeBp: number | null;
  readonly buyerAgentFeeCents: number | null;
}

export type NetLineKey =
  | 'price'
  | 'listing_fee'
  | 'buyer_agent_fee'
  | 'seller_credit'
  | 'payoff'
  | 'title_escrow'
  | 'transfer_tax'
  | 'other';

export interface NetLine {
  readonly key: NetLineKey;
  readonly label: string;
  /** Added to the price (positive) or taken from it (negative). */
  readonly cents: number;
}

/** A share of a price in basis points, to the nearest cent. */
export const shareOf = (priceCents: number, bp: number): number =>
  Math.round((priceCents * bp) / 10_000);

const pct = (bp: number) => `${(bp / 100).toLocaleString('en-US', { maximumFractionDigits: 3 })}%`;

/** Each line of the estimate, in order, and what the seller would take home. */
export function netEstimate(
  offer: OfferForNet,
  f: NetFigures,
): { lines: NetLine[]; netCents: number } {
  const listingFee =
    f.listingFeeBp !== null ? shareOf(offer.priceCents, f.listingFeeBp) : (f.listingFeeCents ?? 0);
  const buyerFee =
    offer.buyerAgentFeeBp !== null
      ? shareOf(offer.priceCents, offer.buyerAgentFeeBp)
      : (offer.buyerAgentFeeCents ?? 0);
  const transferTax = shareOf(offer.priceCents, f.transferTaxBp);
  const lines: NetLine[] = [
    { key: 'price', label: 'Price', cents: offer.priceCents },
    {
      key: 'listing_fee',
      label: f.listingFeeBp !== null ? `Listing fee · ${pct(f.listingFeeBp)}` : 'Listing fee',
      cents: -listingFee,
    },
    {
      key: 'buyer_agent_fee',
      label:
        offer.buyerAgentFeeBp !== null
          ? `Their agent’s fee · ${pct(offer.buyerAgentFeeBp)}`
          : 'Their agent’s fee',
      cents: -buyerFee,
    },
    { key: 'seller_credit', label: 'Seller credit', cents: -offer.sellerCreditCents },
    { key: 'payoff', label: 'Mortgage payoff', cents: -f.payoffCents },
    { key: 'title_escrow', label: 'Title and escrow', cents: -f.titleEscrowCents },
    { key: 'transfer_tax', label: `Transfer tax · ${pct(f.transferTaxBp)}`, cents: -transferTax },
    {
      key: 'other',
      label: f.otherNote ? `Other costs · ${f.otherNote}` : 'Other costs',
      cents: -f.otherCents,
    },
  ];
  return { lines, netCents: lines.reduce((sum, l) => sum + l.cents, 0) };
}

/** The figures before the agent has saved any: nothing owed, no fee, nothing else. */
export const EMPTY_NET_FIGURES: NetFigures = {
  payoffCents: 0,
  listingFeeBp: null,
  listingFeeCents: null,
  titleEscrowCents: 0,
  transferTaxBp: 0,
  otherCents: 0,
  otherNote: null,
};

/** The four things a seller can say about an offer in their portal. */
export const SELLER_CHOICES = {
  accept: 'Accept',
  counter: 'Counter',
  decline: 'Decline',
  talk: 'Let’s talk',
} as const;
export type SellerChoice = keyof typeof SELLER_CHOICES;
export const SELLER_CHOICE_KEYS = Object.keys(SELLER_CHOICES) as [SellerChoice, ...SellerChoice[]];

/**
 * A listing (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing core"): the home's facts and where
 * each came from, the seller's questionnaire, the rule that nothing public goes before the MLS, and the words the
 * screens, the portal and the Assistant share. Browser-safe and pure.
 */
import {
  factWords,
  LISTING_FACTS,
  LISTING_FACT_KEYS,
  type ListingFactKey,
  type ListingFacts,
} from './homes';

/** A listing's own facts: a home's, without a price (its list price is the deal's `list_price`, signed off apart). */
export const LISTING_HOME_FACT_KEYS = LISTING_FACT_KEYS.filter(
  (k): k is Exclude<ListingFactKey, 'price_cents'> => k !== 'price_cents',
);
export type ListingHomeFactKey = (typeof LISTING_HOME_FACT_KEYS)[number];
export type ListingHomeFacts = Omit<ListingFacts, 'price_cents'>;

/** Where a fact came from (Chris, 2026-10-01: the seller's questionnaire, the old listing's words, or the agent). */
export const FACT_FROM = {
  seller: 'From the seller’s questionnaire',
  pasted: 'From the old listing',
  agent: 'Typed by you',
} as const;
export type FactFrom = keyof typeof FACT_FROM;
export const FACT_FROM_KEYS = Object.keys(FACT_FROM) as [FactFrom, ...FactFrom[]];

/** The seller's questionnaire: the home's facts as they know them, and two things in their own words. */
export interface SellerAnswers {
  readonly facts?: ListingHomeFacts;
  /** What they've updated, and when. */
  readonly updates?: string;
  /** What they love most about it. */
  readonly loves?: string;
}

/** The questionnaire's questions, in order, as the portal asks them. */
export const SELLER_QUESTIONS = {
  updates: 'What have you updated, and when?',
  loves: 'What do you love most about it?',
} as const;

export interface FactCandidate {
  readonly from: FactFrom;
  readonly value: unknown;
  /** The old listing's words it was found in. */
  readonly quote: string | null;
  readonly words: string;
}

export interface FactChoice {
  readonly key: ListingHomeFactKey;
  readonly label: string;
  /** What the agent confirmed, if anything. */
  readonly confirmed: FactCandidate | null;
  /** What the seller and the old listing say, when they say anything. */
  readonly candidates: FactCandidate[];
  /** They say different things: the agent picks one, or types the right one. */
  readonly disagree: boolean;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Each of the listing's facts: what's confirmed, what the seller and the old listing say, and whether they agree. */
export function factChoices(input: {
  readonly confirmed: Record<string, unknown>;
  readonly confirmedSources: Record<string, { readonly from: FactFrom; readonly quote?: string }>;
  readonly seller: ListingHomeFacts | null;
  readonly pasted: Record<string, unknown>;
  readonly pastedQuotes: Record<string, string>;
}): FactChoice[] {
  return LISTING_HOME_FACT_KEYS.map((key) => {
    const candidates: FactCandidate[] = [];
    const seller = input.seller?.[key];
    if (seller !== undefined && seller !== null)
      candidates.push({
        from: 'seller',
        value: seller,
        quote: null,
        words: factWords(key, seller),
      });
    const pasted = input.pasted[key];
    if (pasted !== undefined && pasted !== null)
      candidates.push({
        from: 'pasted',
        value: pasted,
        quote: input.pastedQuotes[key] ?? null,
        words: factWords(key, pasted),
      });
    const value = input.confirmed[key];
    const source = input.confirmedSources[key];
    const confirmed: FactCandidate | null =
      value === undefined || value === null
        ? null
        : {
            from: source?.from ?? 'agent',
            value,
            quote: source?.quote ?? null,
            words: factWords(key, value),
          };
    const disagree =
      candidates.length > 1 && !candidates.every((c) => sameValue(c.value, candidates[0]!.value));
    return { key, label: LISTING_FACTS[key].label, confirmed, candidates, disagree };
  });
}

/** The listing's address, as its public page's: `2207 Juniper Trail, Austin, TX` → `2207-juniper-trail`. */
export function listingSlugFrom(address: string): string {
  const street = address.split(',')[0] ?? address;
  const slug = street
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
  return slug || 'home';
}

/** The street part of an address: what the screens and the words call the home. */
export const streetOf = (address: string): string => (address.split(',')[0] ?? address).trim();

/**
 * Nothing public before the MLS (Chris, 2026-10-01): the page, the flyer, the email or text to contacts, the social
 * posts, the open house sign-in and matching all wait until the listing is live on it.
 */
export function notOnMlsWords(address: string): string {
  return `${streetOf(address)} isn’t live on the MLS yet, so it can’t be shared outside your office. Mark it live on the listing page once it is.`;
}

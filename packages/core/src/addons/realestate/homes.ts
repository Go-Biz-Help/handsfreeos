/**
 * Homes on a buyer deal (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): the facts a home
 * can have, how an address is compared, the words for where the agent has it, and how well it fits what the buyer
 * wants. Browser-safe and pure: the web, the portal, the phone and the Assistant say the same thing.
 */
import { money } from '../../money/format';

/** The facts a home can have, in the order they're shown. Money in cents; areas in square feet. */
export const LISTING_FACTS = {
  price_cents: { label: 'Price', kind: 'money' },
  beds: { label: 'Bedrooms', kind: 'count' },
  baths: { label: 'Bathrooms', kind: 'half' },
  sqft: { label: 'Square feet', kind: 'count' },
  lot_sqft: { label: 'Lot (square feet)', kind: 'count' },
  year_built: { label: 'Year built', kind: 'year' },
  hoa_monthly_cents: { label: 'HOA a month', kind: 'money' },
  property_type: { label: 'Type', kind: 'type' },
  garage_spaces: { label: 'Garage spaces', kind: 'count' },
} as const;
export type ListingFactKey = keyof typeof LISTING_FACTS;
export const LISTING_FACT_KEYS = Object.keys(LISTING_FACTS) as [
  ListingFactKey,
  ...ListingFactKey[],
];

/** The kinds of home a buyer looks for, and a home is. */
export const HOME_TYPES = {
  single_family: 'Single-family',
  condo: 'Condo',
  townhouse: 'Townhouse',
  multi_family: 'Multi-family',
  manufactured: 'Manufactured',
  land: 'Land',
} as const;
export type HomeType = keyof typeof HOME_TYPES;
export const HOME_TYPE_KEYS = Object.keys(HOME_TYPES) as [HomeType, ...HomeType[]];

export interface ListingFacts {
  readonly price_cents?: number;
  readonly beds?: number;
  readonly baths?: number;
  readonly sqft?: number;
  readonly lot_sqft?: number;
  readonly year_built?: number;
  readonly hoa_monthly_cents?: number;
  readonly property_type?: HomeType;
  readonly garage_spaces?: number;
}

/** Where the agent has a home. */
export const HOME_STATUSES = {
  saved: 'Saved',
  shortlisted: 'Shortlisted',
  toured: 'Toured',
  offered: 'Offer made',
  passed: 'Passed',
  removed: 'Removed',
} as const;
export type HomeStatus = keyof typeof HOME_STATUSES;
export const HOME_STATUS_KEYS = Object.keys(HOME_STATUSES) as [HomeStatus, ...HomeStatus[]];

/** An address as compared: "12 Main St., Austin, TX" and "12 main st austin tx" are the same home. */
export function addressKey(address: string): string {
  return address
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\b(street)\b/g, 'st')
    .replace(/\b(avenue)\b/g, 'ave')
    .replace(/\b(road)\b/g, 'rd')
    .replace(/\b(drive)\b/g, 'dr')
    .replace(/\b(lane)\b/g, 'ln')
    .replace(/\b(court)\b/g, 'ct')
    .replace(/\b(boulevard)\b/g, 'blvd')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A fact as it reads: "$525,000", "2.5", "1,850", "Townhouse". */
export function factWords(key: ListingFactKey, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  const kind = LISTING_FACTS[key].kind;
  if (kind === 'money' && typeof value === 'number') return money(value);
  if (kind === 'type') return HOME_TYPES[value as HomeType] ?? String(value);
  if (typeof value === 'number')
    return kind === 'year' ? String(value) : value.toLocaleString('en-US');
  return String(value);
}

/** What the buyer wants, as far as fit reads it. */
export interface FitProfile {
  readonly budgetMinCents: number | null;
  readonly budgetMaxCents: number | null;
  readonly areas: readonly string[];
  readonly homeTypes: readonly string[];
  readonly bedsMin: number | null;
  readonly bathsMin: number | null;
  readonly sqftMin: number | null;
}

/**
 * A buyer's profile as kept (`buyer_profiles`), the same whether the server reads its row or a phone its copy. Baths
 * are a decimal: text from the database, a number from the phone's JSON.
 */
export interface BuyerProfileFields {
  readonly budgetMinCents: number | null;
  readonly budgetMaxCents: number | null;
  readonly areas: string[];
  readonly homeTypes: string[];
  readonly bedsMin: number | null;
  readonly bathsMin: string | number | null;
  readonly sqftMin: number | null;
  readonly moveBy: string | null;
  readonly mustHaves: string[];
  readonly dealBreakers: string[];
  readonly version: number;
  /** ISO time. */
  readonly updatedAt: string;
}

/** What the buyer wants, as the screens show it, with who saved it last. */
export const buyerProfileOut = (
  p: BuyerProfileFields,
  updatedBy: { id: string; fullName: string } | null,
) => ({
  budgetMinCents: p.budgetMinCents,
  budgetMaxCents: p.budgetMaxCents,
  areas: p.areas,
  homeTypes: p.homeTypes,
  bedsMin: p.bedsMin,
  bathsMin: p.bathsMin === null ? null : Number(p.bathsMin),
  sqftMin: p.sqftMin,
  moveBy: p.moveBy,
  mustHaves: p.mustHaves,
  dealBreakers: p.dealBreakers,
  version: p.version,
  updatedAt: p.updatedAt,
  updatedBy,
});

/** What fit reads of a buyer's profile; nothing asked for when there's no profile yet. */
export const fitProfileOf = (
  p: Pick<
    BuyerProfileFields,
    'budgetMinCents' | 'budgetMaxCents' | 'areas' | 'homeTypes' | 'bedsMin' | 'bathsMin' | 'sqftMin'
  > | null,
): FitProfile => ({
  budgetMinCents: p?.budgetMinCents ?? null,
  budgetMaxCents: p?.budgetMaxCents ?? null,
  areas: p?.areas ?? [],
  homeTypes: p?.homeTypes ?? [],
  bedsMin: p?.bedsMin ?? null,
  bathsMin: p?.bathsMin === null || p?.bathsMin === undefined ? null : Number(p.bathsMin),
  sqftMin: p?.sqftMin ?? null,
});

/** One thing the buyer asked for, against the home: met, missed, or not known yet. */
export interface FitLine {
  readonly key: 'budget' | 'area' | 'type' | 'beds' | 'baths' | 'sqft';
  readonly met: boolean | null;
  readonly words: string;
}

export interface Fit {
  readonly lines: readonly FitLine[];
  readonly met: number;
  readonly missed: number;
  readonly unknown: number;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * How a home fits what the buyer wants, one line per thing they asked for. Only what's known counts: a fact the home
 * doesn't have yet is "not known", never a miss. Must-haves and deal-breakers are for the agent to judge, so they
 * aren't here.
 */
export function homeFit(profile: FitProfile, facts: ListingFacts, address: string): Fit {
  const lines: FitLine[] = [];
  const price = facts.price_cents;
  if (profile.budgetMaxCents !== null || profile.budgetMinCents !== null) {
    if (price === undefined) lines.push({ key: 'budget', met: null, words: 'Price not known yet' });
    else if (profile.budgetMaxCents !== null && price > profile.budgetMaxCents)
      lines.push({
        key: 'budget',
        met: false,
        words: `${money(price - profile.budgetMaxCents)} over budget`,
      });
    else if (profile.budgetMinCents !== null && price < profile.budgetMinCents)
      lines.push({ key: 'budget', met: false, words: 'Under their price range' });
    else lines.push({ key: 'budget', met: true, words: 'Within budget' });
  }
  if (profile.areas.length) {
    const lower = address.toLowerCase();
    const area = profile.areas.find((a) => a.trim() && lower.includes(a.trim().toLowerCase()));
    lines.push(
      area
        ? { key: 'area', met: true, words: `In ${area.trim()}` }
        : { key: 'area', met: null, words: 'Check the area' },
    );
  }
  if (profile.homeTypes.length) {
    const t = facts.property_type;
    lines.push(
      t === undefined
        ? { key: 'type', met: null, words: 'Type not known yet' }
        : profile.homeTypes.includes(t)
          ? { key: 'type', met: true, words: HOME_TYPES[t] }
          : { key: 'type', met: false, words: `${HOME_TYPES[t]}, not what they want` },
    );
  }
  const atLeast = (
    key: 'beds' | 'baths' | 'sqft',
    want: number | null,
    have: number | undefined,
    noun: string,
    many?: string,
  ) => {
    if (want === null) return;
    if (have === undefined) lines.push({ key, met: null, words: `${noun} not known yet` });
    else
      lines.push({
        key,
        met: have >= want,
        words:
          have >= want
            ? plural(have, noun.toLowerCase(), many)
            : `Only ${plural(have, noun.toLowerCase(), many)}`,
      });
  };
  atLeast('beds', profile.bedsMin, facts.beds, 'Bedroom');
  atLeast('baths', profile.bathsMin, facts.baths, 'Bathroom');
  atLeast('sqft', profile.sqftMin, facts.sqft, 'Square foot', 'square feet');
  return {
    lines,
    met: lines.filter((l) => l.met === true).length,
    missed: lines.filter((l) => l.met === false).length,
    unknown: lines.filter((l) => l.met === null).length,
  };
}

/**
 * Whether one of the business's own listings is worth suggesting to a buyer's agent (round three, step 11): within
 * their budget, nothing they asked for missed, and at least one more thing met. What isn't known yet never counts
 * against it; the agent judges the rest.
 */
export function suggestsListing(fit: Fit): boolean {
  return (
    fit.missed === 0 && fit.met >= 2 && fit.lines.some((l) => l.key === 'budget' && l.met === true)
  );
}

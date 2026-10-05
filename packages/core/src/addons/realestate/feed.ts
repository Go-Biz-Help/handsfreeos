/**
 * Listing data from a feed (round five, step 3): one shape for what Repliers, AnyProp and an MLS's own RESO Web API
 * send, so everything that uses a feed (a home's facts, buyers' new matches, sold comps, our listings' status) reads
 * the same thing whoever supplied it. Field meanings follow RESO's Data Dictionary; money is in cents and areas in
 * square feet, as everywhere else in the add-on.
 *
 * Each listing says where it came from (the supplier, the MLS) and when the MLS last changed it, and carries what
 * the MLS asks to be shown with it (its notice and logo, and whose listing it is). A feed is a source of facts,
 * never of authority: what it brings is shown as "from the MLS" and a person confirms what matters.
 *
 * Browser-safe and pure: the worker's adapters build these, the commands check them, the screens show them.
 */
import { z } from 'zod';
import { money } from '../../money/format';
import { HOME_TYPE_KEYS, LISTING_FACT_KEYS, type HomeType, type ListingFacts } from './homes';
import { publicStatus } from './listing';

/** Where a listing stands on the MLS, in our words. */
export const FEED_STATUSES = {
  coming_soon: 'Coming soon',
  active: 'For sale',
  pending: 'Pending',
  sold: 'Sold',
  off_market: 'Off the market',
} as const;
export type FeedStatus = keyof typeof FEED_STATUSES;
export const FEED_STATUS_KEYS = Object.keys(FEED_STATUSES) as [FeedStatus, ...FeedStatus[]];

/** RESO's StandardStatus, as each supplier says it, in our words. Anything else reads as off the market. */
export function feedStatusOf(standardStatus: string | null | undefined): FeedStatus {
  switch ((standardStatus ?? '').trim().toLowerCase()) {
    case 'coming soon':
      return 'coming_soon';
    case 'active':
      return 'active';
    case 'active under contract':
    case 'pending':
      return 'pending';
    case 'closed':
      return 'sold';
    default:
      return 'off_market';
  }
}

/** The StandardStatus values each of our statuses covers, for asking a feed. */
export const STANDARD_STATUSES: Readonly<Record<FeedStatus, readonly string[]>> = {
  coming_soon: ['Coming Soon'],
  active: ['Active'],
  pending: ['Active Under Contract', 'Pending'],
  sold: ['Closed'],
  off_market: ['Canceled', 'Expired', 'Withdrawn', 'Hold'],
};

/** What kind of home a listing is, from the words its MLS uses (RESO's PropertySubType or PropertyType). */
export function homeTypeOf(...words: (string | null | undefined)[]): HomeType | null {
  const text = words.filter(Boolean).join(' ').toLowerCase();
  if (!text) return null;
  if (/condo|apartment|co-?op|stock cooperative/.test(text)) return 'condo';
  if (/town ?house|townhome|row ?house/.test(text)) return 'townhouse';
  if (/duplex|triplex|quadruplex|fourplex|multi.?family|multiple units/.test(text))
    return 'multi_family';
  if (/manufactured|mobile/.test(text)) return 'manufactured';
  if (/\bland\b|\blots?\b|acreage|unimproved/.test(text)) return 'land';
  if (/single family|residential|detached|house|cabin|farm|ranch/.test(text))
    return 'single_family';
  return null;
}

/** RESO's PropertySubType names for each kind of home, for asking a feed. */
export const SUB_TYPES: Readonly<Record<HomeType, readonly string[]>> = {
  single_family: ['Single Family Residence'],
  condo: ['Condominium', 'Stock Cooperative'],
  townhouse: ['Townhouse'],
  multi_family: ['Duplex', 'Triplex', 'Quadruplex'],
  manufactured: ['Manufactured Home', 'Mobile Home', 'Manufactured On Land'],
  land: [],
};

/** Baths in halves, from full and half baths where the MLS splits them, else its total. */
export function bathsOf(
  full: number | null | undefined,
  half: number | null | undefined,
  total: number | null | undefined,
): number | undefined {
  if (typeof full === 'number' && full >= 0)
    return full + (typeof half === 'number' && half > 0 ? half * 0.5 : 0);
  if (typeof total === 'number' && total >= 0) return Math.round(total * 2) / 2;
  return undefined;
}

/** Dollars, as a feed sends them, to cents; nothing for a missing or silly amount. */
export function centsOf(dollars: unknown): number | undefined {
  const n = typeof dollars === 'string' ? Number(dollars.replace(/[$,\s]/g, '')) : dollars;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 1_000_000_000) return undefined;
  return Math.round(n * 100);
}

/** A whole, positive count or area; nothing otherwise. */
export function countOf(value: unknown, max = 10_000_000): number | undefined {
  const n = typeof value === 'string' ? Number(value.replace(/[,\s]/g, '')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max) return undefined;
  return Math.round(n);
}

/** A date (YYYY-MM-DD) from what a feed sends (a date or a timestamp); null otherwise. */
export function dayOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return m ? m[1]! : null;
}

const isoOrNull = z.string().max(40).nullable();
const cents = z.int().min(1).max(100_000_000_000);

/** One listing from a feed. */
export const FeedListingSchema = z.object({
  /** The supplier (repliers, anyprop, reso). */
  provider: z.string().max(40),
  /** The MLS it's on: its id at the supplier and its name, where known. */
  mls: z.object({ id: z.string().max(80).nullable(), name: z.string().max(200).nullable() }),
  /** The supplier's own key for the listing: unique within the supplier. */
  listingKey: z.string().min(1).max(200),
  /** The MLS number people know it by (RESO's ListingId). */
  mlsNumber: z.string().min(1).max(80),
  status: z.enum(FEED_STATUS_KEYS),
  /** The MLS's own word for where it stands. */
  standardStatus: z.string().max(80).nullable(),
  address: z.object({
    /** "1204 Elm St" */
    line: z.string().max(300),
    unit: z.string().max(40).nullable(),
    city: z.string().max(120).nullable(),
    state: z.string().max(40).nullable(),
    zip: z.string().max(20).nullable(),
    /** Some MLSs ask that a listing's address not be shown in public. */
    hidden: z.boolean(),
  }),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  facts: z.object({
    price_cents: cents.optional(),
    beds: z.int().min(0).max(100).optional(),
    baths: z.number().min(0).max(100).optional(),
    sqft: z.int().min(0).max(10_000_000).optional(),
    lot_sqft: z.int().min(0).max(1_000_000_000).optional(),
    year_built: z.int().min(1600).max(2100).optional(),
    hoa_monthly_cents: z.int().min(0).max(100_000_000).optional(),
    property_type: z.enum(HOME_TYPE_KEYS).optional(),
    garage_spaces: z.int().min(0).max(100).optional(),
  }),
  listPriceCents: cents.nullable(),
  originalPriceCents: cents.nullable(),
  soldPriceCents: cents.nullable(),
  listedOn: z.string().max(10).nullable(),
  soldOn: z.string().max(10).nullable(),
  daysOnMarket: z.int().min(0).max(100_000).nullable(),
  description: z.string().max(20_000).nullable(),
  photos: z
    .array(z.object({ url: z.url().max(2000), caption: z.string().max(500).nullable() }))
    .max(60),
  listAgent: z.string().max(200).nullable(),
  listOffice: z.string().max(200).nullable(),
  /** When the MLS last changed it (RESO's ModificationTimestamp). */
  updatedAt: isoOrNull,
  /** What its MLS asks to be shown with it. */
  display: z.object({
    notice: z.string().max(4000).nullable(),
    logoUrl: z.url().max(2000).nullable(),
    /** "Listing courtesy of Hill Country Realty." */
    courtesy: z.string().max(300).nullable(),
  }),
});
export type FeedListing = z.infer<typeof FeedListingSchema>;

/** What a feed is asked for. */
export const FeedSearchSchema = z.object({
  statuses: z.array(z.enum(FEED_STATUS_KEYS)).min(1).max(5).default(['active']),
  priceMinCents: cents.optional(),
  priceMaxCents: cents.optional(),
  bedsMin: z.int().min(0).max(20).optional(),
  bathsMin: z.number().min(0).max(20).optional(),
  sqftMin: z.int().min(0).max(100_000).optional(),
  sqftMax: z.int().min(0).max(100_000).optional(),
  types: z.array(z.enum(HOME_TYPE_KEYS)).max(6).optional(),
  zips: z
    .array(z.string().regex(/^\d{5}$/))
    .max(20)
    .optional(),
  cities: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  near: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      miles: z.number().min(0.1).max(50),
    })
    .optional(),
  /** Sold in the last this many days (sold listings only). */
  soldWithinDays: z.int().min(1).max(730).optional(),
  /** Changed on the MLS since (ISO time). */
  updatedSince: z.string().max(40).optional(),
  mlsNumbers: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  /** A street address ("1204 Elm St, Austin, TX 78704"): matched on its number and street. */
  address: z.string().trim().min(3).max(300).optional(),
  limit: z.int().min(1).max(100).default(25),
  page: z.int().min(0).max(1000).default(0),
});
export type FeedSearch = z.input<typeof FeedSearchSchema>;
export type FeedSearchQuery = z.output<typeof FeedSearchSchema>;

/** A street address split for asking a feed: its number, the first word of its street, and its ZIP. */
export function addressParts(address: string): {
  number: string | null;
  street: string | null;
  zip: string | null;
} {
  const first = address.split(',')[0]!.trim();
  const m = /^(\d+[a-z]?)\s+(?:[nsew]\.?\s+|north\s+|south\s+|east\s+|west\s+)?([a-z0-9']+)/i.exec(
    first,
  );
  const zip = /\b(\d{5})(?:-\d{4})?\s*$/.exec(address.trim());
  return { number: m?.[1] ?? null, street: m?.[2] ?? null, zip: zip?.[1] ?? null };
}

/** A listing's facts as the add-on keeps a home's (only those the feed had). */
export function feedFacts(listing: Pick<FeedListing, 'facts'>): ListingFacts {
  return Object.fromEntries(
    Object.entries(listing.facts).filter(([, v]) => v !== undefined && v !== null),
  ) as ListingFacts;
}

/** "1204 Elm St, Unit 3, Austin, TX 78704" */
export function feedAddressWords(a: FeedListing['address']): string {
  const place = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.line, a.unit ? `Unit ${a.unit}` : null, place].filter(Boolean).join(', ');
}

/** A listing as the add-on keeps it on a home, a listing or a comp: what the feed said, and when it was asked. */
export const MlsSnapshotSchema = FeedListingSchema.extend({ checkedAt: z.string().max(40) });
export type MlsSnapshot = z.infer<typeof MlsSnapshotSchema>;

/** Each supplier's name, as people read it. */
export const FEED_SUPPLIERS: Readonly<Record<string, string>> = {
  repliers: 'Repliers',
  anyprop: 'AnyProp',
  reso: 'your MLS’s feed',
  standin: 'the stand-in MLS',
};

/** "From the MLS (Unlock MLS, through Repliers)": where a value from the feed came from. */
export function mlsSourceWords(s: Pick<FeedListing, 'provider' | 'mls'>): string {
  const supplier = FEED_SUPPLIERS[s.provider] ?? s.provider;
  const mls = s.mls.name && s.mls.name !== s.mls.id ? s.mls.name : null;
  if (s.provider === 'standin') return 'From the stand-in MLS';
  if (s.provider === 'reso') return mls ? `From the MLS (${mls})` : 'From the MLS';
  return mls ? `From the MLS (${mls}, through ${supplier})` : `From the MLS, through ${supplier}`;
}

/** Where looking a home or listing up on the feed stands, in words; null when there's nothing to say. */
export function mlsStateWords(
  state: 'none' | 'looking' | 'found' | 'not_found' | 'failed',
  failure: string | null,
): string | null {
  switch (state) {
    case 'looking':
      return 'Looking it up on the MLS…';
    case 'not_found':
      return 'The MLS has no listing at this address. Check the address, or look it up by its MLS number.';
    case 'failed':
      return failure ?? 'The MLS couldn’t be asked just now. Try again in a few minutes.';
    default:
      return null;
  }
}

export const MLS_STATE_KEYS = ['none', 'looking', 'found', 'not_found', 'failed'] as const;
export type MlsState = (typeof MLS_STATE_KEYS)[number];

/** The facts where the feed and what's kept disagree: each with both values, for a person to pick. */
export function mlsDiffers(
  kept: ListingFacts,
  mls: ListingFacts,
  keys: readonly (keyof ListingFacts)[],
): (keyof ListingFacts)[] {
  return keys.filter((k) => {
    const a = kept[k];
    const b = mls[k];
    return a !== undefined && a !== null && b !== undefined && b !== null && a !== b;
  });
}

/** What the screens show of a kept snapshot, beside the facts a person kept. */
export function mlsOut(snapshot: MlsSnapshot, kept: ListingFacts) {
  const facts = feedFacts(snapshot);
  return {
    mlsNumber: snapshot.mlsNumber,
    status: snapshot.status,
    statusWords: FEED_STATUSES[snapshot.status],
    sourceWords: mlsSourceWords(snapshot),
    listPriceCents: snapshot.listPriceCents,
    soldPriceCents: snapshot.soldPriceCents,
    soldOn: snapshot.soldOn,
    daysOnMarket: snapshot.daysOnMarket,
    facts,
    photos: snapshot.photos.slice(0, 12),
    description: snapshot.description,
    differs: mlsDiffers(kept, facts, LISTING_FACT_KEYS),
    display: snapshot.display,
    checkedAt: snapshot.checkedAt,
  };
}

/** Where finding comps on the feed stands, in words; null when there's nothing to say. */
export function compsStateWords(
  state: 'none' | 'finding' | 'found' | 'none_found' | 'failed',
  failure: string | null,
  added?: number,
): string | null {
  switch (state) {
    case 'finding':
      return 'Finding homes sold nearby on the MLS…';
    case 'found':
      return added === undefined
        ? 'Homes sold nearby came from the MLS. Tick the ones to count.'
        : `${added} ${added === 1 ? 'home' : 'homes'} sold nearby came from the MLS. Tick the ones to count.`;
    case 'none_found':
      return 'The MLS had no homes sold that close in that time. Look further out, or further back.';
    case 'failed':
      return failure ?? 'The MLS couldn’t be asked just now. Try again in a few minutes.';
    default:
      return null;
  }
}

/** Where our listing and the MLS disagree: its price or where it stands. Flagged for a person, never copied over. */
export interface FeedDifference {
  readonly key: 'price' | 'status';
  readonly words: string;
}

const OURS_WORDS = {
  for_sale: 'for sale',
  under_contract: 'under contract',
  sold: 'sold',
} as const;
const FEED_AS_OURS: Readonly<Record<FeedStatus, 'for_sale' | 'under_contract' | 'sold' | null>> = {
  coming_soon: 'for_sale',
  active: 'for_sale',
  pending: 'under_contract',
  sold: 'sold',
  off_market: null,
};

export function listingFeedDiffers(
  ours: {
    readonly stage: string;
    readonly listPriceCents: number | null;
    readonly closed: boolean;
  },
  mls: Pick<FeedListing, 'status' | 'listPriceCents'>,
): FeedDifference[] {
  const out: FeedDifference[] = [];
  const here = ours.closed ? 'sold' : publicStatus(ours.stage);
  const there = FEED_AS_OURS[mls.status];
  // Before it's on the market here, the MLS showing it for sale is what marks it live, not a difference.
  if (here !== null && there !== here)
    out.push({
      key: 'status',
      words: `The MLS shows it ${FEED_STATUSES[mls.status].toLowerCase()}; here it’s ${OURS_WORDS[here]}. Move the deal’s stage if the MLS is right, or fix the listing in your MLS.`,
    });
  if (
    here === 'for_sale' &&
    mls.listPriceCents !== null &&
    ours.listPriceCents !== null &&
    mls.listPriceCents !== ours.listPriceCents
  )
    out.push({
      key: 'price',
      words: `The MLS shows ${money(mls.listPriceCents)}; the deal’s list price is ${money(ours.listPriceCents)}. Change whichever is wrong: the list price here, or the listing in your MLS.`,
    });
  return out;
}

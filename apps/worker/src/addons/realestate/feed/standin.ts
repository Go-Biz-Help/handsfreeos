/**
 * The stand-in listing supplier (round five, step 3): what every listing feed answers with in development and tests
 * (ADDON_CONNECTORS=fake), so nothing leaves the worker. Its key tester takes any key but one with "wrong" in it.
 *
 * It holds a made-up MLS ("Stand-in MLS") of homes around Austin, Texas: for sale, pending, coming soon and sold
 * over the last year, each with its facts, photos and courtesy line, and answers every question a real feed does,
 * worked out here. A test or the browser tests add their own (`putStandinListing`), such as a business's own
 * listing going live.
 */
import {
  addressParts,
  type FeedListing,
  type FeedSearchQuery,
  type FeedStatus,
} from '@hfos/core/addons/realestate/feed';
import type { HomeType } from '@hfos/core/addons/realestate/homes';
import { addressKey } from '@hfos/core/addons/realestate/homes';
import { ConnectionRefused, type ConnectionTried } from '../../connections';
import { milesBetween } from './reso';
import type { FeedPage, ListingFeed } from './types';

const MLS = { id: 'standin', name: 'Stand-in MLS' };
const NOTICE =
  'Listing data from the Stand-in MLS, a made-up feed for trying HandsFreeOS. Not for real buyers or sellers.';

const STREETS = [
  ['Elm St', '78704', 30.2481, -97.7663],
  ['Oak Ridge Dr', '78704', 30.2442, -97.7781],
  ['Bluebonnet Ln', '78704', 30.2523, -97.7712],
  ['Cedar Bend Dr', '78745', 30.2069, -97.8015],
  ['Pecan Grove Rd', '78745', 30.2112, -97.7932],
  ['Willow Creek Dr', '78745', 30.2178, -97.7859],
  ['Live Oak St', '78702', 30.2636, -97.7189],
  ['Chicon St', '78702', 30.2668, -97.7224],
  ['Mesa Verde Dr', '78731', 30.3529, -97.7655],
  ['Shoal Creek Blvd', '78731', 30.3421, -97.7569],
] as const;
const TYPES: readonly HomeType[] = [
  'single_family',
  'single_family',
  'townhouse',
  'condo',
  'single_family',
];
const OFFICES = [
  'Hill Country Realty',
  'Lone Star Homes',
  'Barton Springs Properties',
  'Eastside Realty',
];

const day = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** The made-up homes, the same every time (dates move with today). */
function seed(): FeedListing[] {
  const out: FeedListing[] = [];
  for (let i = 0; i < 60; i++) {
    const [street, zip, lat, lng] = STREETS[i % STREETS.length]!;
    const number = 1000 + ((i * 37) % 900);
    const type = TYPES[i % TYPES.length]!;
    const beds = type === 'condo' ? 1 + (i % 3) : 2 + (i % 4);
    const baths = type === 'condo' ? 1 + (i % 2) * 0.5 : 2 + (i % 3) * 0.5;
    const sqft = type === 'condo' ? 700 + ((i * 53) % 900) : 1300 + ((i * 97) % 2200);
    const price = Math.round((sqft * (300 + ((i * 29) % 160))) / 1000) * 1000;
    // 0–29 for sale, 30–37 pending, 38–39 coming soon, 40–59 sold over the last year.
    const status: FeedStatus =
      i < 30 ? 'active' : i < 38 ? 'pending' : i < 40 ? 'coming_soon' : 'sold';
    const listedAgo = status === 'sold' ? 30 + (i - 40) * 16 : 3 + ((i * 7) % 60);
    const soldAgo = status === 'sold' ? (i - 40) * 16 + 2 : null;
    const sold =
      soldAgo !== null ? Math.round((price * (0.96 + ((i * 3) % 7) / 100)) / 1000) * 1000 : null;
    const office = OFFICES[i % OFFICES.length]!;
    out.push({
      provider: 'standin',
      mls: MLS,
      listingKey: `standin-${i + 1}`,
      mlsNumber: String(5_100_000 + i * 113),
      status,
      standardStatus: {
        active: 'Active',
        pending: 'Pending',
        coming_soon: 'Coming Soon',
        sold: 'Closed',
        off_market: 'Withdrawn',
      }[status],
      address: {
        line: `${number} ${street}`,
        unit: type === 'condo' ? String(100 + i) : null,
        city: 'Austin',
        state: 'TX',
        zip,
        hidden: false,
      },
      lat: lat + ((i % 7) - 3) * 0.002,
      lng: lng + ((i % 5) - 2) * 0.002,
      facts: {
        price_cents: price * 100,
        beds,
        baths,
        sqft,
        lot_sqft: type === 'condo' ? undefined : 5000 + ((i * 211) % 6000),
        year_built: 1950 + ((i * 13) % 74),
        hoa_monthly_cents:
          type === 'condo' || type === 'townhouse' ? (150 + ((i * 17) % 300)) * 100 : undefined,
        property_type: type,
        garage_spaces: type === 'condo' ? undefined : 1 + (i % 2),
      },
      listPriceCents: price * 100,
      originalPriceCents: (price + (i % 4 === 0 ? 10_000 : 0)) * 100,
      soldPriceCents: sold ? sold * 100 : null,
      listedOn: day(-listedAgo),
      soldOn: soldAgo !== null ? day(-soldAgo) : null,
      daysOnMarket: soldAgo !== null ? listedAgo - soldAgo : listedAgo,
      description: `A ${beds}-bedroom ${type.replace('_', '-')} home on ${street} in ${zip}, with ${sqft.toLocaleString('en-US')} square feet.`,
      photos: [1, 2, 3].map((n) => ({
        url: `https://picsum.photos/seed/hfos-standin-${i}-${n}/1200/800`,
        caption: n === 1 ? 'Front' : null,
      })),
      listAgent: `Agent ${String.fromCharCode(65 + (i % 26))}. Sample`,
      listOffice: office,
      updatedAt: new Date(Date.now() - ((i * 41) % 600) * 60_000).toISOString(),
      display: { notice: NOTICE, logoUrl: null, courtesy: `Listing courtesy of ${office}.` },
    });
  }
  return out;
}

let homes: FeedListing[] | null = null;
const all = () => (homes ??= seed());

/** Adds a listing to the stand-in MLS, or replaces the one with its MLS number (a test's own listing going live). */
export function putStandinListing(listing: FeedListing): void {
  const list = all();
  const at = list.findIndex((l) => l.mlsNumber === listing.mlsNumber);
  const kept = {
    ...listing,
    provider: 'standin',
    mls: MLS,
    updatedAt: listing.updatedAt ?? new Date().toISOString(),
  };
  if (at >= 0) list[at] = kept;
  else list.push(kept);
}

/** Back to the made-up homes alone. */
export function resetStandin(): void {
  homes = null;
}

function matches(l: FeedListing, q: FeedSearchQuery): boolean {
  if (!q.statuses.includes(l.status)) return false;
  const price = l.status === 'sold' ? (l.soldPriceCents ?? l.listPriceCents) : l.listPriceCents;
  if (q.priceMinCents && (price ?? 0) < q.priceMinCents) return false;
  if (q.priceMaxCents && (price ?? Infinity) > q.priceMaxCents) return false;
  if (q.bedsMin !== undefined && (l.facts.beds ?? 0) < q.bedsMin) return false;
  if (q.bathsMin !== undefined && (l.facts.baths ?? 0) < q.bathsMin) return false;
  if (q.sqftMin !== undefined && (l.facts.sqft ?? 0) < q.sqftMin) return false;
  if (q.sqftMax !== undefined && (l.facts.sqft ?? Infinity) > q.sqftMax) return false;
  if (q.types?.length && (!l.facts.property_type || !q.types.includes(l.facts.property_type)))
    return false;
  if (q.zips?.length && !q.zips.includes(l.address.zip ?? '')) return false;
  if (
    q.cities?.length &&
    !q.cities.some((c) => c.toLowerCase() === (l.address.city ?? '').toLowerCase())
  )
    return false;
  if (
    q.near &&
    (l.lat === null ||
      l.lng === null ||
      milesBetween(q.near, { lat: l.lat, lng: l.lng }) > q.near.miles)
  )
    return false;
  if (q.soldWithinDays && (!l.soldOn || l.soldOn < day(-q.soldWithinDays))) return false;
  if (q.updatedSince && (!l.updatedAt || l.updatedAt <= q.updatedSince)) return false;
  if (q.mlsNumbers?.length && !q.mlsNumbers.includes(l.mlsNumber)) return false;
  if (q.address) {
    const want = addressParts(q.address);
    const line = addressKey(l.address.line);
    if (want.number && !line.startsWith(`${want.number.toLowerCase()} `)) return false;
    if (want.street && !line.includes(addressKey(want.street))) return false;
    if (want.zip && l.address.zip !== want.zip) return false;
  }
  return true;
}

export function createStandinFeed(): ListingFeed {
  return {
    provider: 'standin',
    async search(q): Promise<FeedPage> {
      const sold = q.statuses.every((s) => s === 'sold');
      const found = all()
        .filter((l) => matches(l, q))
        .sort((a, b) =>
          sold
            ? (b.soldOn ?? '').localeCompare(a.soldOn ?? '')
            : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
        );
      return {
        listings: found.slice(q.page * q.limit, (q.page + 1) * q.limit),
        total: found.length,
      };
    },
  };
}

/** The stand-in's key tester: any key but one with "wrong" in it. */
export async function tryStandin(
  provider: string,
  fields: Readonly<Record<string, string>>,
): Promise<ConnectionTried> {
  if (Object.values(fields).some((v) => v.toLowerCase().includes('wrong')))
    throw new ConnectionRefused(
      `The stand-in ${provider} feed turned that down (it has “wrong” in it).`,
    );
  return {
    label: `Stand-in ${provider} account`,
    accountRef: `standin-${provider}`,
    details: { mlss: [MLS.name], listings: all().length },
  };
}

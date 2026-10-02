/**
 * Repliers (https://api.repliers.io), HandsFreeOS's own listing supplier and one a brokerage can connect itself
 * (round five, step 3). One API key reads every MLS the account is approved for; each listing carries its board.
 *
 * - Asked with `GET /listings` and the key in `REPLIERS-API-KEY`. Its own filters where it has them (status, price,
 *   bedrooms, area, dates); the rest are checked here, on what comes back.
 * - Its listings are translated to core's shape: RESO's StandardStatus where Repliers sends it, else its own status
 *   codes; photos from its image host; the listing office as the courtesy line.
 * - Its updates (webhooks) are about every listing on the account, so the add-on asks targeted questions every
 *   fifteen minutes instead (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, round five, step 3).
 */
import {
  addressParts,
  bathsOf,
  centsOf,
  countOf,
  dayOf,
  feedStatusOf,
  homeTypeOf,
  STANDARD_STATUSES,
  type FeedListing,
  type FeedSearchQuery,
  type FeedStatus,
} from '@hfos/core/addons/realestate/feed';
import type { ConnectionTried } from '../../connections';
import { feedJson, num, obj, str } from './http';
import type { FeedFetch, FeedPage, ListingFeed } from './types';

export const REPLIERS_API = 'https://api.repliers.io';
export const REPLIERS_IMAGES = 'https://cdn.repliers.io';

const words = {
  supplier: 'Repliers',
  refused:
    'Repliers turned that API key down. Copy it again from your Repliers dashboard, under API keys, and connect again.',
};

/** Repliers's own last-status codes, for a listing without RESO's StandardStatus. */
function statusOf(l: Record<string, unknown>): FeedStatus {
  const standard = str(l['standardStatus']);
  if (standard) return feedStatusOf(standard);
  const last = str(l['lastStatus']);
  if (last === 'Sld') return 'sold';
  if (last === 'Sc' || last === 'Sce' || last === 'Lc') return 'pending';
  if (str(l['status']) === 'A') return 'active';
  return 'off_market';
}

/** One Repliers listing in core's shape. */
export function fromRepliers(l: Record<string, unknown>): FeedListing | null {
  const mlsNumber = str(l['mlsNumber'], 80);
  if (!mlsNumber) return null;
  const board = str(l['boardId'], 80);
  const a = obj(l['address']);
  const d = obj(l['details']);
  const lot = obj(l['lot']);
  const map = obj(l['map']);
  const office = obj(l['office']);
  const fees = obj(obj(l['condominium'])['fees']);
  const perms = obj(l['permissions']);
  const line = [
    a['streetNumber'],
    a['streetDirectionPrefix'],
    a['streetName'],
    a['streetSuffix'],
    a['streetDirection'],
  ]
    .map((x) => str(x, 80))
    .filter(Boolean)
    .join(' ');
  const listPrice = centsOf(l['listPrice']);
  const agents = Array.isArray(l['agents']) ? (l['agents'] as unknown[]).map(obj) : [];
  const lotSqft =
    countOf(lot['squareFeet'], 1_000_000_000) ??
    (num(lot['acres']) !== null ? countOf(num(lot['acres'])! * 43_560, 1_000_000_000) : undefined);
  const yearBuilt = countOf(d['yearBuilt'], 2100);
  const brokerage = str(office['brokerageName'], 200);
  return {
    provider: 'repliers',
    mls: { id: board, name: null },
    listingKey: board ? `${board}:${mlsNumber}` : mlsNumber,
    mlsNumber,
    status: statusOf(l),
    standardStatus: str(l['standardStatus'], 80),
    address: {
      line: line.slice(0, 300),
      unit: str(a['unitNumber'], 40),
      city: str(a['city'], 120),
      state: str(a['state'], 40),
      zip: str(a['zip'], 20),
      hidden: str(perms['displayAddressOnInternet']) === 'N',
    },
    lat: num(map['latitude']),
    lng: num(map['longitude']),
    facts: {
      price_cents: listPrice,
      beds: countOf(d['numBedrooms'], 100),
      baths: bathsOf(null, null, num(d['numBathrooms'])),
      sqft: countOf(d['sqft']),
      lot_sqft: lotSqft,
      year_built: yearBuilt && yearBuilt >= 1600 ? yearBuilt : undefined,
      hoa_monthly_cents: centsOf(fees['maintenance']),
      property_type: homeTypeOf(str(d['propertyType']), str(l['class'])) ?? undefined,
      garage_spaces: countOf(d['numGarageSpaces'], 100),
    },
    listPriceCents: listPrice ?? null,
    originalPriceCents: centsOf(l['originalPrice']) ?? null,
    soldPriceCents: centsOf(l['soldPrice']) ?? null,
    listedOn: dayOf(l['listDate']),
    soldOn: dayOf(l['soldDate']),
    daysOnMarket: countOf(l['daysOnMarket'], 100_000) ?? null,
    description: str(d['description'], 20_000),
    photos: (Array.isArray(l['images']) ? (l['images'] as unknown[]) : [])
      .map((p) => str(p, 1000))
      .filter((p): p is string => !!p)
      .slice(0, 60)
      .map((p) => ({
        url: p.startsWith('https://') ? p : `${REPLIERS_IMAGES}/${p.replace(/^\//, '')}`,
        caption: null,
      })),
    listAgent: str(agents[0]?.['name'], 200),
    listOffice: brokerage,
    updatedAt: str(l['updatedOn'], 40),
    display: {
      notice: null,
      logoUrl: null,
      courtesy: brokerage ? `Listing courtesy of ${brokerage}.` : null,
    },
  };
}

/** The question in Repliers's own words: its filters where it has them. */
export function repliersParams(q: FeedSearchQuery): URLSearchParams {
  const p = new URLSearchParams();
  p.set('type', 'sale');
  // Both available and not: which ones is said by StandardStatus.
  p.append('status', 'A');
  p.append('status', 'U');
  for (const s of q.statuses)
    for (const std of STANDARD_STATUSES[s]) p.append('standardStatus', std);
  const onlySold = q.statuses.every((s) => s === 'sold');
  if (q.priceMinCents)
    p.set(onlySold ? 'minSoldPrice' : 'minPrice', String(Math.floor(q.priceMinCents / 100)));
  if (q.priceMaxCents)
    p.set(onlySold ? 'maxSoldPrice' : 'maxPrice', String(Math.ceil(q.priceMaxCents / 100)));
  if (q.bedsMin !== undefined) p.set('minBedrooms', String(q.bedsMin));
  if (q.bathsMin !== undefined) p.set('minBaths', String(Math.floor(q.bathsMin)));
  if (q.sqftMin !== undefined) p.set('minSqft', String(q.sqftMin));
  if (q.sqftMax !== undefined) p.set('maxSqft', String(q.sqftMax));
  if (q.types?.length && q.types.every((t) => t === 'condo')) p.set('class', 'condo');
  else if (q.types?.length && !q.types.includes('condo')) p.set('class', 'residential');
  for (const z of q.zips ?? []) p.append('zip', z);
  for (const c of q.cities ?? []) p.append('city', c);
  if (q.near) {
    p.set('lat', String(q.near.lat));
    p.set('long', String(q.near.lng));
    p.set('radius', String(q.near.miles));
    p.set('radiusUnit', 'mi');
  }
  if (q.soldWithinDays)
    p.set(
      'minSoldDate',
      new Date(Date.now() - q.soldWithinDays * 86_400_000).toISOString().slice(0, 10),
    );
  if (q.updatedSince) p.set('minUpdatedOn', q.updatedSince.slice(0, 10));
  for (const m of q.mlsNumbers ?? []) p.append('mlsNumber', m);
  if (q.address) {
    const parts = addressParts(q.address);
    if (parts.number) p.set('streetNumber', parts.number);
    if (parts.street) p.set('streetName', parts.street);
    if (parts.zip) p.append('zip', parts.zip);
  }
  p.set('sortBy', onlySold ? 'soldDateDesc' : 'updatedOnDesc');
  p.set('pageNum', String(q.page + 1));
  p.set('resultsPerPage', String(q.limit));
  return p;
}

export function createRepliersFeed(opts: {
  readonly apiKey: string;
  readonly fetch?: FeedFetch;
  readonly base?: string;
}): ListingFeed {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.base ?? REPLIERS_API;
  return {
    provider: 'repliers',
    async search(q, signal): Promise<FeedPage> {
      const body = obj(
        await feedJson(
          fetchImpl,
          `${base}/listings?${repliersParams(q).toString()}`,
          { method: 'GET', signal, headers: { 'REPLIERS-API-KEY': opts.apiKey } },
          words,
        ),
      );
      const listings = (Array.isArray(body['listings']) ? (body['listings'] as unknown[]) : [])
        .map((l) => fromRepliers(obj(l)))
        .filter((l): l is FeedListing => !!l);
      return { listings, total: num(body['count']) };
    },
  };
}

/** Tries a pasted Repliers key: one listing asked for, and how many the account can read. */
export async function tryRepliersKey(
  fields: Readonly<Record<string, string>>,
  signal: AbortSignal,
  fetchImpl: FeedFetch = fetch,
  base = REPLIERS_API,
): Promise<ConnectionTried> {
  const body = obj(
    await feedJson(
      fetchImpl,
      `${base}/listings?resultsPerPage=1&fields=mlsNumber,boardId`,
      { method: 'GET', signal, headers: { 'REPLIERS-API-KEY': fields['apiKey'] ?? '' } },
      words,
    ),
  );
  const count = num(body['count']);
  return {
    label: 'Repliers account',
    accountRef: null,
    details: count !== null ? { listings: count } : {},
  };
}

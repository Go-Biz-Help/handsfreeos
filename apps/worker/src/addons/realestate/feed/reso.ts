/**
 * An MLS's own feed through the RESO Web API (round five, step 3): Bridge, Trestle, MLS Grid and any other OData
 * server with RESO's Property resource. AnyProp is one too (./anyprop.ts).
 *
 * - Its address is what the MLS gave, up to the part before `/Property`. A server token (Bridge, MLS Grid) goes as
 *   a bearer token; a client ID and secret (Trestle) are swapped for one at the token address, and kept in memory
 *   until shortly before it lapses.
 * - Asked with OData: `$filter` on RESO's own field names, `$top`/`$skip`, `$expand=Media` for photos, newest change
 *   first. Plain `eq`, `ge`, `le` and `or` only, which every server here takes; an address is asked by its number
 *   and ZIP and matched here on its street.
 * - MLS Grid only copies its whole feed out, so it answers an MLS number and nothing broader: a search it can't
 *   answer says so (FeedUnsupported).
 */
import { addressKey } from '@hfos/core/addons/realestate/homes';
import {
  addressParts,
  bathsOf,
  centsOf,
  countOf,
  dayOf,
  feedStatusOf,
  homeTypeOf,
  STANDARD_STATUSES,
  SUB_TYPES,
  type FeedListing,
  type FeedSearchQuery,
} from '@hfos/core/addons/realestate/feed';
import { ConnectionRefused, type ConnectionTried } from '../../connections';
import { feedJson, httpsUrl, num, obj, str } from './http';
import {
  FeedUnreachable,
  FeedUnsupported,
  type FeedFetch,
  type FeedPage,
  type ListingFeed,
} from './types';

/** What an MLS asks to be shown with its listings (AnyProp's MLS profiles), by its OriginatingSystemName. */
export interface MlsProfile {
  readonly name: string;
  readonly fullName: string | null;
  readonly notice: string | null;
  readonly logoUrl: string | null;
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const anyOf = (field: string, values: readonly string[]) =>
  values.length === 1
    ? `${field} eq ${quote(values[0]!)}`
    : `(${values.map((v) => `${field} eq ${quote(v)}`).join(' or ')})`;

/** The question as an OData `$filter` on RESO's field names. */
export function resoFilter(q: FeedSearchQuery, mls: string | null): string {
  const parts: string[] = [];
  if (mls) parts.push(`OriginatingSystemName eq ${quote(mls)}`);
  parts.push(
    anyOf(
      'StandardStatus',
      q.statuses.flatMap((s) => [...STANDARD_STATUSES[s]]),
    ),
  );
  const onlySold = q.statuses.every((s) => s === 'sold');
  const price = onlySold ? 'ClosePrice' : 'ListPrice';
  if (q.priceMinCents) parts.push(`${price} ge ${Math.floor(q.priceMinCents / 100)}`);
  if (q.priceMaxCents) parts.push(`${price} le ${Math.ceil(q.priceMaxCents / 100)}`);
  if (q.bedsMin !== undefined) parts.push(`BedroomsTotal ge ${q.bedsMin}`);
  if (q.bathsMin !== undefined) parts.push(`BathroomsTotalInteger ge ${Math.floor(q.bathsMin)}`);
  if (q.sqftMin !== undefined) parts.push(`LivingArea ge ${q.sqftMin}`);
  if (q.sqftMax !== undefined) parts.push(`LivingArea le ${q.sqftMax}`);
  if (q.types?.length) {
    const subs = q.types.flatMap((t) => [...SUB_TYPES[t]]);
    const land = q.types.includes('land');
    const either = [
      subs.length ? anyOf('PropertySubType', subs) : null,
      land ? `PropertyType eq 'Land'` : null,
    ]
      .filter(Boolean)
      .join(' or ');
    if (either) parts.push(`(${either})`);
  }
  if (q.zips?.length) parts.push(anyOf('PostalCode', q.zips));
  if (q.cities?.length) parts.push(anyOf('City', q.cities));
  if (q.near) {
    // A box around the point; the distance itself is checked on what comes back.
    const dLat = q.near.miles / 69;
    const dLng = q.near.miles / (69 * Math.max(0.1, Math.cos((q.near.lat * Math.PI) / 180)));
    parts.push(
      `Latitude ge ${(q.near.lat - dLat).toFixed(5)} and Latitude le ${(q.near.lat + dLat).toFixed(5)}`,
      `Longitude ge ${(q.near.lng - dLng).toFixed(5)} and Longitude le ${(q.near.lng + dLng).toFixed(5)}`,
    );
  }
  if (q.soldWithinDays)
    parts.push(
      `CloseDate ge ${new Date(Date.now() - q.soldWithinDays * 86_400_000).toISOString().slice(0, 10)}`,
    );
  if (q.updatedSince)
    parts.push(`ModificationTimestamp gt ${new Date(q.updatedSince).toISOString()}`);
  if (q.mlsNumbers?.length) parts.push(anyOf('ListingId', q.mlsNumbers));
  if (q.address) {
    const a = addressParts(q.address);
    if (a.number) parts.push(`StreetNumber eq ${quote(a.number)}`);
    if (a.zip) parts.push(`PostalCode eq ${quote(a.zip)}`);
  }
  return parts.join(' and ');
}

/** One RESO Property record in core's shape. */
export function fromReso(
  p: Record<string, unknown>,
  provider: string,
  profiles: ReadonlyMap<string, MlsProfile> = new Map(),
): FeedListing | null {
  const mlsNumber = str(p['ListingId'], 80);
  const key = str(p['ListingKey'], 200) ?? mlsNumber;
  if (!mlsNumber || !key) return null;
  const system = str(p['OriginatingSystemName'], 80);
  const profile = system ? profiles.get(system.toLowerCase()) : undefined;
  const line =
    [
      p['StreetNumber'],
      p['StreetDirPrefix'],
      p['StreetName'],
      p['StreetSuffix'],
      p['StreetDirSuffix'],
    ]
      .map((x) => str(x, 80))
      .filter(Boolean)
      .join(' ') ||
    (str(p['UnparsedAddress'], 300)?.split(',')[0] ?? '');
  const listPrice = centsOf(p['ListPrice']);
  const fee = centsOf(p['AssociationFee']);
  const freq = (str(p['AssociationFeeFrequency']) ?? 'Monthly').toLowerCase();
  const perMonth =
    fee === undefined
      ? undefined
      : /annual|year/.test(freq)
        ? Math.round(fee / 12)
        : /quarter/.test(freq)
          ? Math.round(fee / 3)
          : /semi/.test(freq)
            ? Math.round(fee / 6)
            : fee;
  const lotSqft =
    countOf(p['LotSizeSquareFeet'], 1_000_000_000) ??
    (num(p['LotSizeAcres']) !== null
      ? countOf(num(p['LotSizeAcres'])! * 43_560, 1_000_000_000)
      : undefined);
  const yearBuilt = countOf(p['YearBuilt'], 2100);
  const media = (Array.isArray(p['Media']) ? (p['Media'] as unknown[]) : [])
    .map(obj)
    .filter((m) => !str(m['MediaCategory']) || /photo/i.test(str(m['MediaCategory'])!))
    .sort((a, b) => (num(a['Order']) ?? 0) - (num(b['Order']) ?? 0));
  const office = str(p['ListOfficeName'], 200);
  return {
    provider,
    mls: { id: system, name: profile?.fullName ?? system },
    listingKey: key,
    mlsNumber,
    status: feedStatusOf(str(p['StandardStatus'])),
    standardStatus: str(p['StandardStatus'], 80),
    address: {
      line: line.slice(0, 300),
      unit: str(p['UnitNumber'], 40),
      city: str(p['City'], 120),
      state: str(p['StateOrProvince'], 40),
      zip: str(p['PostalCode'], 20),
      hidden: p['InternetAddressDisplayYN'] === false,
    },
    lat: num(p['Latitude']),
    lng: num(p['Longitude']),
    facts: {
      price_cents: listPrice,
      beds: countOf(p['BedroomsTotal'], 100),
      baths: bathsOf(
        num(p['BathroomsFull']),
        num(p['BathroomsHalf']),
        num(p['BathroomsTotalInteger']),
      ),
      sqft: countOf(p['LivingArea']),
      lot_sqft: lotSqft,
      year_built: yearBuilt && yearBuilt >= 1600 ? yearBuilt : undefined,
      hoa_monthly_cents: perMonth,
      property_type: homeTypeOf(str(p['PropertySubType']), str(p['PropertyType'])) ?? undefined,
      garage_spaces: countOf(p['GarageSpaces'], 100),
    },
    listPriceCents: listPrice ?? null,
    originalPriceCents: centsOf(p['OriginalListPrice']) ?? null,
    soldPriceCents: centsOf(p['ClosePrice']) ?? null,
    listedOn: dayOf(p['ListingContractDate']) ?? dayOf(p['OnMarketDate']),
    soldOn: dayOf(p['CloseDate']),
    daysOnMarket: countOf(p['DaysOnMarket'], 100_000) ?? null,
    description: str(p['PublicRemarks'], 20_000),
    photos: media
      .map((m) => ({ url: httpsUrl(m['MediaURL']), caption: str(m['ShortDescription'], 500) }))
      .filter((m): m is { url: string; caption: string | null } => !!m.url)
      .slice(0, 60),
    listAgent: str(p['ListAgentFullName'], 200),
    listOffice: office,
    updatedAt: str(p['ModificationTimestamp'], 40),
    display: {
      notice: profile?.notice ?? null,
      logoUrl: profile?.logoUrl ?? null,
      courtesy: office ? `Listing courtesy of ${office}.` : null,
    },
  };
}

/** Miles between two points. */
export function milesBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

/** What a server's answer can't be asked for, checked on what came back: the street, the true distance, the type. */
export function stillMatches(l: FeedListing, q: FeedSearchQuery): boolean {
  if (q.address) {
    const want = addressParts(q.address);
    if (want.street && !addressKey(l.address.line).includes(addressKey(want.street))) return false;
  }
  if (
    q.near &&
    l.lat !== null &&
    l.lng !== null &&
    milesBetween(q.near, { lat: l.lat, lng: l.lng }) > q.near.miles
  )
    return false;
  if (q.types?.length && l.facts.property_type && !q.types.includes(l.facts.property_type))
    return false;
  if (q.bathsMin !== undefined && l.facts.baths !== undefined && l.facts.baths < q.bathsMin)
    return false;
  return true;
}

export interface ResoOptions {
  /** Which supplier this is, for the listings it brings and the words it says. */
  readonly provider: string;
  readonly label: string;
  /** Up to the part before `/Property`. */
  readonly serviceUrl: string;
  /** The bearer token to use now. */
  readonly token: (signal: AbortSignal) => Promise<string>;
  /** Its OriginatingSystemName, when the feed carries more than one MLS. */
  readonly mls?: string | null;
  readonly profiles?: (signal: AbortSignal) => Promise<ReadonlyMap<string, MlsProfile>>;
  readonly refused: string;
  readonly fetch?: FeedFetch;
}

export function createResoFeed(opts: ResoOptions): ListingFeed {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.serviceUrl.replace(/\/+$/, '').replace(/\/Property$/i, '');
  const words = { supplier: opts.label, refused: opts.refused };
  return {
    provider: opts.provider,
    async search(q, signal): Promise<FeedPage> {
      const params = new URLSearchParams({
        $filter: resoFilter(q, opts.mls ?? null),
        $top: String(q.limit),
        $skip: String(q.page * q.limit),
        $orderby: q.statuses.every((s) => s === 'sold')
          ? 'CloseDate desc'
          : 'ModificationTimestamp desc',
        $expand: 'Media',
        $count: 'true',
      });
      const token = await opts.token(signal);
      const body = obj(
        await feedJson(
          fetchImpl,
          `${base}/Property?${params.toString()}`,
          { method: 'GET', signal, headers: { authorization: `Bearer ${token}` } },
          words,
        ),
      );
      const profiles = opts.profiles ? await opts.profiles(signal) : new Map<string, MlsProfile>();
      const listings = (Array.isArray(body['value']) ? (body['value'] as unknown[]) : [])
        .map((p) => fromReso(obj(p), opts.provider, profiles))
        .filter((l): l is FeedListing => !!l && stillMatches(l, q));
      return { listings, total: num(body['@odata.count']) ?? num(body['@odata.totalCount']) };
    },
  };
}

/** A token kept until shortly before it lapses, by whose it is. Never written anywhere. */
const tokens = new Map<string, { readonly token: string; readonly until: number }>();

/** A bearer token from a token address (OAuth client credentials, or AnyProp's username and password). */
export async function cachedToken(
  cacheKey: string,
  fetchImpl: FeedFetch,
  url: string,
  form: Readonly<Record<string, string>>,
  words: { readonly supplier: string; readonly refused: string },
  signal: AbortSignal,
): Promise<string> {
  const held = tokens.get(cacheKey);
  if (held && held.until > Date.now()) return held.token;
  const body = obj(
    await feedJson(
      fetchImpl,
      url,
      {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      },
      words,
    ),
  );
  const token = str(body['access_token'], 8000);
  if (!token) throw new FeedUnreachable(`${words.supplier} didn’t send a token.`);
  const seconds = num(body['expires_in']) ?? 3600;
  // A minute early, so a call never starts on a token about to lapse.
  tokens.set(cacheKey, { token, until: Date.now() + Math.max(60, seconds - 60) * 1000 });
  return token;
}

/** Forgets a kept token (its key was turned down). */
export const forgetToken = (cacheKey: string) => tokens.delete(cacheKey);

const RESO_REFUSED =
  'Your MLS’s feed turned that token down. Check it, or the client ID and secret, with your MLS, then connect again.';

/** A direct RESO feed from what a business pasted. */
export function resoFromFields(
  fields: Readonly<Record<string, string>>,
  cacheKey: string,
  fetchImpl: FeedFetch = fetch,
): ListingFeed {
  const { serviceUrl, accessToken, clientId, clientSecret, tokenUrl, mls } = fields;
  return createResoFeed({
    provider: 'reso',
    label: 'Your MLS’s feed',
    serviceUrl: serviceUrl ?? '',
    mls: mls?.trim() || null,
    refused: RESO_REFUSED,
    fetch: fetchImpl,
    token: async (signal) =>
      accessToken ||
      cachedToken(
        cacheKey,
        fetchImpl,
        tokenUrl ?? '',
        {
          grant_type: 'client_credentials',
          client_id: clientId ?? '',
          client_secret: clientSecret ?? '',
          scope: 'api',
        },
        { supplier: 'Your MLS’s token address', refused: RESO_REFUSED },
        signal,
      ),
  });
}

/** What a business pasted for a direct feed, checked before anything is asked: the words say what's missing. */
export function resoFieldsProblem(fields: Readonly<Record<string, string>>): string | null {
  const url = fields['serviceUrl'] ?? '';
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url))
    return 'The Web API address starts with https://. Copy it again from what your MLS sent.';
  if (fields['accessToken']) return null;
  if (!fields['clientId'] || !fields['clientSecret'])
    return 'Fill in the server token, or the client ID and client secret, from what your MLS sent.';
  if (!/^https:\/\/[^\s]+$/i.test(fields['tokenUrl'] ?? ''))
    return 'With a client ID and secret, fill in the token address too (it starts with https://).';
  return null;
}

/** Tries a direct feed: one listing asked for. */
export async function tryResoFields(
  fields: Readonly<Record<string, string>>,
  signal: AbortSignal,
  fetchImpl: FeedFetch = fetch,
): Promise<ConnectionTried> {
  const problem = resoFieldsProblem(fields);
  if (problem) throw new ConnectionRefused(problem);
  const key = `try:${Math.random()}`;
  const feed = resoFromFields(fields, key, fetchImpl);
  const host = new URL(fields['serviceUrl']!).host;
  let page: FeedPage;
  try {
    page = await feed.search({ statuses: ['active'], limit: 1, page: 0 }, signal);
  } catch (e) {
    if (e instanceof FeedUnsupported)
      throw new ConnectionRefused(
        `${host} didn’t answer as an MLS feed. Check the Web API address with your MLS, and the MLS name if it carries more than one.`,
      );
    throw e;
  } finally {
    forgetToken(key);
  }
  const first = page.listings[0];
  return {
    label: fields['mls'] ? `${fields['mls']} at ${host}` : host,
    accountRef: null,
    details: {
      ...(first?.mls.id ? { mls: first.mls.id } : {}),
      ...(page.total !== null ? { listings: page.total } : {}),
    },
  };
}

/**
 * Where an address is (M18), for service areas by distance or drawn on the map. Google's Geocoding API in
 * production; a stand-in for development and tests; `off` when no key is set, and then only ZIP areas work.
 * Each address is looked up once and kept (app.geocodes, by a hash of the address), so a customer asked about
 * twice costs one lookup.
 */
import { createHash } from 'node:crypto';
import { rows, sql, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import type { WorkerEnv } from '../env';
import { spendLookup } from './budget';

export interface Place {
  readonly lat: number;
  readonly lng: number;
  /** Its 5-digit ZIP, when the address has one. */
  readonly postalCode: string | null;
}

export interface Geocoder {
  readonly name: 'google' | 'fake' | 'off';
  /**
   * Null when there is no such place (or it can't look anything up). Throws on an outage, so a job retries, and
   * `LookupsPaused` when a booking page's daily budget is spent (geo/budget.ts).
   */
  geocode(address: string): Promise<Place | null>;
}

const GOOGLE = 'https://maps.googleapis.com/maps/api/geocode/json';

interface GoogleAnswer {
  readonly status: string;
  readonly error_message?: string;
  readonly results?: readonly {
    readonly geometry?: { readonly location?: { readonly lat: number; readonly lng: number } };
    readonly address_components?: readonly {
      readonly short_name: string;
      readonly types: readonly string[];
    }[];
  }[];
}

/** How long an address found nowhere is remembered, and how many are, on each machine. */
const MISS_KEPT_MS = 86_400_000;
const MISSES_KEPT = 10_000;

/**
 * Addresses a map found nowhere lately, so the same bad address (a customer's typo, or a visit's) isn't paid for
 * again and again. Only a sure "nowhere" is remembered, never a refusal or an outage. Kept in memory for a day.
 */
function rememberedMisses(now: () => number) {
  const until = new Map<string, number>();
  const keyOf = (address: string) => address.trim().replace(/\s+/g, ' ').toLowerCase();
  return {
    has(address: string): boolean {
      const key = keyOf(address);
      const t = until.get(key);
      if (t === undefined) return false;
      if (t > now()) return true;
      until.delete(key);
      return false;
    },
    add(address: string): void {
      const key = keyOf(address);
      until.delete(key);
      if (until.size >= MISSES_KEPT) until.delete(until.keys().next().value!);
      until.set(key, now() + MISS_KEPT_MS);
    },
  };
}

/**
 * Google's Geocoding API. An address it finds nothing for is remembered for a day, and a lookup a booking page's
 * daily budget doesn't allow is never asked (geo/budget.ts).
 */
export function createGoogleGeocoder(opts: {
  apiKey: string;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
}): Geocoder {
  const get = opts.fetch ?? fetch;
  const misses = rememberedMisses(opts.now ?? Date.now);
  return {
    name: 'google',
    async geocode(address) {
      if (misses.has(address)) return null;
      spendLookup();
      const url = `${GOOGLE}?${new URLSearchParams({ address, region: 'us', key: opts.apiKey })}`;
      const res = await get(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Geocoding answered ${res.status}`);
      const body = (await res.json()) as GoogleAnswer;
      if (body.status === 'ZERO_RESULTS') {
        misses.add(address);
        return null;
      }
      if (body.status !== 'OK') {
        // A key without the Geocoding API, or over its quota: say so, and treat the address as not found.
        opts.log.warn({ status: body.status, err: body.error_message }, 'geocoding refused');
        if (body.status === 'UNKNOWN_ERROR') throw new Error('Geocoding is unavailable');
        return null;
      }
      const top = body.results?.[0];
      const at = top?.geometry?.location;
      if (!at) {
        misses.add(address);
        return null;
      }
      const zip = top.address_components?.find((c) => c.types.includes('postal_code'))?.short_name;
      return { lat: at.lat, lng: at.lng, postalCode: zip && /^\d{5}$/.test(zip) ? zip : null };
    },
  };
}

/**
 * The stand-in. An address that ends with "@lat,lng" is there; one with "nowhere" in it isn't anywhere; any
 * other lands in downtown Dallas. A 5-digit number in it is its ZIP. Like Google's, it remembers an address that
 * isn't anywhere and counts against a booking page's budget, so both can be tested without a key.
 */
export function createFakeGeocoder(): Geocoder & { readonly asked: string[] } {
  const asked: string[] = [];
  const misses = rememberedMisses(Date.now);
  return {
    name: 'fake',
    asked,
    async geocode(address) {
      if (misses.has(address)) return null;
      spendLookup();
      asked.push(address);
      if (/nowhere/i.test(address)) {
        misses.add(address);
        return null;
      }
      const at = /@\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(address);
      const zip = /\b(\d{5})\b/.exec(address.replace(/@.*$/, ''))?.[1] ?? null;
      return at
        ? { lat: Number(at[1]), lng: Number(at[2]), postalCode: zip }
        : { lat: 32.7767, lng: -96.797, postalCode: zip };
    },
  };
}

export const offGeocoder: Geocoder = { name: 'off', geocode: async () => null };

export function createGeocoder(env: WorkerEnv, log: Logger): Geocoder {
  if (env.geocoder === 'google' && env.googleMapsServerKey)
    return createGoogleGeocoder({ apiKey: env.googleMapsServerKey, log });
  if (env.geocoder === 'fake') return createFakeGeocoder();
  return offGeocoder;
}

const hashOf = (address: string) =>
  createHash('sha256').update(address.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');

/** Where an address is: kept from an earlier lookup, or looked up now and kept. */
export async function placeOf(tx: Tx, geocoder: Geocoder, address: string): Promise<Place | null> {
  const text = address.trim();
  if (!text || geocoder.name === 'off') return null;
  const key = hashOf(text);
  const [kept] = await rows<{ lat: number; lng: number; postal_code: string | null }>(
    tx,
    sql`select lat, lng, postal_code from app.geocodes where query_hash = ${key}`,
  );
  if (kept) return { lat: Number(kept.lat), lng: Number(kept.lng), postalCode: kept.postal_code };
  const found = await geocoder.geocode(text);
  if (!found) return null;
  await tx.execute(
    sql`insert into app.geocodes (query_hash, lat, lng, postal_code)
        values (${key}, ${found.lat}, ${found.lng}, ${found.postalCode})
        on conflict (query_hash) do nothing`,
  );
  return found;
}

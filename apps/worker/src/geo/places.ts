/**
 * A spot to meet (docs/outreach.md, decision 179: coffee spots): the coffee shop nearest the point halfway between a
 * customer and the person they're meeting, from Google's Places API (Text Search) when the server key is set. A
 * stand-in for development and tests; `off` without a key, and then the booking page offers the usual spot or one
 * the customer names, never a guess.
 *
 * The key needs the Places API (New) turned on as well as the Geocoding and Routes APIs.
 */
import type { GeoPoint } from '@hfos/core/server';
import type { Logger } from 'pino';
import type { WorkerEnv } from '../env';

export interface FoundSpot {
  readonly name: string;
  /** Its street address, as Google writes it. */
  readonly address: string;
  readonly lat: number;
  readonly lng: number;
}

export interface PlaceFinder {
  readonly name: 'google' | 'fake' | 'off';
  /** The nearest place of a kind to a point ("coffee shop"), or null when there is none or it can't look. */
  near(point: GeoPoint, what: string): Promise<FoundSpot | null>;
}

const SEARCH = 'https://places.googleapis.com/v1/places:searchText';

export function createGooglePlaceFinder(opts: {
  apiKey: string;
  log: Logger;
  fetch?: typeof fetch;
}): PlaceFinder {
  const get = opts.fetch ?? fetch;
  return {
    name: 'google',
    async near(point, what) {
      try {
        const res = await get(SEARCH, {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': opts.apiKey,
            'x-goog-fieldmask': 'places.displayName,places.formattedAddress,places.location',
          },
          body: JSON.stringify({
            textQuery: what,
            maxResultCount: 1,
            rankPreference: 'DISTANCE',
            locationBias: {
              circle: { center: { latitude: point.lat, longitude: point.lng }, radius: 8000 },
            },
          }),
        });
        if (!res.ok) throw new Error(`Places answered ${res.status}`);
        const body = (await res.json()) as {
          places?: {
            displayName?: { text?: string };
            formattedAddress?: string;
            location?: { latitude?: number; longitude?: number };
          }[];
        };
        const top = body.places?.[0];
        const name = top?.displayName?.text?.trim();
        const address = top?.formattedAddress?.trim();
        const lat = top?.location?.latitude;
        const lng = top?.location?.longitude;
        if (!name || !address || typeof lat !== 'number' || typeof lng !== 'number') return null;
        return { name, address, lat, lng };
      } catch (e) {
        // A key without the Places API, or an outage: the page offers the other spots.
        opts.log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          'finding a spot from Google failed',
        );
        return null;
      }
    },
  };
}

/** The stand-in: a coffee shop right at the point, whose address the stand-in geocoder reads back. */
export function createFakePlaceFinder(): PlaceFinder {
  return {
    name: 'fake',
    async near(point) {
      const lat = Number(point.lat.toFixed(4));
      const lng = Number(point.lng.toFixed(4));
      return { name: 'Halfway Coffee', address: `100 Middle Rd @${lat},${lng}`, lat, lng };
    },
  };
}

export const offPlaceFinder: PlaceFinder = { name: 'off', near: async () => null };

export function createPlaceFinder(env: WorkerEnv, log: Logger): PlaceFinder {
  if (env.geocoder === 'google' && env.googleMapsServerKey)
    return createGooglePlaceFinder({ apiKey: env.googleMapsServerKey, log });
  if (env.geocoder === 'fake') return createFakePlaceFinder();
  return offPlaceFinder;
}

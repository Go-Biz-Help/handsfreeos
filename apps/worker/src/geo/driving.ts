/**
 * How long a drive takes (M18 step 4, "On my way"): from where the tech is to the visit, with traffic, from
 * Google's Routes API when the server key is set. Without one — or when Google doesn't answer — a rough guess
 * from the straight-line distance, so a customer still hears about when to expect them.
 *
 * The key needs the Routes API turned on as well as the Geocoding API.
 */
import { milesBetween, type GeoPoint } from '@hfos/core/server';
import type { Logger } from 'pino';
import type { WorkerEnv } from '../env';
import { spendLookup } from './budget';

export interface DriveTimer {
  readonly name: 'google' | 'rough';
  /** Minutes of driving, or null when there's no road answer and no guess worth giving. */
  minutes(from: GeoPoint, to: GeoPoint): Promise<number | null>;
  /**
   * Minutes of driving from one place to each of many (decision 179, drive times between visits), in their order,
   * without traffic: the visits are days away. A place Google has no road to gets the rough guess. Throws
   * `LookupsPaused` when a booking page's daily budget is spent (geo/budget.ts).
   */
  many(from: GeoPoint, to: readonly GeoPoint[]): Promise<number[]>;
}

/** Roads wind (1.3× the straight line) at about 30 mph in town; a guess, rounded up to five minutes. */
export function roughMinutes(from: GeoPoint, to: GeoPoint): number {
  const miles = milesBetween(from, to) * 1.3;
  return Math.max(5, Math.ceil(((miles / 30) * 60) / 5) * 5);
}

export const roughDriveTimer: DriveTimer = {
  name: 'rough',
  minutes: async (from, to) => roughMinutes(from, to),
  many: async (from, to) => to.map((p) => roughMinutes(from, p)),
};

const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const MATRIX = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
/** Destinations in one matrix request: well inside Google's 625 elements. */
const MATRIX_CHUNK = 25;

export function createGoogleDriveTimer(opts: {
  apiKey: string;
  log: Logger;
  fetch?: typeof fetch;
}): DriveTimer {
  const get = opts.fetch ?? fetch;
  const latLng = (p: GeoPoint) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  /** One request: minutes to each destination, null where Google gave no route. */
  async function matrix(from: GeoPoint, to: readonly GeoPoint[]): Promise<(number | null)[]> {
    const res = await get(MATRIX, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': opts.apiKey,
        'x-goog-fieldmask': 'originIndex,destinationIndex,duration,condition',
      },
      body: JSON.stringify({
        origins: [{ waypoint: latLng(from) }],
        destinations: to.map((p) => ({ waypoint: latLng(p) })),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
      }),
    });
    if (!res.ok) throw new Error(`Route matrix answered ${res.status}`);
    const body = (await res.json()) as {
      destinationIndex?: number;
      duration?: string;
      condition?: string;
    }[];
    const out: (number | null)[] = to.map(() => null);
    for (const e of Array.isArray(body) ? body : []) {
      const seconds = Number.parseInt(e.duration ?? '', 10);
      if (e.condition === 'ROUTE_EXISTS' && Number.isFinite(seconds))
        out[e.destinationIndex ?? 0] = Math.max(1, Math.round(seconds / 60));
    }
    return out;
  }
  return {
    name: 'google',
    async many(from, to) {
      const out: number[] = [];
      for (let i = 0; i < to.length; i += MATRIX_CHUNK) {
        const chunk = to.slice(i, i + MATRIX_CHUNK);
        // Before the try: a spent budget throws, so the caller doesn't keep a rough guess (geo/budget.ts).
        spendLookup();
        try {
          const got = await matrix(from, chunk);
          chunk.forEach((p, j) => out.push(got[j] ?? roughMinutes(from, p)));
        } catch (e) {
          // A key without the Routes API, or an outage: the booking page still leaves a rough drive.
          opts.log.warn(
            { err: e instanceof Error ? e.message : String(e) },
            'route matrix from Google failed',
          );
          chunk.forEach((p) => out.push(roughMinutes(from, p)));
        }
      }
      return out;
    },
    async minutes(from, to) {
      try {
        const res = await get(ROUTES, {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': opts.apiKey,
            'x-goog-fieldmask': 'routes.duration',
          },
          body: JSON.stringify({
            origin: latLng(from),
            destination: latLng(to),
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_AWARE',
          }),
        });
        if (!res.ok) throw new Error(`Routes answered ${res.status}`);
        const body = (await res.json()) as { routes?: { duration?: string }[] };
        const seconds = Number.parseInt(body.routes?.[0]?.duration ?? '', 10);
        if (Number.isFinite(seconds)) return Math.max(1, Math.round(seconds / 60));
        return roughMinutes(from, to);
      } catch (e) {
        // A key without the Routes API, or an outage: the customer still gets a rough time.
        opts.log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          'driving time from Google failed',
        );
        return roughMinutes(from, to);
      }
    },
  };
}

export function createDriveTimer(env: WorkerEnv, log: Logger): DriveTimer {
  return env.geocoder === 'google' && env.googleMapsServerKey
    ? createGoogleDriveTimer({ apiKey: env.googleMapsServerKey, log })
    : roughDriveTimer;
}

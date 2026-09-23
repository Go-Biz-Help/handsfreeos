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

export interface DriveTimer {
  readonly name: 'google' | 'rough';
  /** Minutes of driving, or null when there's no road answer and no guess worth giving. */
  minutes(from: GeoPoint, to: GeoPoint): Promise<number | null>;
}

/** Roads wind (1.3× the straight line) at about 30 mph in town; a guess, rounded up to five minutes. */
export function roughMinutes(from: GeoPoint, to: GeoPoint): number {
  const miles = milesBetween(from, to) * 1.3;
  return Math.max(5, Math.ceil(((miles / 30) * 60) / 5) * 5);
}

export const roughDriveTimer: DriveTimer = {
  name: 'rough',
  minutes: async (from, to) => roughMinutes(from, to),
};

const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export function createGoogleDriveTimer(opts: {
  apiKey: string;
  log: Logger;
  fetch?: typeof fetch;
}): DriveTimer {
  const get = opts.fetch ?? fetch;
  const latLng = (p: GeoPoint) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  return {
    name: 'google',
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

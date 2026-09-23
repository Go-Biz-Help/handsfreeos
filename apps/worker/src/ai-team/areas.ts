/**
 * Where the customer is, for the teammate's service-area checks (M18): their ZIP for ZIP areas, where their
 * address is for areas by distance or drawn on the map. Shared by the live tools and the test console.
 */
import {
  areaCovers,
  needsAddress,
  quoteData,
  zip5,
  type CatalogTerritory,
} from '@hfos/core/server';
import type { Tx } from '@hfos/db/client';
import { placeOf, type Geocoder } from '../geo/geocoder';
import type { RunCalendar } from './context';

export interface Whereabouts {
  readonly zip: string | null;
  readonly point: { readonly lat: number; readonly lng: number } | null;
  /** An address was given and couldn't be found. */
  readonly notFound: boolean;
}

/** Their ZIP as given (or the one their address has), and where their address is. */
export async function whereabouts(
  tx: Tx,
  geocoder: Geocoder,
  given: { readonly postalCode?: string | null; readonly address?: string | null },
): Promise<Whereabouts> {
  const address = given.address?.trim() || null;
  const place = address ? await placeOf(tx, geocoder, address) : null;
  return {
    zip: zip5(given.postalCode) ?? place?.postalCode ?? null,
    point: place ? { lat: place.lat, lng: place.lng } : null,
    notFound: !!address && !place,
  };
}

const NOT_FOUND =
  'That address couldn’t be found on the map. Ask them to check it (street, city and ZIP).';

/** check_service_area's answer, for the model. */
export function serviceAreaAnswer(
  areas: readonly CatalogTerritory[],
  calendars: readonly RunCalendar[],
  where: Whereabouts,
  lookUpsOn: boolean,
): Record<string, unknown> {
  if (!areas.length)
    return {
      served: null,
      note: 'The business hasn’t listed the areas it serves. Go by the service area in the business profile; if it doesn’t say, follow your “when unsure” rule.',
    };
  if (where.notFound) return { served: null, note: NOT_FOUND };
  const verdicts = areas.map((a) => ({
    area: a,
    covers: needsAddress(a) && !lookUpsOn ? null : areaCovers(a, where.zip, where.point),
  }));
  const covering = verdicts.filter((v) => v.covers === true).map((v) => v.area);
  const unsure = verdicts.some((v) => v.covers === null && needsAddress(v.area));
  const servedBy = (c: RunCalendar) =>
    covering.some((a) => !c.areaIds.length || c.areaIds.includes(a.id));
  const cals = calendars
    .filter((c) => c.byZip)
    .map((c) => ({ calendar: quoteData(c.name), served: servedBy(c) }));
  if (!covering.length && unsure)
    return {
      served: null,
      note: lookUpsOn
        ? 'Some of the business’s areas go by distance or a drawn map area: ask for their street address and city, then check again with it.'
        : 'Some of the business’s areas go by distance or a drawn map area, which can’t be checked right now. Follow your “when unsure” rule.',
    };
  return {
    served: covering.length > 0,
    ...(covering.length ? { areas: covering.map((a) => quoteData(a.name)) } : {}),
    ...(cals.length ? { calendars: cals } : {}),
    ...(covering.length
      ? {}
      : {
          note: 'The business doesn’t serve there. Tell them kindly, and don’t book a visit at their place. Hand off if they want someone to double-check.',
        }),
  };
}

export const ADDRESS_NOT_FOUND = NOT_FOUND;

/**
 * Service areas, three ways (M18): a list of ZIP codes, so many miles from a point, or a shape drawn on the map.
 * A ZIP area is checked against the customer's ZIP; the others against where their address is, which the worker
 * looks up (and keeps) before asking. Pure, so the engine, the worker and the web share it.
 */
import { zip5, type CatalogTerritory } from './catalogs';

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export const AREA_KINDS = ['zip', 'radius', 'polygon'] as const;
export type AreaKind = (typeof AREA_KINDS)[number];

const EARTH_MILES = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle miles between two points. */
export function milesBetween(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whether a point is inside a shape given as [lat, lng] corners (ray casting; a service area is small and flat). */
export function insidePolygon(
  p: GeoPoint,
  corners: readonly (readonly [number, number])[],
): boolean {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const [yi, xi] = corners[i]!;
    const [yj, xj] = corners[j]!;
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

export type AreaShapeFacts = Pick<
  CatalogTerritory,
  'kind' | 'postalCodes' | 'center' | 'radiusMiles' | 'polygon'
>;

/**
 * Whether an area covers a customer: their ZIP for a ZIP area, their point for the others. Null when it can't
 * tell — a distance or drawn area with no point, a ZIP area with no ZIP.
 */
export function areaCovers(
  area: AreaShapeFacts,
  postalCode: string | null | undefined,
  point: GeoPoint | null | undefined,
): boolean | null {
  if (area.kind === 'zip') {
    const zip = zip5(postalCode);
    return zip ? area.postalCodes.some((p) => zip5(p) === zip) : null;
  }
  if (!point) return null;
  if (area.kind === 'radius')
    return (
      !!area.center &&
      area.radiusMiles !== null &&
      milesBetween(area.center, point) <= area.radiusMiles
    );
  return !!area.polygon && insidePolygon(point, area.polygon);
}

/** An area goes by where the customer is (distance or drawn), so it needs their address, not just a ZIP. */
export const needsAddress = (area: Pick<CatalogTerritory, 'kind'>): boolean => area.kind !== 'zip';

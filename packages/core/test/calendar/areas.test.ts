import { describe, expect, it } from 'vitest';
import { areaCovers, insidePolygon, milesBetween } from '../../src/calendar/areas';

const DALLAS = { lat: 32.7767, lng: -96.797 };
const FORT_WORTH = { lat: 32.7555, lng: -97.3308 };

describe('service areas (M18)', () => {
  it('measures miles on the globe', () => {
    expect(milesBetween(DALLAS, FORT_WORTH)).toBeGreaterThan(30);
    expect(milesBetween(DALLAS, FORT_WORTH)).toBeLessThan(32);
    expect(milesBetween(DALLAS, DALLAS)).toBe(0);
  });

  it('tells inside a drawn shape from outside it, concave corners included', () => {
    // An L: the notch at the top right is outside.
    const l: [number, number][] = [
      [0, 0],
      [0, 2],
      [1, 2],
      [1, 1],
      [2, 1],
      [2, 0],
    ];
    expect(insidePolygon({ lat: 0.5, lng: 1.5 }, l)).toBe(true);
    expect(insidePolygon({ lat: 1.5, lng: 0.5 }, l)).toBe(true);
    expect(insidePolygon({ lat: 1.5, lng: 1.5 }, l)).toBe(false);
    expect(insidePolygon({ lat: 3, lng: 3 }, l)).toBe(false);
  });

  it('checks a ZIP area by ZIP and the others by point, and says when it can’t tell', () => {
    const zip = {
      kind: 'zip' as const,
      postalCodes: ['75201'],
      center: null,
      radiusMiles: null,
      polygon: null,
    };
    const radius = {
      kind: 'radius' as const,
      postalCodes: [],
      center: DALLAS,
      radiusMiles: 20,
      polygon: null,
    };
    expect(areaCovers(zip, '75201-1234', null)).toBe(true);
    expect(areaCovers(zip, '75202', DALLAS)).toBe(false);
    expect(areaCovers(zip, null, DALLAS)).toBeNull();
    expect(areaCovers(radius, null, { lat: 32.9, lng: -96.8 })).toBe(true);
    expect(areaCovers(radius, null, FORT_WORTH)).toBe(false);
    expect(areaCovers(radius, '75201', null)).toBeNull();
  });
});

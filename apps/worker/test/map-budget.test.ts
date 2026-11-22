/**
 * The daily budgets for paid map lookups that signed-out booking pages start (geo/budget.ts), and the coffee spots
 * kept by the point they were found for (geo/places.ts). No database: the lookups are Google's, on a fake fetch.
 */
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLookupBudgets, spendLookup } from '../src/geo/budget';
import { createGoogleDriveTimer } from '../src/geo/driving';
import { createGoogleGeocoder } from '../src/geo/geocoder';
import {
  createGooglePlaceFinder,
  forgetSpots,
  spotNear,
  type PlaceFinder,
} from '../src/geo/places';

const DAY = 86_400_000;
const log = pino({ level: 'silent' });
const HERE = { lat: 30.2672, lng: -97.7431 };

/** A fetch that counts what it was asked and answers each Google API with something sensible. */
function counting() {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    if (url.includes('geocode'))
      return Response.json({
        status: 'OK',
        results: [{ geometry: { location: HERE }, address_components: [] }],
      });
    if (url.includes('searchText'))
      return Response.json({
        places: [
          {
            displayName: { text: 'Corner Coffee' },
            formattedAddress: '1 Main St',
            location: { latitude: HERE.lat, longitude: HERE.lng },
          },
        ],
      });
    return Response.json([{ destinationIndex: 0, duration: '600s', condition: 'ROUTE_EXISTS' }]);
  }) as typeof globalThis.fetch;
  return { asked, fetch };
}

describe('the daily budgets for paid map lookups', () => {
  it('stops a business at its budget, the machine at its own, and starts again the next day', async () => {
    let clock = 0;
    const budgets = createLookupBudgets({ perBusiness: 2, perMachine: 3 }, () => clock);
    const spend = (ws: string) =>
      budgets.within(ws, async () => {
        spendLookup();
        return 'asked';
      });
    expect(await spend('a')).toBe('asked');
    expect(await spend('a')).toBe('asked');
    expect(await spend('a')).toBe('paused');
    // Another business has its own room, until the machine's runs out.
    expect(await spend('b')).toBe('asked');
    expect(await spend('b')).toBe('paused');
    expect(await spend('c')).toBe('paused');
    clock += DAY;
    expect(await spend('a')).toBe('asked');
  });

  it('counts nothing outside a request that counts', () => {
    expect(() => spendLookup()).not.toThrow();
  });

  it('asks Google nothing once a budget is spent', async () => {
    const budgets = createLookupBudgets({ perBusiness: 1, perMachine: 100 });
    const { asked, fetch } = counting();
    const geocoder = createGoogleGeocoder({ apiKey: 'k', log, fetch });
    const places = createGooglePlaceFinder({ apiKey: 'k', log, fetch });
    const driving = createGoogleDriveTimer({ apiKey: 'k', log, fetch });
    expect(await budgets.within('ws', () => geocoder.geocode('1 Main St'))).toMatchObject(HERE);
    expect(asked).toHaveLength(1);
    expect(await budgets.within('ws', () => geocoder.geocode('2 Main St'))).toBe('paused');
    expect(await budgets.within('ws', () => places.near(HERE, 'coffee shop'))).toBe('paused');
    expect(await budgets.within('ws', () => driving.many(HERE, [HERE]))).toBe('paused');
    expect(asked).toHaveLength(1);
    // A job or a signed-in screen isn't counted, so it still looks up.
    expect(await driving.many(HERE, [HERE])).toEqual([10]);
    expect(asked).toHaveLength(2);
  });
});

describe('coffee spots kept by where they were found', () => {
  beforeEach(() => forgetSpots());

  it('searches once for points within about 100 m, and again farther away', async () => {
    const { asked, fetch } = counting();
    const places = createGooglePlaceFinder({ apiKey: 'k', log, fetch });
    const first = await spotNear(places, { lat: 30.40012, lng: -97.70031 }, 'coffee shop');
    expect(first).toMatchObject({ name: 'Corner Coffee' });
    expect(await spotNear(places, { lat: 30.40024, lng: -97.70044 }, 'coffee shop')).toEqual(first);
    expect(asked).toHaveLength(1);
    await spotNear(places, { lat: 30.41, lng: -97.7 }, 'coffee shop');
    expect(asked).toHaveLength(2);
  });

  it('doesn’t keep a search that found nothing', async () => {
    let calls = 0;
    const none: PlaceFinder = {
      name: 'google',
      near: async () => {
        calls += 1;
        return null;
      },
    };
    expect(await spotNear(none, HERE, 'coffee shop')).toBeNull();
    expect(await spotNear(none, HERE, 'coffee shop')).toBeNull();
    expect(calls).toBe(2);
  });

  it('keeps nothing when the budget stopped the search', async () => {
    const budgets = createLookupBudgets({ perBusiness: 1, perMachine: 100 });
    const { asked, fetch } = counting();
    const places = createGooglePlaceFinder({ apiKey: 'k', log, fetch });
    await budgets.within('ws', async () => spendLookup());
    expect(await budgets.within('ws', () => spotNear(places, HERE, 'coffee shop'))).toBe('paused');
    expect(asked).toHaveLength(0);
    // Tomorrow's customer (or a request that doesn't count) gets a real search.
    expect(await spotNear(places, HERE, 'coffee shop')).toMatchObject({ name: 'Corner Coffee' });
    expect(asked).toHaveLength(1);
  });
});

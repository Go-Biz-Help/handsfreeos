/**
 * M18 service areas by distance or drawn on a map, through the worker: the address lookup (Google, the
 * stand-in, and the kept answers) and the public booking page asking for the street address.
 */
import { attendeeRescheduleOnline, executeCommand, territoryCreate } from '@hfos/core/server';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { asWorker, rows, sql } from '@hfos/db/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeGeocoder, createGoogleGeocoder, placeOf } from '../src/geo/geocoder';
import { pino } from 'pino';
import {
  AT_HOME,
  customer,
  get,
  iso,
  makeCalendar,
  makeWorld,
  MIN,
  post,
  run,
  type World,
} from './booking-world';

let w: World;
const DAY = 86_400_000;
// The stand-in puts an address with no "@lat,lng" in downtown Dallas.
const IN_DALLAS = '1500 Marilla St, Dallas, TX 75201';
const IN_AUSTIN = '301 Congress Ave, Austin, TX 78701 @30.2672,-97.7431';

beforeAll(async () => {
  w = await makeWorld('areas');
}, 60_000);
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('finding where an address is', () => {
  it('asks Google once per address and keeps the answer', async () => {
    const asked: string[] = [];
    const google = createGoogleGeocoder({
      apiKey: 'test-key',
      log: pino({ level: 'silent' }),
      fetch: (async (url: string) => {
        asked.push(url);
        const q = new URL(url).searchParams.get('address') ?? '';
        const body = /nowhere/.test(q)
          ? { status: 'ZERO_RESULTS', results: [] }
          : {
              status: 'OK',
              results: [
                {
                  geometry: { location: { lat: 32.78, lng: -96.8 } },
                  address_components: [{ short_name: '75201', types: ['postal_code'] }],
                },
              ],
            };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch,
    });
    const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
    const address = `${Date.now()} Elm St, Dallas`;
    const first = await asWorker(testDbs().worker.db, scope, (tx) => placeOf(tx, google, address));
    expect(first).toEqual({ lat: 32.78, lng: -96.8, postalCode: '75201' });
    expect(new URL(asked[0]!).searchParams.get('key')).toBe('test-key');
    // The same address again, in other spacing and case: kept, not asked.
    const again = await asWorker(testDbs().worker.db, scope, (tx) =>
      placeOf(tx, google, `  ${address.toUpperCase()} `),
    );
    expect(again).toEqual(first);
    expect(asked).toHaveLength(1);
    expect(
      await asWorker(testDbs().worker.db, scope, (tx) => placeOf(tx, google, 'nowhere at all')),
    ).toBeNull();
  });

  it('reads a point and a ZIP from the stand-in’s addresses', async () => {
    const fake = createFakeGeocoder();
    expect(await fake.geocode(IN_AUSTIN)).toEqual({
      lat: 30.2672,
      lng: -97.7431,
      postalCode: '78701',
    });
    expect(await fake.geocode(IN_DALLAS)).toMatchObject({ lat: 32.7767, postalCode: '75201' });
    expect(await fake.geocode('nowhere, TX')).toBeNull();
  });
});

describe('the booking page, for an area by distance', () => {
  it('asks for the street address, shows times only where it goes, and books there', async () => {
    const downtown = await run(w, territoryCreate, {
      workspaceId: w.workspaceId,
      name: 'Downtown 20 miles',
      shape: { kind: 'radius', address: IN_DALLAS, lat: 32.7767, lng: -96.797, miles: 20 },
      userIds: [w.owner.id],
    });
    const cal = await makeCalendar(w, 'Home visits', {
      territory: { routing: 'zip', territoryIds: [downtown.territoryId] },
      locations: { options: [{ kind: 'customer_address' }] },
    });
    const info = await get(w, `/public/book/${w.site}/${cal.slug}`);
    expect(info.statusCode, info.body).toBe(200);
    expect(info.json()).toMatchObject({
      booking: { zipRouting: { postalCodes: [], byAddress: true } },
    });

    const from = iso(Date.now() + 60 * MIN);
    const to = iso(Date.now() + 3 * DAY);
    const slots = async (address: string) => {
      const res = await get(
        w,
        `/public/book/${w.site}/${cal.slug}/slots?${new URLSearchParams({ from, to, address })}`,
      );
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { slots: { startsAt: string }[] }).slots;
    };
    const near = await slots(IN_DALLAS);
    expect(near.length).toBeGreaterThan(0);
    expect(await slots(IN_AUSTIN)).toEqual([]);

    const who = customer('Remi');
    const outside = await post(w, `/public/book/${w.site}/${cal.slug}/bookings`, {
      clientId: crypto.randomUUID(),
      startsAt: near[0]!.startsAt,
      ...who,
      ...AT_HOME,
      address: IN_AUSTIN,
      postalCode: null,
    });
    expect(outside.statusCode).toBe(409);
    const booked = await post(w, `/public/book/${w.site}/${cal.slug}/bookings`, {
      clientId: crypto.randomUUID(),
      startsAt: near[0]!.startsAt,
      ...who,
      ...AT_HOME,
      address: IN_DALLAS,
      postalCode: null,
    });
    expect(booked.statusCode, booked.body).toBe(200);

    // The customer moves it from their link: the visit's address is still where the area goes.
    const token = (booked.json() as { manageToken: string }).manageToken;
    const open = await get(w, `/public/manage/${token}/slots?${new URLSearchParams({ from, to })}`);
    expect(open.statusCode, open.body).toBe(200);
    const times = (open.json() as { slots: { startsAt: string }[] }).slots;
    const later = times.find((t) => t.startsAt !== near[0]!.startsAt);
    expect(later).toBeTruthy();
    const moved = await post(w, `/public/manage/${token}/reschedule`, {
      startsAt: later!.startsAt,
    });
    expect(moved.statusCode, moved.body).toBe(200);

    // Moved with no point handed over, as the AI teammate moves a visit: the point found at booking is read back.
    const [att] = await rows<{ id: string; manage_version: number }>(
      testDbs().admin.db,
      sql`select id, manage_version from app.appointment_attendees where public_ref = ${token.slice(0, 8)}`,
    );
    const again = times.find(
      (t) => t.startsAt !== near[0]!.startsAt && t.startsAt !== later!.startsAt,
    );
    const { output } = await executeCommand(
      testDbs().worker.db,
      attendeeRescheduleOnline,
      {
        workspaceId: w.workspaceId,
        attendeeId: att!.id,
        manageVersion: att!.manage_version,
        startsAt: again!.startsAt,
      },
      { type: 'system', workspaceId: w.workspaceId, organizationId: w.organizationId },
      { correlationId: crypto.randomUUID(), channel: 'test' },
    );
    expect(output.startsAt).toBe(new Date(again!.startsAt).toISOString());
  });
});

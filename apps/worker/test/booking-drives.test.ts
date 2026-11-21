/**
 * Drive times between visits through the worker (docs/outreach.md, decision 179): a calendar with Leave time to
 * drive between visits asks for the address first, offers only times that leave room to drive from the visit
 * before and on to the next, refuses an address it can't find, and books only a time that leaves room.
 *
 * The stand-in geocoder reads "@lat,lng" from an address, and the rough drive timer guesses from the straight line.
 */
import { dayStartSet } from '@hfos/core/server';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetDrives } from '../src/booking/drives';
import { roughMinutes } from '../src/geo/driving';
import {
  customer,
  errorOf,
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
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DOWNTOWN = { lat: 30.2672, lng: -97.7431 };
const NORTH = { lat: 30.5, lng: -97.7 };
const AT_DOWNTOWN = '301 Congress Ave, Austin, TX 78701 @30.2672,-97.7431';
const AT_NORTH = '1 Main St, Round Rock, TX 78664 @30.5,-97.7';

beforeAll(async () => {
  forgetDrives();
  w = await makeWorld('drives');
}, 60_000);
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('a calendar that leaves time to drive between visits', () => {
  it('asks for the address first and offers only times the drive leaves room for', async () => {
    await run(w, dayStartSet, { workspaceId: w.workspaceId, address: AT_DOWNTOWN });
    const cal = await makeCalendar(w, 'Car detailing', {
      durations: { minutes: [60], step: 30 },
      locations: { options: [{ kind: 'customer_address' }] },
      buffers: { driveBetween: true },
    });
    const info = await get(w, `/public/book/${w.site}/${cal.slug}`);
    expect(info.statusCode, info.body).toBe(200);
    expect(info.json()).toMatchObject({ booking: { drives: true } });

    // A visit downtown, tomorrow on the hour.
    const visit = Math.ceil((Date.now() + DAY) / HOUR) * HOUR;
    const first = await post(w, `/public/book/${w.site}/${cal.slug}/bookings`, {
      clientId: crypto.randomUUID(),
      startsAt: iso(visit),
      ...customer('Dana'),
      locationKind: 'customer_address',
      address: AT_DOWNTOWN,
    });
    expect(first.statusCode, first.body).toBe(200);

    const drive = roughMinutes(DOWNTOWN, NORTH) * MIN;
    expect(drive).toBeGreaterThanOrEqual(30 * MIN);
    const from = iso(visit - 6 * HOUR);
    const to = iso(visit + 6 * HOUR);
    const slots = async (address: string) =>
      get(
        w,
        `/public/book/${w.site}/${cal.slug}/slots?${new URLSearchParams({ from, to, address, locationKind: 'customer_address' })}`,
      );
    const north = await slots(AT_NORTH);
    expect(north.statusCode, north.body).toBe(200);
    const starts = (north.json() as { slots: { startsAt: string }[] }).slots.map((s) =>
      Date.parse(s.startsAt),
    );
    // Nothing that ends less than a drive before the visit, or starts less than a drive after it.
    const tooClose = starts.filter((s) => s + HOUR > visit - drive && s < visit + HOUR + drive);
    expect(tooClose).toEqual([]);
    const after = starts.find((s) => s >= visit + HOUR + drive);
    expect(after).toBeDefined();
    // Next door to the visit, the drive is short: the hour right after it is open.
    const nextDoor = await slots('303 Congress Ave, Austin, TX 78701 @30.2673,-97.7431');
    const close = (nextDoor.json() as { slots: { startsAt: string }[] }).slots.map((s) =>
      Date.parse(s.startsAt),
    );
    expect(close).toContain(visit + HOUR + 30 * MIN);

    // An address that isn't on any map: no times on a guess.
    const lost = await slots('Nowhere Lane, TX');
    expect(lost.statusCode).toBe(422);
    expect(errorOf(lost).rule).toBe('address_not_found');

    // Booking too close is refused; a time with room books.
    const tight = await post(w, `/public/book/${w.site}/${cal.slug}/bookings`, {
      clientId: crypto.randomUUID(),
      startsAt: iso(visit + HOUR),
      ...customer('Remi'),
      locationKind: 'customer_address',
      address: AT_NORTH,
    });
    expect(tight.statusCode, tight.body).toBe(409);
    const roomy = await post(w, `/public/book/${w.site}/${cal.slug}/bookings`, {
      clientId: crypto.randomUUID(),
      startsAt: iso(after!),
      ...customer('Remi'),
      locationKind: 'customer_address',
      address: AT_NORTH,
    });
    expect(roomy.statusCode, roomy.body).toBe(200);
  });
});

describe('meeting up for coffee (coffee spots)', () => {
  it('offers the usual spot, finds one halfway, and books where they pick', async () => {
    const usual = 'Mozart’s Coffee, 3825 Lake Austin Blvd, Austin, TX @30.2950,-97.7840';
    const cal = await makeCalendar(w, 'Coffee chat', {
      durations: { minutes: [60], step: 30 },
      locations: { options: [{ kind: 'meetup', address: usual }] },
      buffers: { driveBetween: true },
    });
    const info = await get(w, `/public/book/${w.site}/${cal.slug}`);
    expect(info.json()).toMatchObject({
      booking: { drives: true, locations: [{ kind: 'meetup', label: 'Meet up', address: usual }] },
    });

    // Halfway between them and where the owner's day starts (downtown, set above).
    const halfway = await get(
      w,
      `/public/book/${w.site}/${cal.slug}/halfway?${new URLSearchParams({ address: AT_NORTH })}`,
    );
    expect(halfway.statusCode, halfway.body).toBe(200);
    const { spot } = halfway.json() as { spot: { name: string; address: string } };
    expect(spot.name).toBe('Halfway Coffee');
    expect(spot.address).toMatch(/^100 Middle Rd @30\.383/);
    const lost = await get(
      w,
      `/public/book/${w.site}/${cal.slug}/halfway?${new URLSearchParams({ address: 'Nowhere, TX' })}`,
    );
    expect(errorOf(lost).rule).toBe('address_not_found');

    const at = `${spot.name}, ${spot.address}`;
    const day = Math.ceil((Date.now() + 3 * DAY) / HOUR) * HOUR;
    const times = await get(
      w,
      `/public/book/${w.site}/${cal.slug}/slots?${new URLSearchParams({ from: iso(day), to: iso(day + 4 * HOUR), address: at, locationKind: 'meetup' })}`,
    );
    expect(times.statusCode, times.body).toBe(200);
    const first = (times.json() as { slots: { startsAt: string }[] }).slots[0]!;
    const booked = await post(w, `/public/book/${w.site}/${cal.slug}/bookings`, {
      clientId: crypto.randomUUID(),
      startsAt: first.startsAt,
      ...customer('Jo'),
      locationKind: 'meetup',
      address: at,
    });
    expect(booked.statusCode, booked.body).toBe(200);
    expect(JSON.stringify(booked.json())).toContain('Halfway Coffee, 100 Middle Rd');

    // A calendar that doesn't meet up has no spot to find.
    const other = await makeCalendar(w, 'Phone chat', {
      locations: { options: [{ kind: 'phone' }] },
    });
    const none = await get(
      w,
      `/public/book/${w.site}/${other.slug}/halfway?${new URLSearchParams({ address: AT_NORTH })}`,
    );
    expect(errorOf(none).rule).toBe('no_meetup');
  });
});

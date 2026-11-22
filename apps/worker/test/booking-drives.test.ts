/**
 * Drive times between visits through the worker (docs/outreach.md, decision 179): a calendar with Leave time to
 * drive between visits asks for the address first, offers only times that leave room to drive from the visit
 * before and on to the next, refuses an address it can't find, and books only a time that leaves room.
 *
 * The stand-in geocoder reads "@lat,lng" from an address, and the rough drive timer guesses from the straight line.
 * Both stand-ins count against the daily budget for paid map lookups like Google would (geo/budget.ts).
 */
import { dayStartSet } from '@hfos/core/server';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { passThroughBotCheck } from '../src/booking/bot-check';
import { forgetDrives } from '../src/booking/drives';
import { roughMinutes } from '../src/geo/driving';
import type { createFakeGeocoder } from '../src/geo/geocoder';
import { forgetSpots } from '../src/geo/places';
import { buildHttpServer } from '../src/http/server';
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

/** Every address the stand-in geocoder was asked about: one it was asked is one Google would bill. */
const asked = () => (w.s.geocoder as ReturnType<typeof createFakeGeocoder>).asked;
const startsOf = (res: LightMyRequestResponse) =>
  (res.json() as { slots: { startsAt: string }[] }).slots.map((s) => Date.parse(s.startsAt));
const uniq = () => crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  forgetDrives();
  forgetSpots();
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

  it('looks up an address found nowhere once, whether a customer typed it or a visit has it', async () => {
    await run(w, dayStartSet, { workspaceId: w.workspaceId, address: AT_DOWNTOWN });
    const cal = await makeCalendar(w, 'Mobile wash', {
      durations: { minutes: [60], step: 30 },
      locations: { options: [{ kind: 'customer_address' }] },
      buffers: { driveBetween: true },
    });
    // A calendar that doesn't time drives takes any address, so a visit can be where no map finds it.
    const plain = await makeCalendar(w, 'House calls', {
      durations: { minutes: [60], step: 30 },
      locations: { options: [{ kind: 'customer_address' }] },
    });
    const lostVisit = `${uniq()} Nowhere Rd, Austin, TX`;
    const visit = Math.ceil((Date.now() + 6 * DAY) / HOUR) * HOUR;
    const booked = await post(w, `/public/book/${w.site}/${plain.slug}/bookings`, {
      clientId: crypto.randomUUID(),
      startsAt: iso(visit),
      ...customer('Sky'),
      locationKind: 'customer_address',
      address: lostVisit,
    });
    expect(booked.statusCode, booked.body).toBe(200);

    const slots = (address: string) =>
      get(
        w,
        `/public/book/${w.site}/${cal.slug}/slots?${new URLSearchParams({ from: iso(visit - 6 * HOUR), to: iso(visit + 6 * HOUR), address, locationKind: 'customer_address' })}`,
      );
    for (let i = 0; i < 3; i++) {
      const res = await slots(AT_NORTH);
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(asked().filter((a) => a === lostVisit)).toHaveLength(1);
    const typo = `${uniq()} Nowhere Lane, TX`;
    for (let i = 0; i < 3; i++) expect(errorOf(await slots(typo)).rule).toBe('address_not_found');
    expect(asked().filter((a) => a === typo)).toHaveLength(1);
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

  it('searches once for customers within about 100 m of each other', async () => {
    forgetSpots();
    await run(w, dayStartSet, { workspaceId: w.workspaceId, address: AT_DOWNTOWN });
    const cal = await makeCalendar(w, 'Walk and talk', {
      locations: { options: [{ kind: 'meetup' }] },
    });
    const near = vi.spyOn(w.s.places, 'near');
    try {
      const halfway = (address: string) =>
        get(w, `/public/book/${w.site}/${cal.slug}/halfway?${new URLSearchParams({ address })}`);
      // Halfway to downtown: about 30.3836,-97.7221 and 30.3837,-97.7222, the same 100 m.
      const a = await halfway('10 Oak St, Round Rock, TX @30.5000,-97.7010');
      const b = await halfway('12 Oak St, Round Rock, TX @30.5002,-97.7012');
      expect(a.statusCode, a.body).toBe(200);
      expect(b.json()).toEqual(a.json());
      expect((a.json() as { spot: { name: string } }).spot.name).toBe('Halfway Coffee');
      expect(near).toHaveBeenCalledTimes(1);
      // Farther away, a search of its own.
      await halfway('1 Elm St, Georgetown, TX @30.63,-97.68');
      expect(near).toHaveBeenCalledTimes(2);
    } finally {
      near.mockRestore();
    }
  });
});

describe('past the day’s budget for paid map lookups', () => {
  it('asks the maps nothing more, and the page still answers', async () => {
    // The same services behind a second server, whose budget is one lookup per business a day.
    const ROOM = { max: 10_000, timeWindow: MIN };
    const tight = await buildHttpServer({
      ...w.s,
      httpDb: testDbs().worker.db,
      verifyToken: null,
      webOrigins: ['http://localhost:3000'],
      booking: {
        botCheck: passThroughBotCheck,
        limits: { read: ROOM, book: ROOM, manageRead: ROOM, manageWrite: ROOM },
        lookupBudget: { perBusiness: 1 },
      },
    });
    const t: World = { ...w, app: tight };
    const near = vi.spyOn(w.s.places, 'near');
    try {
      await run(w, dayStartSet, { workspaceId: w.workspaceId, address: AT_DOWNTOWN });
      const cal = await makeCalendar(w, 'Mobile detailing', {
        durations: { minutes: [60], step: 30 },
        locations: { options: [{ kind: 'customer_address' }, { kind: 'meetup' }] },
        buffers: { driveBetween: true },
      });
      // A visit downtown, booked on the usual server (which also finds downtown on the map once and keeps it).
      const visit = Math.ceil((Date.now() + 9 * DAY) / HOUR) * HOUR;
      const first = await post(w, `/public/book/${w.site}/${cal.slug}/bookings`, {
        clientId: crypto.randomUUID(),
        startsAt: iso(visit),
        ...customer('Lee'),
        locationKind: 'customer_address',
        address: AT_DOWNTOWN,
      });
      expect(first.statusCode, first.body).toBe(200);

      const slots = (address: string) =>
        get(
          t,
          `/public/book/${w.site}/${cal.slug}/slots?${new URLSearchParams({ from: iso(visit - 6 * HOUR), to: iso(visit + 6 * HOUR), address, locationKind: 'customer_address' })}`,
        );
      const drive = roughMinutes(DOWNTOWN, NORTH) * MIN;
      const tooClose = (starts: number[]) =>
        starts.filter((s) => s + HOUR > visit - drive && s < visit + HOUR + drive);
      // The day's one lookup: a new address, found, and times that leave room to drive.
      const one = `${uniq()} Oak St, Round Rock, TX @30.5,-97.7`;
      const timed = await slots(one);
      expect(timed.statusCode, timed.body).toBe(200);
      expect(tooClose(startsOf(timed))).toEqual([]);

      // Another new address isn't looked up: times as with maps off, back to back with the visit.
      const before = asked().length;
      const two = `${uniq()} Elm St, Round Rock, TX @30.5,-97.7`;
      const untimed = await slots(two);
      expect(untimed.statusCode, untimed.body).toBe(200);
      expect(startsOf(untimed)).toContain(visit + HOUR);
      // Nor is a coffee spot looked for: the page offers the usual spot or one they name.
      const spot = await get(
        t,
        `/public/book/${w.site}/${cal.slug}/halfway?${new URLSearchParams({ address: `${uniq()} Ash St, Austin, TX @30.4,-97.7` })}`,
      );
      expect(spot.statusCode, spot.body).toBe(200);
      expect(spot.json()).toEqual({ spot: null });
      expect(asked()).toHaveLength(before);
      expect(near).not.toHaveBeenCalled();

      // The address found before is kept, so it's still timed.
      expect(tooClose(startsOf(await slots(one)))).toEqual([]);
      // And booking (behind the bot check) still finds the address and keeps room to drive.
      const tight409 = await post(t, `/public/book/${w.site}/${cal.slug}/bookings`, {
        clientId: crypto.randomUUID(),
        startsAt: iso(visit + HOUR),
        ...customer('Ari'),
        locationKind: 'customer_address',
        address: two,
      });
      expect(tight409.statusCode, tight409.body).toBe(409);
      expect(asked()).toContain(two);
    } finally {
      near.mockRestore();
      await tight.close();
    }
  });
});

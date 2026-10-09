/**
 * The public booking page's routes end to end on the real database: listing and booking, the honeypot,
 * per-address limits, the bot check on and off, two customers racing for one time, change-or-cancel
 * links (good, bad and stale; rescheduling and cancelling within the cutoffs; the calendar file), the
 * waitlist for a full session, and the links' signing and key rotation.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  applyPatch,
  bookingSiteSetPage,
  bookingSiteUpdate,
  chatWidgetCreate,
  chatWidgetPause,
  calendarCreate,
  calendarGet,
  calendarSave,
  calendarSetStatus,
  executeCommand,
  executeQuery,
  knowledgeProfileUpdate,
  KnowledgeProfile,
  organizationCreate,
  scheduleSet,
  sessionPublish,
  type CalendarConfig,
  type CommandDef,
  type ConfigPatch,
  type HumanActor,
  workspaceUpdate,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  fakeBotCheck,
  passThroughBotCheck,
  turnstileBotCheck,
  TURNSTILE_TEST_SECRET_KEY,
  TURNSTILE_TEST_SITE_KEY,
  type FakeBotCheck,
} from '../src/booking/bot-check';
import {
  createBookingLinks,
  manageToken,
  manageUrl,
  parseLinkToken,
  verifyManageCode,
  verifyWaitlistCode,
  waitlistUrl,
} from '../src/booking/links';
import type { BookingHttpOptions } from '../src/http/booking';
import { buildHttpServer } from '../src/http/server';
import { testServices, type TestServices } from './helpers';

const MIN = 60_000;
const DAY = 86_400_000;
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));
/** Room for every test's requests; the limits test builds its own server. */
const ROOMY: BookingHttpOptions['limits'] = {
  read: { max: 10_000, timeWindow: MIN },
  book: { max: 10_000, timeWindow: MIN },
  manageRead: { max: 10_000, timeWindow: MIN },
  manageWrite: { max: 10_000, timeWindow: MIN },
};

const token = () => randomUUID().slice(0, 8);
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let workspaceId: string;
let site: string;
let s: TestServices;
let app: FastifyInstance;
const servers: FastifyInstance[] = [];

function run<I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
): Promise<z.output<O>> {
  return executeCommand(api(), cmd, input, actor(owner), meta()).then((r) => r.output);
}

let phoneSeq = 0;
/** A distinct US mobile number per call. */
const nextPhone = () => `+1713555${String(1000 + ((phoneSeq++ * 37) % 9000)).padStart(4, '0')}`;

/** A public, active calendar for Dale, bookable right away, with change and cancel allowed until the start. */
async function makeCalendar(name: string, patch: ConfigPatch = {}) {
  const created = await run(calendarCreate, { workspaceId, name, preset: 'scratch' });
  const { calendar } = await executeQuery(
    api(),
    calendarGet,
    { workspaceId, calendarId: created.calendarId },
    actor(owner),
    meta(),
  );
  const draft = applyPatch(
    applyPatch(calendar.config as CalendarConfig, {
      public: true,
      team: { members: [{ userId: owner.id }] },
      window: { minNoticeMinutes: 0 },
      policies: { cancel: { cutoffHours: 0 }, reschedule: { cutoffHours: 0, maxTimes: 2 } },
    }),
    patch,
  );
  await run(calendarSave, {
    workspaceId,
    calendarId: created.calendarId,
    baseRevision: calendar.revision,
    draft,
  });
  await run(calendarSetStatus, { workspaceId, calendarId: created.calendarId, status: 'active' });
  return { id: created.calendarId, slug: created.slug };
}

async function server(booking: BookingHttpOptions): Promise<FastifyInstance> {
  const srv = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
    booking,
  });
  servers.push(srv);
  return srv;
}

const get = (url: string, opts: { ip?: string; srv?: FastifyInstance } = {}) =>
  (opts.srv ?? app).inject({
    method: 'GET',
    url,
    headers: { 'x-forwarded-for': opts.ip ?? '203.0.113.10' },
  });
const post = (url: string, body: unknown, opts: { ip?: string; srv?: FastifyInstance } = {}) =>
  (opts.srv ?? app).inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': opts.ip ?? '203.0.113.10' },
    payload: JSON.stringify(body),
  });
const errorOf = (res: LightMyRequestResponse) =>
  (res.json() as { error: { code: string; rule?: string; message: string; details?: unknown } })
    .error;

interface Slot {
  startsAt: string;
  endsAt: string;
  sessionId: string | null;
  seatsLeft: number | null;
}

/** Open times from an hour from now to a week out. */
async function openTimes(slug: string, extra = '', srv?: FastifyInstance) {
  const from = new Date(Date.now() + 60 * MIN).toISOString();
  const to = new Date(Date.now() + 7 * DAY).toISOString();
  const res = await get(
    `/public/book/${site}/${slug}/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`,
    { srv },
  );
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    slots: Slot[];
    full: { sessionId: string; startsAt: string; waiting: number }[];
  };
}

const customer = (label: string) => ({
  name: `${label} Customer`,
  phone: nextPhone(),
  email: `${label.toLowerCase()}-${token()}@example.com`,
});
const bookingBody = (startsAt: string, extra: Record<string, unknown> = {}) => ({
  clientId: randomUUID(),
  startsAt,
  ...customer('Nora'),
  ...extra,
});

interface Booked {
  booking: {
    title: string;
    startsAt: string;
    endsAt: string;
    with: string[];
    timezoneLabel: string;
  };
  manageToken: string;
  manageUrl: string;
  duplicate: boolean;
  joined: boolean;
  contact: { email: string | null; texts: boolean };
}

async function book(slug: string, startsAt: string, extra: Record<string, unknown> = {}) {
  const res = await post(`/public/book/${site}/${slug}/bookings`, bookingBody(startsAt, extra));
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Booked;
}

beforeAll(async () => {
  owner = await createTestUser('booking-worker-dale', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Booking Worker HVAC', timezone: 'America/Chicago' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  await run(scheduleSet, { workspaceId, ownerId: owner.id, weekly: ALL_WEEK });
  site = `bw-${token()}`;
  await run(bookingSiteUpdate, { workspaceId, slug: site, name: 'Lone Star Test HVAC' });
  s = testServices();
  app = await server({ botCheck: passThroughBotCheck, limits: ROOMY });
});
afterAll(async () => {
  for (const srv of servers) await srv.close();
  await closeTestDbs();
});

describe('the booking page', () => {
  it('lists the calendars, shows one, and books it with a change-or-cancel link', async () => {
    const cal = await makeCalendar('Tune-ups');
    const listed = await get(`/public/book/${site}`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      business: { name: 'Lone Star Test HVAC' },
      site: { slug: site, enabled: true },
      timezoneLabel: 'Central Time',
    });
    expect((listed.json() as { calendars: { slug: string }[] }).calendars).toContainEqual(
      expect.objectContaining({ slug: cal.slug, name: 'Tune-ups' }),
    );

    const info = await get(`/public/book/${site}/${cal.slug}`);
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({
      state: 'open',
      canonical: { site, calendar: cal.slug },
      timezone: 'America/Chicago',
      calendar: { id: cal.id, name: 'Tune-ups' },
      booking: { durations: [60], zipRouting: null, botCheck: null, mode: 'hours' },
    });

    const { slots } = await openTimes(cal.slug);
    expect(slots.length).toBeGreaterThan(3);
    // The page passes on the link's ref (a demo link's, a campaign's); one that isn't a ref is dropped.
    const body = bookingBody(slots[1]!.startsAt, { smsConsent: true, ref: 'spring-mailer' });
    const res = await post(`/public/book/${site}/${cal.slug}/bookings`, body);
    expect(res.statusCode, res.body).toBe(200);
    const booked = res.json() as Booked;
    expect(booked).toMatchObject({
      booking: { title: 'Tune-ups', startsAt: slots[1]!.startsAt, with: ['Dale'] },
      duplicate: false,
      joined: false,
      contact: { email: body.email, texts: true },
    });
    expect(booked.manageUrl).toBe(`http://localhost:3000/m/${booked.manageToken}`);
    expect(booked.manageToken).toMatch(/^[0-9A-Za-z]{18}$/);
    const [saved] = await rows<{
      source: string;
      public_ref: string;
      first_name: string;
      link_ref: string | null;
    }>(
      admin(),
      sql`select p.source::text as source, a.public_ref, c.first_name, a.link_ref
          from app.appointments p
          join app.appointment_attendees a on a.appointment_id = p.id
          join app.people c on c.id = a.person_id
          where p.calendar_id = ${cal.id} and p.starts_at = ${slots[1]!.startsAt}::timestamptz`,
    );
    expect(saved).toEqual({
      source: 'booking_page',
      public_ref: booked.manageToken.slice(0, 8),
      first_name: 'Nora',
      link_ref: 'spring-mailer',
    });

    // A doubled tap sends the same clientId: one booking, the same link.
    const again = await post(`/public/book/${site}/${cal.slug}/bookings`, body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true, manageToken: booked.manageToken });
  });

  it('hides private calendars, says when one is off, and follows the permanent link', async () => {
    const hidden = await makeCalendar('Private', { public: false });
    expect((await get(`/public/book/${site}/${hidden.slug}`)).statusCode).toBe(404);
    expect((await get(`/public/book/no-such-${token()}/x`)).statusCode).toBe(404);
    expect((await get(`/public/book/${site}/no-such-calendar`)).statusCode).toBe(404);

    const paused = await makeCalendar('Paused');
    const permanent = await get(`/public/book/c/${paused.id}`);
    expect(permanent.json()).toMatchObject({ canonical: { site, calendar: paused.slug } });
    const { slots } = await openTimes(paused.slug);
    await run(calendarSetStatus, { workspaceId, calendarId: paused.id, status: 'paused' });
    const off = await get(`/public/book/${site}/${paused.slug}`);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ state: 'off', booking: null, calendar: { name: 'Paused' } });
    const refused = await post(
      `/public/book/${site}/${paused.slug}/bookings`,
      bookingBody(slots[0]!.startsAt),
    );
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused).rule).toBe('calendar_not_bookable');
  });

  it('answers a filled honeypot with a plain 400 and saves nothing', async () => {
    const cal = await makeCalendar('Honeypot');
    const { slots } = await openTimes(cal.slug);
    const body = bookingBody(slots[0]!.startsAt, { website: 'https://cheap-pills.example' });
    const res = await post(`/public/book/${site}/${cal.slug}/bookings`, body);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).message).toBe('That didn’t go through. Refresh the page and try again.');
    const saved = await rows(
      admin(),
      sql`select 1 from app.people where workspace_id = ${workspaceId} and phone_e164 = ${body.phone}
          union all select 1 from app.appointments where calendar_id = ${cal.id}`,
    );
    expect(saved).toEqual([]);
  });

  it('takes US and Canadian numbers only, and says which field is wrong', async () => {
    const cal = await makeCalendar('Numbers');
    const { slots } = await openTimes(cal.slug);
    const uk = await post(
      `/public/book/${site}/${cal.slug}/bookings`,
      bookingBody(slots[0]!.startsAt, { phone: '+44 20 7946 0958' }),
    );
    expect(uk.statusCode).toBe(400);
    expect(errorOf(uk).details).toEqual([
      { path: 'phone', message: 'Use a US or Canadian mobile number.' },
    ]);
    const nobody = await post(
      `/public/book/${site}/${cal.slug}/bookings`,
      bookingBody(slots[0]!.startsAt, { phone: '', email: '' }),
    );
    expect(nobody.statusCode).toBe(400);
    expect(errorOf(nobody).details).toContainEqual(
      expect.objectContaining({ path: 'phone', message: 'Enter a mobile number or an email.' }),
    );
    // A Canadian mobile books.
    const ca = await post(
      `/public/book/${site}/${cal.slug}/bookings`,
      bookingBody(slots[0]!.startsAt, { phone: '(604) 555-0199' }),
    );
    expect(ca.statusCode, ca.body).toBe(200);
  });

  it('limits each address: reads, then bookings, with other addresses unaffected', async () => {
    const cal = await makeCalendar('Busy');
    const limited = await server({
      limits: {
        read: { max: 2, timeWindow: MIN },
        book: { max: 2, timeWindow: 10 * MIN },
      },
    });
    const a = { srv: limited, ip: '198.51.100.7' };
    expect((await get(`/public/book/${site}/${cal.slug}`, a)).statusCode).toBe(200);
    expect((await get(`/public/book/${site}/${cal.slug}`, a)).statusCode).toBe(200);
    const third = await get(`/public/book/${site}/${cal.slug}`, a);
    expect(third.statusCode).toBe(429);
    expect(errorOf(third)).toMatchObject({ code: 'rule_violation', rule: 'rate_limited' });
    expect(
      (await get(`/public/book/${site}/${cal.slug}`, { srv: limited, ip: '198.51.100.8' }))
        .statusCode,
    ).toBe(200);
    // Bookings count on their own: honeypot tries are refused but still counted.
    const spam = bookingBody(new Date(Date.now() + DAY).toISOString(), { website: 'x' });
    const url = `/public/book/${site}/${cal.slug}/bookings`;
    expect((await post(url, spam, a)).statusCode).toBe(400);
    expect((await post(url, spam, a)).statusCode).toBe(400);
    const blocked = await post(url, spam, a);
    expect(blocked.statusCode).toBe(429);
    expect(errorOf(blocked).rule).toBe('rate_limited');
  });

  it('asks for the bot check when it is on, and passes the address along', async () => {
    const cal = await makeCalendar('Checked');
    const fake: FakeBotCheck = fakeBotCheck();
    const checked = await server({ botCheck: fake, limits: ROOMY });
    const info = await get(`/public/book/${site}/${cal.slug}`, { srv: checked });
    expect(info.json()).toMatchObject({ booking: { botCheck: { siteKey: 'fake-site-key' } } });
    const { slots } = await openTimes(cal.slug, '', checked);
    const url = `/public/book/${site}/${cal.slug}/bookings`;
    const missing = await post(url, bookingBody(slots[0]!.startsAt), {
      srv: checked,
      ip: '192.0.2.44',
    });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing).rule).toBe('bot_check_failed');
    const wrong = await post(url, bookingBody(slots[0]!.startsAt, { turnstileToken: 'nope' }), {
      srv: checked,
    });
    expect(errorOf(wrong).rule).toBe('bot_check_failed');
    const [none] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.appointments where calendar_id = ${cal.id}`,
    );
    expect(none!.n).toBe(0);
    const ok = await post(url, bookingBody(slots[0]!.startsAt, { turnstileToken: 'pass' }), {
      srv: checked,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(fake.seen[0]).toEqual({ token: undefined, ip: '192.0.2.44' });
    // With the check off (the main server), no token is needed: the first test booked without one.
  });

  it('asks Cloudflare with the secret, the token and the address', async () => {
    const calls: { url: string; body: string }[] = [];
    const answer = (success: boolean) =>
      turnstileBotCheck(TURNSTILE_TEST_SECRET_KEY, {
        fetch: (async (url: string, init: { body: string }) => {
          calls.push({ url, body: init.body });
          return new Response(JSON.stringify({ success }), { status: 200 });
        }) as unknown as typeof fetch,
      });
    const passing = answer(true);
    expect(passing).toMatchObject({ enabled: true, siteKey: TURNSTILE_TEST_SITE_KEY });
    expect(await passing.verify('tok-1', '203.0.113.9')).toBe('pass');
    const form = new URLSearchParams(calls[0]!.body);
    expect(calls[0]!.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(Object.fromEntries(form)).toEqual({
      secret: TURNSTILE_TEST_SECRET_KEY,
      response: 'tok-1',
      remoteip: '203.0.113.9',
    });
    expect(await answer(false).verify('tok-2', '203.0.113.9')).toBe('fail');
    expect(await passing.verify(undefined, '203.0.113.9')).toBe('fail');
    const down = turnstileBotCheck('real-secret', {
      fetch: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    });
    expect(down.siteKey).toBeNull();
    expect(await down.verify('tok-3', '203.0.113.9')).toBe('unavailable');
  });

  it('gives one of two customers racing for the same time the booking, and the other fresh times', async () => {
    const cal = await makeCalendar('Race');
    const { slots } = await openTimes(cal.slug);
    const url = `/public/book/${site}/${cal.slug}/bookings`;
    const [first, second] = await Promise.all([
      post(url, bookingBody(slots[2]!.startsAt), { ip: '203.0.113.21' }),
      post(url, bookingBody(slots[2]!.startsAt), { ip: '203.0.113.22' }),
    ]);
    const statuses = [first!.statusCode, second!.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const lost = first!.statusCode === 409 ? first! : second!;
    const err = errorOf(lost);
    expect(err.rule).toBe('slot_taken');
    const fresh = (err.details as { slots: { startsAt: string }[] }).slots;
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.map((f) => f.startsAt)).not.toContain(slots[2]!.startsAt);
    const [n] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.appointments where calendar_id = ${cal.id} and status = 'scheduled'`,
    );
    expect(n!.n).toBe(1);
  });
});

describe('the simple page', () => {
  interface Page {
    description: string;
    servicesTitle: string;
    services: { name: string; description: string; price: string | null }[];
    area: string;
    place: string | null;
    openHours: unknown;
    hours: string;
    privacyPath: string;
    termsPath: string;
    textTo: string | null;
    chat: string | null;
  }
  const pageOf = async (query = '') => {
    const res = await get(`/public/book/${site}${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { page: Page | null }).page;
  };
  const OPEN = [1, 2, 3, 4, 5].map((day) => ({ day, start: '07:00', end: '18:00' }));
  const profile = (allowPrices: boolean) =>
    KnowledgeProfile.parse({
      description: 'Heating and cooling for Houston homes.',
      services: [
        { name: 'AC repair', description: 'Same week', price: 'From $89' },
        { name: 'Tune-up', price: null },
      ],
      serviceArea: 'Houston and Katy',
      allowPrices,
    });

  it('isn’t there until the business turns it on', async () => {
    expect(await pageOf()).toBeNull();
  });

  it('shows what the business keeps: what it does, its services, area, city and hours', async () => {
    await run(knowledgeProfileUpdate, { workspaceId, profile: profile(false) });
    await run(workspaceUpdate, {
      workspaceId,
      settings: {
        openHours: OPEN,
        address: { line1: '9 Elm St', city: 'Houston', state: 'TX', postalCode: '77002' },
      },
    });
    await run(bookingSiteSetPage, { workspaceId, on: true });
    expect(await pageOf()).toEqual({
      description: 'Heating and cooling for Houston homes.',
      servicesTitle: 'Services',
      // No prices: the business doesn't tell customers its prices.
      services: [
        { name: 'AC repair', description: 'Same week', price: null },
        { name: 'Tune-up', description: '', price: null },
      ],
      area: 'Houston and Katy',
      place: 'Houston, Texas',
      openHours: OPEN,
      hours: '',
      privacyPath: `/legal/${site}/privacy`,
      termsPath: `/legal/${site}/terms`,
      // No number yet, so nothing to text.
      textTo: null,
      chat: null,
    });

    await run(knowledgeProfileUpdate, { workspaceId, profile: profile(true) });
    expect((await pageOf())?.services[0]).toMatchObject({ name: 'AC repair', price: 'From $89' });
  });

  it('offers the chat only where it’s set up, and not while it’s paused', async () => {
    const made = await run(chatWidgetCreate, {
      workspaceId,
      allowedOrigins: ['https://page.example'],
    });
    const key = made.publicKey;
    expect((await pageOf('?origin=https%3A%2F%2Fpage.example'))?.chat).toBe(key);
    expect((await pageOf('?origin=https%3A%2F%2Felsewhere.example'))?.chat).toBeNull();
    expect((await pageOf())?.chat).toBeNull();
    expect((await pageOf("?origin=x'%20or%201%3D1"))?.chat).toBeNull();
    await run(chatWidgetPause, { workspaceId, widgetId: made.widgetId });
    expect((await pageOf('?origin=https%3A%2F%2Fpage.example'))?.chat).toBeNull();
  });
});

describe('change-or-cancel links', () => {
  it('shows the booking, refuses bad and stale links, reschedules, cancels and exports it', async () => {
    const cal = await makeCalendar('Manage me');
    const { slots } = await openTimes(cal.slug);
    const booked = await book(cal.slug, slots[3]!.startsAt);
    const base = `/public/manage/${booked.manageToken}`;

    const view = await get(base);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.headers['referrer-policy']).toBe('no-referrer');
    expect(view.json()).toMatchObject({
      state: 'booked',
      business: { name: 'Lone Star Test HVAC' },
      calendar: { name: 'Manage me', bookingPath: `/book/${site}/${cal.slug}` },
      appointment: { title: 'Manage me', startsAt: slots[3]!.startsAt, with: ['Dale'] },
      policies: {
        reschedule: { allowed: true, movesLeft: 2, cutoffHours: 0 },
        cancel: { allowed: true, cutoffHours: 0 },
      },
      manageToken: booked.manageToken,
    });

    // Bad links: a changed code, an unknown reference, and the wrong shape.
    const last = booked.manageToken.at(-1) === 'a' ? 'b' : 'a';
    for (const bad of [
      `${booked.manageToken.slice(0, 17)}${last}`,
      `ZZZZZZZZ${booked.manageToken.slice(8)}`,
      'short',
    ])
      expect((await get(`/public/manage/${bad}`)).statusCode).toBe(404);

    // The calendar file: METHOD:PUBLISH, a stable UID and a SEQUENCE; no line over 75 octets.
    const ics = await get(`${base}/ics`);
    expect(ics.statusCode).toBe(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    const attendeeId = (
      await rows<{ id: string }>(
        admin(),
        sql`select id from app.appointment_attendees where public_ref = ${booked.manageToken.slice(0, 8)}`,
      )
    )[0]!.id;
    expect(ics.body).toContain('METHOD:PUBLISH');
    expect(ics.body).toContain(`UID:${attendeeId}@handsfreeos.com`);
    expect(ics.body).toMatch(/SEQUENCE:\d+/);
    expect(ics.body).toContain('STATUS:CONFIRMED');
    for (const line of ics.body.split('\r\n'))
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);

    // Rescheduling: the page's open times leave out the current one; the link stays the same.
    const moveTo = (await openTimes(cal.slug)).slots.find(
      (x) => x.startsAt !== slots[3]!.startsAt,
    )!;
    const from = new Date(Date.now() + 60 * MIN).toISOString();
    const to = new Date(Date.now() + 7 * DAY).toISOString();
    const own = await get(
      `${base}/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(own.statusCode, own.body).toBe(200);
    const ownTimes = (own.json() as { slots: Slot[] }).slots.map((x) => x.startsAt);
    expect(ownTimes).not.toContain(slots[3]!.startsAt);
    expect(ownTimes).toContain(moveTo.startsAt);
    const moved = await post(`${base}/reschedule`, { startsAt: moveTo.startsAt });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({
      state: 'booked',
      newLink: false,
      manageToken: booked.manageToken,
      appointment: { startsAt: moveTo.startsAt },
      policies: { reschedule: { movesLeft: 1 } },
    });
    const icsAfter = await get(`${base}/ics`);
    const seq = (body: string) => Number(/SEQUENCE:(\d+)/.exec(body)![1]);
    expect(seq(icsAfter.body)).toBeGreaterThanOrEqual(seq(ics.body));

    // Staff changed something and retired the old links: the old one is out of date, a new one works.
    await rows(
      admin(),
      sql`update app.appointment_attendees set manage_version = manage_version + 1 where id = ${attendeeId}`,
    );
    const stale = await get(base);
    expect(stale.statusCode).toBe(410);
    expect(errorOf(stale)).toMatchObject({
      rule: 'manage_link_stale',
      details: { business: { name: 'Lone Star Test HVAC' } },
    });
    expect((await post(`${base}/cancel`, {})).statusCode).toBe(410);
    const fresh = manageToken(s.bookingLinks, {
      publicRef: booked.manageToken.slice(0, 8),
      attendeeId,
      manageVersion: 2,
    });
    expect((await get(`/public/manage/${fresh}`)).statusCode).toBe(200);

    // Cancelling: the page then says so, and a second cancel is refused.
    const cancelled = await post(`/public/manage/${fresh}/cancel`, { reason: 'Fixed it myself' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({
      state: 'cancelled',
      policies: { cancel: { allowed: false } },
    });
    const twice = await post(`/public/manage/${fresh}/cancel`, {});
    expect(twice.statusCode).toBe(409);
    expect(errorOf(twice).rule).toBe('booking_cancelled');
    expect((await get(`/public/manage/${fresh}/ics`)).body).toContain('STATUS:CANCELLED');
  });

  it('keeps to the cutoffs: too close to the start, it can’t be moved or cancelled online', async () => {
    const cal = await makeCalendar('Strict', {
      policies: { cancel: { cutoffHours: 48 }, reschedule: { cutoffHours: 48 } },
    });
    const { slots } = await openTimes(cal.slug);
    const soon = slots.find((x) => Date.parse(x.startsAt) < Date.now() + 47 * 3_600_000)!;
    const booked = await book(cal.slug, soon.startsAt);
    const base = `/public/manage/${booked.manageToken}`;
    expect((await get(base)).json()).toMatchObject({
      state: 'booked',
      policies: {
        reschedule: { allowed: false, reason: 'cutoff' },
        cancel: { allowed: false, reason: 'cutoff' },
      },
    });
    const later = slots.find((x) => Date.parse(x.startsAt) > Date.now() + 49 * 3_600_000)!;
    const moved = await post(`${base}/reschedule`, { startsAt: later.startsAt });
    expect(moved.statusCode).toBe(409);
    expect(errorOf(moved).rule).toBe('reschedule_cutoff');
    const cancelled = await post(`${base}/cancel`, {});
    expect(cancelled.statusCode).toBe(409);
    expect(errorOf(cancelled).rule).toBe('cancel_cutoff');
  });
});

describe('sessions and the waitlist', () => {
  it('fills a session, then puts the next customer on its waitlist once', async () => {
    const cal = await makeCalendar('Homeowner class', {
      schedule: { mode: 'sessions' },
      capacity: { seats: 1, maxPartySize: 1 },
      waitlist: { enabled: true },
    });
    const at = new Date(Date.now() + 3 * DAY);
    at.setUTCMinutes(0, 0, 0);
    const session = await run(sessionPublish, {
      workspaceId,
      calendarId: cal.id,
      startsAt: at.toISOString(),
      userIds: [owner.id],
    });
    const before = await openTimes(cal.slug);
    const open = before.slots.find((x) => x.sessionId === session.appointmentId)!;
    expect(open).toMatchObject({ seatsLeft: 1 });
    const booked = await book(cal.slug, open.startsAt, { sessionId: session.appointmentId });
    expect(booked.joined).toBe(true);

    const after = await openTimes(cal.slug);
    expect(after.slots.find((x) => x.sessionId === session.appointmentId)).toBeUndefined();
    expect(after.full).toContainEqual(
      expect.objectContaining({ sessionId: session.appointmentId, waiting: 0 }),
    );
    const waiter = { ...customer('Wendy'), sessionId: session.appointmentId };
    const url = `/public/book/${site}/${cal.slug}/waitlist`;
    const joined = await post(url, waiter);
    expect(joined.statusCode, joined.body).toBe(200);
    expect(joined.json()).toEqual({ position: 1, alreadyWaiting: false });
    const again = await post(url, waiter);
    expect(again.json()).toEqual({ position: 1, alreadyWaiting: true });
    expect((await openTimes(cal.slug)).full).toContainEqual(
      expect.objectContaining({ sessionId: session.appointmentId, waiting: 1 }),
    );
    const honeypot = await post(url, {
      ...customer('Bot'),
      sessionId: session.appointmentId,
      website: 'x',
    });
    expect(honeypot.statusCode).toBe(400);
  });
});

describe('link signing', () => {
  it('makes 18-character links that verify with the current and previous keys only', () => {
    const oldKey = randomBytes(32).toString('base64');
    const newKey = randomBytes(32).toString('base64');
    const before = createBookingLinks({ webUrl: 'https://app.example/', key: oldKey });
    const rotated = createBookingLinks({
      webUrl: 'https://app.example',
      key: newKey,
      previousKeys: [oldKey],
    });
    const newOnly = createBookingLinks({ webUrl: 'https://app.example', key: newKey });
    const link = { publicRef: 'Ab3dE5gH', attendeeId: randomUUID(), manageVersion: 1 };
    const url = manageUrl(before, link);
    expect(url).toMatch(/^https:\/\/app\.example\/m\/Ab3dE5gH[0-9A-Za-z]{10}$/);
    const { publicRef, code } = parseLinkToken(url.split('/m/')[1]!)!;
    expect(publicRef).toBe('Ab3dE5gH');
    expect(verifyManageCode(rotated, code, link.attendeeId, 1)).toBe(true);
    expect(verifyManageCode(newOnly, code, link.attendeeId, 1)).toBe(false);
    expect(verifyManageCode(rotated, code, link.attendeeId, 2)).toBe(false);
    expect(verifyManageCode(rotated, code, randomUUID(), 1)).toBe(false);
    // New links are signed with the new key.
    expect(manageToken(rotated, link)).not.toBe(manageToken(before, link));
    const offer = waitlistUrl(rotated, { publicRef: 'Ab3dE5gH', entryId: link.attendeeId });
    expect(offer).toMatch(/^https:\/\/app\.example\/w\/Ab3dE5gH[0-9A-Za-z]{10}$/);
    const offerCode = offer.slice(-10);
    expect(verifyWaitlistCode(rotated, offerCode, link.attendeeId)).toBe(true);
    expect(verifyManageCode(rotated, offerCode, link.attendeeId, 1)).toBe(false);
    for (const bad of ['', 'short', 'Ab3dE5gH!!!!!!!!!!', `Ab3dE5gH${'x'.repeat(11)}`])
      expect(parseLinkToken(bad)).toBeNull();
    expect(() => manageUrl(rotated, { ...link, publicRef: 'bad ref!' })).toThrow();
  });
});

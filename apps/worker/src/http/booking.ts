/**
 * The public booking page's routes. Signed-out customers see a business's calendars and open times, book,
 * join a waitlist, and change or cancel through their short link (`/m/<token>`, booking/links.ts).
 * Everything runs as the system actor on the `booking_page` channel, scoped by private.booking_route, and
 * only calendars that are active, public and on an enabled booking site take bookings. A private calendar
 * looks exactly like a missing one.
 *
 * Protection: per-address rate limits (@fastify/rate-limit; the server trusts the one proxy hop in front of
 * it), a bot check (Cloudflare Turnstile when configured), a honeypot field, US and Canadian numbers only,
 * the page's idempotency key, and the database's own caps (appointment.book_online, waitlist.join_online).
 */
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  appointmentBookOnline,
  attendeeCancelOnline,
  attendeeRescheduleOnline,
  bookableDurations,
  calendarAvailability,
  computeSlots,
  executeCommand,
  executeQuery,
  findBookingByClientId,
  formatPhone,
  HfosError,
  IntakeAnswers,
  loadCalendar,
  loadCatalogService,
  loadSlotInput,
  loadTerritories,
  LocationKind,
  normalizePhone,
  offerStillOpen,
  parseConfig,
  parseWaitlistOffer,
  slotOut,
  userNames,
  waitlistClaimOnline,
  waitlistClientId,
  waitlistJoinOnline,
  type CalendarConfig,
  type LoadedCalendar,
  type RequestMeta,
  type SlotOut,
} from '@hfos/core/server';
import { and, eq, inArray } from 'drizzle-orm';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import {
  appointmentAttendees,
  appointments,
  appointmentStaff,
  bookingSites,
  calendarRevisions,
  phoneNumbers,
  services as serviceRows,
  waitlistEntries,
  workspaces,
} from '@hfos/db/schema';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { passThroughBotCheck, type BotCheck } from '../booking/bot-check';
import { icsCalendar, icsSequence } from '../booking/ics';
import { manageToken, resolveManageToken, resolveWaitlistToken } from '../booking/links';
import { systemActor, type TenantScope } from '../services';
import { parseBody, type HttpDeps } from './common';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---- Limits and options ----

export interface RateRule {
  readonly max: number;
  /** Milliseconds. */
  readonly timeWindow: number;
}

export interface BookingLimits {
  /** Booking pages and their open times. */
  readonly read: RateRule;
  /** Bookings and waitlist joins. */
  readonly book: RateRule;
  /** A change-or-cancel page, its open times and its calendar file. */
  readonly manageRead: RateRule;
  /** Rescheduling and cancelling. */
  readonly manageWrite: RateRule;
}

/** Per address: reads 60 a minute, bookings 5 per 10 minutes, change-or-cancel 30 and 10 a minute. */
export const BOOKING_LIMITS: BookingLimits = {
  read: { max: 60, timeWindow: MIN },
  book: { max: 5, timeWindow: 10 * MIN },
  manageRead: { max: 30, timeWindow: MIN },
  manageWrite: { max: 10, timeWindow: MIN },
};

export interface BookingHttpOptions {
  /** Default: none (every booking passes). */
  readonly botCheck?: BotCheck;
  /** Multiplies every limit; 10 outside production, where Playwright books from one address. */
  readonly limitFactor?: number;
  /** Replaces limits outright (tests). */
  readonly limits?: Partial<BookingLimits>;
}

function limitsFor(opts: BookingHttpOptions): BookingLimits {
  const factor = Math.max(1, Math.floor(opts.limitFactor ?? 1));
  const scaled = (r: RateRule): RateRule => ({ max: r.max * factor, timeWindow: r.timeWindow });
  return {
    read: opts.limits?.read ?? scaled(BOOKING_LIMITS.read),
    book: opts.limits?.book ?? scaled(BOOKING_LIMITS.book),
    manageRead: opts.limits?.manageRead ?? scaled(BOOKING_LIMITS.manageRead),
    manageWrite: opts.limits?.manageWrite ?? scaled(BOOKING_LIMITS.manageWrite),
  };
}

// ---- Shapes and small helpers ----

type RouteRow = {
  workspace_id: string;
  organization_id: string;
  timezone: string;
  site_id: string | null;
  site_slug: string | null;
  site_name: string | null;
  site_enabled: boolean | null;
  calendar_id: string | null;
  calendar_slug: string | null;
  calendar_status: 'draft' | 'active' | 'paused' | 'archived' | null;
  calendar_public: boolean | null;
  redirected: boolean;
};

export interface PublicBusiness {
  readonly name: string;
  readonly phone: string | null;
  readonly phoneDisplay: string | null;
}

const SLUG_RE = /^[A-Za-z0-9-]{1,80}$/;
const NANP_RE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const instant = z.iso.datetime({
  offset: true,
  error: 'Use a date and time like 2026-10-01T15:00:00Z.',
});
const zip5 = (v: string | null | undefined): string => (v ?? '').replace(/\D/g, '').slice(0, 5);

const pageNotFound = () => HfosError.notFound('We couldn’t find that booking page.');
const notBookable = () =>
  HfosError.rule('calendar_not_bookable', 409, 'This calendar isn’t taking bookings right now.');
const linkNotFound = () =>
  HfosError.notFound('This link doesn’t work. Check that it matches the one we sent you.');

const meta = (): RequestMeta => ({
  correlationId: randomUUID(),
  causationId: null,
  channel: 'booking_page',
});

/** "Central Time" for America/Chicago. */
export function zoneLabel(timeZone: string): string {
  try {
    return (
      new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value ?? timeZone
    );
  } catch {
    return timeZone;
  }
}

/** A person's first name for customers; never an email address (userNames falls back to one). */
function firstName(full: string | undefined): string {
  const name = (full ?? '').trim();
  if (!name || name.includes('@') || name === 'Someone') return 'Our team';
  return name.split(/\s+/)[0]!;
}

async function firstNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const names = await userNames(tx, ids);
  return new Map([...new Set(ids)].map((id) => [id, firstName(names.get(id))]));
}

/** US and Canadian numbers only (+1), as E.164; null when left empty. */
function usPhone(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const e164 = normalizePhone(raw);
  if (!e164 || !NANP_RE.test(e164))
    throw HfosError.validation([{ path: 'phone', message: 'Use a US or Canadian mobile number.' }]);
  return e164;
}

/** "Mike Johnson" → Mike and Johnson; one word is a first name. */
function splitName(name: string): { firstName: string; lastName: string } {
  const [first = '', ...rest] = name.trim().split(/\s+/);
  return { firstName: first, lastName: rest.join(' ') };
}

/** Core names customer fields `customer.*`; the page's form has name, phone and email. */
function publicPaths(e: unknown): never {
  if (e instanceof HfosError && e.code === 'validation' && Array.isArray(e.details))
    throw new HfosError(
      'validation',
      400,
      e.message,
      (e.details as { path: string; message: string }[]).map((d) => ({
        ...d,
        path: d.path.replace(/^customer\.(firstName|lastName)$/, 'name').replace(/^customer\./, ''),
      })),
      e.rule,
    );
  throw e;
}

/** A filled honeypot is a bot: a plain 400, nothing saved. */
function refuseHoneypot(body: unknown): void {
  const website = (body as { website?: unknown } | null)?.website;
  if (typeof website === 'string' && website.trim() !== '')
    throw HfosError.validation([], 'Please check the form and try again.');
}

const LOCATION_LABEL: Record<string, string> = {
  customer_address: 'At your address',
  business: 'At our place',
  virtual: 'Online',
  phone: 'By phone',
};

type StoredLocation = {
  kind?: string | null;
  address?: string | null;
  meetingUrl?: string | null;
  postalCode?: string | null;
};

function whereText(location: unknown): string | null {
  const l = (location ?? {}) as StoredLocation;
  if (l.kind === 'customer_address' || l.kind === 'business') {
    const zip = l.kind === 'customer_address' && l.postalCode ? zip5(l.postalCode) : '';
    const address = (l.address ?? '').trim();
    const text = [address, zip && !address.includes(zip) ? zip : ''].filter(Boolean).join(', ');
    return text || (l.kind === 'customer_address' ? 'At your address' : null);
  }
  if (l.kind === 'virtual') return l.meetingUrl ? `Online: ${l.meetingUrl}` : 'Online';
  if (l.kind === 'phone') return 'By phone';
  return null;
}

// ---- Reads ----

async function businessIn(
  tx: Tx,
  workspaceId: string,
  siteName: string | null,
): Promise<PublicBusiness> {
  let name = siteName;
  if (!name) {
    const [w] = await tx
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    name = w?.name ?? 'The business';
  }
  const [phone] = await tx
    .select({ e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.status, 'active')))
    .limit(1);
  return {
    name,
    phone: phone?.e164 ?? null,
    phoneDisplay: phone ? formatPhone(phone.e164) : null,
  };
}

type BookedRow = {
  a: typeof appointmentAttendees.$inferSelect;
  p: typeof appointments.$inferSelect;
};

async function loadBooked(tx: Tx, attendeeId: string): Promise<BookedRow | null> {
  const [row] = await tx
    .select({ a: appointmentAttendees, p: appointments })
    .from(appointmentAttendees)
    .innerJoin(appointments, eq(appointments.id, appointmentAttendees.appointmentId))
    .where(eq(appointmentAttendees.id, attendeeId));
  return row ?? null;
}

/** Who comes, first names only, the host first. */
async function withWhom(tx: Tx, appointmentId: string): Promise<string[]> {
  const staff = await tx
    .select({ userId: appointmentStaff.userId, role: appointmentStaff.role })
    .from(appointmentStaff)
    .where(eq(appointmentStaff.appointmentId, appointmentId));
  staff.sort((x, y) =>
    x.role === y.role ? x.userId.localeCompare(y.userId) : x.role === 'host' ? -1 : 1,
  );
  const names = await firstNames(
    tx,
    staff.map((s) => s.userId),
  );
  return staff.map((s) => names.get(s.userId)!);
}

export interface PublicAppointment {
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly durationMinutes: number;
  readonly timezone: string;
  readonly timezoneLabel: string;
  readonly where: string | null;
  readonly with: string[];
  readonly seats: number;
  readonly kind: 'booking' | 'session';
}

async function publicAppointment(
  tx: Tx,
  b: BookedRow,
  timeZone: string,
): Promise<PublicAppointment> {
  return {
    title: b.p.title,
    startsAt: b.p.startsAt.toISOString(),
    endsAt: b.p.endsAt.toISOString(),
    durationMinutes: Math.round((b.p.endsAt.getTime() - b.p.startsAt.getTime()) / MIN),
    timezone: timeZone,
    timezoneLabel: zoneLabel(timeZone),
    where: whereText(b.p.location),
    with: await withWhom(tx, b.p.id),
    seats: b.a.seats,
    kind: b.p.kind,
  };
}

interface PublicSlot {
  readonly startsAt: string;
  readonly endsAt: string;
  /** null unless the calendar shows seats left. */
  readonly seatsLeft: number | null;
  readonly sessionId: string | null;
  /** First names, only where the slot's people are the ones who come (fixed, chosen, collective). */
  readonly people: string[];
}

async function publicSlots(
  tx: Tx,
  config: CalendarConfig,
  slots: readonly SlotOut[],
): Promise<PublicSlot[]> {
  const exact = ['fixed', 'customer_choice', 'collective'].includes(config.team.assignment);
  const names = exact
    ? await firstNames(
        tx,
        slots.flatMap((s) => s.userIds),
      )
    : new Map();
  const seats = config.capacity.showSeatsLeft;
  return slots.map((s) => ({
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    seatsLeft: seats ? s.seatsLeft : null,
    sessionId: s.sessionId,
    people: exact ? s.userIds.map((u) => names.get(u) as string) : [],
  }));
}

/** Sessions and group times too full for this party, with how many are waiting (for "Join the waitlist"). */
async function fullSessions(
  tx: Tx,
  calendar: LoadedCalendar,
  from: number,
  to: number,
  partySize: number,
) {
  const list = await rows<{
    id: string;
    starts_at: Date | string;
    ends_at: Date | string;
    waiting: number;
  }>(
    tx,
    sql`select a.id, a.starts_at, a.ends_at,
          (select count(*)::int from app.waitlist_entries w
            where w.appointment_id = a.id and w.status in ('waiting', 'offered')) as waiting
        from app.appointments a
        where a.workspace_id = ${calendar.workspaceId} and a.calendar_id = ${calendar.id}
          and a.status = 'scheduled' and (a.kind = 'session' or a.capacity > 1)
          and a.starts_at >= greatest(${new Date(from).toISOString()}::timestamptz, now())
          and a.starts_at < ${new Date(to).toISOString()}::timestamptz
          and a.seats_taken + ${partySize}::int > a.capacity
        order by a.starts_at, a.id
        limit 200`,
  );
  return list.map((s) => ({
    sessionId: s.id,
    startsAt: new Date(s.starts_at).toISOString(),
    endsAt: new Date(s.ends_at).toISOString(),
    waiting: s.waiting,
  }));
}

/** What the page needs to run the booking steps for one open calendar. */
async function bookingInfo(tx: Tx, calendar: LoadedCalendar, botCheck: BotCheck) {
  const { config } = calendar;
  const ws = calendar.workspaceId;
  const memberIds = config.team.members.map((m) => m.userId);
  const serviceList = [];
  if (config.services.mode !== 'none' && config.services.items.length) {
    const ids = config.services.items.map((i) => i.serviceId);
    const extra = await tx
      .select({
        id: serviceRows.id,
        description: serviceRows.description,
        priceCents: serviceRows.priceCents,
      })
      .from(serviceRows)
      .where(and(eq(serviceRows.workspaceId, ws), inArray(serviceRows.id, ids)));
    for (const id of ids) {
      const s = await loadCatalogService(tx, ws, id);
      if (!s || s.archived) continue;
      const more = extra.find((x) => x.id === id);
      serviceList.push({
        id: s.id,
        name: s.name,
        description: more?.description ?? null,
        priceCents: more?.priceCents ?? null,
        durations: bookableDurations(config, s),
      });
    }
  }
  const names = await firstNames(tx, memberIds);
  let postalCodes: string[] | null = null;
  if (config.territory.routing === 'zip') {
    const chosen = config.territory.territoryIds;
    // With no staff, every selected territory is served; otherwise only those someone on it covers.
    const none = config.team.assignment === 'none';
    const covered = (await loadTerritories(tx, ws)).filter(
      (t) =>
        (!chosen.length || chosen.includes(t.id)) &&
        (none || t.userIds.some((u) => memberIds.includes(u))),
    );
    postalCodes = [
      ...new Set(covered.flatMap((t) => t.postalCodes.map(zip5)).filter((z) => z.length === 5)),
    ].sort();
  }
  return {
    services: serviceList,
    durations: bookableDurations(config, null),
    people:
      config.team.assignment === 'customer_choice'
        ? memberIds.map((id) => ({ id, name: names.get(id)! }))
        : [],
    locations: config.locations.options.map((o) => ({
      kind: o.kind,
      label: LOCATION_LABEL[o.kind] ?? o.kind,
      address: o.kind === 'business' ? o.address : null,
    })),
    customerChoosesLocation: config.locations.customerChooses,
    intake: config.intake.questions,
    policies: {
      text: config.policies.policyText,
      cancel: config.policies.cancel,
      reschedule: config.policies.reschedule,
    },
    zipRouting: postalCodes ? { postalCodes } : null,
    mode: config.schedule.mode,
    capacity: {
      seats: config.capacity.seats,
      maxPartySize: Math.min(config.capacity.maxPartySize, config.capacity.seats),
      showSeatsLeft: config.capacity.showSeatsLeft,
    },
    waitlist: { enabled: config.waitlist.enabled },
    window: {
      minNoticeMinutes: config.window.minNoticeMinutes,
      maxDaysAhead: config.window.maxDaysAhead,
      dateFrom: config.window.dateFrom,
      dateTo: config.window.dateTo,
    },
    confirmation: config.notifications.confirmation,
    botCheck: botCheck.enabled ? { siteKey: botCheck.siteKey } : null,
  };
}

// ---- Request bodies ----

const customerFields = {
  name: z.string().trim().min(1, 'Enter your name.').max(160),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(254).nullable().optional(),
  smsConsent: z.boolean().default(false),
  /** The honeypot: people never see it, so it stays empty. */
  website: z.string().max(500).optional(),
  turnstileToken: z.string().max(2048).optional(),
};

const BookingBody = z.object({
  /** One per Book tap on the page: a retried or doubled submit books once. */
  clientId: z.string().trim().min(8).max(64),
  startsAt: instant,
  sessionId: z.uuid().nullable().optional(),
  serviceId: z.uuid().nullable().optional(),
  durationMinutes: z.int().min(5).max(720).optional(),
  partySize: z.int().min(1).max(100).default(1),
  locationKind: LocationKind.nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  chosenUserId: z.uuid().nullable().optional(),
  intake: IntakeAnswers.default(() => ({})),
  notes: z.string().trim().max(2000).nullable().optional(),
  ...customerFields,
});

const WaitlistBody = z
  .object({
    sessionId: z.uuid().nullable().optional(),
    wantedFrom: instant.optional(),
    wantedTo: instant.optional(),
    partySize: z.int().min(1).max(100).default(1),
    ...customerFields,
  })
  .refine((v) => !!v.sessionId || (!!v.wantedFrom && !!v.wantedTo), {
    path: ['sessionId'],
    error: 'Pick a session, or the times you want.',
  });

const RangeQuery = z.object({ from: instant, to: instant });
const SlotsQuery = RangeQuery.extend({
  serviceId: z.uuid().optional(),
  durationMinutes: z.coerce.number().int().min(5).max(720).optional(),
  partySize: z.coerce.number().int().min(1).max(100).default(1),
  postalCode: z.string().trim().max(20).optional(),
  chosenUserId: z.uuid().optional(),
  locationKind: LocationKind.optional(),
});

const RescheduleBody = z.object({ startsAt: instant, sessionId: z.uuid().nullable().optional() });
const CancelBody = z.object({ reason: z.string().trim().max(500).nullable().optional() });

/** At most 31 days of open times per request. */
function range(q: { from: string; to: string }): { from: number; to: number } {
  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  if (!(to > from)) throw HfosError.validation([{ path: 'to', message: 'End after the start.' }]);
  if (to - from > 31 * DAY)
    throw HfosError.validation([{ path: 'to', message: 'Ask for 31 days or fewer.' }]);
  return { from, to };
}

// ---- Routes ----

export async function registerBookingRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const opts = deps.booking ?? {};
  const botCheck = opts.botCheck ?? passThroughBotCheck;
  const limits = limitsFor(opts);
  const links = deps.bookingLinks;
  const worker = <T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>) =>
    asWorker(deps.httpDb, scope, fn);

  interface Found {
    readonly route: RouteRow;
    readonly scope: TenantScope;
    readonly calendarId: string;
    /** Active, public and on an enabled site: it takes bookings. */
    readonly open: boolean;
  }

  async function findRoute(site: string, calendar: string | null): Promise<RouteRow | null> {
    if (!SLUG_RE.test(site) || (calendar !== null && !SLUG_RE.test(calendar))) return null;
    const [r] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<RouteRow>(
        tx,
        sql`select * from private.booking_route(${site}::text, ${calendar}::text)`,
      ),
    );
    return r ?? null;
  }

  /** The calendar a /book/<site>/<calendar> address names, when customers may see it at all. */
  async function findCalendar(site: string, calendar: string): Promise<Found> {
    const r = await findRoute(site, calendar);
    // Private, archived, or without a booking site: exactly like a calendar that doesn't exist.
    if (!r?.calendar_id || !r.site_id || !r.calendar_public || r.calendar_status === 'archived')
      throw pageNotFound();
    return {
      route: r,
      scope: { workspaceId: r.workspace_id, organizationId: r.organization_id },
      calendarId: r.calendar_id,
      open: !!r.site_enabled && r.calendar_status === 'active',
    };
  }

  async function openCalendar(site: string, calendar: string) {
    const found = await findCalendar(site, calendar);
    if (!found.open) throw notBookable();
    const loaded = await worker(found.scope, (tx) =>
      loadCalendar(tx, found.scope.workspaceId, found.calendarId),
    );
    if (!loaded.config.public || loaded.status !== 'active') throw notBookable();
    return { ...found, calendar: loaded };
  }

  /** Checks a change-or-cancel link: 404 when it isn't one, 410 when a newer one replaced it. */
  async function managed(token: string) {
    const r = await resolveManageToken(deps.httpDb, links, token);
    if (r.status === 'invalid') throw linkNotFound();
    if (r.status === 'stale') {
      const business = await worker(r.scope, async (tx) => {
        const [site] = await tx
          .select({ name: bookingSites.name })
          .from(bookingSites)
          .where(eq(bookingSites.workspaceId, r.scope.workspaceId));
        return businessIn(tx, r.scope.workspaceId, site?.name ?? null);
      });
      throw new HfosError(
        'rule_violation',
        410,
        'This link is out of date. Use the newest one we sent you.',
        { business },
        'manage_link_stale',
      );
    }
    return r;
  }

  /** A booking as its change-or-cancel page shows it, with what the customer may still do. */
  function manageView(scope: TenantScope, attendeeId: string) {
    return worker(scope, async (tx) => {
      const b = await loadBooked(tx, attendeeId);
      if (!b) throw linkNotFound();
      const calendar = await loadCalendar(tx, scope.workspaceId, b.p.calendarId);
      const [site] = await tx
        .select()
        .from(bookingSites)
        .where(eq(bookingSites.workspaceId, scope.workspaceId));
      const business = await businessIn(tx, scope.workspaceId, site?.name ?? null);
      // The booking keeps the policies of the revision it was made under.
      const [rev] = await tx
        .select({ config: calendarRevisions.config })
        .from(calendarRevisions)
        .where(
          and(
            eq(calendarRevisions.calendarId, calendar.id),
            eq(calendarRevisions.revision, b.p.calendarRevision),
          ),
        );
      let policies = calendar.config.policies;
      try {
        if (rev) policies = parseConfig(rev.config).policies;
      } catch {
        // An unreadable old revision: today's policies.
      }
      const now = Date.now();
      const start = b.p.startsAt.getTime();
      const state =
        b.a.status !== 'booked' || b.p.status === 'cancelled'
          ? 'cancelled'
          : b.p.status !== 'scheduled' || start <= now
            ? 'past'
            : 'booked';
      const bookable = calendar.status === 'active' && calendar.config.public && !!site?.enabled;
      const r = policies.reschedule;
      const c = policies.cancel;
      const rescheduleUntil = start - r.cutoffHours * HOUR;
      const cancelUntil = start - c.cutoffHours * HOUR;
      const movesLeft = Math.max(0, r.maxTimes - b.a.rescheduleCount);
      const rescheduleReason = !r.allowed
        ? 'not_allowed'
        : now >= rescheduleUntil
          ? 'cutoff'
          : movesLeft === 0
            ? 'limit'
            : !bookable
              ? 'calendar_off'
              : null;
      const cancelReason = !c.allowed ? 'not_allowed' : now >= cancelUntil ? 'cutoff' : null;
      const token = manageToken(links, {
        publicRef: b.a.publicRef,
        attendeeId: b.a.id,
        manageVersion: b.a.manageVersion,
      });
      return {
        state,
        business,
        calendar: {
          name: calendar.name,
          bookingPath: bookable && site ? `/book/${site.slug}/${calendar.slug}` : null,
        },
        appointment: await publicAppointment(tx, b, calendar.timeZone),
        policies: {
          text: policies.policyText,
          reschedule: {
            allowed: state === 'booked' && rescheduleReason === null,
            reason: rescheduleReason,
            until: new Date(rescheduleUntil).toISOString(),
            cutoffHours: r.cutoffHours,
            movesLeft,
          },
          cancel: {
            allowed: state === 'booked' && cancelReason === null,
            reason: cancelReason,
            until: new Date(cancelUntil).toISOString(),
            cutoffHours: c.cutoffHours,
          },
        },
        manageToken: token,
        manageUrl: `${links.webUrl}/m/${token}`,
        /** For the calendar file. */
        sequence: icsSequence(b.p.updatedAt, b.a.updatedAt),
        attendeeId: b.a.id,
      };
    });
  }

  /** Checks a waitlist offer's link: 404 when it isn't one. */
  async function offerLink(token: string) {
    const r = await resolveWaitlistToken(deps.httpDb, links, token);
    if (r.status === 'invalid') throw linkNotFound();
    return r;
  }

  /**
   * A waitlist offer as its page shows it: the time it holds and until when ('offered'), someone else
   * booking it first ('taken'), the hold running out ('expired'), claimed ('booked', with the booking's
   * change-or-cancel link), or no offer at all ('closed').
   */
  function offerView(scope: TenantScope, entryId: string) {
    return worker(scope, async (tx) => {
      const ws = scope.workspaceId;
      const [e] = await tx.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId));
      if (!e) throw linkNotFound();
      const calendar = await loadCalendar(tx, ws, e.calendarId);
      const [site] = await tx.select().from(bookingSites).where(eq(bookingSites.workspaceId, ws));
      const business = await businessIn(tx, ws, site?.name ?? null);
      const bookable = calendar.status === 'active' && calendar.config.public && !!site?.enabled;
      const offer = parseWaitlistOffer(e.offer);
      const service = offer?.serviceId ? await loadCatalogService(tx, ws, offer.serviceId) : null;
      const holding = !!e.offerExpiresAt && e.offerExpiresAt.getTime() > Date.now();
      let state: 'offered' | 'taken' | 'expired' | 'booked' | 'closed' = 'closed';
      let manage: string | null = null;
      if (e.status === 'booked') {
        state = 'booked';
        const earlier = await findBookingByClientId(tx, ws, waitlistClientId(e.id));
        const [a] = earlier?.attendeeId
          ? await tx
              .select({
                id: appointmentAttendees.id,
                publicRef: appointmentAttendees.publicRef,
                manageVersion: appointmentAttendees.manageVersion,
              })
              .from(appointmentAttendees)
              .where(eq(appointmentAttendees.id, earlier.attendeeId))
          : [];
        if (a)
          manage = manageToken(links, {
            publicRef: a.publicRef,
            attendeeId: a.id,
            manageVersion: a.manageVersion,
          });
      } else if (offer && e.status === 'offered' && holding)
        state = (await offerStillOpen(tx, calendar, offer, e.seats)) ? 'offered' : 'taken';
      else if (offer && (e.status === 'offered' || e.status === 'expired')) state = 'expired';
      // Offered, then someone else booked the time: they wait again, in their old place.
      else if (offer && e.status === 'waiting') state = 'taken';
      const businessAddress =
        calendar.config.locations.options.find((o) => o.kind === 'business')?.address ?? null;
      return {
        state,
        business,
        calendar: {
          name: calendar.name,
          bookingPath: bookable && site ? `/book/${site.slug}/${calendar.slug}` : null,
        },
        offer: offer
          ? {
              title: service?.name ?? calendar.name,
              startsAt: offer.startsAt,
              endsAt: offer.endsAt,
              durationMinutes: offer.durationMinutes,
              timezone: calendar.timeZone,
              timezoneLabel: zoneLabel(calendar.timeZone),
              where: whereText({
                kind: offer.locationKind,
                address: offer.locationKind === 'business' ? businessAddress : null,
              }),
              seats: e.seats,
            }
          : null,
        expiresAt: state === 'offered' ? e.offerExpiresAt!.toISOString() : null,
        manageToken: manage,
        manageUrl: manage ? `${links.webUrl}/m/${manage}` : null,
      };
    });
  }

  await app.register(async (pub) => {
    await pub.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of tries from here. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });

    // ---------- the site: the business and its bookable calendars ----------
    pub.get<{ Params: { site: string } }>(
      '/public/book/:site',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const r = await findRoute(req.params.site, null);
        if (!r?.site_id) throw pageNotFound();
        const scope = { workspaceId: r.workspace_id, organizationId: r.organization_id };
        return worker(scope, async (tx) => {
          const [site] = await tx
            .select()
            .from(bookingSites)
            .where(eq(bookingSites.id, r.site_id!));
          const list = r.site_enabled
            ? await rows<{ slug: string; name: string; description: string | null }>(
                tx,
                sql`select slug, name, description from app.calendars
                    where workspace_id = ${r.workspace_id} and status = 'active' and public
                    order by name, id`,
              )
            : [];
          return {
            business: await businessIn(tx, r.workspace_id, r.site_name),
            site: {
              slug: r.site_slug,
              name: r.site_name,
              intro: site?.intro ?? null,
              enabled: !!r.site_enabled,
            },
            timezone: r.timezone,
            timezoneLabel: zoneLabel(r.timezone),
            calendars: list,
          };
        });
      },
    );

    // ---------- one calendar: what to ask, or that it's off ----------
    pub.get<{ Params: { site: string; calendar: string } }>(
      '/public/book/:site/:calendar',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const found = await findCalendar(req.params.site, req.params.calendar);
        const r = found.route;
        return worker(found.scope, async (tx) => {
          const calendar = await loadCalendar(tx, found.scope.workspaceId, found.calendarId);
          const open = found.open && calendar.config.public;
          return {
            state: open ? ('open' as const) : ('off' as const),
            canonical: { site: r.site_slug!, calendar: r.calendar_slug! },
            business: await businessIn(tx, r.workspace_id, r.site_name),
            timezone: calendar.timeZone,
            timezoneLabel: zoneLabel(calendar.timeZone),
            calendar: {
              id: calendar.id,
              name: calendar.name,
              description: calendar.description,
            },
            booking: open ? await bookingInfo(tx, calendar, botCheck) : null,
          };
        });
      },
    );

    // ---------- open times ----------
    pub.get<{ Params: { site: string; calendar: string } }>(
      '/public/book/:site/:calendar/slots',
      { config: { rateLimit: limits.read } },
      async (req) => {
        const q = parseBody(SlotsQuery, req.query);
        const { from, to } = range(q);
        const { scope, calendar } = await openCalendar(req.params.site, req.params.calendar);
        const { config } = calendar;
        const out = await executeQuery(
          deps.httpDb,
          calendarAvailability,
          {
            workspaceId: scope.workspaceId,
            calendarId: calendar.id,
            from: q.from,
            to: q.to,
            serviceId: q.serviceId ?? null,
            durationMinutes: q.durationMinutes,
            partySize: q.partySize,
            postalCode: q.postalCode ?? null,
            // Only a calendar that lets customers pick a person honours a pick.
            chosenUserId:
              config.team.assignment === 'customer_choice' ? (q.chosenUserId ?? null) : null,
            locationKind: q.locationKind,
          },
          systemActor(scope),
          meta(),
        );
        return worker(scope, async (tx) => ({
          timezone: out.timezone,
          durationMinutes: out.durationMinutes,
          slots: await publicSlots(tx, config, out.slots),
          full:
            config.schedule.mode === 'sessions' || config.capacity.seats > 1
              ? await fullSessions(tx, calendar, from, to, q.partySize)
              : [],
        }));
      },
    );

    // ---------- booking ----------
    pub.post<{ Params: { site: string; calendar: string } }>(
      '/public/book/:site/:calendar/bookings',
      { config: { rateLimit: limits.book } },
      async (req) => {
        refuseHoneypot(req.body);
        const body = parseBody(BookingBody, req.body);
        const phone = usPhone(body.phone);
        const verdict = await botCheck.verify(body.turnstileToken, req.ip);
        if (verdict === 'unavailable')
          throw HfosError.rule(
            'bot_check_unavailable',
            503,
            'We couldn’t check this booking just now. Try again in a minute, or give us a call.',
          );
        if (verdict !== 'pass')
          throw HfosError.rule(
            'bot_check_failed',
            400,
            'Please confirm you’re a person, then try again.',
          );
        const { scope, calendar } = await openCalendar(req.params.site, req.params.calendar);
        const { output } = await executeCommand(
          deps.httpDb,
          appointmentBookOnline,
          {
            workspaceId: scope.workspaceId,
            calendarId: calendar.id,
            startsAt: body.startsAt,
            sessionId: body.sessionId ?? null,
            serviceId: body.serviceId ?? null,
            durationMinutes: body.durationMinutes,
            partySize: body.partySize,
            locationKind: body.locationKind,
            address: body.address ?? null,
            postalCode: body.postalCode ?? null,
            chosenUserId:
              calendar.config.team.assignment === 'customer_choice'
                ? (body.chosenUserId ?? null)
                : null,
            customer: { ...splitName(body.name), phone, email: body.email || null },
            smsConsent: body.smsConsent,
            intake: body.intake,
            notes: body.notes ?? null,
            clientId: body.clientId,
          },
          systemActor(scope),
          meta(),
        ).catch(publicPaths);
        const view = await manageView(scope, output.attendeeId);
        return worker(scope, async (tx) => {
          const [att] = await tx
            .select({
              smsOk: appointmentAttendees.smsOk,
              email: appointmentAttendees.contactEmail,
              phone: appointmentAttendees.contactPhoneE164,
            })
            .from(appointmentAttendees)
            .where(eq(appointmentAttendees.id, output.attendeeId));
          return {
            booking: view.appointment,
            manageToken: view.manageToken,
            manageUrl: view.manageUrl,
            policies: view.policies,
            contact: {
              email: att?.email ?? null,
              phoneDisplay: att?.phone ? formatPhone(att.phone) : null,
              texts: !!att?.smsOk,
            },
            joined: output.joined,
            duplicate: output.duplicate,
          };
        });
      },
    );

    // ---------- the waitlist: a full session, or no open times ----------
    pub.post<{ Params: { site: string; calendar: string } }>(
      '/public/book/:site/:calendar/waitlist',
      { config: { rateLimit: limits.book } },
      async (req) => {
        refuseHoneypot(req.body);
        const body = parseBody(WaitlistBody, req.body);
        const phone = usPhone(body.phone);
        const verdict = await botCheck.verify(body.turnstileToken, req.ip);
        if (verdict === 'unavailable')
          throw HfosError.rule(
            'bot_check_unavailable',
            503,
            'We couldn’t check this just now. Try again in a minute, or give us a call.',
          );
        if (verdict !== 'pass')
          throw HfosError.rule(
            'bot_check_failed',
            400,
            'Please confirm you’re a person, then try again.',
          );
        const { scope, calendar } = await openCalendar(req.params.site, req.params.calendar);
        const { output } = await executeCommand(
          deps.httpDb,
          waitlistJoinOnline,
          {
            workspaceId: scope.workspaceId,
            calendarId: calendar.id,
            appointmentId: body.sessionId ?? null,
            wantedFrom: body.sessionId ? undefined : body.wantedFrom,
            wantedTo: body.sessionId ? undefined : body.wantedTo,
            seats: body.partySize,
            customer: { ...splitName(body.name), phone, email: body.email || null },
            smsConsent: body.smsConsent,
          },
          systemActor(scope),
          meta(),
        ).catch(publicPaths);
        return { position: output.position, alreadyWaiting: output.alreadyWaiting };
      },
    );

    // ---------- change or cancel ----------
    pub.get<{ Params: { token: string } }>(
      '/public/manage/:token',
      { config: { rateLimit: limits.manageRead } },
      async (req, reply) => {
        const m = await managed(req.params.token);
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        const view = await manageView(m.scope, m.attendeeId);
        const { sequence: _sequence, attendeeId: _attendeeId, ...rest } = view;
        return rest;
      },
    );

    pub.get<{ Params: { token: string } }>(
      '/public/manage/:token/slots',
      { config: { rateLimit: limits.manageRead } },
      async (req) => {
        const m = await managed(req.params.token);
        const { from, to } = range(parseBody(RangeQuery, req.query));
        return worker(m.scope, async (tx) => {
          const ws = m.scope.workspaceId;
          const b = await loadBooked(tx, m.attendeeId);
          if (!b) throw linkNotFound();
          if (b.a.status !== 'booked' || b.p.status !== 'scheduled')
            throw HfosError.rule('booking_cancelled', 409, 'This booking was cancelled.');
          const calendar = await loadCalendar(tx, ws, b.p.calendarId);
          if (calendar.status !== 'active' || !calendar.config.public) throw notBookable();
          const minutes = Math.round((b.p.endsAt.getTime() - b.p.startsAt.getTime()) / MIN);
          const location = (b.p.location ?? {}) as StoredLocation;
          const oneToOne = b.p.kind === 'booking' && b.p.capacity === 1;
          // The same request attendee.reschedule_online checks the new time with.
          const onCalendar = calendar.config.services.items.some(
            (i) => i.serviceId === b.p.serviceId,
          );
          const service =
            b.p.serviceId && (oneToOne || onCalendar)
              ? await loadCatalogService(tx, ws, b.p.serviceId)
              : null;
          const loaded = await loadSlotInput(
            tx,
            calendar,
            oneToOne
              ? {
                  from,
                  to,
                  serviceId: service?.id ?? null,
                  durationMinutes: minutes,
                  partySize: b.a.seats,
                  locationKind: (location.kind ?? null) as LocationKind | null,
                  postalCode: location.postalCode ?? null,
                  excludeAppointmentIds: [b.p.id],
                }
              : {
                  from,
                  to,
                  serviceId: service?.id ?? null,
                  durationMinutes:
                    calendar.config.schedule.mode === 'sessions' ? undefined : minutes,
                  partySize: b.a.seats,
                },
            { service },
          );
          const current = b.p.startsAt.getTime();
          const slots = computeSlots(loaded.input)
            .filter((s) => (oneToOne ? s.start !== current : s.sessionId !== b.p.id))
            .map(slotOut);
          return {
            timezone: calendar.timeZone,
            durationMinutes: loaded.durationMinutes,
            slots: await publicSlots(tx, calendar.config, slots),
          };
        });
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/manage/:token/reschedule',
      { config: { rateLimit: limits.manageWrite } },
      async (req) => {
        const m = await managed(req.params.token);
        const body = parseBody(RescheduleBody, req.body);
        const { output } = await executeCommand(
          deps.httpDb,
          attendeeRescheduleOnline,
          {
            workspaceId: m.scope.workspaceId,
            attendeeId: m.attendeeId,
            manageVersion: m.manageVersion,
            startsAt: body.startsAt,
            sessionId: body.sessionId ?? null,
          },
          systemActor(m.scope),
          meta(),
        );
        // A seat moved to another session is a new booking, with its own link.
        const {
          sequence: _sequence,
          attendeeId: _attendeeId,
          ...view
        } = await manageView(m.scope, output.attendeeId);
        return { ...view, newLink: output.attendeeId !== m.attendeeId };
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/manage/:token/cancel',
      { config: { rateLimit: limits.manageWrite } },
      async (req) => {
        const m = await managed(req.params.token);
        const body = parseBody(CancelBody, req.body ?? {});
        await executeCommand(
          deps.httpDb,
          attendeeCancelOnline,
          {
            workspaceId: m.scope.workspaceId,
            attendeeId: m.attendeeId,
            manageVersion: m.manageVersion,
            reason: body.reason ?? null,
          },
          systemActor(m.scope),
          meta(),
        );
        const {
          sequence: _sequence,
          attendeeId: _attendeeId,
          ...view
        } = await manageView(m.scope, m.attendeeId);
        return view;
      },
    );

    /** The booking as an iCalendar file (Apple Calendar, or any app that opens .ics files). */
    pub.get<{ Params: { token: string } }>(
      '/public/manage/:token/ics',
      { config: { rateLimit: limits.manageRead } },
      async (req, reply) => {
        const m = await managed(req.params.token);
        const view = await manageView(m.scope, m.attendeeId);
        const a = view.appointment;
        const file = icsCalendar({
          uid: `${view.attendeeId}@handsfreeos.com`,
          sequence: view.sequence,
          start: new Date(a.startsAt),
          end: new Date(a.endsAt),
          summary: `${a.title} with ${view.business.name}`,
          location: a.where,
          description: [
            a.with.length ? `With ${a.with.join(', ')}.` : null,
            `Change or cancel: ${view.manageUrl}`,
            view.business.phoneDisplay ? `Questions? Call ${view.business.phoneDisplay}.` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          url: view.manageUrl,
          cancelled: view.state === 'cancelled',
        });
        return reply
          .type('text/calendar; charset=utf-8')
          .header('content-disposition', 'attachment; filename="appointment.ics"')
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .send(file);
      },
    );

    // ---------- a waitlist offer: the time it holds, and claiming it ----------
    pub.get<{ Params: { token: string } }>(
      '/public/waitlist/:token',
      { config: { rateLimit: limits.manageRead } },
      async (req, reply) => {
        const w = await offerLink(req.params.token);
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        return offerView(w.scope, w.entryId);
      },
    );

    /** Books the held time (idempotent: the entry's own clientId); 409 slot_taken or 410 offer_expired. */
    pub.post<{ Params: { token: string } }>(
      '/public/waitlist/:token/claim',
      { config: { rateLimit: limits.manageWrite } },
      async (req, reply) => {
        const w = await offerLink(req.params.token);
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        const { output } = await executeCommand(
          deps.httpDb,
          waitlistClaimOnline,
          { workspaceId: w.scope.workspaceId, entryId: w.entryId },
          systemActor(w.scope),
          meta(),
        );
        const {
          sequence: _sequence,
          attendeeId: _attendeeId,
          ...view
        } = await manageView(w.scope, output.attendeeId);
        return { ...view, duplicate: output.duplicate };
      },
    );
  });
}

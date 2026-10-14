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
import { publicLookOf, type PublicLook } from '../look/public';
import { placeOf } from '../geo/geocoder';
import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import {
  appointmentBookOnline,
  attendeeCancelOnline,
  attendeeConfirmOnline,
  attendeeRescheduleOnline,
  bookableDurations,
  computeSlots,
  DEPOSIT_HOLD_MINUTES,
  executeCommand,
  findBookingByClientId,
  formatPhone,
  HfosError,
  holdState,
  IntakeAnswers,
  linkRefOf,
  loadCalendar,
  loadCatalogService,
  loadSlotInput,
  loadTerritories,
  needsAddress,
  LocationKind,
  normalizePhone,
  offerStillOpen,
  openTimes,
  parseConfig,
  parseWaitlistOffer,
  plainSpaces,
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
import {
  cannotTakePayment,
  confirmAndCapture,
  depositPlan,
  holdLost,
  invoiceForHold,
  raiseDepositInvoice,
  recordDepositPayment,
  refused,
  undoOnLostSlot,
  type DepositPayContext,
} from '../booking/deposit';
import { icsCalendar, icsSequence } from '../booking/ics';
import { manageToken, resolveManageToken, resolveWaitlistToken } from '../booking/links';
import { businessPageOf } from '../booking/page';
import { oneOnOne } from '../booking/visit';
import { publicOrigin } from '../hosting/origin';
import { accountFor } from '../payments/index';
import { declineWording, type PaymentMethodKind, type PaymentResult } from '../payments/provider';
import { systemActor, type TenantScope } from '../services';
import { offersBoxFor, parseBody, type HttpDeps } from './common';

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
  /** Paying the deposit that holds a time. */
  readonly pay: RateRule;
}

/**
 * Per address: reads 60 a minute, bookings 5 per 10 minutes, change-or-cancel 30 and 10 a minute, and
 * deposits 8 per 10 minutes — the customer's money pages' figure, for the same reason.
 */
export const BOOKING_LIMITS: BookingLimits = {
  read: { max: 60, timeWindow: MIN },
  book: { max: 5, timeWindow: 10 * MIN },
  manageRead: { max: 30, timeWindow: MIN },
  manageWrite: { max: 10, timeWindow: MIN },
  pay: { max: 8, timeWindow: 10 * MIN },
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
    pay: opts.limits?.pay ?? opts.limits?.manageWrite ?? scaled(BOOKING_LIMITS.pay),
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
  /** Its logo and colour, for the top of the page and its buttons. */
  readonly look: PublicLook;
  /** The separate box for offers under "Text me", for a business that sends them; null otherwise. */
  readonly offersConsent?: { readonly title: string; readonly detail: string } | null;
}

const SLUG_RE = /^[A-Za-z0-9-]{1,80}$/;
const NANP_RE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const instant = z.iso.datetime({
  offset: true,
  error: 'Use a date and time like 2026-10-01T15:00:00Z.',
});
const zip5 = (v: string | null | undefined): string => (v ?? '').replace(/\D/g, '').slice(0, 5);

const pageNotFound = () =>
  HfosError.notFound(
    'There’s no booking page at this address. Check the link, or contact the business for the right one.',
  );
const notBookable = () =>
  HfosError.rule(
    'calendar_not_bookable',
    409,
    'This calendar isn’t taking bookings online right now. Contact the business to book another way.',
  );
const linkNotFound = () =>
  HfosError.notFound(
    'This link doesn’t work. Check that it matches the one we sent you, or contact the business.',
  );

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
    throw HfosError.validation([], 'That didn’t go through. Refresh the page and try again.');
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

/** "Thursday, September 24 at 9:00 AM", for the deposit line on the invoice. */
export function whenText(startsAt: string, timeZone: string): string {
  const at = new Date(startsAt);
  try {
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(at);
    const clock = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(at);
    return plainSpaces(`${day} at ${clock}`);
  } catch {
    return at.toISOString();
  }
}

/** What has landed against a deposit invoice: only what a customer's own page may be told. */
async function depositPayments(tx: Tx, invoiceId: string) {
  return rows<{
    status: string;
    method: string;
    amount_cents: number;
    card_brand: string | null;
    card_last4: string | null;
    received_at: Date | string | null;
  }>(
    tx,
    sql`select status::text as status, method::text as method, amount_cents::float8 as amount_cents,
          card_brand, card_last4, received_at
        from app.payments
        where invoice_id = ${invoiceId} and status in ('processing', 'succeeded')
        order by created_at desc, id`,
  );
}

// ---- Reads ----

async function businessIn(
  tx: Tx,
  workspaceId: string,
  siteName: string | null,
  storageUrl: string | null | undefined,
): Promise<PublicBusiness> {
  const [w] = await tx
    .select({ name: workspaces.name, settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const name = siteName || (w?.name ?? 'The business');
  const [phone] = await tx
    .select({ e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.status, 'active')))
    .limit(1);
  return {
    name,
    phone: phone?.e164 ?? null,
    phoneDisplay: phone ? formatPhone(phone.e164) : null,
    look: publicLookOf(w?.settings, storageUrl),
    offersConsent: await offersBoxFor(tx, workspaceId, name),
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
async function bookingInfo(deps: HttpDeps, tx: Tx, calendar: LoadedCalendar, botCheck: BotCheck) {
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
  let byAddress = false;
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
    // M18: an area by distance or drawn on the map needs where they are, so the page asks for the address.
    byAddress = deps.geocoder.name !== 'off' && covered.some(needsAddress);
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
      // Said before booking: the call is recorded and transcribed (Zoom with Record and transcribe on).
      recorded: o.kind === 'virtual' && o.video === 'zoom' && o.record,
    })),
    customerChoosesLocation: config.locations.customerChooses,
    intake: config.intake.questions,
    policies: {
      text: config.policies.policyText,
      cancel: config.policies.cancel,
      reschedule: config.policies.reschedule,
    },
    zipRouting: postalCodes ? { postalCodes, byAddress } : null,
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
    /**
     * What this calendar asks for before it will hold a time, so the page can say so before anyone types
     * their details and count the pay step into "Step 3 of 4". Null when it asks for nothing.
     */
    payment: await paymentInfo(deps, tx, calendar),
    botCheck: botCheck.enabled ? { siteKey: botCheck.siteKey } : null,
  };
}

/** The deposit this calendar asks for, on its cheapest service, in the words the page shows. */
async function paymentInfo(deps: HttpDeps, tx: Tx, calendar: LoadedCalendar) {
  const plan = await depositPlan(deps, tx, calendar.workspaceId, calendar.config, {
    serviceId: null,
    calendarName: calendar.name,
  });
  return plan
    ? {
        mode: plan.charge.mode,
        amountCents: plan.charge.amountCents,
        priceCents: plan.charge.priceCents,
        dueAfterCents: plan.charge.dueAfterCents,
        /** False when no connected account could take it: the page says so rather than taking details. */
        canPay: !!plan.account,
      }
    : null;
}

// ---- Request bodies ----

const customerFields = {
  name: z.string().trim().min(1, 'Enter your name.').max(160),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(254).nullable().optional(),
  smsConsent: z.boolean().default(false),
  /** The separate box for offers, shown when the business sends them. */
  offersConsent: z.boolean().default(false),
  /** The honeypot: people never see it, so it stays empty. */
  website: z.string().max(500).optional(),
  turnstileToken: z.string().max(2048).optional(),
};

/**
 * Paying the deposit that holds a time. One route, two phases, exactly as the invoice page's is: nothing but
 * a `clientId` asks for a session, and naming what the provider did takes the money.
 */
const DepositPayBody = z.object({
  /** One per press, kept across the trip to the provider: a retry is answered, never charged again. */
  clientId: z.string().trim().min(8).max(64),
  method: z.enum(['card', 'ach']).default('card'),
  /** Stripe, after the browser confirmed: the intent to read back. */
  providerPaymentId: z.string().trim().max(200).optional(),
  /** Square: the one-time token the browser made from the card. */
  sourceToken: z.string().trim().max(2048).optional(),
  website: z.string().max(500).optional(),
});

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
  /** The `ref` the page was opened with (`?ref=`): a link's, kept on the booking. Anything odd is left off. */
  ref: z.string().max(200).nullable().optional(),
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
  /** M18: their street address, where the calendar's areas go by distance or a drawn shape. */
  address: z.string().trim().max(300).optional(),
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

  /**
   * M18: where a customer's address is, when the calendar routes by service area and some of its areas go by
   * distance or a drawn shape. Looked up once and kept; null otherwise, or when it can't be found.
   */
  async function placeFor(scope: TenantScope, config: CalendarConfig, address?: string | null) {
    if (!address?.trim() || config.territory.routing !== 'zip' || deps.geocoder.name === 'off')
      return null;
    const chosen = config.territory.territoryIds;
    return worker(scope, async (tx) => {
      // A calendar with only ZIP areas never needs the lookup (and its cost).
      const areas = await loadTerritories(tx, scope.workspaceId);
      if (!areas.some((a) => needsAddress(a) && (!chosen.length || chosen.includes(a.id))))
        return null;
      return placeOf(tx, deps.geocoder, address);
    });
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
        return businessIn(tx, r.scope.workspaceId, site?.name ?? null, deps.storageUrl);
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
      const business = await businessIn(tx, scope.workspaceId, site?.name ?? null, deps.storageUrl);
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
      // Their own domain once one is serving (M17). The token is the same either way — the origin is all
      // that moves — so a link already in somebody's texts keeps working on our address.
      const origin = await publicOrigin(tx, scope.workspaceId, links.webUrl);
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
        /**
         * One-on-one bookings (null for a group time or a session seat): when it was confirmed and how, and when
         * HandsFreeOS asked them to, for the page's Confirm button and its "Confirmed".
         */
        confirmation: oneOnOne(b.p)
          ? {
              confirmedAt: b.a.confirmedAt?.toISOString() ?? null,
              confirmedVia: b.a.confirmedVia ?? null,
              askedAt: b.a.confirmAskedAt?.toISOString() ?? null,
            }
          : null,
        manageToken: token,
        manageUrl: `${origin}/m/${token}`,
        /** For the calendar file. */
        sequence: icsSequence(b.p.updatedAt, b.a.updatedAt),
        attendeeId: b.a.id,
      };
    });
  }

  /** "You're booked", as both the booking route and a paid deposit answer with it. */
  async function bookedPayload(
    scope: TenantScope,
    attendeeId: string,
    extra: { joined: boolean; duplicate: boolean },
  ) {
    const view = await manageView(scope, attendeeId);
    return worker(scope, async (tx) => {
      const [att] = await tx
        .select({
          smsOk: appointmentAttendees.smsOk,
          email: appointmentAttendees.contactEmail,
          phone: appointmentAttendees.contactPhoneE164,
        })
        .from(appointmentAttendees)
        .where(eq(appointmentAttendees.id, attendeeId));
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
        joined: extra.joined,
        duplicate: extra.duplicate,
      };
    });
  }

  /**
   * A held time as the pay step sees it: the visit, what is due now and what is left for after, and the public
   * keys the browser needs. `state` is the whole story — 'held' while they pay, 'booked' once the deposit is
   * in hand, 'gone' when the time went (and then nothing was charged, because a card was only ever held).
   */
  async function holdView(scope: TenantScope, attendeeId: string) {
    const view = await worker(scope, async (tx) => {
      const b = await loadBooked(tx, attendeeId);
      if (!b) throw linkNotFound();
      const calendar = await loadCalendar(tx, scope.workspaceId, b.p.calendarId);
      const [site] = await tx
        .select()
        .from(bookingSites)
        .where(eq(bookingSites.workspaceId, scope.workspaceId));
      const invoice = await invoiceForHold(tx, scope.workspaceId, attendeeId);
      const plan = await depositPlan(deps, tx, scope.workspaceId, calendar.config, {
        serviceId: b.p.serviceId,
        calendarName: calendar.name,
      });
      const hold = await holdState(tx, attendeeId);
      const gone = b.a.status !== 'booked' || b.p.status !== 'scheduled';
      const paid = invoice ? await depositPayments(tx, invoice.id) : [];
      const landed = paid.find((p) => p.status === 'succeeded') ?? paid[0] ?? null;
      const state = gone
        ? ('gone' as const)
        : invoice && invoice.status !== 'draft'
          ? ('booked' as const)
          : ('held' as const);
      const bookable = calendar.status === 'active' && calendar.config.public && !!site?.enabled;
      const account = plan?.account ?? null;
      const amountCents = invoice?.amountCents ?? plan?.charge.amountCents ?? 0;
      return {
        state,
        business: await businessIn(tx, scope.workspaceId, site?.name ?? null, deps.storageUrl),
        calendar: {
          name: calendar.name,
          bookingPath: bookable && site ? `/book/${site.slug}/${calendar.slug}` : null,
        },
        appointment: await publicAppointment(tx, b, calendar.timeZone),
        deposit: {
          /** 'deposit': part now, the rest on the invoice for the job. 'full': the whole price now. */
          mode: plan?.charge.mode ?? 'deposit',
          what: plan?.what ?? calendar.name,
          amountCents,
          priceCents: plan?.charge.priceCents ?? 0,
          dueAfterCents: Math.max(0, (plan?.charge.priceCents ?? 0) - amountCents),
          paidCents: invoice?.paidCents ?? 0,
          number: invoice?.number ?? null,
          method: landed?.method ?? null,
          cardBrand: landed?.card_brand ?? null,
          cardLast4: landed?.card_last4 ?? null,
          receivedAt: landed?.received_at ? new Date(landed.received_at).toISOString() : null,
        },
        pay: {
          canPay: state === 'held' && !!account,
          /** Why not, when it can't be paid here: the page says so rather than offering a dead button. */
          reason:
            state === 'gone' ? 'gone' : state === 'booked' ? 'paid' : account ? null : 'no_account',
          methods: account?.methods ?? [],
          /** Public keys only: never a secret key, and never Square's access token. */
          session: account?.session ?? null,
        },
        holdToken: manageToken(links, {
          publicRef: b.a.publicRef,
          attendeeId: b.a.id,
          manageVersion: b.a.manageVersion,
        }),
        expiresAt: hold.expiresAt,
        holdMinutes: DEPOSIT_HOLD_MINUTES,
      };
    });
    return view.state === 'booked'
      ? {
          ...view,
          booked: await bookedPayload(scope, attendeeId, { joined: false, duplicate: false }),
        }
      : { ...view, booked: null };
  }

  /** "Other times this week", for a customer whose time went while they were paying. */
  async function openTimesNear(scope: TenantScope, attendeeId: string): Promise<PublicSlot[]> {
    return worker(scope, async (tx) => {
      const b = await loadBooked(tx, attendeeId);
      if (!b) return [];
      const calendar = await loadCalendar(tx, scope.workspaceId, b.p.calendarId);
      if (calendar.status !== 'active' || !calendar.config.public) return [];
      const minutes = Math.round((b.p.endsAt.getTime() - b.p.startsAt.getTime()) / MIN);
      const location = (b.p.location ?? {}) as StoredLocation;
      const service = b.p.serviceId
        ? await loadCatalogService(tx, scope.workspaceId, b.p.serviceId)
        : null;
      const loaded = await loadSlotInput(
        tx,
        calendar,
        {
          from: Date.now(),
          to: Date.now() + 7 * DAY,
          serviceId: service?.id ?? null,
          durationMinutes: calendar.config.schedule.mode === 'sessions' ? undefined : minutes,
          partySize: b.a.seats,
          locationKind: (location.kind ?? null) as LocationKind | null,
          postalCode: location.postalCode ?? null,
        },
        { service },
      );
      const slots = computeSlots(loaded.input).map(slotOut).slice(0, 6);
      return publicSlots(tx, calendar.config, slots);
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
      const business = await businessIn(tx, ws, site?.name ?? null, deps.storageUrl);
      const bookable = calendar.status === 'active' && calendar.config.public && !!site?.enabled;
      const offer = parseWaitlistOffer(e.offer);
      const service = offer?.serviceId ? await loadCatalogService(tx, ws, offer.serviceId) : null;
      const holding = !!e.offerExpiresAt && e.offerExpiresAt.getTime() > Date.now();
      // Their own domain once one is serving (M17), as everywhere else a customer is sent a link.
      const origin = await publicOrigin(tx, ws, links.webUrl);
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
        manageUrl: manage ? `${origin}/m/${manage}` : null,
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
    // With the simple page on, also what the business does, its services, hours and area (booking/page.ts). `origin`
    // is the address the page is shown at, for whether its website chat is set up there.
    pub.get<{ Params: { site: string }; Querystring: { origin?: string } }>(
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
          const origin = typeof req.query.origin === 'string' ? req.query.origin : null;
          return {
            business: await businessIn(tx, r.workspace_id, r.site_name, deps.storageUrl),
            site: {
              slug: r.site_slug,
              name: r.site_name,
              intro: site?.intro ?? null,
              enabled: !!r.site_enabled,
            },
            timezone: r.timezone,
            timezoneLabel: zoneLabel(r.timezone),
            calendars: list,
            page: site?.pageEnabled
              ? await businessPageOf(tx, r.workspace_id, r.site_slug!, origin)
              : null,
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
            business: await businessIn(tx, r.workspace_id, r.site_name, deps.storageUrl),
            timezone: calendar.timeZone,
            timezoneLabel: zoneLabel(calendar.timeZone),
            calendar: {
              id: calendar.id,
              name: calendar.name,
              description: calendar.description,
            },
            booking: open ? await bookingInfo(deps, tx, calendar, botCheck) : null,
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
        const place = await placeFor(scope, config, q.address);
        // One transaction, on the calendar openCalendar already read.
        return worker(scope, async (tx) => {
          const out = await openTimes(tx, calendar, {
            from,
            to,
            serviceId: q.serviceId ?? null,
            durationMinutes: q.durationMinutes,
            partySize: q.partySize,
            postalCode: q.postalCode ?? place?.postalCode ?? null,
            point: place ? { lat: place.lat, lng: place.lng } : null,
            // Only a calendar that lets customers pick a person honours a pick.
            chosenUserId:
              config.team.assignment === 'customer_choice' ? (q.chosenUserId ?? null) : null,
            locationKind: q.locationKind,
          });
          return {
            timezone: calendar.timeZone,
            durationMinutes: out.durationMinutes,
            slots: await publicSlots(tx, config, out.slots),
            full:
              config.schedule.mode === 'sessions' || config.capacity.seats > 1
                ? await fullSessions(tx, calendar, from, to, q.partySize)
                : [],
          };
        });
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
            'We couldn’t confirm you’re a person. Finish the check on this page, then try again.',
          );
        const { scope, calendar } = await openCalendar(req.params.site, req.params.calendar);
        /**
         * What this calendar asks for before it will hold the time. With a figure to ask for, the booking is
         * **held** rather than confirmed and nobody is told anything until the deposit is in hand. A calendar
         * that asks for payment with no account that can take it refuses here, in plain words.
         */
        const plan = await worker(scope, (tx) =>
          depositPlan(deps, tx, scope.workspaceId, calendar.config, {
            serviceId: body.serviceId ?? null,
            calendarName: calendar.name,
          }),
        );
        if (plan && !plan.account) throw cannotTakePayment();
        const place = await placeFor(scope, calendar.config, body.address);
        const { output } = await executeCommand(
          deps.httpDb,
          appointmentBookOnline,
          {
            workspaceId: scope.workspaceId,
            calendarId: calendar.id,
            hold: !!plan,
            startsAt: body.startsAt,
            sessionId: body.sessionId ?? null,
            serviceId: body.serviceId ?? null,
            durationMinutes: body.durationMinutes,
            partySize: body.partySize,
            locationKind: body.locationKind,
            address: body.address ?? null,
            postalCode: body.postalCode ?? place?.postalCode ?? null,
            point: place ? { lat: place.lat, lng: place.lng } : null,
            chosenUserId:
              calendar.config.team.assignment === 'customer_choice'
                ? (body.chosenUserId ?? null)
                : null,
            customer: { ...splitName(body.name), phone, email: body.email || null },
            smsConsent: body.smsConsent,
            offersConsent: body.offersConsent,
            intake: body.intake,
            notes: body.notes ?? null,
            linkRef: linkRefOf(body.ref),
            clientId: body.clientId,
          },
          systemActor(scope),
          meta(),
        ).catch(publicPaths);
        // Held: the time is theirs for fifteen minutes while they pay, and the deposit is its own invoice.
        if (plan && output.held) {
          const already = await worker(scope, (tx) =>
            invoiceForHold(tx, scope.workspaceId, output.attendeeId),
          );
          if (!already)
            await raiseDepositInvoice(deps, scope, {
              personId: output.personId,
              attendeeId: output.attendeeId,
              leadId: output.leadId,
              plan,
              when: whenText(output.startsAt, calendar.timeZone),
            });
          return holdView(scope, output.attendeeId);
        }
        return bookedPayload(scope, output.attendeeId, {
          joined: output.joined,
          duplicate: output.duplicate,
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
            'We couldn’t confirm you’re a person. Finish the check on this page, then try again.',
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
            offersConsent: body.offersConsent,
          },
          systemActor(scope),
          meta(),
        ).catch(publicPaths);
        return { position: output.position, alreadyWaiting: output.alreadyWaiting };
      },
    );

    // ---------- a time held while a deposit is paid ----------
    /**
     * The pay step, and the page the provider sends the customer back to. A GET never changes anything: it
     * says where the hold stands and hands the browser the public keys it needs, nothing more.
     */
    pub.get<{ Params: { token: string } }>(
      '/public/hold/:token',
      { config: { rateLimit: limits.manageRead } },
      async (req, reply) => {
        const m = await managed(req.params.token);
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        return holdView(m.scope, m.attendeeId);
      },
    );

    /**
     * Paying the deposit, in the two phases the two providers need. **A card is authorised, not charged**;
     * the time is confirmed in its own transaction, and only then is the card captured. If the time went
     * while they were typing, the hold is let go and nothing is taken — and a bank transfer, which cannot be
     * held, is sent back in full at once.
     */
    pub.post<{ Params: { token: string } }>(
      '/public/hold/:token/pay',
      { config: { rateLimit: limits.pay } },
      async (req, reply) => {
        refuseHoneypot(req.body);
        const body = parseBody(DepositPayBody, req.body ?? {});
        const m = await managed(req.params.token);
        const scope = m.scope;
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');

        const start = await worker(scope, async (tx) => {
          const b = await loadBooked(tx, m.attendeeId);
          if (!b) throw linkNotFound();
          const calendar = await loadCalendar(tx, scope.workspaceId, b.p.calendarId);
          const invoice = await invoiceForHold(tx, scope.workspaceId, m.attendeeId);
          if (!invoice)
            throw HfosError.notFound(
              'There’s nothing to pay for this booking. Contact the business if that doesn’t look right.',
            );
          const plan = await depositPlan(deps, tx, scope.workspaceId, calendar.config, {
            serviceId: b.p.serviceId,
            calendarName: calendar.name,
          });
          const account = plan?.account ?? null;
          if (!account) throw cannotTakePayment();
          const method: PaymentMethodKind = account.methods.includes(body.method)
            ? body.method
            : account.methods[0]!;
          return {
            invoice,
            account,
            method,
            gone: b.a.status !== 'booked' || b.p.status !== 'scheduled',
            what: plan!.what,
            // Read here rather than in a transaction of its own, because this one is already open: their own
            // domain when one is serving (M17), so a customer is not bounced between two names in the middle
            // of putting a card down.
            origin: await publicOrigin(tx, scope.workspaceId, links.webUrl),
          };
        });

        // Already paid for: the answer is the booking it already made. Nothing is taken a second time.
        if (start.invoice.status !== 'draft' || start.invoice.paidCents > 0)
          return { stage: 'recorded' as const, hold: await holdView(scope, m.attendeeId) };

        const ctx: DepositPayContext = {
          invoiceId: start.invoice.id,
          attendeeId: m.attendeeId,
          account: start.account,
          amountCents: start.invoice.amountCents,
          method: start.method,
          // Written on the payment row before the provider is called: one press, one payment.
          idempotencyKey: `hold:${m.attendeeId}:${body.clientId}`.slice(0, 64),
          description: `Deposit · ${start.what}`,
        };
        const provider = deps.payments.providers[ctx.account.session.provider]!;
        let account;
        try {
          account = accountFor(deps.sealer, ctx.account.connection);
        } catch (e) {
          return refused(deps, e, scope, ctx.account.connection.id);
        }
        const returnUrl = `${start.origin}/hold/${req.params.token}`;

        // Phase one: hand the browser whatever the provider needs it to do. `hold: true` is the whole point —
        // Stripe's intent is made for capture later, so confirming it holds the card instead of taking it.
        if (!body.sourceToken && !body.providerPaymentId) {
          if (start.gone) throw holdLost();
          let session;
          try {
            session = await provider.prepare(account, {
              amountCents: ctx.amountCents,
              methods: [ctx.method],
              idempotencyKey: ctx.idempotencyKey,
              description: ctx.description,
              customerRef: null,
              // A card is held, not charged, until the time is confirmed.
              hold: ctx.method === 'card',
              metadata: { attendeeId: m.attendeeId, workspaceId: scope.workspaceId },
              returnUrl,
            });
          } catch (e) {
            return refused(deps, e, scope, ctx.account.connection.id);
          }
          if (session.providerPaymentId)
            await recordDepositPayment(deps, scope, ctx, {
              status: 'requires_payment',
              providerPaymentId: session.providerPaymentId,
            });
          return {
            stage: 'prepared' as const,
            payment: {
              status: 'requires_payment' as const,
              amountCents: ctx.amountCents,
              method: ctx.method,
              flow: session.flow,
              publishableKey: session.publishableKey,
              accountId: session.accountId,
              locationId: session.locationId,
              clientSecret: session.clientSecret,
              providerPaymentId: session.providerPaymentId,
              /** The stand-in's own page; null with the real providers, which run in the browser. */
              hostedUrl: session.hostedUrl,
              returnUrl,
            },
            hold: await holdView(scope, m.attendeeId),
          };
        }

        /** The time went and nothing is owed: what the page says, whatever had to be undone first. */
        const lost = async (undone: { refunded: boolean }) => ({
          stage: 'recorded' as const,
          state: 'gone' as const,
          payment: {
            status: 'failed' as const,
            amountCents: ctx.amountCents,
            method: ctx.method,
            /** Nothing was taken: a card was only held, and a bank transfer has already gone back. */
            charged: false,
            refunded: undone.refunded,
            failureCode: 'slot_taken',
            failureMessage: undone.refunded
              ? 'That time went, so we’ve sent your deposit straight back. It takes a day or two to land.'
              : 'That time went, so nothing was charged. The hold on your card has been let go.',
          },
          hold: await holdView(scope, m.attendeeId),
          times: await openTimesNear(scope, m.attendeeId),
        });

        /**
         * The time went while they were on the provider's page. A card the browser already confirmed is held
         * money, so the hold is let go; a card token that has not been charged is simply never charged — the
         * best possible answer, because the money never leaves at all.
         */
        if (start.gone) {
          let held: PaymentResult | null = null;
          if (body.providerPaymentId) {
            try {
              held = await provider.confirmFromClient(account, body.providerPaymentId);
            } catch {
              // Nothing to read back is nothing to let go of.
            }
          }
          return lost(await undoOnLostSlot(deps, scope, ctx, held));
        }

        // Phase two: the provider's own answer, never the page's guess.
        let result: PaymentResult;
        try {
          result = body.providerPaymentId
            ? await provider.confirmFromClient(account, body.providerPaymentId)
            : await (async () => {
                await recordDepositPayment(deps, scope, ctx, { status: 'requires_payment' });
                const input = {
                  amountCents: ctx.amountCents,
                  method: ctx.method,
                  sourceToken: body.sourceToken ?? null,
                  idempotencyKey: ctx.idempotencyKey,
                  description: ctx.description,
                  customerRef: null,
                  metadata: { attendeeId: m.attendeeId, workspaceId: scope.workspaceId },
                };
                // A card is held; a bank transfer cannot be, so it is charged and given back if the time goes.
                return ctx.method === 'card'
                  ? provider.authorize(account, input)
                  : provider.charge(account, input);
              })();
        } catch (e) {
          if (e instanceof HfosError) throw e;
          return refused(deps, e, scope, ctx.account.connection.id);
        }

        // A refusal is an answer, not an error: the time stays held and they can try another card.
        if (result.status === 'failed') {
          await recordDepositPayment(deps, scope, ctx, {
            status: 'failed',
            providerPaymentId: result.providerPaymentId,
            providerStatus: result.providerStatus,
            failureCode: result.failureCode,
          });
          return {
            stage: 'recorded' as const,
            payment: {
              status: 'failed' as const,
              amountCents: result.amountCents,
              method: ctx.method,
              failureCode: result.failureCode,
              failureMessage: result.failureMessage ?? declineWording(result.failureCode),
            },
            hold: await holdView(scope, m.attendeeId),
          };
        }
        await recordDepositPayment(deps, scope, ctx, {
          status: result.capturable ? 'processing' : result.status,
          providerPaymentId: result.providerPaymentId,
          providerStatus: result.providerStatus,
          cardBrand: result.cardBrand,
          cardLast4: result.cardLast4,
        });

        try {
          const done = await confirmAndCapture(deps, scope, ctx, result);
          await recordDepositPayment(deps, scope, ctx, {
            status: done.payment.status,
            providerPaymentId: done.payment.providerPaymentId,
            providerStatus: done.payment.providerStatus,
            feeCents: done.payment.feeCents,
            netCents: done.payment.netCents,
            receivedAt: done.payment.receivedAt,
            cardBrand: done.payment.cardBrand ?? result.cardBrand,
            cardLast4: done.payment.cardLast4 ?? result.cardLast4,
          });
          return {
            stage: 'recorded' as const,
            payment: {
              status: done.payment.status,
              amountCents: ctx.amountCents,
              method: ctx.method,
              failureCode: null,
              failureMessage: null,
            },
            hold: await holdView(scope, m.attendeeId),
          };
        } catch (e) {
          if (!(e instanceof HfosError && e.rule === 'booking_hold_lost')) throw e;
          // The time went while they were paying. A held card is let go; a bank transfer goes back in full.
          return lost(await undoOnLostSlot(deps, scope, ctx, result));
        }
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
            throw HfosError.rule(
              'booking_cancelled',
              409,
              'This booking was cancelled, so it can’t be moved. Contact the business to book a new time.',
            );
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

    /**
     * The Confirm button: confirms a one-on-one booking (attendee.confirm_online; a second press changes nothing)
     * and answers with the page as it is now, plus `changed`. POST only, and nothing else confirms: email
     * scanners open links, so opening one never does. A group time or a session seat is 409
     * confirmation_not_needed; bad, old, cancelled and past bookings are refused as reschedule and cancel do.
     */
    pub.post<{ Params: { token: string } }>(
      '/public/manage/:token/confirm',
      { config: { rateLimit: limits.manageWrite } },
      async (req, reply) => {
        const m = await managed(req.params.token);
        void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        const booked = await worker(m.scope, (tx) => loadBooked(tx, m.attendeeId));
        if (!booked) throw linkNotFound();
        if (!oneOnOne(booked.p))
          throw HfosError.rule(
            'confirmation_not_needed',
            409,
            'This booking doesn’t need confirming. You’re already booked in.',
          );
        const { output } = await executeCommand(
          deps.httpDb,
          attendeeConfirmOnline,
          {
            workspaceId: m.scope.workspaceId,
            attendeeId: m.attendeeId,
            manageVersion: m.manageVersion,
          },
          systemActor(m.scope),
          meta(),
        );
        const {
          sequence: _sequence,
          attendeeId: _attendeeId,
          ...view
        } = await manageView(m.scope, m.attendeeId);
        return { ...view, changed: output.changed };
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

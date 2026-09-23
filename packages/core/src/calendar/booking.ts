/**
 * The shared booking core: staff booking now, the worker's online booking later.
 *
 * Under transaction-scoped advisory locks (`cal:<calendarId>`, then each `res:<resourceId>` in sorted
 * order, all taken before anything is written) it re-reads the calendar on fresh data, re-checks the time,
 * picks staff with the calendar's strategy (`chooseAssignment`, with the database clock) and writes the
 * appointment, its staff rows sorted by user id (so two collective bookings never wait on each other in
 * opposite orders), resources and attendee inside a savepoint, then the changed round-robin state.
 *
 * A 23P01 (the person was just booked on another calendar) or 40P01 rolls back the savepoint and gets one
 * retry on fresh data, which picks the next eligible person; after that it is a 409 slot_taken carrying up
 * to six fresh nearby open times.
 *
 * A calendar without staff (assignment 'none') writes no staff rows: the resource locks and quantities are
 * what keep it honest, and a resource with no room is a 409 resource_full (with nearby times) for customers
 * and staff alike.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  appointmentAttendees,
  appointmentResources,
  appointments,
  jobs,
  appointmentStaff,
  calendarAssignmentState,
  type AppointmentSource,
} from '@hfos/db/schema';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import type { CommandContext } from '../kernel/types';
import type { AppointmentLocation, AppointmentWarning, SlotOut } from '../schemas/calendar';
import type { CatalogService } from './catalogs';
import type { CalendarConfig, LocationKind } from './config';
import {
  containsInterval,
  normalize,
  overlaps,
  overlapsAny,
  type Interval,
} from './engine/intervals';
import { candidatePool, computeSlots } from './engine/slots';
import { chooseAssignment, memberState } from './engine/strategies';
import type { AssignmentState, Slot } from './engine/types';
import { addDays, localDateOf, startOfLocalDay } from './engine/zoned';
import {
  iso,
  loadSlotInput,
  resolveService,
  userNames,
  type LoadedCalendar,
  type LoadedSlots,
  type ResourceData,
  type SlotRequest,
  type StaffData,
} from './load';
import { resolveTerms } from './terms';

const MIN = 60_000;

// ---- Locks, errors, small helpers ----

/** Serializes bookings on one calendar and on each resource it uses (resources in sorted order). */
export async function lockBooking(
  tx: Tx,
  calendarId: string,
  resourceIds: readonly string[] = [],
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cal:${calendarId}`}, 0))`);
  for (const id of [...new Set(resourceIds)].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`res:${id}`}, 0))`);
}

function pgCode(e: unknown): string | undefined {
  let err: unknown = e;
  while (err instanceof Error && err.cause instanceof Error) err = err.cause;
  return (err as { code?: string } | null)?.code;
}

/** Someone was booked over this time in between (exclusion) or two bookings deadlocked. */
export function isRetryable(e: unknown): boolean {
  const code = pgCode(e);
  return code === '23P01' || code === '40P01';
}

export const slotOut = (s: Slot): SlotOut => ({
  startsAt: iso(s.start),
  endsAt: iso(s.end),
  userIds: [...s.userIds],
  seatsLeft: s.seatsLeft,
  sessionId: s.sessionId,
});

/** Up to six open times nearest the one asked for (that day and the next two). */
async function nearbySlots(
  tx: Tx,
  calendar: LoadedCalendar,
  base: SlotRequest,
  start: number,
  service: CatalogService | null,
): Promise<SlotOut[]> {
  const tz = calendar.timeZone;
  const day = localDateOf(start, tz);
  const loaded = await loadSlotInput(
    tx,
    calendar,
    { ...base, from: startOfLocalDay(day, tz), to: startOfLocalDay(addDays(day, 3), tz) },
    { service },
  );
  return computeSlots(loaded.input)
    .sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start) || a.start - b.start)
    .slice(0, 6)
    .sort((a, b) => a.start - b.start)
    .map(slotOut);
}

/** 409 slot_taken with up to six open times nearest the one asked for (that day and the next two). */
export async function slotTakenError(
  tx: Tx,
  calendar: LoadedCalendar,
  base: SlotRequest,
  start: number,
  service: CatalogService | null,
): Promise<HfosError> {
  return new HfosError(
    'conflict',
    409,
    'That time was just taken. Pick another time.',
    { slots: await nearbySlots(tx, calendar, base, start, service) },
    'slot_taken',
  );
}

/** A required resource with no room at a time (its quantity, cleanup and setup buffers included). */
export interface FullResource {
  readonly resourceId: string;
  readonly name: string;
  /** How many the booking needs. */
  readonly quantity: number;
}

const fullMessage = (r: FullResource): string =>
  r.quantity === 1
    ? `No ${r.name} is free then.`
    : `Fewer than ${r.quantity} of ${r.name} are free then.`;

/**
 * 409 resource_full with nearby open times. A calendar without staff can't book past its resources: there
 * is no "book anyway" over a physical limit.
 */
export async function resourceFullError(
  tx: Tx,
  calendar: LoadedCalendar,
  base: SlotRequest,
  start: number,
  service: CatalogService | null,
  full: FullResource,
): Promise<HfosError> {
  return new HfosError(
    'conflict',
    409,
    fullMessage(full),
    { resourceId: full.resourceId, slots: await nearbySlots(tx, calendar, base, start, service) },
    'resource_full',
  );
}

/**
 * Why a customer can't have a time, with nearby open times: resource_full when a calendar without staff has
 * no room on a required resource then, otherwise slot_taken.
 */
export async function unavailableError(
  tx: Tx,
  calendar: LoadedCalendar,
  base: SlotRequest,
  start: number,
  service: CatalogService | null,
): Promise<HfosError> {
  if (calendar.config.team.assignment === 'none') {
    const loaded = await loadSlotInput(tx, calendar, base, { service });
    const span: BookingSpan = {
      start,
      end: start + loaded.durationMinutes * MIN,
      before: loaded.bufferBefore * MIN,
      after: loaded.bufferAfter * MIN,
    };
    const data = await checkDataFor(tx, loaded);
    const needs = loaded.terms.requiredResources;
    const check = checkBooking(data, span, [], needs, { hardResources: true });
    if (check.full) return resourceFullError(tx, calendar, base, start, service, check.full);
  }
  return slotTakenError(tx, calendar, base, start, service);
}

export function needsConfirmation(
  warnings: readonly AppointmentWarning[],
  userIds: readonly string[],
): HfosError {
  return new HfosError(
    'conflict',
    409,
    'Check these before booking.',
    { warnings, userIds },
    'needs_confirmation',
  );
}

export const staffSource = (ctx: CommandContext): AppointmentSource =>
  ctx.meta.channel === 'assistant' ? 'assistant' : 'staff';

// ---- Warnings for staff bookings ----

export interface BookingSpan extends Interval {
  /** Milliseconds blocked around the visit, travel included. */
  readonly before: number;
  readonly after: number;
}

export interface CheckData {
  readonly now: number;
  readonly config: CalendarConfig;
  readonly staff: ReadonlyMap<string, StaffData>;
  readonly resources: ReadonlyMap<string, ResourceData>;
  readonly calendarWindows: readonly Interval[] | null;
  readonly serviceWindows: readonly Interval[] | null;
  readonly serviceName: string | null;
  readonly names: ReadonlyMap<string, string>;
}

export interface PersonCheck {
  /** Already in another appointment then (never allowed). */
  readonly overlap: boolean;
  readonly warnings: AppointmentWarning[];
}

const warn = (
  code: AppointmentWarning['code'],
  message: string,
  userId: string | null = null,
  resourceId: string | null = null,
): AppointmentWarning => ({ code, message, userId, resourceId });

export function checkPerson(data: CheckData, userId: string, span: BookingSpan): PersonCheck {
  const person = data.staff.get(userId);
  const name = data.names.get(userId) ?? 'Someone';
  if (!person)
    return { overlap: false, warnings: [warn('outside_hours', `Outside ${name}’s hours`, userId)] };
  const blocked = { start: span.start - span.before, end: span.end + span.after };
  const overlap = person.bookings.some((b) => overlaps(b.during, span));
  const warnings: AppointmentWarning[] = [];
  if (
    !overlap &&
    person.bookings.some((b) => overlaps(b.during, blocked) || overlaps(b.blocked, span))
  )
    warnings.push(warn('buffer_clash', `Too close to ${name}’s other appointment`, userId));
  if (!containsInterval(person.windows, span))
    warnings.push(warn('outside_hours', `Outside ${name}’s hours`, userId));
  if (overlapsAny(person.timeOff, span))
    warnings.push(warn('time_off', `${name} is off then`, userId));
  if (data.config.integrations.checkStaffCalendars && overlapsAny(person.external, span))
    warnings.push(warn('calendar_busy', `${name}’s calendar shows busy then`, userId));
  return { overlap, warnings };
}

/** Highest total quantity in use at any moment inside `window`. */
function peakLoad(
  items: readonly { span: Interval; quantity: number }[],
  window: Interval,
): number {
  const events: [number, number][] = [];
  for (const i of items) {
    const start = Math.max(i.span.start, window.start);
    const end = Math.min(i.span.end, window.end);
    if (end > start) events.push([start, i.quantity], [end, -i.quantity]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let level = 0;
  let peak = 0;
  for (const [, delta] of events) {
    level += delta;
    peak = Math.max(peak, level);
  }
  return peak;
}

export interface BookingCheck {
  /** Why it can't be booked at all (someone or something is already in use then). */
  readonly blocked: HfosError | null;
  /** With hard resources: the resource that has no room (`blocked` is its resource_full, without times). */
  readonly full?: FullResource | null;
  readonly warnings: AppointmentWarning[];
}

/**
 * Everything staff should hear about a time before booking it. With `hardResources` (a calendar without
 * staff), a resource with no room then, buffers included, blocks the booking instead of warning.
 */
export function checkBooking(
  data: CheckData,
  span: BookingSpan,
  userIds: readonly string[],
  needs: readonly { readonly resourceId: string; readonly quantity: number }[],
  opts: { readonly hardResources?: boolean } = {},
): BookingCheck {
  const warnings: AppointmentWarning[] = [];
  if (span.start < data.now) warnings.push(warn('in_past', 'That time has already passed'));
  if (data.calendarWindows && !containsInterval(normalize(data.calendarWindows), span))
    warnings.push(warn('outside_hours', 'Outside the calendar’s hours'));
  if (data.serviceWindows && !containsInterval(normalize(data.serviceWindows), span))
    warnings.push(warn('outside_hours', `Outside ${data.serviceName ?? 'the service'}’s hours`));
  for (const userId of userIds) {
    const check = checkPerson(data, userId, span);
    if (check.overlap)
      return {
        blocked: new HfosError(
          'conflict',
          409,
          `${data.names.get(userId) ?? 'Someone'} already has an appointment then.`,
          { userId },
          'slot_taken',
        ),
        warnings,
      };
    warnings.push(...check.warnings);
  }
  const blocked = { start: span.start - span.before, end: span.end + span.after };
  for (const need of needs) {
    const r = data.resources.get(need.resourceId);
    if (!r || r.archived)
      return {
        blocked: HfosError.rule(
          'resource_unavailable',
          409,
          `${r?.name ?? 'A required resource'} is no longer available.`,
        ),
        warnings,
      };
    const durings = r.bookings.map((b) => ({ span: b.during, quantity: b.quantity }));
    const blockeds = r.bookings.map((b) => ({ span: b.blocked, quantity: b.quantity }));
    const inUse = peakLoad(durings, span) + need.quantity > r.quantity;
    const tooClose =
      peakLoad(durings, blocked) + need.quantity > r.quantity ||
      peakLoad(blockeds, span) + need.quantity > r.quantity;
    if (opts.hardResources && (inUse || tooClose)) {
      const full = { resourceId: r.resourceId, name: r.name, quantity: need.quantity };
      return {
        blocked: new HfosError(
          'conflict',
          409,
          fullMessage(full),
          { resourceId: r.resourceId, slots: [] },
          'resource_full',
        ),
        full,
        warnings,
      };
    }
    if (inUse)
      return {
        blocked: new HfosError(
          'conflict',
          409,
          `${r.name} is already booked then.`,
          { resourceId: r.resourceId },
          'slot_taken',
        ),
        warnings,
      };
    if (tooClose)
      warnings.push(
        warn('buffer_clash', `Too close to ${r.name}’s other booking`, null, r.resourceId),
      );
    if (r.windows && !containsInterval(normalize(r.windows), span))
      warnings.push(warn('outside_hours', `Outside ${r.name}’s hours`, null, r.resourceId));
  }
  return { blocked: null, warnings };
}

export async function checkDataFor(
  tx: Tx,
  loaded: LoadedSlots,
  extraIds: readonly string[] = [],
): Promise<CheckData> {
  return {
    now: loaded.input.now,
    config: loaded.config,
    staff: loaded.staff,
    resources: loaded.resources,
    calendarWindows: loaded.calendarWindows,
    serviceWindows: loaded.serviceWindows,
    serviceName: loaded.service?.name ?? null,
    names: await userNames(tx, [...loaded.staff.keys(), ...extraIds]),
  };
}

// ---- Round-robin state ----

export async function loadAssignmentState(tx: Tx, calendarId: string): Promise<AssignmentState> {
  const list = await rows<{
    user_id: string;
    assigned_count: number;
    last_ms: number | null;
    wrr_credit: number;
  }>(
    tx,
    sql`select user_id, assigned_count, round(extract(epoch from last_assigned_at) * 1000)::float8 as last_ms,
          wrr_credit
        from app.calendar_assignment_state where calendar_id = ${calendarId}`,
  );
  return Object.fromEntries(
    list.map((r) => [
      r.user_id,
      { assignedCount: r.assigned_count, lastAssignedAt: r.last_ms, credit: r.wrr_credit },
    ]),
  );
}

/** Counts a booking for people picked by hand (their credit is left alone). */
export function bumpState(
  state: AssignmentState,
  userIds: readonly string[],
  now: number,
): AssignmentState {
  const next = { ...state };
  for (const u of userIds) {
    const s = memberState(state, u);
    next[u] = { ...s, assignedCount: s.assignedCount + 1, lastAssignedAt: now };
  }
  return next;
}

/** Writes back only the rows that changed. */
export async function saveAssignmentState(
  tx: Tx,
  workspaceId: string,
  calendarId: string,
  before: AssignmentState,
  after: AssignmentState,
): Promise<void> {
  for (const [userId, s] of Object.entries(after)) {
    const b = before[userId];
    if (
      b &&
      b.assignedCount === s.assignedCount &&
      b.lastAssignedAt === s.lastAssignedAt &&
      b.credit === s.credit
    )
      continue;
    const values = {
      assignedCount: s.assignedCount,
      lastAssignedAt: s.lastAssignedAt === null ? null : new Date(s.lastAssignedAt),
      wrrCredit: Math.round(s.credit),
    };
    await tx
      .insert(calendarAssignmentState)
      .values({ workspaceId, calendarId, userId, ...values })
      .onConflictDoUpdate({
        target: [calendarAssignmentState.calendarId, calendarAssignmentState.userId],
        set: values,
      });
  }
}

// ---- Booking ----

export interface AttendeeDraft {
  readonly personId: string;
  readonly seats: number;
  readonly intake?: Record<string, unknown>;
  readonly contactPhoneE164: string | null;
  readonly contactEmail: string | null;
  readonly smsOk: boolean;
  readonly source: AppointmentSource;
}

export type StaffChoice =
  /** A customer: the calendar's full rules, and the strategy picks who. */
  | { readonly mode: 'customer' }
  /** Staff: warnings instead of rules; `userIds` picks people by hand, else the strategy picks. */
  | {
      readonly mode: 'staff';
      readonly userIds?: readonly string[];
      readonly acknowledgeWarnings: boolean;
    };

export interface BookingRequest {
  readonly calendar: LoadedCalendar;
  readonly startsAt: number;
  readonly serviceId?: string | null;
  readonly durationMinutes?: number;
  readonly partySize: number;
  readonly locationKind?: LocationKind | null;
  readonly postalCode?: string | null;
  /** M18: where the customer's address is, for distance and drawn service areas. */
  readonly point?: { readonly lat: number; readonly lng: number } | null;
  readonly chosenUserId?: string | null;
  /** Join this session or group time (customers; staff use the add-attendee path). */
  readonly sessionId?: string | null;
  readonly preferUserIds?: readonly string[];
  readonly choice: StaffChoice;
  readonly kind?: 'booking' | 'session';
  /** Seats; defaults to the terms' seats. */
  readonly capacity?: number;
  readonly attendee?: AttendeeDraft | null;
  readonly title?: string;
  readonly notes?: string | null;
  readonly location?: AppointmentLocation;
  readonly leadId?: string | null;
  readonly clientId?: string | null;
  readonly source: AppointmentSource;
  readonly seriesId?: string | null;
  readonly occurrence?: number | null;
  readonly ownerUserId?: string | null;
  /** The caller already holds the calendar's locks (a series books many at once). */
  readonly skipLock?: boolean;
}

export interface BookingResult {
  readonly appointmentId: string;
  readonly attendeeId: string | null;
  readonly manageVersion: number | null;
  readonly userIds: string[];
  readonly startsAt: number;
  readonly endsAt: number;
  readonly serviceId: string | null;
  readonly title: string;
  readonly joined: boolean;
  readonly duplicate: boolean;
  readonly warnings: AppointmentWarning[];
}

/** Where an appointment happens: what the caller sent, else the calendar's option for that kind. */
export function locationFor(
  config: CalendarConfig,
  kind: LocationKind | null,
  given?: Partial<AppointmentLocation>,
): AppointmentLocation {
  const k = given?.kind !== undefined ? given.kind : kind;
  const option = k ? config.locations.options.find((o) => o.kind === k) : undefined;
  return {
    kind: k ?? null,
    address: given?.address ?? option?.address ?? null,
    meetingUrl: given?.meetingUrl ?? option?.meetingUrl ?? null,
    postalCode: given?.postalCode ?? null,
  };
}

async function staffOf(tx: Tx, appointmentId: string): Promise<string[]> {
  const list = await tx
    .select({ userId: appointmentStaff.userId, role: appointmentStaff.role })
    .from(appointmentStaff)
    .where(eq(appointmentStaff.appointmentId, appointmentId));
  return list
    .sort((a, b) =>
      a.role === b.role ? a.userId.localeCompare(b.userId) : a.role === 'host' ? -1 : 1,
    )
    .map((s) => s.userId);
}

export async function findBookingByClientId(
  tx: Tx,
  workspaceId: string,
  clientId: string,
): Promise<BookingResult | null> {
  const [a] = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.workspaceId, workspaceId), eq(appointments.clientId, clientId)));
  if (!a) return null;
  const [att] = await tx
    .select({ id: appointmentAttendees.id, manageVersion: appointmentAttendees.manageVersion })
    .from(appointmentAttendees)
    .where(eq(appointmentAttendees.appointmentId, a.id))
    .orderBy(appointmentAttendees.createdAt)
    .limit(1);
  return {
    appointmentId: a.id,
    attendeeId: att?.id ?? null,
    manageVersion: att?.manageVersion ?? null,
    userIds: await staffOf(tx, a.id),
    startsAt: a.startsAt.getTime(),
    endsAt: a.endsAt.getTime(),
    serviceId: a.serviceId,
    title: a.title,
    joined: false,
    duplicate: true,
    warnings: [],
  };
}

/**
 * Books one appointment (or joins a session, for customers). Throws 409 slot_taken (with nearby times),
 * needs_confirmation (staff warnings not yet acknowledged) or a validation error.
 */
export async function bookAppointment(
  ctx: CommandContext,
  req: BookingRequest,
): Promise<BookingResult> {
  const { calendar } = req;
  const service = await resolveService(ctx.tx, calendar, req.serviceId);
  const terms = resolveTerms(calendar.config, service);
  if (!req.skipLock)
    await lockBooking(
      ctx.tx,
      calendar.id,
      terms.requiredResources.map((r) => r.resourceId),
    );
  if (req.clientId) {
    const dup = await findBookingByClientId(ctx.tx, calendar.workspaceId, req.clientId);
    if (dup) return dup;
  }
  const base: SlotRequest = {
    from: req.startsAt,
    to: req.startsAt + 1,
    serviceId: service?.id ?? null,
    durationMinutes: req.durationMinutes,
    partySize: req.partySize,
    postalCode: req.postalCode ?? null,
    point: req.point ?? null,
    chosenUserId: req.chosenUserId ?? null,
    locationKind: req.locationKind,
  };
  return req.choice.mode === 'customer'
    ? bookAsCustomer(ctx, req, service, base)
    : bookAsStaff(ctx, req, req.choice, service, base);
}

async function bookAsCustomer(
  ctx: CommandContext,
  req: BookingRequest,
  service: CatalogService | null,
  base: SlotRequest,
): Promise<BookingResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const loaded = await loadSlotInput(ctx.tx, req.calendar, base, { service });
    const here = computeSlots(loaded.input).filter((s) => s.start === req.startsAt);
    const slot = req.sessionId
      ? here.find((s) => s.sessionId === req.sessionId)
      : (here.find((s) => s.sessionId !== null) ?? here[0]);
    if (!slot) break;
    if (slot.sessionId) {
      if (!req.attendee) break;
      return joinSession(ctx, {
        calendar: req.calendar,
        sessionId: slot.sessionId,
        attendee: req.attendee,
        customer: true,
      });
    }
    const state = await loadAssignmentState(ctx.tx, req.calendar.id);
    const picked = chooseAssignment(slot, loaded.config, state, {
      now: loaded.input.now,
      chosenUserId: req.chosenUserId ?? null,
      preferUserIds: req.preferUserIds,
    });
    try {
      return await commit(ctx, req, loaded, picked.userIds, state, picked.nextState, []);
    } catch (e) {
      if (!isRetryable(e)) throw e;
    }
  }
  throw await unavailableError(ctx.tx, req.calendar, base, req.startsAt, service);
}

/** People the strategy may pick from for a staff booking: free ones first, then ones with warnings. */
function staffCandidates(loaded: LoadedSlots, data: CheckData, span: BookingSpan): string[] {
  const { config } = loaded;
  const pool = candidatePool(loaded.input, loaded.terms);
  if (!pool.length)
    throw HfosError.rule('no_one_eligible', 409, 'No one on this calendar can take this booking.');
  const checks = new Map(pool.map((u) => [u, checkPerson(data, u, span)]));
  const free = pool.filter((u) => !checks.get(u)!.overlap);
  const clean = free.filter((u) => checks.get(u)!.warnings.length === 0);
  const soft = free.filter((u) => checks.get(u)!.warnings.length > 0);
  const busy = (u: string) =>
    new HfosError(
      'conflict',
      409,
      `${data.names.get(u) ?? 'Someone'} already has an appointment then.`,
      { userId: u },
      'slot_taken',
    );
  const mode = config.team.assignment;
  if (mode === 'collective') {
    const marked = config.team.members.filter((m) => m.required).map((m) => m.userId);
    const required = marked.length ? marked : config.team.members.map((m) => m.userId);
    const missing = required.find((u) => !free.includes(u));
    if (missing) throw busy(missing);
    return [...required, ...clean.filter((u) => !required.includes(u))];
  }
  const k = config.team.crewSize;
  const host = mode === 'fixed' ? (config.team.members[0]?.userId ?? null) : null;
  if (host && !free.includes(host)) throw busy(host);
  const ordered = clean.length >= k ? clean : [...clean, ...soft];
  const list = host ? [host, ...ordered.filter((u) => u !== host)] : ordered;
  if (list.length < k)
    throw HfosError.rule('not_enough_people', 409, 'Not enough people are free then.');
  return list;
}

async function bookAsStaff(
  ctx: CommandContext,
  req: BookingRequest,
  choice: Extract<StaffChoice, { mode: 'staff' }>,
  service: CatalogService | null,
  base: SlotRequest,
): Promise<BookingResult> {
  // No staff: nobody is picked, and a resource with no room is a hard stop.
  const none = req.calendar.config.team.assignment === 'none';
  if (none && choice.userIds?.length)
    throw HfosError.validation(
      [{ path: 'userIds', message: 'This calendar books without staff. Leave out who works it.' }],
      'This calendar books without staff. Leave out who works it.',
    );
  const byHand = choice.userIds?.length ? [...new Set(choice.userIds)] : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const loaded = await loadSlotInput(ctx.tx, req.calendar, base, {
      service,
      extraUserIds: byHand ?? [],
    });
    const data = await checkDataFor(ctx.tx, loaded);
    const span: BookingSpan = {
      start: req.startsAt,
      end: req.startsAt + loaded.durationMinutes * MIN,
      before: loaded.bufferBefore * MIN,
      after: loaded.bufferAfter * MIN,
    };
    let userIds: string[];
    const state = none ? {} : await loadAssignmentState(ctx.tx, req.calendar.id);
    let next: AssignmentState;
    if (none) {
      userIds = [];
      next = state;
    } else if (byHand) {
      userIds = byHand;
      next = bumpState(state, userIds, loaded.input.now);
    } else {
      const candidates = staffCandidates(loaded, data, span);
      const slot: Slot = {
        start: span.start,
        end: span.end,
        userIds: candidates,
        seatsLeft: loaded.terms.seats,
        sessionId: null,
      };
      const picked = chooseAssignment(slot, loaded.config, state, {
        now: loaded.input.now,
        chosenUserId: req.chosenUserId ?? null,
        preferUserIds: req.preferUserIds,
      });
      userIds = picked.userIds;
      next = picked.nextState;
    }
    const check = checkBooking(data, span, userIds, loaded.terms.requiredResources, {
      hardResources: none,
    });
    if (check.full)
      throw await resourceFullError(ctx.tx, req.calendar, base, req.startsAt, service, check.full);
    if (check.blocked) throw check.blocked;
    if (check.warnings.length && !choice.acknowledgeWarnings)
      throw needsConfirmation(check.warnings, userIds);
    try {
      return await commit(ctx, req, loaded, userIds, state, next, check.warnings);
    } catch (e) {
      if (!isRetryable(e)) throw e;
      if (byHand && pgCode(e) === '23P01') break;
    }
  }
  throw new HfosError(
    'conflict',
    409,
    'That time was just taken. Pick another time.',
    { slots: [] },
    'slot_taken',
  );
}

async function commit(
  ctx: CommandContext,
  req: BookingRequest,
  loaded: LoadedSlots,
  userIds: readonly string[],
  state: AssignmentState,
  next: AssignmentState,
  warnings: AppointmentWarning[],
): Promise<BookingResult> {
  const { calendar } = req;
  const workspaceId = calendar.workspaceId;
  const start = req.startsAt;
  const end = start + loaded.durationMinutes * MIN;
  const capacity = req.capacity ?? loaded.terms.seats;
  const party = req.attendee?.seats ?? 0;
  if (party > capacity)
    throw HfosError.validation([{ path: 'partySize', message: 'More people than seats.' }]);
  const title = req.title ?? loaded.service?.name ?? calendar.name;
  const location = locationFor(loaded.config, loaded.locationKind, req.location);
  const createdBy = userIdOf(ctx.actor);
  const needs = [...loaded.terms.requiredResources].sort((a, b) =>
    a.resourceId.localeCompare(b.resourceId),
  );
  const saved = await ctx.tx.transaction(async (sp) => {
    // M18: every booked visit starts a job of its own (a session's seats don't: many customers share it).
    const [job] =
      (req.kind ?? 'booking') === 'booking'
        ? await sp
            .insert(jobs)
            .values({
              workspaceId,
              personId: req.attendee?.personId ?? null,
              title: title.slice(0, 200),
              createdBy,
            })
            .returning({ id: jobs.id })
        : [];
    const [appt] = await sp
      .insert(appointments)
      .values({
        jobId: job?.id ?? null,
        workspaceId,
        calendarId: calendar.id,
        calendarRevision: calendar.revision,
        serviceId: loaded.service?.id ?? null,
        kind: req.kind ?? 'booking',
        title,
        startsAt: new Date(start),
        endsAt: new Date(end),
        bufferBefore: loaded.bufferBefore,
        bufferAfter: loaded.bufferAfter,
        capacity,
        seatsTaken: party,
        location,
        seriesId: req.seriesId ?? null,
        occurrence: req.occurrence ?? null,
        // Nobody works it: the calendar's owner answers for it.
        ownerUserId: req.ownerUserId ?? (userIds.length ? null : calendar.ownerUserId),
        leadId: req.leadId ?? null,
        source: req.source,
        notes: req.notes ?? null,
        clientId: req.clientId ?? null,
        createdBy,
      })
      .returning({ id: appointments.id });
    const appointmentId = appt!.id;
    // Sorted by user id: every transaction takes people's rows in the same order, so none deadlock.
    // A calendar without staff writes none.
    if (userIds.length)
      await sp.insert(appointmentStaff).values(
        [...userIds].sort().map((userId) => ({
          workspaceId,
          appointmentId,
          userId,
          role: userId === userIds[0] ? ('host' as const) : ('crew' as const),
        })),
      );
    if (needs.length)
      await sp.insert(appointmentResources).values(
        needs.map((n) => ({
          workspaceId,
          appointmentId,
          resourceId: n.resourceId,
          quantity: n.quantity,
        })),
      );
    let attendee: { id: string; manageVersion: number } | undefined;
    if (req.attendee)
      [attendee] = await sp
        .insert(appointmentAttendees)
        .values({
          workspaceId,
          appointmentId,
          personId: req.attendee.personId,
          seats: req.attendee.seats,
          intake: req.attendee.intake ?? {},
          contactPhoneE164: req.attendee.contactPhoneE164,
          contactEmail: req.attendee.contactEmail,
          smsOk: req.attendee.smsOk,
          source: req.attendee.source,
          createdBy,
        })
        .returning({
          id: appointmentAttendees.id,
          manageVersion: appointmentAttendees.manageVersion,
        });
    await saveAssignmentState(sp, workspaceId, calendar.id, state, next);
    return { appointmentId, attendee };
  });
  return {
    appointmentId: saved.appointmentId,
    attendeeId: saved.attendee?.id ?? null,
    manageVersion: saved.attendee?.manageVersion ?? null,
    userIds: [...userIds],
    startsAt: start,
    endsAt: end,
    serviceId: loaded.service?.id ?? null,
    title,
    joined: false,
    duplicate: false,
    warnings,
  };
}

// ---- Joining a session or group time ----

export interface JoinRequest {
  readonly calendar: LoadedCalendar;
  readonly sessionId: string;
  readonly attendee: AttendeeDraft;
  /** Customers hear "slot taken" (with other times); staff hear "full". */
  readonly customer: boolean;
}

/** Adds someone to a session under the calendar's lock (the caller holds it), keeping seats_taken right. */
export async function joinSession(ctx: CommandContext, req: JoinRequest): Promise<BookingResult> {
  const { calendar, attendee } = req;
  const [s] = await ctx.tx
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.id, req.sessionId),
        eq(appointments.workspaceId, calendar.workspaceId),
        eq(appointments.calendarId, calendar.id),
      ),
    );
  const full = () =>
    req.customer
      ? new HfosError(
          'conflict',
          409,
          'That time was just taken. Pick another time.',
          { slots: [] },
          'slot_taken',
        )
      : HfosError.rule('session_full', 409, 'There aren’t enough seats left.');
  if (!s || s.status !== 'scheduled')
    throw req.customer ? full() : HfosError.notFound('Appointment not found.');
  const [existing] = await ctx.tx
    .select()
    .from(appointmentAttendees)
    .where(
      and(
        eq(appointmentAttendees.appointmentId, s.id),
        eq(appointmentAttendees.personId, attendee.personId),
      ),
    );
  const result = (id: string, manageVersion: number, duplicate: boolean): BookingResult => ({
    appointmentId: s.id,
    attendeeId: id,
    manageVersion,
    userIds: [],
    startsAt: s.startsAt.getTime(),
    endsAt: s.endsAt.getTime(),
    serviceId: s.serviceId,
    title: s.title,
    joined: true,
    duplicate,
    warnings: [],
  });
  if (existing?.status === 'booked') {
    if (!req.customer)
      throw HfosError.conflict('They’re already booked on this.', 'already_booked');
    return {
      ...result(existing.id, existing.manageVersion, true),
      userIds: await staffOf(ctx.tx, s.id),
    };
  }
  if (s.seatsTaken + attendee.seats > s.capacity) throw full();
  let row: { id: string; manageVersion: number } | undefined;
  if (existing)
    [row] = await ctx.tx
      .update(appointmentAttendees)
      .set({
        status: 'booked',
        seats: attendee.seats,
        intake: attendee.intake ?? {},
        contactPhoneE164: attendee.contactPhoneE164,
        contactEmail: attendee.contactEmail,
        smsOk: attendee.smsOk,
        cancelledAt: null,
        // A fresh booking retires the links sent for the cancelled one.
        manageVersion: existing.manageVersion + 1,
      })
      .where(eq(appointmentAttendees.id, existing.id))
      .returning({
        id: appointmentAttendees.id,
        manageVersion: appointmentAttendees.manageVersion,
      });
  else
    [row] = await ctx.tx
      .insert(appointmentAttendees)
      .values({
        workspaceId: calendar.workspaceId,
        appointmentId: s.id,
        personId: attendee.personId,
        seats: attendee.seats,
        intake: attendee.intake ?? {},
        contactPhoneE164: attendee.contactPhoneE164,
        contactEmail: attendee.contactEmail,
        smsOk: attendee.smsOk,
        source: attendee.source,
        createdBy: userIdOf(ctx.actor),
      })
      .returning({
        id: appointmentAttendees.id,
        manageVersion: appointmentAttendees.manageVersion,
      });
  await ctx.tx
    .update(appointments)
    .set({ seatsTaken: sql`${appointments.seatsTaken} + ${attendee.seats}` })
    .where(eq(appointments.id, s.id));
  return { ...result(row!.id, row!.manageVersion, false), userIds: await staffOf(ctx.tx, s.id) };
}

export { staffOf as appointmentStaffIds };

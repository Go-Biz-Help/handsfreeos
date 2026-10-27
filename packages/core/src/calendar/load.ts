/**
 * Server-only loaders for the calendar (exported through '@hfos/core/server', never the browser entry):
 * catalogs for the rules, `SlotInput` for the engine and the upcoming-appointments summary impact analysis
 * reads. Weekly hours become instants in Postgres (`private.expand_schedule`, which runs as the caller, so
 * RLS keeps every read inside the caller's workspace); TypeScript only does interval math on the results.
 *
 * Raw queries return epoch milliseconds as float8: Drizzle leaves timestamptz as text in raw results.
 */
import type { GeoPoint } from './areas';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  calendars,
  pipelines,
  pipelineStages,
  resources,
  schedules,
  serviceResources,
  services,
  serviceStaff,
  territories,
  territoryMembers,
  workspaces,
  type CalendarStatus,
} from '@hfos/db/schema';
import { loadMoneySettings } from '../commands/money-shared';
import { HfosError } from '../errors';
import { defaultNumber, loadRegistrations, readiness } from '../messaging/store';
import { NO_DEPOSIT, type DepositTerms } from '../money/totals';
import type {
  CalendarCatalogs,
  CatalogPerson,
  CatalogResource,
  CatalogService,
  CatalogTerritory,
} from './catalogs';
import { parseConfig, type CalendarConfig, type LocationKind, type WeeklyHours } from './config';
import { expandWeeklyHours } from './engine/hours';
import { normalize, subtract, type Interval } from './engine/intervals';
import { MAX_RANGE_DAYS } from './engine/slots';
import type { Booking, ResourceBooking, SessionInput, SlotInput } from './engine/types';
import { addDays, localDateOf, startOfLocalDay } from './engine/zoned';
import type { UpcomingSummary } from './impact';
import { bookableDurations, defaultLocationKind, resolveTerms, type Terms } from './terms';

const MIN = 60_000;
const DAY = 86_400_000;

/** Hours for someone who hasn't saved any yet: weekdays 9 to 5 in the workspace's zone. */
export const DEFAULT_WEEKLY_HOURS: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '09:00',
  end: '17:00',
}));
/** A resource or service schedule created only to hold a closure starts open all week. */
export const ALWAYS_OPEN_HOURS: WeeklyHours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  start: '00:00',
  end: '24:00',
}));

export const iso = (ms: number): string => new Date(ms).toISOString();
const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];

/** A uuid[] parameter (Drizzle's sql tag would spread a JS array into a list). */
export function uuidArray(ids: readonly string[]) {
  return ids.length
    ? sql`array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]::uuid[]`
    : sql`array[]::uuid[]`;
}
/** A text[] parameter, the same way. */
export function textArray(values: readonly string[]) {
  return values.length
    ? sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`
    : sql`array[]::text[]`;
}
export const tsParam = (ms: number) => sql`${iso(ms)}::timestamptz`;
const tsRange = (r: Interval) => sql`tstzrange(${tsParam(r.start)}, ${tsParam(r.end)}, '[)')`;
const epoch = (column: ReturnType<typeof sql>) =>
  sql`round(extract(epoch from ${column}) * 1000)::float8`;

/** The database clock, read now (not the transaction's start), in epoch milliseconds. */
export async function dbNow(tx: Tx): Promise<number> {
  const [r] = await rows<{ ms: number }>(tx, sql`select ${epoch(sql`clock_timestamp()`)} as ms`);
  return r!.ms;
}

// ---- Calendars ----

export interface LoadedCalendar {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string | null;
  readonly color: string;
  readonly slug: string;
  readonly status: CalendarStatus;
  readonly public: boolean;
  readonly revision: number;
  readonly labels: readonly string[];
  readonly ownerUserId: string | null;
  /** The calendar's own zone; null follows the workspace. */
  readonly ownTimezone: string | null;
  /** The zone it books in. */
  readonly timeZone: string;
  readonly config: CalendarConfig;
  readonly updatedAt: Date;
  /** The business has HandsFreeOS video calls on, so its Online places can make them (absent: off). */
  readonly videoCalls?: boolean;
}

type CalendarRow = typeof calendars.$inferSelect;

export function toLoadedCalendar(
  row: CalendarRow,
  workspaceZone: string,
  videoCalls = false,
): LoadedCalendar {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    color: row.color,
    slug: row.slug,
    status: row.status,
    public: row.public,
    revision: row.revision,
    labels: row.labels,
    ownerUserId: row.ownerUserId,
    ownTimezone: row.timezone,
    timeZone: row.timezone ?? workspaceZone,
    config: parseConfig(row.config),
    updatedAt: row.updatedAt,
    videoCalls,
  };
}

/** One calendar with its settings parsed. `forUpdate` locks the row (people who manage calendars only). */
export async function loadCalendar(
  tx: Tx,
  workspaceId: string,
  calendarId: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<LoadedCalendar> {
  // Postgres wants an unqualified name in FOR UPDATE OF, so the row is locked on its own first.
  if (opts.forUpdate)
    await tx.execute(
      sql`select 1 from app.calendars where id = ${calendarId} and workspace_id = ${workspaceId} for update`,
    );
  const [row] = await tx
    .select({ c: calendars, zone: workspaces.timezone, videoCalls: workspaces.videoCalls })
    .from(calendars)
    .innerJoin(workspaces, eq(workspaces.id, calendars.workspaceId))
    .where(and(eq(calendars.id, calendarId), eq(calendars.workspaceId, workspaceId)));
  if (!row)
    throw HfosError.notFound(
      'That calendar isn’t there anymore. It may have been deleted. Refresh and try again.',
    );
  return toLoadedCalendar(row.c, row.zone, row.videoCalls);
}

export async function workspaceZone(tx: Tx, workspaceId: string): Promise<string> {
  const [ws] = await tx
    .select({ timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws)
    throw HfosError.notFound(
      'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
    );
  return ws.timezone;
}

/** Display names for people ('Someone' when not visible). */
export async function userNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const wanted = unique(ids);
  if (!wanted.length) return map;
  const list = await rows<{ id: string; name: string }>(
    tx,
    sql`select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name
        from app.users u where u.id = any(${uuidArray(wanted)})`,
  );
  for (const r of list) map.set(r.id, r.name);
  for (const id of wanted) if (!map.has(id)) map.set(id, 'Someone');
  return map;
}

// ---- Catalogs ----

type ScheduleRow = { id: string; ownerKind: string; ownerId: string; weekly: WeeklyHours };

async function scheduleRows(tx: Tx, workspaceId: string): Promise<ScheduleRow[]> {
  return tx
    .select({
      id: schedules.id,
      ownerKind: schedules.ownerKind,
      ownerId: schedules.ownerId,
      weekly: schedules.weekly,
    })
    .from(schedules)
    .where(eq(schedules.workspaceId, workspaceId));
}

/**
 * A read the calendar's rules would like but can live without, in its own savepoint: the money side is
 * readable by fewer people than a calendar is, and a refusal must never cost someone their calendar page
 * (a rolled-back savepoint leaves the transaction usable, where a plain catch would not).
 */
async function inSavepoint<T>(tx: Tx, read: (sp: Tx) => Promise<T>): Promise<T | null> {
  try {
    return await tx.transaction((sp) => read(sp as unknown as Tx));
  } catch {
    return null;
  }
}

/** What the business asks for up front, or nothing when its money settings can't be read from here. */
async function businessDepositOf(tx: Tx, workspaceId: string): Promise<DepositTerms> {
  const settings = await inSavepoint(tx, (sp) => loadMoneySettings(sp, workspaceId));
  return settings?.deposit ?? NO_DEPOSIT;
}

function toCatalogService(
  row: typeof services.$inferSelect,
  staff: readonly { serviceId: string; userId: string }[],
  needs: readonly { serviceId: string; resourceId: string; quantity: number }[],
  hours: WeeklyHours | null,
  /** The product that prices it, where one does: the money side of the same thing. */
  price?: number | null,
): CatalogService {
  const durations = [
    row.defaultDuration,
    ...row.durations.filter((d) => d !== row.defaultDuration),
  ];
  return {
    id: row.id,
    name: row.name,
    durations,
    bufferBefore: row.bufferBefore,
    bufferAfter: row.bufferAfter,
    priceCents: price ?? row.priceCents ?? null,
    eligibleUserIds: staff.filter((s) => s.serviceId === row.id).map((s) => s.userId),
    requiredResources: needs
      .filter((r) => r.serviceId === row.id)
      .map((r) => ({ resourceId: r.resourceId, quantity: r.quantity })),
    archived: row.archivedAt !== null,
    hours,
  };
}

/** One service as the rules and the engine see it, or null. */
export async function loadCatalogService(
  tx: Tx,
  workspaceId: string,
  serviceId: string,
): Promise<CatalogService | null> {
  const [row] = await tx
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.workspaceId, workspaceId)));
  if (!row) return null;
  const staff = await tx
    .select({ serviceId: serviceStaff.serviceId, userId: serviceStaff.userId })
    .from(serviceStaff)
    .where(eq(serviceStaff.serviceId, serviceId));
  const needs = await tx
    .select({
      serviceId: serviceResources.serviceId,
      resourceId: serviceResources.resourceId,
      quantity: serviceResources.quantity,
    })
    .from(serviceResources)
    .where(eq(serviceResources.serviceId, serviceId));
  const [hours] = await tx
    .select({ weekly: schedules.weekly })
    .from(schedules)
    .where(
      and(
        eq(schedules.workspaceId, workspaceId),
        eq(schedules.ownerKind, 'service'),
        eq(schedules.ownerId, serviceId),
      ),
    );
  return toCatalogService(row, staff, needs, hours?.weekly ?? null);
}

export async function loadTerritories(tx: Tx, workspaceId: string): Promise<CatalogTerritory[]> {
  const list = await tx
    .select()
    .from(territories)
    .where(eq(territories.workspaceId, workspaceId))
    .orderBy(asc(territories.name));
  const members = await tx
    .select({ territoryId: territoryMembers.territoryId, userId: territoryMembers.userId })
    .from(territoryMembers)
    .where(eq(territoryMembers.workspaceId, workspaceId));
  return list.map((t) => ({
    id: t.id,
    name: t.name,
    kind: (t.kind as CatalogTerritory['kind']) ?? 'zip',
    postalCodes: t.postalCodes,
    centerAddress: t.centerAddress,
    center:
      t.centerLat !== null && t.centerLng !== null ? { lat: t.centerLat, lng: t.centerLng } : null,
    radiusMiles: t.radiusMiles === null ? null : Number(t.radiusMiles),
    polygon: t.polygon ?? null,
    userIds: members.filter((m) => m.territoryId === t.id).map((m) => m.userId),
  }));
}

export interface CatalogOptions {
  /** The calendar's zone (the workspace's when it has none). */
  readonly timeZone: string;
  /** People a settings document names who may have left (they come back with active false). */
  readonly extraUserIds?: readonly string[];
}

/**
 * Everything a calendar's settings can refer to: the team (current members plus anyone a calendar still
 * names, marked inactive once they leave), their hours, services, resources, territories, pipelines and
 * whether texting is ready.
 */
export async function loadCatalogs(
  tx: Tx,
  workspaceId: string,
  opts: CatalogOptions,
): Promise<CalendarCatalogs> {
  const teamRows = await rows<{ id: string; name: string | null; active: boolean }>(
    tx,
    sql`with ids as (
          select wm.user_id from app.workspace_memberships wm where wm.workspace_id = ${workspaceId}
          union select cm.user_id from app.calendar_members cm where cm.workspace_id = ${workspaceId}
          union select unnest(${uuidArray(opts.extraUserIds ?? [])})
        )
        select ids.user_id as id, coalesce(nullif(u.full_name, ''), u.email::text) as name,
          private.workspace_has_user(${workspaceId}, ids.user_id) as active
        from ids left join app.users u on u.id = ids.user_id`,
  );
  const scheds = await scheduleRows(tx, workspaceId);
  const hoursOf = (kind: string, id: string) =>
    scheds.find((s) => s.ownerKind === kind && s.ownerId === id)?.weekly ?? null;
  const team: CatalogPerson[] = teamRows
    .map((r) => ({
      userId: r.id,
      name: r.name ?? 'Someone',
      active: r.active,
      hours: hoursOf('user', r.id) ?? DEFAULT_WEEKLY_HOURS,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const serviceList = await tx
    .select()
    .from(services)
    .where(eq(services.workspaceId, workspaceId))
    .orderBy(asc(services.name));
  const staff = await tx
    .select({ serviceId: serviceStaff.serviceId, userId: serviceStaff.userId })
    .from(serviceStaff)
    .where(eq(serviceStaff.workspaceId, workspaceId));
  const needs = await tx
    .select({
      serviceId: serviceResources.serviceId,
      resourceId: serviceResources.resourceId,
      quantity: serviceResources.quantity,
    })
    .from(serviceResources)
    .where(eq(serviceResources.workspaceId, workspaceId));
  const resourceList = await tx
    .select()
    .from(resources)
    .where(eq(resources.workspaceId, workspaceId))
    .orderBy(asc(resources.name));
  const pipelineList = await tx
    .select({ id: pipelines.id, name: pipelines.name, archivedAt: pipelines.archivedAt })
    .from(pipelines)
    .where(eq(pipelines.workspaceId, workspaceId))
    .orderBy(asc(pipelines.position));
  const stageList = await tx
    .select({
      id: pipelineStages.id,
      pipelineId: pipelineStages.pipelineId,
      name: pipelineStages.name,
    })
    .from(pipelineStages)
    .where(eq(pipelineStages.workspaceId, workspaceId))
    .orderBy(asc(pipelineStages.position));
  const number = await defaultNumber(tx, workspaceId);
  const regs = await loadRegistrations(tx, workspaceId);
  // Whether a booking can take money at all: one live account is enough. The read runs as the caller, and
  // `payment_connections` is only readable with money.manage, so a member reading a calendar sees false —
  // which is right for them either way, since only owners and admins change these settings.
  // What the catalogue says a service costs, where a product prices it: the deposit rules read this, and a
  // member who may not see products simply gets the service's own "price shown".
  const productPrice = new Map<string, number>();
  for (const p of await inSavepoint(tx, (sp) =>
    rows<{ service_id: string; unit_price_cents: number }>(
      sp,
      sql`select service_id, unit_price_cents::float8 as unit_price_cents from app.products
          where workspace_id = ${workspaceId} and service_id is not null and archived_at is null
            and unit_price_cents > 0`,
    ),
  ).then((list) => list ?? []))
    productPrice.set(p.service_id, Math.round(Number(p.unit_price_cents)));

  const paid = await rows<{
    id: string;
    name: string | null;
    provider: string;
    is_default: boolean;
  }>(
    tx,
    sql`select id, coalesce(nullif(btrim(label), ''), display_name) as name,
          provider::text as provider, is_default
        from app.payment_connections
        where workspace_id = ${workspaceId} and status = 'active'
        order by is_default desc, connected_at, id`,
  );

  return {
    timeZone: opts.timeZone,
    team,
    services: serviceList.map((s) =>
      toCatalogService(s, staff, needs, hoursOf('service', s.id), productPrice.get(s.id)),
    ),
    resources: resourceList.map((r): CatalogResource => ({
      id: r.id,
      name: r.name,
      quantity: r.quantity,
      archived: r.archivedAt !== null,
      hours: hoursOf('resource', r.id),
    })),
    territories: await loadTerritories(tx, workspaceId),
    pipelines: pipelineList.map((p) => ({
      id: p.id,
      name: p.name,
      archived: p.archivedAt !== null,
      stages: stageList
        .filter((s) => s.pipelineId === p.id)
        .map((s) => ({ id: s.id, name: s.name, archived: false })),
    })),
    textingReady: readiness(number, regs).messagingReady,
    paymentsAvailable: paid.length > 0,
    businessDeposit: await businessDepositOf(tx, workspaceId),
    paymentAccounts: paid.map((p) => ({
      id: p.id,
      name: p.name ?? '',
      provider: p.provider,
      isDefault: p.is_default,
    })),
  };
}

// ---- Hours, time off, busy times and bookings ----

export interface ExceptionSpan extends Interval {
  readonly id: string;
  readonly scheduleId: string;
  readonly kind: 'unavailable' | 'available';
  readonly allDay: boolean;
  readonly note: string | null;
}

/** Open windows per schedule between two instants (Postgres's expansion, merged). */
export async function expandSchedules(
  tx: Tx,
  scheduleIds: readonly string[],
  span: Interval,
): Promise<Map<string, Interval[]>> {
  const map = new Map<string, Interval[]>(scheduleIds.map((id) => [id, []]));
  if (!scheduleIds.length) return map;
  const list = await rows<{ id: string; s: number; e: number }>(
    tx,
    sql`select x.id, ${epoch(sql`w.starts_at`)} as s, ${epoch(sql`w.ends_at`)} as e
        from unnest(${uuidArray(scheduleIds)}) as x(id)
        cross join lateral private.expand_schedule(x.id, ${tsParam(span.start)}, ${tsParam(span.end)}) w`,
  );
  for (const r of list) map.get(r.id)?.push({ start: r.s, end: r.e });
  for (const [id, windows] of map) map.set(id, normalize(windows));
  return map;
}

export async function loadExceptions(
  tx: Tx,
  scheduleIds: readonly string[],
  span: Interval,
): Promise<ExceptionSpan[]> {
  if (!scheduleIds.length) return [];
  const list = await rows<{
    id: string;
    schedule_id: string;
    kind: 'unavailable' | 'available';
    all_day: boolean;
    note: string | null;
    s: number;
    e: number;
  }>(
    tx,
    sql`select e.id, e.schedule_id, e.kind::text as kind, e.all_day, e.note,
          ${epoch(sql`e.starts_at`)} as s, ${epoch(sql`e.ends_at`)} as e
        from app.schedule_exceptions e
        where e.schedule_id = any(${uuidArray(scheduleIds)})
          and e.starts_at < ${tsParam(span.end)} and e.ends_at > ${tsParam(span.start)}
        order by e.starts_at, e.id`,
  );
  return list.map((r) => ({
    id: r.id,
    scheduleId: r.schedule_id,
    kind: r.kind,
    allDay: r.all_day,
    note: r.note,
    start: r.s,
    end: r.e,
  }));
}

export interface StaffBooking extends Booking {
  readonly appointmentId: string;
}

export interface StaffData {
  readonly userId: string;
  readonly scheduleId: string | null;
  readonly weekly: WeeklyHours;
  /** The zone their hours are in. */
  readonly timezone: string;
  /** No hours saved: DEFAULT_WEEKLY_HOURS apply. */
  readonly defaultHours: boolean;
  /** Open hours including extra-hours exceptions, merged. */
  readonly windows: Interval[];
  /** Time off (unavailable exceptions), merged. */
  readonly timeOff: Interval[];
  readonly exceptions: ExceptionSpan[];
  /** Busy times read from their Google or Outlook calendar (empty unless asked for). */
  readonly external: Interval[];
  readonly bookings: StaffBooking[];
}

export interface StaffLoadOptions {
  readonly workspaceZone: string;
  readonly includeExternal: boolean;
  readonly excludeAppointmentIds?: readonly string[];
}

export async function loadStaffData(
  tx: Tx,
  workspaceId: string,
  userIds: readonly string[],
  span: Interval,
  opts: StaffLoadOptions,
): Promise<Map<string, StaffData>> {
  const ids = unique(userIds);
  const out = new Map<string, StaffData>();
  if (!ids.length) return out;
  const scheds = await tx
    .select({
      id: schedules.id,
      ownerId: schedules.ownerId,
      timezone: schedules.timezone,
      weekly: schedules.weekly,
    })
    .from(schedules)
    .where(
      and(
        eq(schedules.workspaceId, workspaceId),
        eq(schedules.ownerKind, 'user'),
        inArray(schedules.ownerId, ids),
      ),
    );
  const windows = await expandSchedules(
    tx,
    scheds.map((s) => s.id),
    span,
  );
  const exceptions = await loadExceptions(
    tx,
    scheds.map((s) => s.id),
    span,
  );
  const busy = opts.includeExternal
    ? await rows<{ user_id: string; s: number; e: number }>(
        tx,
        sql`select b.user_id, ${epoch(sql`b.starts_at`)} as s, ${epoch(sql`b.ends_at`)} as e
            from app.calendar_busy_blocks b
            where b.workspace_id = ${workspaceId} and b.user_id = any(${uuidArray(ids)})
              and b.starts_at < ${tsParam(span.end)} and b.ends_at > ${tsParam(span.start)}`,
      )
    : [];
  // A left join: an appointment on a private record the caller can't see (sealed) still makes its staff busy.
  const bookings = await rows<{
    user_id: string;
    appointment_id: string;
    calendar_id: string | null;
    ds: number;
    de: number;
    bs: number;
    be: number;
  }>(
    tx,
    sql`select s.user_id, s.appointment_id, a.calendar_id,
          ${epoch(sql`lower(s.during)`)} as ds, ${epoch(sql`upper(s.during)`)} as de,
          ${epoch(sql`lower(s.blocked)`)} as bs, ${epoch(sql`upper(s.blocked)`)} as be
        from app.appointment_staff s left join app.appointments a on a.id = s.appointment_id
        where s.workspace_id = ${workspaceId} and s.active and s.user_id = any(${uuidArray(ids)})
          and s.blocked && ${tsRange(span)}
          and not (s.appointment_id = any(${uuidArray(opts.excludeAppointmentIds ?? [])}))`,
  );
  for (const userId of ids) {
    const sched = scheds.find((s) => s.ownerId === userId);
    const timezone = sched?.timezone ?? opts.workspaceZone;
    const own = exceptions.filter((e) => sched && e.scheduleId === sched.id);
    out.set(userId, {
      userId,
      scheduleId: sched?.id ?? null,
      weekly: sched?.weekly ?? DEFAULT_WEEKLY_HOURS,
      timezone,
      defaultHours: !sched,
      windows: sched
        ? (windows.get(sched.id) ?? [])
        : expandWeeklyHours(DEFAULT_WEEKLY_HOURS, span.start, span.end, timezone),
      timeOff: normalize(own.filter((e) => e.kind === 'unavailable')),
      exceptions: own,
      external: normalize(
        busy.filter((b) => b.user_id === userId).map((b) => ({ start: b.s, end: b.e })),
      ),
      bookings: bookings
        .filter((b) => b.user_id === userId)
        .map((b) => ({
          appointmentId: b.appointment_id,
          calendarId: b.calendar_id,
          during: { start: b.ds, end: b.de },
          blocked: { start: b.bs, end: b.be },
        })),
    });
  }
  return out;
}

export interface ResourceData {
  readonly resourceId: string;
  readonly name: string;
  readonly quantity: number;
  readonly archived: boolean;
  /** Resource hours minus closures; null means always open. */
  readonly windows: Interval[] | null;
  readonly bookings: (ResourceBooking & { readonly appointmentId: string })[];
}

/** Windows for one owner's schedule minus its closures, or null when it has no schedule. */
async function ownerWindows(
  tx: Tx,
  schedule: { id: string } | undefined,
  span: Interval,
): Promise<Interval[] | null> {
  if (!schedule) return null;
  const windows = (await expandSchedules(tx, [schedule.id], span)).get(schedule.id) ?? [];
  const closures = (await loadExceptions(tx, [schedule.id], span)).filter(
    (e) => e.kind === 'unavailable',
  );
  return subtract(windows, closures);
}

export async function loadResourceData(
  tx: Tx,
  workspaceId: string,
  resourceIds: readonly string[],
  span: Interval,
  excludeAppointmentIds: readonly string[] = [],
): Promise<Map<string, ResourceData>> {
  const ids = unique(resourceIds);
  const out = new Map<string, ResourceData>();
  if (!ids.length) return out;
  const list = await tx
    .select()
    .from(resources)
    .where(and(eq(resources.workspaceId, workspaceId), inArray(resources.id, ids)));
  const scheds = await tx
    .select({ id: schedules.id, ownerId: schedules.ownerId })
    .from(schedules)
    .where(
      and(
        eq(schedules.workspaceId, workspaceId),
        eq(schedules.ownerKind, 'resource'),
        inArray(schedules.ownerId, ids),
      ),
    );
  const bookings = await rows<{
    resource_id: string;
    appointment_id: string;
    calendar_id: string | null;
    quantity: number;
    ds: number;
    de: number;
    bs: number;
    be: number;
  }>(
    tx,
    sql`select r.resource_id, r.appointment_id, a.calendar_id, r.quantity,
          ${epoch(sql`lower(r.during)`)} as ds, ${epoch(sql`upper(r.during)`)} as de,
          ${epoch(sql`lower(r.blocked)`)} as bs, ${epoch(sql`upper(r.blocked)`)} as be
        from app.appointment_resources r left join app.appointments a on a.id = r.appointment_id
        where r.workspace_id = ${workspaceId} and r.active and r.resource_id = any(${uuidArray(ids)})
          and r.blocked && ${tsRange(span)}
          and not (r.appointment_id = any(${uuidArray(excludeAppointmentIds)}))`,
  );
  for (const r of list) {
    out.set(r.id, {
      resourceId: r.id,
      name: r.name,
      quantity: r.quantity,
      archived: r.archivedAt !== null,
      windows: await ownerWindows(
        tx,
        scheds.find((s) => s.ownerId === r.id),
        span,
      ),
      bookings: bookings
        .filter((b) => b.resource_id === r.id)
        .map((b) => ({
          appointmentId: b.appointment_id,
          calendarId: b.calendar_id,
          quantity: b.quantity,
          during: { start: b.ds, end: b.de },
          blocked: { start: b.bs, end: b.be },
        })),
    });
  }
  return out;
}

/** The calendar's or a service's hours layer (minus closures), or null when it has none. */
export async function loadLayerWindows(
  tx: Tx,
  workspaceId: string,
  ownerKind: 'calendar' | 'service',
  ownerId: string,
  span: Interval,
): Promise<Interval[] | null> {
  const [schedule] = await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(
      and(
        eq(schedules.workspaceId, workspaceId),
        eq(schedules.ownerKind, ownerKind),
        eq(schedules.ownerId, ownerId),
      ),
    );
  return ownerWindows(tx, schedule, span);
}

/** Sessions (sessions mode) or open group appointments (hours mode) starting in [from, to). */
export async function loadSessions(
  tx: Tx,
  calendarId: string,
  from: number,
  to: number,
  kind: 'session' | 'group',
  excludeAppointmentIds: readonly string[] = [],
): Promise<SessionInput[]> {
  const list = await rows<{
    id: string;
    s: number;
    e: number;
    capacity: number;
    seats_taken: number;
    service_id: string | null;
    user_ids: string[];
  }>(
    tx,
    sql`select a.id, ${epoch(sql`a.starts_at`)} as s, ${epoch(sql`a.ends_at`)} as e, a.capacity, a.seats_taken,
          a.service_id,
          coalesce((select json_agg(st.user_id order by st.user_id) from app.appointment_staff st
                    where st.appointment_id = a.id), '[]'::json) as user_ids
        from app.appointments a
        where a.calendar_id = ${calendarId} and a.status = 'scheduled'
          and a.starts_at >= ${tsParam(from)} and a.starts_at < ${tsParam(to)}
          and ${kind === 'session' ? sql`a.kind = 'session'` : sql`a.capacity > 1`}
          and not (a.id = any(${uuidArray(excludeAppointmentIds)}))
        order by a.starts_at, a.id`,
  );
  return list.map((r) => ({
    id: r.id,
    start: r.s,
    end: r.e,
    capacity: r.capacity,
    seatsTaken: r.seats_taken,
    userIds: r.user_ids,
    serviceId: r.service_id,
  }));
}

// ---- The engine's input ----

/**
 * The calendar's service for a request: the one asked for (it must be on the calendar), else the first
 * one when the calendar has services, else none.
 */
export async function resolveService(
  tx: Tx,
  calendar: LoadedCalendar,
  serviceId: string | null | undefined,
  config: CalendarConfig = calendar.config,
): Promise<CatalogService | null> {
  if (config.services.mode === 'none') {
    if (serviceId)
      throw HfosError.validation(
        [{ path: 'serviceId', message: 'This calendar doesn’t offer services. Leave it empty.' }],
        `${calendar.name} doesn’t offer services. Book it without picking one.`,
      );
    return null;
  }
  const id = serviceId ?? config.services.items[0]?.serviceId;
  if (!id) return null;
  if (!config.services.items.some((i) => i.serviceId === id))
    throw HfosError.validation(
      [
        {
          path: 'serviceId',
          message: 'This calendar doesn’t offer that service. Pick one it offers.',
        },
      ],
      `${calendar.name} doesn’t offer that service. Pick one of the services it offers.`,
    );
  const service = await loadCatalogService(tx, calendar.workspaceId, id);
  if (!service) throw HfosError.notFound('That service isn’t offered anymore. Pick another one.');
  return service;
}

export interface SlotRequest {
  /** Start times from `from` (inclusive) to `to` (exclusive). */
  readonly from: number;
  readonly to: number;
  readonly serviceId?: string | null;
  readonly durationMinutes?: number;
  readonly partySize?: number;
  readonly postalCode?: string | null;
  /** M18: where the customer's address is, for distance and drawn service areas. */
  readonly point?: GeoPoint | null;
  readonly chosenUserId?: string | null;
  /** undefined: the calendar's first location. */
  readonly locationKind?: LocationKind | null;
  /** Leave these appointments out (the one being moved). */
  readonly excludeAppointmentIds?: readonly string[];
}

export interface SlotLoadOptions {
  readonly now?: number;
  /** An already resolved service (skips resolveService). */
  readonly service?: CatalogService | null;
  /** More people to load than the calendar's team (staff picked by hand). */
  readonly extraUserIds?: readonly string[];
  /** More resources to load than the terms need (an appointment's own). */
  readonly extraResourceIds?: readonly string[];
}

export interface LoadedSlots {
  readonly input: SlotInput;
  readonly calendar: LoadedCalendar;
  readonly config: CalendarConfig;
  readonly service: CatalogService | null;
  readonly terms: Terms;
  readonly durationMinutes: number;
  readonly locationKind: LocationKind | null;
  /** Minutes around the visit, travel included. */
  readonly bufferBefore: number;
  readonly bufferAfter: number;
  readonly staff: ReadonlyMap<string, StaffData>;
  readonly resources: ReadonlyMap<string, ResourceData>;
  readonly calendarWindows: Interval[] | null;
  readonly serviceWindows: Interval[] | null;
  /** What was read: a local day of slack on each side, plus the visit's length and buffers. */
  readonly span: Interval;
}

/**
 * Reads everything the engine needs for one request on fresh data: the calendar and service hours layers,
 * each person's hours, time off, busy times (only when the calendar checks staff calendars) and bookings,
 * the resources with their bookings, sessions to join and the workspace's territories. Bookings are read
 * over the requested days padded by the visit's length, buffers and travel, whole local days, so buffers
 * and daily limits see everything that matters.
 */
export async function loadSlotInput(
  tx: Tx,
  calendar: LoadedCalendar,
  req: SlotRequest,
  opts: SlotLoadOptions = {},
): Promise<LoadedSlots> {
  if (!(req.to > req.from))
    throw HfosError.validation([{ path: 'to', message: 'End after the start.' }]);
  if (req.to - req.from > MAX_RANGE_DAYS * DAY)
    throw HfosError.validation([{ path: 'to', message: 'Ask for 62 days or fewer.' }]);
  const config = calendar.config;
  const service =
    opts.service !== undefined ? opts.service : await resolveService(tx, calendar, req.serviceId);
  const terms = resolveTerms(config, service);
  const durationMinutes = req.durationMinutes ?? bookableDurations(config, service)[0] ?? 60;
  const locationKind =
    req.locationKind === undefined ? defaultLocationKind(config) : req.locationKind;
  const travel = locationKind === 'customer_address' ? terms.travelMinutes : 0;
  const bufferBefore = terms.bufferBefore + travel;
  const bufferAfter = terms.bufferAfter + travel;
  const tz = calendar.timeZone;
  const span: Interval = {
    start: startOfLocalDay(addDays(localDateOf(req.from, tz), -1), tz) - bufferBefore * MIN,
    end:
      startOfLocalDay(addDays(localDateOf(req.to, tz), 2), tz) +
      (durationMinutes + bufferAfter) * MIN,
  };
  const now = opts.now ?? (await dbNow(tx));
  const exclude = req.excludeAppointmentIds ?? [];
  const zone = await workspaceZone(tx, calendar.workspaceId);
  // With no staff the team is ignored: only people asked for by name (an appointment's own) are read.
  const none = config.team.assignment === 'none';
  const userIds = unique([
    ...(none ? [] : config.team.members.map((m) => m.userId)),
    ...(opts.extraUserIds ?? []),
    ...(req.chosenUserId && !none ? [req.chosenUserId] : []),
  ]);
  const staff = await loadStaffData(tx, calendar.workspaceId, userIds, span, {
    workspaceZone: zone,
    includeExternal: config.integrations.checkStaffCalendars,
    excludeAppointmentIds: exclude,
  });
  const resourceData = await loadResourceData(
    tx,
    calendar.workspaceId,
    unique([...terms.requiredResources.map((r) => r.resourceId), ...(opts.extraResourceIds ?? [])]),
    span,
    exclude,
  );
  let calendarWindows: Interval[] | null = null;
  if (config.schedule.hours) {
    calendarWindows = await loadLayerWindows(
      tx,
      calendar.workspaceId,
      'calendar',
      calendar.id,
      span,
    );
    // The save command mirrors the hours into a schedule row; read the settings if it is missing.
    calendarWindows ??= expandWeeklyHours(config.schedule.hours, span.start, span.end, tz);
  }
  const serviceWindows = service
    ? await loadLayerWindows(tx, calendar.workspaceId, 'service', service.id, span)
    : null;
  const sessionKind = config.schedule.mode === 'sessions' ? 'session' : 'group';
  const sessions =
    sessionKind === 'session' || terms.seats > 1
      ? await loadSessions(tx, calendar.id, req.from, req.to, sessionKind, exclude)
      : [];
  const territoryList =
    config.territory.routing === 'zip' ? await loadTerritories(tx, calendar.workspaceId) : [];

  const input: SlotInput = {
    config,
    calendarId: calendar.id,
    timeZone: tz,
    now,
    from: req.from,
    to: req.to,
    service,
    durationMinutes,
    partySize: req.partySize ?? 1,
    locationKind,
    postalCode: req.postalCode ?? null,
    point: req.point ?? null,
    chosenUserId: req.chosenUserId ?? null,
    calendarWindows,
    serviceWindows,
    staff: [...staff.values()].map((s) => ({
      userId: s.userId,
      windows: s.windows,
      busy: normalize([...s.timeOff, ...s.external]),
      bookings: s.bookings,
    })),
    resources: [...resourceData.values()].map((r) => ({
      resourceId: r.resourceId,
      quantity: r.archived ? 0 : r.quantity,
      windows: r.windows,
      bookings: r.bookings,
    })),
    sessions,
    territories: territoryList,
  };
  return {
    input,
    calendar,
    config,
    service,
    terms,
    durationMinutes,
    locationKind,
    bufferBefore,
    bufferAfter,
    staff,
    resources: resourceData,
    calendarWindows,
    serviceWindows,
    span,
  };
}

// ---- Upcoming appointments (impact analysis) ----

/** Future scheduled appointments on a calendar: per person, per resource, and group sessions' seats. */
export async function loadUpcomingSummary(
  tx: Tx,
  calendarId: string,
  now: number,
): Promise<UpcomingSummary> {
  const members = await rows<{ user_id: string; n: number }>(
    tx,
    sql`select s.user_id, count(*)::int as n
        from app.appointment_staff s join app.appointments a on a.id = s.appointment_id
        where a.calendar_id = ${calendarId} and a.status = 'scheduled' and a.starts_at > ${tsParam(now)}
        group by s.user_id`,
  );
  const needs = await rows<{ resource_id: string; n: number }>(
    tx,
    sql`select r.resource_id, count(*)::int as n
        from app.appointment_resources r join app.appointments a on a.id = r.appointment_id
        where a.calendar_id = ${calendarId} and a.status = 'scheduled' and a.starts_at > ${tsParam(now)}
        group by r.resource_id`,
  );
  const sessions = await rows<{ id: string; seats_taken: number; service_id: string | null }>(
    tx,
    sql`select a.id, a.seats_taken, a.service_id from app.appointments a
        where a.calendar_id = ${calendarId} and a.status = 'scheduled' and a.starts_at > ${tsParam(now)}
          and (a.kind = 'session' or a.capacity > 1)`,
  );
  return {
    members: members.map((m) => ({ userId: m.user_id, appointments: m.n })),
    resources: needs.map((r) => ({ resourceId: r.resource_id, appointments: r.n })),
    sessions: sessions.map((s) => ({
      appointmentId: s.id,
      seatsBooked: s.seats_taken,
      serviceId: s.service_id,
    })),
  };
}

/** Future scheduled appointments on a calendar that a person works or a resource is on, soonest first. */
export async function upcomingAppointmentIds(
  tx: Tx,
  calendarId: string,
  now: number,
  by: { readonly userId?: string; readonly resourceId?: string },
): Promise<string[]> {
  const join = by.userId
    ? sql`join app.appointment_staff x on x.appointment_id = a.id and x.user_id = ${by.userId}`
    : sql`join app.appointment_resources x on x.appointment_id = a.id and x.resource_id = ${by.resourceId ?? null}`;
  const list = await rows<{ id: string }>(
    tx,
    sql`select a.id from app.appointments a ${join}
        where a.calendar_id = ${calendarId} and a.status = 'scheduled' and a.starts_at > ${tsParam(now)}
        order by a.starts_at, a.id`,
  );
  return list.map((r) => r.id);
}

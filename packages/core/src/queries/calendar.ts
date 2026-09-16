/**
 * Calendar reads: calendars (with settings, labels, conflicts computed now and revisions), open times (the
 * booking page's system actor may ask too), appointments, the team's hours and the catalogs.
 */
import { and, asc, desc, eq, gt, inArray, lt, ne, sql as dsql, type SQL } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  appointmentAttendees,
  appointmentResources,
  appointments,
  appointmentSeries,
  appointmentStaff,
  bookingSites,
  calendarConnections,
  calendarRevisions,
  calendars,
  people,
  resources,
  schedules,
  serviceResources,
  services,
  serviceStaff,
  waitlistEntries,
  workspaceMemberships,
} from '@hfos/db/schema';
import { assertTeammateCalendar } from '../ai-team/reach';
import { aiEmployeeOf } from '../kernel/actor';
import { slotOut } from '../calendar/booking';
import { parseConfig } from '../calendar/config';
import { DEPOSIT_HOLD_MS } from '../calendar/deposit';
import { computeSlots } from '../calendar/engine/slots';
import {
  dbNow,
  iso,
  loadCalendar,
  loadCatalogs,
  loadSlotInput,
  loadStaffData,
  loadTerritories,
  resolveService,
  userNames,
  uuidArray,
  workspaceZone,
} from '../calendar/load';
import { parseReminderState } from '../calendar/reminders';
import { validateCalendar } from '../calendar/rules';
import { resolveTerms } from '../calendar/terms';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import {
  AppointmentGetInput,
  AppointmentGetOutput,
  AppointmentListInput,
  AppointmentListOutput,
  BookingSiteGetInput,
  BookingSiteGetOutput,
  CalendarAvailabilityInput,
  CalendarAvailabilityOutput,
  CalendarConnectionListInput,
  CalendarConnectionListOutput,
  CalendarGetInput,
  CalendarGetOutput,
  CalendarListInput,
  CalendarListOutput,
  ResourceListInput,
  ResourceListOutput,
  ScheduleTeamInput,
  ScheduleTeamOutput,
  ServiceListInput,
  ServiceListOutput,
  TerritoryListInput,
  TerritoryListOutput,
  type AppointmentOut,
  type CalendarSummary,
} from '../schemas/calendar';

const DAY = 86_400_000;
const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

function rangeOf(input: { from: string; to: string }): { from: number; to: number } {
  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  if (!(to > from)) throw HfosError.validation([{ path: 'to', message: 'End after the start.' }]);
  if (to - from > 62 * DAY)
    throw HfosError.validation([{ path: 'to', message: 'Ask for 62 days or fewer.' }]);
  return { from, to };
}

async function siteOf(tx: Tx, workspaceId: string) {
  const [site] = await tx
    .select()
    .from(bookingSites)
    .where(eq(bookingSites.workspaceId, workspaceId));
  return site ?? null;
}

const labelsOut = (tags: readonly string[]) => ({
  primary: tags[0] ?? 'custom',
  tags: tags.length ? [...tags] : ['custom'],
});

function summary(
  row: typeof calendars.$inferSelect,
  zone: string,
  site: { slug: string } | null,
  upcoming: ReadonlyMap<string, number>,
): CalendarSummary {
  const config = parseConfig(row.config);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    slug: row.slug,
    status: row.status,
    public: row.public,
    labels: labelsOut(row.labels),
    revision: row.revision,
    timezone: row.timezone ?? zone,
    ownerUserId: row.ownerUserId,
    memberIds: config.team.members.map((m) => m.userId),
    bookingPath: site ? `/book/${site.slug}/${row.slug}` : null,
    permanentPath: `/book/c/${row.id}`,
    upcomingCount: upcoming.get(row.id) ?? 0,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function upcomingCounts(tx: Tx, workspaceId: string): Promise<Map<string, number>> {
  const list = await rows<{ calendar_id: string; n: number }>(
    tx,
    sql`select calendar_id, count(*)::int as n from app.appointments
        where workspace_id = ${workspaceId} and status = 'scheduled'
          and starts_at >= now() and starts_at < now() + interval '7 days'
        group by calendar_id`,
  );
  return new Map(list.map((r) => [r.calendar_id, r.n]));
}

export const calendarList = defineQuery({
  name: 'calendar.list',
  description: 'Every calendar with its labels, link, status and next-7-days count.',
  input: CalendarListInput,
  output: CalendarListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const list = await ctx.tx
      .select()
      .from(calendars)
      .where(
        and(
          eq(calendars.workspaceId, ws),
          input.includeArchived ? undefined : ne(calendars.status, 'archived'),
        ),
      )
      .orderBy(asc(calendars.name), asc(calendars.id));
    const zone = await workspaceZone(ctx.tx, ws);
    const site = await siteOf(ctx.tx, ws);
    const counts = await upcomingCounts(ctx.tx, ws);
    return {
      items: list.map((c) => summary(c, zone, site, counts)),
      site: site ? { id: site.id, slug: site.slug, enabled: site.enabled } : null,
    };
  },
});

export const calendarGet = defineQuery({
  name: 'calendar.get',
  description:
    'One calendar: its settings, labels, the conflicts in them (computed now), recent revisions and links.',
  input: CalendarGetInput,
  output: CalendarGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const calendar = await loadCalendar(ctx.tx, ws, input.calendarId);
    const [row] = await ctx.tx.select().from(calendars).where(eq(calendars.id, calendar.id));
    const zone = await workspaceZone(ctx.tx, ws);
    const site = await siteOf(ctx.tx, ws);
    const catalogs = await loadCatalogs(ctx.tx, ws, {
      timeZone: calendar.timeZone,
      extraUserIds: calendar.config.team.members.map((m) => m.userId),
    });
    const issues = validateCalendar(calendar.config, catalogs, await dbNow(ctx.tx));
    const revisions = await ctx.tx
      .select()
      .from(calendarRevisions)
      .where(eq(calendarRevisions.calendarId, calendar.id))
      .orderBy(desc(calendarRevisions.revision))
      .limit(50);
    const names = await userNames(
      ctx.tx,
      revisions.map((r) => r.changedBy).filter((u): u is string => !!u),
    );
    return {
      calendar: {
        ...summary(row!, zone, site, await upcomingCounts(ctx.tx, ws)),
        config: calendar.config,
        ownTimezone: calendar.ownTimezone,
        issues,
      },
      revisions: revisions.map((r) => ({
        revision: r.revision,
        labels: r.labels,
        diff: (r.diffSummary as unknown[]).map(String),
        changedBy: r.changedBy
          ? { id: r.changedBy, fullName: names.get(r.changedBy) ?? 'Someone' }
          : null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
});

export const calendarAvailability = defineQuery({
  name: 'calendar.availability',
  description:
    'Open times on a calendar between two instants (at most 62 days), for a service, length, party size, ZIP or chosen person. The booking page asks as the system.',
  input: CalendarAvailabilityInput,
  output: CalendarAvailabilityOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  // The AI teammate asks too, on its own calendars only.
  actors: ['human', 'system', 'ai_employee'],
  async handler(ctx, input) {
    const ai = aiEmployeeOf(ctx.actor);
    if (ai) await assertTeammateCalendar(ctx.tx, ai, input.calendarId);
    const calendar = await loadCalendar(ctx.tx, input.workspaceId, input.calendarId);
    const { from, to } = rangeOf(input);
    const service = await resolveService(ctx.tx, calendar, input.serviceId);
    if (
      input.durationMinutes !== undefined &&
      !resolveTerms(calendar.config, service).durations.includes(input.durationMinutes)
    )
      throw HfosError.validation([
        { path: 'durationMinutes', message: 'Pick one of the calendar’s lengths.' },
      ]);
    const loaded = await loadSlotInput(
      ctx.tx,
      calendar,
      {
        from,
        to,
        serviceId: service?.id ?? null,
        durationMinutes: input.durationMinutes,
        partySize: input.partySize,
        postalCode: input.postalCode ?? null,
        chosenUserId: input.chosenUserId ?? null,
        locationKind: input.locationKind,
      },
      { service },
    );
    return {
      calendarId: calendar.id,
      timezone: calendar.timeZone,
      serviceId: service?.id ?? null,
      durationMinutes: loaded.durationMinutes,
      slots: computeSlots(loaded.input).map(slotOut),
    };
  },
});

// ---- Appointments ----

/**
 * The seats that are only **held** while a customer pays a deposit, and when each hold runs out.
 *
 * A held seat is a real appointment on a real slot; what makes it a hold rather than a booking is that
 * nothing was announced and **its deposit invoice is still a draft** (`booking.confirm_deposit` issues that
 * invoice the moment the money is in hand, and `booking.release_hold` withdraws it when nobody pays). So the
 * draft is the hold, and the hold runs out `DEPOSIT_HOLD_MINUTES` after it was raised — the same moment the
 * expiry job is set for. The job itself is the worker's alone (`app.scheduled_jobs` is granted to the service
 * actor and nobody else), which is why this reads the invoice instead.
 */
async function holdsFor(
  tx: Tx,
  workspaceId: string,
  attendeeIds: readonly string[],
): Promise<Map<string, string>> {
  if (!attendeeIds.length) return new Map();
  const held = await rows<{ attendee_id: string; created_at: Date | string }>(
    tx,
    sql`select attendee_id, created_at from app.invoices
        where workspace_id = ${workspaceId} and origin = 'booking' and status = 'draft'
          and attendee_id = any(${uuidArray(attendeeIds)})`,
  );
  return new Map(
    held.map((h) => [
      h.attendee_id,
      new Date(new Date(h.created_at).getTime() + DEPOSIT_HOLD_MS).toISOString(),
    ]),
  );
}

/** The first of a set of hold expiries, so an appointment says the soonest its seats could go. */
const soonest = (times: readonly (string | null)[]): string | null =>
  times.filter((t): t is string => !!t).sort()[0] ?? null;

/**
 * What a visit costs, as the catalogue has it: the product a service is priced by if there is one (the money
 * side of the same thing), else the service's own price shown. The booking page's deposit is worked out from
 * exactly this, so the sheet's "left after the visit" and the customer's "due after the visit" agree.
 */
async function visitPrice(
  tx: Tx,
  workspaceId: string,
  serviceId: string | null,
): Promise<number | null> {
  if (!serviceId) return null;
  const [row] = await rows<{ service_price: number | null; product_price: number | null }>(
    tx,
    sql`select s.price_cents::float8 as service_price, p.unit_price_cents::float8 as product_price
        from app.services s
        left join app.products p
          on p.service_id = s.id and p.workspace_id = s.workspace_id and p.archived_at is null
        where s.id = ${serviceId} and s.workspace_id = ${workspaceId}
        limit 1`,
  );
  if (!row) return null;
  const priced = row.product_price !== null && Number(row.product_price) > 0;
  const cents = Math.round(Number(priced ? row.product_price : row.service_price) || 0);
  return cents > 0 ? cents : null;
}

async function appointmentCards(
  tx: Tx,
  workspaceId: string,
  conditions: SQL[],
  limit = 2000,
): Promise<AppointmentOut[]> {
  const list = await tx
    .select({
      a: appointments,
      calendarName: calendars.name,
      calendarColor: calendars.color,
      serviceName: services.name,
    })
    .from(appointments)
    .innerJoin(calendars, eq(calendars.id, appointments.calendarId))
    .leftJoin(services, eq(services.id, appointments.serviceId))
    .where(and(eq(appointments.workspaceId, workspaceId), ...conditions))
    .orderBy(asc(appointments.startsAt), asc(appointments.id))
    .limit(limit);
  const ids = list.map((r) => r.a.id);
  if (!ids.length) return [];
  const staff = await tx
    .select({
      appointmentId: appointmentStaff.appointmentId,
      userId: appointmentStaff.userId,
      role: appointmentStaff.role,
    })
    .from(appointmentStaff)
    .where(inArray(appointmentStaff.appointmentId, ids));
  const names = await userNames(
    tx,
    staff.map((s) => s.userId),
  );
  const needs = await tx
    .select({
      appointmentId: appointmentResources.appointmentId,
      resourceId: appointmentResources.resourceId,
      quantity: appointmentResources.quantity,
      name: resources.name,
    })
    .from(appointmentResources)
    .innerJoin(resources, eq(resources.id, appointmentResources.resourceId))
    .where(inArray(appointmentResources.appointmentId, ids));
  const attendees = await tx
    .select({
      id: appointmentAttendees.id,
      appointmentId: appointmentAttendees.appointmentId,
      personId: appointmentAttendees.personId,
      status: appointmentAttendees.status,
      seats: appointmentAttendees.seats,
      confirmedAt: appointmentAttendees.confirmedAt,
      confirmedVia: appointmentAttendees.confirmedVia,
      confirmedBy: appointmentAttendees.confirmedBy,
      confirmAskedAt: appointmentAttendees.confirmAskedAt,
      firstName: people.firstName,
      lastName: people.lastName,
    })
    .from(appointmentAttendees)
    .innerJoin(people, eq(people.id, appointmentAttendees.personId))
    .where(inArray(appointmentAttendees.appointmentId, ids))
    .orderBy(asc(appointmentAttendees.createdAt), asc(appointmentAttendees.id));
  // Who marked a booking confirmed for the customer (staff marks only).
  const confirmers = await userNames(
    tx,
    attendees.flatMap((p) => (p.confirmedBy ? [p.confirmedBy] : [])),
  );
  const holds = await holdsFor(
    tx,
    workspaceId,
    attendees.map((p) => p.id),
  );
  return list.map(({ a, calendarName, calendarColor, serviceName }) => ({
    id: a.id,
    calendar: { id: a.calendarId, name: calendarName, color: calendarColor },
    service: a.serviceId && serviceName ? { id: a.serviceId, name: serviceName } : null,
    kind: a.kind,
    title: a.title,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    bufferBefore: a.bufferBefore,
    bufferAfter: a.bufferAfter,
    capacity: a.capacity,
    seatsTaken: a.seatsTaken,
    status: a.status,
    location: a.location as AppointmentOut['location'],
    seriesId: a.seriesId,
    occurrence: a.occurrence,
    source: a.source,
    leadId: a.leadId,
    notes: a.notes,
    staff: staff
      .filter((s) => s.appointmentId === a.id)
      .sort((x, y) =>
        x.role === y.role ? x.userId.localeCompare(y.userId) : x.role === 'host' ? -1 : 1,
      )
      .map((s) => ({ userId: s.userId, fullName: names.get(s.userId) ?? 'Someone', role: s.role })),
    resources: needs
      .filter((n) => n.appointmentId === a.id)
      .map((n) => ({ resourceId: n.resourceId, name: n.name, quantity: n.quantity })),
    attendees: attendees
      .filter((p) => p.appointmentId === a.id)
      .map((p) => ({
        id: p.id,
        personId: p.personId,
        fullName: `${p.firstName} ${p.lastName}`.trim() || 'Customer',
        status: p.status,
        seats: p.seats,
        confirmedAt: p.confirmedAt?.toISOString() ?? null,
        confirmedVia: (p.confirmedVia as 'sms' | 'link' | 'staff' | 'ai' | null) ?? null,
        confirmedBy: p.confirmedBy
          ? { id: p.confirmedBy, fullName: confirmers.get(p.confirmedBy) ?? 'Someone' }
          : null,
        confirmAskedAt: p.confirmAskedAt?.toISOString() ?? null,
        heldUntil: holds.get(p.id) ?? null,
      })),
    heldUntil: soonest(
      attendees
        .filter((p) => p.appointmentId === a.id && p.status !== 'cancelled')
        .map((p) => holds.get(p.id) ?? null),
    ),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }));
}

export const appointmentList = defineQuery({
  name: 'appointment.list',
  description:
    'Appointments overlapping a range (at most 62 days), by people, resources, calendars, status or customer. Cancelled ones only when asked.',
  input: AppointmentListInput,
  output: AppointmentListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const { from, to } = rangeOf(input);
    const conditions: SQL[] = [
      lt(appointments.startsAt, new Date(to)),
      gt(appointments.endsAt, new Date(from)),
    ];
    if (input.calendarIds?.length)
      conditions.push(inArray(appointments.calendarId, input.calendarIds));
    conditions.push(
      input.status?.length
        ? inArray(appointments.status, input.status)
        : ne(appointments.status, 'cancelled'),
    );
    if (input.userIds?.length)
      conditions.push(
        dsql`exists (select 1 from app.appointment_staff s where s.appointment_id = ${appointments.id}
               and s.user_id = any(${uuidArray(input.userIds)}))`,
      );
    if (input.resourceIds?.length)
      conditions.push(
        dsql`exists (select 1 from app.appointment_resources r where r.appointment_id = ${appointments.id}
               and r.resource_id = any(${uuidArray(input.resourceIds)}))`,
      );
    if (input.personId)
      conditions.push(
        dsql`exists (select 1 from app.appointment_attendees p where p.appointment_id = ${appointments.id}
               and p.person_id = ${input.personId})`,
      );
    return {
      timezone: await workspaceZone(ctx.tx, input.workspaceId),
      items: await appointmentCards(ctx.tx, input.workspaceId, conditions),
    };
  },
});

export const appointmentGet = defineQuery({
  name: 'appointment.get',
  description:
    'One appointment with its people, resources, customers (contact, intake, reminders), series and waitlist.',
  input: AppointmentGetInput,
  output: AppointmentGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [card] = await appointmentCards(ctx.tx, input.workspaceId, [
      eq(appointments.id, input.appointmentId),
    ]);
    if (!card) throw HfosError.notFound('Appointment not found.');
    const [row] = await ctx.tx
      .select({
        calendarRevision: appointments.calendarRevision,
        createdBy: appointments.createdBy,
      })
      .from(appointments)
      .where(eq(appointments.id, card.id));
    const attendees = await ctx.tx
      .select({ a: appointmentAttendees, firstName: people.firstName, lastName: people.lastName })
      .from(appointmentAttendees)
      .innerJoin(people, eq(people.id, appointmentAttendees.personId))
      .where(eq(appointmentAttendees.appointmentId, card.id))
      .orderBy(asc(appointmentAttendees.createdAt), asc(appointmentAttendees.id));
    const [series] = card.seriesId
      ? await ctx.tx
          .select({ id: appointmentSeries.id, rule: appointmentSeries.rule })
          .from(appointmentSeries)
          .where(eq(appointmentSeries.id, card.seriesId))
      : [];
    const waitlist = await ctx.tx
      .select({
        id: waitlistEntries.id,
        personId: waitlistEntries.personId,
        seats: waitlistEntries.seats,
        status: waitlistEntries.status,
        position: waitlistEntries.position,
        firstName: people.firstName,
        lastName: people.lastName,
      })
      .from(waitlistEntries)
      .innerJoin(people, eq(people.id, waitlistEntries.personId))
      .where(
        and(
          eq(waitlistEntries.appointmentId, card.id),
          inArray(waitlistEntries.status, ['waiting', 'offered']),
        ),
      )
      .orderBy(asc(waitlistEntries.position), asc(waitlistEntries.createdAt));
    const creator = row?.createdBy
      ? {
          id: row.createdBy,
          fullName: (await userNames(ctx.tx, [row.createdBy])).get(row.createdBy)!,
        }
      : null;
    // Who marked a booking confirmed for the customer (staff marks only).
    const confirmers = await userNames(
      ctx.tx,
      attendees.flatMap(({ a }) => (a.confirmedBy ? [a.confirmedBy] : [])),
    );
    // Every seat here, not only the booked ones the card counted, so a cancelled seat reads as cancelled.
    const holds = await holdsFor(
      ctx.tx,
      input.workspaceId,
      attendees.map(({ a }) => a.id),
    );
    return {
      appointment: {
        ...card,
        calendarRevision: row!.calendarRevision,
        priceCents: await visitPrice(ctx.tx, input.workspaceId, card.service?.id ?? null),
        attendees: attendees.map(({ a, firstName, lastName }) => ({
          id: a.id,
          personId: a.personId,
          fullName: `${firstName} ${lastName}`.trim() || 'Customer',
          status: a.status,
          seats: a.seats,
          contactPhone: a.contactPhoneE164,
          contactEmail: a.contactEmail,
          smsOk: a.smsOk,
          intake: a.intake,
          source: a.source,
          rescheduleCount: a.rescheduleCount,
          cancelledAt: a.cancelledAt?.toISOString() ?? null,
          reminders: parseReminderState(a.reminderState),
          confirmedAt: a.confirmedAt?.toISOString() ?? null,
          confirmedVia: (a.confirmedVia as 'sms' | 'link' | 'staff' | 'ai' | null) ?? null,
          confirmedBy: a.confirmedBy
            ? { id: a.confirmedBy, fullName: confirmers.get(a.confirmedBy) ?? 'Someone' }
            : null,
          confirmAskedAt: a.confirmAskedAt?.toISOString() ?? null,
          heldUntil: holds.get(a.id) ?? null,
        })),
        series: series ? { id: series.id, rule: series.rule } : null,
        waitlist: waitlist.map((w) => ({
          id: w.id,
          personId: w.personId,
          fullName: `${w.firstName} ${w.lastName}`.trim() || 'Customer',
          seats: w.seats,
          status: w.status,
          position: w.position,
        })),
        createdBy: creator,
      },
    };
  },
});

// ---- People's hours ----

const connectionColumns = {
  id: calendarConnections.id,
  userId: calendarConnections.userId,
  provider: calendarConnections.provider,
  status: calendarConnections.status,
  accountEmail: calendarConnections.accountEmail,
  scopes: calendarConnections.scopes,
  busySyncedAt: calendarConnections.busySyncedAt,
  nextSyncAt: calendarConnections.nextSyncAt,
  failures: calendarConnections.failures,
  lastError: calendarConnections.lastError,
  connectedAt: calendarConnections.connectedAt,
  disconnectedAt: calendarConnections.disconnectedAt,
  createdAt: calendarConnections.createdAt,
};

type ConnectionRow = {
  [K in keyof typeof connectionColumns]: (typeof calendarConnections.$inferSelect)[K];
};

const connectionOut = (c: ConnectionRow, fullName: string) => ({
  id: c.id,
  userId: c.userId,
  fullName,
  provider: c.provider,
  status: c.status,
  accountEmail: c.accountEmail,
  scopes: c.scopes,
  busySyncedAt: c.busySyncedAt?.toISOString() ?? null,
  nextSyncAt: c.nextSyncAt?.toISOString() ?? null,
  failures: c.failures,
  lastError: c.lastError,
  connectedAt: c.connectedAt?.toISOString() ?? null,
  disconnectedAt: c.disconnectedAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
});

export const scheduleTeam = defineQuery({
  name: 'schedule.team',
  description:
    'Each person’s open hours, time off and busy times between two instants (at most 62 days), with their calendar connection.',
  input: ScheduleTeamInput,
  output: ScheduleTeamOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const { from, to } = rangeOf(input);
    const zone = await workspaceZone(ctx.tx, ws);
    const ids =
      input.userIds ??
      (
        await ctx.tx
          .select({ userId: workspaceMemberships.userId })
          .from(workspaceMemberships)
          .where(eq(workspaceMemberships.workspaceId, ws))
          .orderBy(asc(workspaceMemberships.createdAt))
      ).map((m) => m.userId);
    const staff = await loadStaffData(
      ctx.tx,
      ws,
      ids,
      { start: from, end: to },
      { workspaceZone: zone, includeExternal: true },
    );
    const names = await userNames(ctx.tx, ids);
    const conns = ids.length
      ? await ctx.tx
          .select(connectionColumns)
          .from(calendarConnections)
          .where(
            and(
              eq(calendarConnections.workspaceId, ws),
              inArray(calendarConnections.userId, ids),
              ne(calendarConnections.status, 'disconnected'),
            ),
          )
          .orderBy(desc(calendarConnections.createdAt))
      : [];
    const span = (i: { start: number; end: number }) => ({
      startsAt: iso(i.start),
      endsAt: iso(i.end),
    });
    return {
      timezone: zone,
      people: [...new Set(ids)].map((userId) => {
        const s = staff.get(userId)!;
        const conn = conns.find((c) => c.userId === userId);
        const fullName = names.get(userId) ?? 'Someone';
        return {
          userId,
          fullName,
          scheduleId: s.scheduleId,
          timezone: s.timezone,
          weekly: s.weekly,
          defaultHours: s.defaultHours,
          hours: s.windows.map(span),
          timeOff: s.exceptions.map((e) => ({
            ...span(e),
            id: e.id,
            kind: e.kind,
            allDay: e.allDay,
            note: e.note,
          })),
          busy: s.external.map(span),
          connection: conn ? connectionOut(conn, fullName) : null,
        };
      }),
    };
  },
});

export const calendarConnectionList = defineQuery({
  name: 'calendar_connection.list',
  description:
    'Google or Outlook calendar connections: your own, or everyone’s for owners and admins.',
  input: CalendarConnectionListInput,
  output: CalendarConnectionListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const conditions: SQL[] = [eq(calendarConnections.workspaceId, input.workspaceId)];
    if (input.userId) conditions.push(eq(calendarConnections.userId, input.userId));
    if (!input.includeDisconnected) conditions.push(ne(calendarConnections.status, 'disconnected'));
    // Row-level security shows people their own; owners and admins see everyone's.
    const list = await ctx.tx
      .select(connectionColumns)
      .from(calendarConnections)
      .where(and(...conditions))
      .orderBy(desc(calendarConnections.createdAt));
    const names = await userNames(
      ctx.tx,
      list.map((c) => c.userId),
    );
    return { items: list.map((c) => connectionOut(c, names.get(c.userId) ?? 'Someone')) };
  },
});

// ---- Catalogs ----

export const serviceList = defineQuery({
  name: 'service.list',
  description: 'The workspace’s services with their lengths, buffers, staff, resources and hours.',
  input: ServiceListInput,
  output: ServiceListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const list = await ctx.tx
      .select()
      .from(services)
      .where(eq(services.workspaceId, ws))
      .orderBy(asc(services.name));
    const staff = await ctx.tx
      .select({ serviceId: serviceStaff.serviceId, userId: serviceStaff.userId })
      .from(serviceStaff)
      .where(eq(serviceStaff.workspaceId, ws));
    const needs = await ctx.tx
      .select({
        serviceId: serviceResources.serviceId,
        resourceId: serviceResources.resourceId,
        quantity: serviceResources.quantity,
      })
      .from(serviceResources)
      .where(eq(serviceResources.workspaceId, ws));
    const hours = await ctx.tx
      .select({ ownerId: schedules.ownerId, weekly: schedules.weekly })
      .from(schedules)
      .where(and(eq(schedules.workspaceId, ws), eq(schedules.ownerKind, 'service')));
    return {
      items: list
        .filter((s) => input.includeArchived || !s.archivedAt)
        .map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          durations: s.durations,
          defaultDuration: s.defaultDuration,
          bufferBefore: s.bufferBefore,
          bufferAfter: s.bufferAfter,
          color: s.color,
          priceCents: s.priceCents,
          locationKinds: s.locationKinds,
          staffUserIds: staff.filter((x) => x.serviceId === s.id).map((x) => x.userId),
          resources: needs
            .filter((x) => x.serviceId === s.id)
            .map((x) => ({ resourceId: x.resourceId, quantity: x.quantity })),
          hours: hours.find((h) => h.ownerId === s.id)?.weekly ?? null,
          archivedAt: s.archivedAt?.toISOString() ?? null,
        })),
    };
  },
});

export const resourceList = defineQuery({
  name: 'resource.list',
  description: 'The workspace’s rooms, trucks and equipment with quantities and hours.',
  input: ResourceListInput,
  output: ResourceListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const list = await ctx.tx
      .select()
      .from(resources)
      .where(eq(resources.workspaceId, ws))
      .orderBy(asc(resources.name));
    const hours = await ctx.tx
      .select({ ownerId: schedules.ownerId, weekly: schedules.weekly })
      .from(schedules)
      .where(and(eq(schedules.workspaceId, ws), eq(schedules.ownerKind, 'resource')));
    return {
      items: list
        .filter((r) => input.includeArchived || !r.archivedAt)
        .map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          quantity: r.quantity,
          location: r.location,
          hours: hours.find((h) => h.ownerId === r.id)?.weekly ?? null,
          archivedAt: r.archivedAt?.toISOString() ?? null,
        })),
    };
  },
});

export const territoryList = defineQuery({
  name: 'territory.list',
  description: 'The workspace’s territories with their ZIP codes and people.',
  input: TerritoryListInput,
  output: TerritoryListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const list = await loadTerritories(ctx.tx, input.workspaceId);
    return {
      items: list.map((t) => ({
        id: t.id,
        name: t.name,
        postalCodes: [...t.postalCodes],
        userIds: [...t.userIds],
      })),
    };
  },
});

export const bookingSiteGet = defineQuery({
  name: 'booking_site.get',
  description: 'The public booking site (/book/<name>), or null until it is set up.',
  input: BookingSiteGetInput,
  output: BookingSiteGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const site = await siteOf(ctx.tx, input.workspaceId);
    return {
      site: site
        ? {
            id: site.id,
            slug: site.slug,
            name: site.name,
            intro: site.intro,
            enabled: site.enabled,
            path: `/book/${site.slug}`,
          }
        : null,
    };
  },
});

/**
 * Appointment internals shared by the appointment commands and calendar.save's impact actions: loading an
 * appointment, a display snapshot for events and audit (names, not ids), timeline entries on the customer,
 * cancelling, replacing staff and the waitlist's "a seat opened" signal. Server-only.
 */
import { and, eq, ne } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  appointmentAttendees,
  appointments,
  appointmentStaff,
  calendarRevisions,
  calendars,
  services,
} from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { HfosError } from '../errors';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import { parseConfig, type CalendarConfig } from './config';
import { userNames, type LoadedCalendar } from './load';

export type AppointmentRow = typeof appointments.$inferSelect;

export async function requireAppointment(
  tx: Tx,
  workspaceId: string,
  appointmentId: string,
): Promise<AppointmentRow> {
  const [row] = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.workspaceId, workspaceId)));
  if (!row) throw HfosError.notFound('Appointment not found.');
  return row;
}

export function requireScheduled(appt: AppointmentRow): void {
  if (appt.status !== 'scheduled')
    throw HfosError.rule(
      'appointment_not_scheduled',
      409,
      appt.status === 'cancelled'
        ? 'This appointment was cancelled.'
        : 'This appointment already happened.',
    );
}

/** The settings an appointment was booked under (policies, lengths); the current ones if that revision is gone. */
export async function revisionConfig(
  tx: Tx,
  calendar: LoadedCalendar,
  revision: number,
): Promise<CalendarConfig> {
  if (revision === calendar.revision) return calendar.config;
  const [r] = await tx
    .select({ config: calendarRevisions.config })
    .from(calendarRevisions)
    .where(
      and(eq(calendarRevisions.calendarId, calendar.id), eq(calendarRevisions.revision, revision)),
    );
  return r ? parseConfig(r.config) : calendar.config;
}

export interface AttendeeInfo {
  readonly id: string;
  readonly personId: string;
  readonly name: string;
  readonly status: string;
  readonly seats: number;
}

export async function attendeesOf(tx: Tx, appointmentId: string): Promise<AttendeeInfo[]> {
  return rows<{ id: string; personId: string; name: string; status: string; seats: number }>(
    tx,
    sql`select a.id, a.person_id as "personId", a.status::text as status, a.seats,
          coalesce(nullif(btrim(p.first_name || ' ' || p.last_name), ''), 'Customer') as name
        from app.appointment_attendees a join app.people p on p.id = a.person_id
        where a.appointment_id = ${appointmentId}
        order by a.created_at, a.id`,
  );
}

/** Host first, then crew, each group by user id. */
export async function staffIdsOf(tx: Tx, appointmentId: string): Promise<string[]> {
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

/** What an event and the audit log say about an appointment: names and times, never just ids. */
export async function appointmentSnapshot(
  tx: Tx,
  appt: AppointmentRow,
): Promise<Record<string, unknown>> {
  const [cal] = await tx
    .select({ name: calendars.name })
    .from(calendars)
    .where(eq(calendars.id, appt.calendarId));
  const [svc] = appt.serviceId
    ? await tx.select({ name: services.name }).from(services).where(eq(services.id, appt.serviceId))
    : [];
  const staffIds = await staffIdsOf(tx, appt.id);
  const names = await userNames(tx, staffIds);
  const attendees = (await attendeesOf(tx, appt.id)).filter((a) => a.status !== 'cancelled');
  return {
    title: appt.title,
    calendar: cal?.name ?? null,
    service: svc?.name ?? null,
    startsAt: appt.startsAt.toISOString(),
    endsAt: appt.endsAt.toISOString(),
    status: appt.status,
    kind: appt.kind,
    staff: staffIds.map((u) => names.get(u) ?? 'Someone'),
    customers: attendees.map((a) => a.name),
    seats: appt.capacity > 1 ? `${appt.seatsTaken}/${appt.capacity}` : null,
    source: appt.source,
  };
}

/**
 * Timeline entries for an appointment: one per customer on it (the first carries the event id, which is
 * unique per entry), or one on the lead when nobody is attached. Nothing when there is neither.
 */
export async function logAppointmentActivity(
  ctx: CommandContext,
  appt: AppointmentRow,
  subtype: string,
  eventId: string | null,
  opts: { readonly personIds?: readonly string[]; readonly meta?: Record<string, unknown> } = {},
): Promise<void> {
  const personIds =
    opts.personIds ??
    (await attendeesOf(ctx.tx, appt.id))
      .filter((a) => a.status !== 'cancelled')
      .map((a) => a.personId);
  const meta = {
    appointmentId: appt.id,
    calendarId: appt.calendarId,
    startsAt: appt.startsAt.toISOString(),
    endsAt: appt.endsAt.toISOString(),
    ...(opts.meta ?? {}),
  };
  const targets = [...new Set(personIds)];
  if (!targets.length) {
    if (appt.leadId)
      await logSystemActivity(ctx, {
        subtype,
        leadId: appt.leadId,
        body: appt.title,
        meta,
        eventId,
      });
    return;
  }
  let first = true;
  for (const personId of targets) {
    await logSystemActivity(ctx, {
      subtype,
      personId,
      leadId: appt.leadId,
      body: appt.title,
      meta,
      eventId: first ? eventId : null,
    });
    first = false;
  }
}

/**
 * Cancels the appointment and everyone booked on it, without events (callers emit their own). `at` is when it was
 * cancelled, now when left out.
 */
export async function markCancelled(
  tx: Tx,
  appointmentId: string,
  at: Date = new Date(),
): Promise<void> {
  await tx
    .update(appointments)
    .set({ status: 'cancelled' })
    .where(eq(appointments.id, appointmentId));
  await tx
    .update(appointmentAttendees)
    .set({ status: 'cancelled', cancelledAt: at })
    .where(
      and(
        eq(appointmentAttendees.appointmentId, appointmentId),
        eq(appointmentAttendees.status, 'booked'),
      ),
    );
}

export type CancelledBy = 'staff' | 'customer' | 'calendar_change';

/** Cancels an appointment, emits appointment.cancelled and writes the customers' timeline entries. */
export async function cancelAppointment(
  ctx: CommandContext,
  appt: AppointmentRow,
  opts: { readonly reason: string | null; readonly notify: boolean; readonly by: CancelledBy },
): Promise<string | null> {
  if (appt.status === 'cancelled') return null;
  const personIds = (await attendeesOf(ctx.tx, appt.id))
    .filter((a) => a.status === 'booked')
    .map((a) => a.personId);
  const snapshot = await appointmentSnapshot(ctx.tx, appt);
  // Cancelled when the change was made: from a phone, perhaps before it had signal.
  await markCancelled(ctx.tx, appt.id, changeMoment(ctx.meta));
  const eventId = await ctx.emit({
    type: 'appointment.cancelled',
    entityType: 'appointment',
    entityId: appt.id,
    payload: {
      calendarId: appt.calendarId,
      startsAt: appt.startsAt.toISOString(),
      reason: opts.reason,
      notify: opts.notify,
      by: opts.by,
      personIds,
    },
    before: { title: appt.title, status: appt.status },
    after: { ...snapshot, status: 'cancelled', reason: opts.reason },
  });
  await logAppointmentActivity(ctx, appt, 'appointment_cancelled', eventId, {
    personIds,
    meta: { reason: opts.reason, by: opts.by },
  });
  return eventId;
}

/**
 * Replaces who works an appointment, inserting rows in user-id order (the first listed hosts). Nobody (a
 * calendar without staff) leaves it with none.
 */
export async function replaceStaff(
  tx: Tx,
  workspaceId: string,
  appointmentId: string,
  userIds: readonly string[],
): Promise<void> {
  await tx.delete(appointmentStaff).where(eq(appointmentStaff.appointmentId, appointmentId));
  if (!userIds.length) return;
  await tx.insert(appointmentStaff).values(
    [...new Set(userIds)].sort().map((userId) => ({
      workspaceId,
      appointmentId,
      userId,
      role: userId === userIds[0] ? ('host' as const) : ('crew' as const),
    })),
  );
}

/**
 * Tells the worker a seat or a 1:1 time opened on a calendar whose waitlist is on and has someone waiting
 * (for that session, or for a wanted window). The worker promotes or sends an offer.
 */
export async function signalSeatFreed(
  ctx: CommandContext,
  calendar: LoadedCalendar,
  appt: AppointmentRow,
): Promise<void> {
  if (!calendar.config.waitlist.enabled) return;
  const [waiting] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from app.waitlist_entries w
        where w.calendar_id = ${calendar.id} and w.status = 'waiting'
          and (w.appointment_id = ${appt.id}
            or (w.appointment_id is null and w.wanted_from < ${appt.endsAt.toISOString()}::timestamptz
                and w.wanted_to > ${appt.startsAt.toISOString()}::timestamptz))`,
  );
  if (!waiting?.n) return;
  await ctx.emit({
    type: 'waitlist.seat_freed',
    entityType: 'appointment',
    entityId: appt.id,
    payload: {
      calendarId: calendar.id,
      appointmentId: appt.id,
      startsAt: appt.startsAt.toISOString(),
      waiting: waiting.n,
    },
    broadcast: false,
  });
}

/** Booked (not cancelled) attendees other than one, for "is anyone still coming". */
export async function othersBooked(
  tx: Tx,
  appointmentId: string,
  exceptAttendeeId: string,
): Promise<number> {
  const list = await tx
    .select({ id: appointmentAttendees.id })
    .from(appointmentAttendees)
    .where(
      and(
        eq(appointmentAttendees.appointmentId, appointmentId),
        eq(appointmentAttendees.status, 'booked'),
        ne(appointmentAttendees.id, exceptAttendeeId),
      ),
    );
  return list.length;
}

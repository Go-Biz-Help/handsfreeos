/**
 * Appointments for people who book (appointments.write): book, change, move, reassign, cancel, mark done
 * or no-show, add and remove attendees, publish sessions, repeat as a series and keep a waitlist. Staff
 * bookings hear warnings (buffers, hours, busy times, time off, a time in the past) they can book anyway,
 * but never a real overlap: the database refuses one person in two places.
 */
import { and, asc, eq, gte, inArray, sql as dsql } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  appointmentAttendees,
  appointmentResources,
  appointments,
  appointmentSeries,
  leads,
  waitlistEntries,
} from '@hfos/db/schema';
import {
  appointmentSnapshot,
  attendeesOf,
  cancelAppointment,
  logAppointmentActivity,
  markCancelled,
  replaceStaff,
  requireAppointment,
  requireScheduled,
  signalSeatFreed,
  staffIdsOf,
  type AppointmentRow,
} from '../calendar/appointments';
import {
  bookAppointment,
  checkBooking,
  checkDataFor,
  joinSession,
  lockBooking,
  needsConfirmation,
  resourceFullError,
  staffSource,
  type AttendeeDraft,
  type BookingResult,
} from '../calendar/booking';
import { expandRecurrence } from '../calendar/engine/recurrence';
import {
  dbNow,
  iso,
  loadCalendar,
  loadCatalogService,
  loadSlotInput,
  resolveService,
  type LoadedCalendar,
} from '../calendar/load';
import { resolveTerms } from '../calendar/terms';
import { requirePerson } from '../crm/records';
import { requireCustomRecord } from '../relationships/store';
import { HfosError } from '../errors';
import { logNotApplied, mergeColumns, mergeFields } from '../kernel/field-merge';
import { FRESH_MINUTES } from '../mobile';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import { isOptedOut } from '../messaging/store';
import {
  AppointmentAddAttendeeInput,
  AppointmentAddAttendeeOutput,
  AppointmentCancelInput,
  AppointmentCancelOutput,
  AppointmentCreateInput,
  AppointmentCreateOutput,
  AppointmentReassignInput,
  AppointmentReassignOutput,
  AppointmentRemoveAttendeeInput,
  AppointmentRemoveAttendeeOutput,
  AppointmentRescheduleInput,
  AppointmentRescheduleOutput,
  AppointmentSetStatusInput,
  AppointmentSetStatusOutput,
  AppointmentStillGoingInput,
  AppointmentStillGoingOutput,
  AppointmentUpdateInput,
  AppointmentUpdateOutput,
  SeriesCancelInput,
  SeriesCancelOutput,
  SeriesCreateInput,
  SeriesCreateOutput,
  SessionPublishInput,
  SessionPublishOutput,
  WaitlistAddInput,
  WaitlistAddOutput,
  WaitlistRemoveInput,
  WaitlistRemoveOutput,
} from '../schemas/calendar';
import { wantedWindowIssue } from './waitlist-online';

const MIN = 60_000;
const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

// ---- Helpers shared with the booking page ----

/** How to reach a customer about one booking, from their record; texts only when they haven't said STOP. */
export async function attendeeFromPerson(
  tx: Tx,
  workspaceId: string,
  personId: string,
  seats: number,
  source: AttendeeDraft['source'],
): Promise<AttendeeDraft> {
  const person = await requirePerson(tx, workspaceId, personId);
  const phone = person.phoneE164;
  const smsOk =
    !!phone && person.smsConsent !== 'opted_out' && !(await isOptedOut(tx, workspaceId, phone));
  return {
    personId,
    seats,
    contactPhoneE164: phone,
    contactEmail: person.email ? person.email.toLowerCase() : null,
    smsOk,
    source,
  };
}

async function requireLead(tx: Tx, workspaceId: string, leadId: string): Promise<void> {
  const [lead] = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.workspaceId, workspaceId)));
  if (!lead) throw HfosError.notFound('Lead not found.');
}

function assertOpen(calendar: LoadedCalendar): void {
  if (calendar.status === 'archived')
    throw HfosError.rule('calendar_archived', 409, 'This calendar is archived.');
}

/** Emits appointment.booked with a display snapshot and writes the customers' timeline entries. */
export async function announceBooked(
  ctx: CommandContext,
  result: BookingResult,
  subtype: string,
  payload: Record<string, unknown> = {},
  only?: readonly string[],
): Promise<string> {
  const appt = await requireAppointment(ctx.tx, ctx.scope.workspaceId!, result.appointmentId);
  const snapshot = await appointmentSnapshot(ctx.tx, appt);
  const personIds = only
    ? [...only]
    : (
        await ctx.tx
          .select({ personId: appointmentAttendees.personId })
          .from(appointmentAttendees)
          .where(
            and(
              eq(appointmentAttendees.appointmentId, appt.id),
              eq(appointmentAttendees.status, 'booked'),
            ),
          )
      ).map((a) => a.personId);
  const eventId = await ctx.emit({
    type: 'appointment.booked',
    entityType: 'appointment',
    entityId: appt.id,
    payload: {
      calendarId: appt.calendarId,
      startsAt: appt.startsAt.toISOString(),
      endsAt: appt.endsAt.toISOString(),
      userIds: result.userIds,
      personIds,
      attendeeId: result.attendeeId,
      source: appt.source,
      warnings: result.warnings.map((w) => w.code),
      ...payload,
    },
    after: snapshot,
  });
  await logAppointmentActivity(ctx, appt, subtype, eventId, { personIds });
  return eventId;
}

async function appointmentResourceNeeds(tx: Tx, appointmentId: string) {
  return tx
    .select({
      resourceId: appointmentResources.resourceId,
      quantity: appointmentResources.quantity,
    })
    .from(appointmentResources)
    .where(eq(appointmentResources.appointmentId, appointmentId));
}

/**
 * Staff warnings for an existing appointment at a (new) time or with (new) people, on fresh data under the
 * calendar's lock. Throws when it can't happen at all, or needs_confirmation when not acknowledged.
 */
/** Whether an appointment still fits at a new start and length (M18's add-to-visit uses it too). */
export async function checkExisting(
  ctx: CommandContext,
  calendar: LoadedCalendar,
  appt: AppointmentRow,
  change: { start: number; minutes: number; userIds: string[] },
  acknowledge: boolean,
) {
  const needs = await appointmentResourceNeeds(ctx.tx, appt.id);
  await lockBooking(
    ctx.tx,
    calendar.id,
    needs.map((n) => n.resourceId),
  );
  const service = appt.serviceId
    ? await loadCatalogService(ctx.tx, calendar.workspaceId, appt.serviceId)
    : null;
  const loaded = await loadSlotInput(
    ctx.tx,
    calendar,
    {
      from: change.start,
      to: change.start + 1,
      durationMinutes: change.minutes,
      locationKind: null,
      excludeAppointmentIds: [appt.id],
    },
    { service, extraUserIds: change.userIds, extraResourceIds: needs.map((n) => n.resourceId) },
  );
  const data = await checkDataFor(ctx.tx, loaded);
  const span = {
    start: change.start,
    end: change.start + change.minutes * MIN,
    before: appt.bufferBefore * MIN,
    after: appt.bufferAfter * MIN,
  };
  // A calendar without staff can't be booked past its resources, not even anyway.
  const hardResources = calendar.config.team.assignment === 'none';
  const check = checkBooking(data, span, change.userIds, needs, { hardResources });
  if (check.full)
    throw await resourceFullError(
      ctx.tx,
      calendar,
      {
        from: change.start,
        to: change.start + 1,
        durationMinutes: change.minutes,
        locationKind: null,
        excludeAppointmentIds: [appt.id],
      },
      change.start,
      service,
      check.full,
    );
  if (check.blocked) throw check.blocked;
  if (check.warnings.length && !acknowledge)
    throw needsConfirmation(check.warnings, change.userIds);
  return { span, warnings: check.warnings };
}

// ---- Commands ----

export const appointmentCreate = defineCommand({
  name: 'appointment.create',
  description:
    'Book an appointment on a calendar. Staff hear warnings (buffers, outside hours, busy, time off, in the past) and may book anyway; a real overlap is never allowed.',
  risk: 2,
  input: AppointmentCreateInput,
  output: AppointmentCreateOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['appointment.booked'],
  offline: { freshMinutes: FRESH_MINUTES },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const calendar = await loadCalendar(ctx.tx, ws, input.calendarId);
    assertOpen(calendar);
    if (input.leadId) await requireLead(ctx.tx, ws, input.leadId);
    if (input.customRecordId) await requireCustomRecord(ctx.tx, ws, input.customRecordId);
    const source = staffSource(ctx);
    const attendee = input.personId
      ? await attendeeFromPerson(ctx.tx, ws, input.personId, input.partySize, source)
      : null;
    const result = await bookAppointment(ctx, {
      calendar,
      startsAt: Date.parse(input.startsAt),
      serviceId: input.serviceId,
      durationMinutes: input.durationMinutes,
      partySize: input.partySize,
      locationKind: input.location ? input.location.kind : undefined,
      choice: {
        mode: 'staff',
        userIds: input.userIds,
        acknowledgeWarnings: input.acknowledgeWarnings,
      },
      attendee,
      title: input.title,
      notes: input.notes,
      location: input.location,
      leadId: input.leadId,
      customRecordId: input.customRecordId,
      clientId: input.clientId,
      source,
    });
    if (!result.duplicate)
      await announceBooked(ctx, result, 'appointment_booked', { notify: input.notify });
    return {
      appointmentId: result.appointmentId,
      startsAt: iso(result.startsAt),
      endsAt: iso(result.endsAt),
      userIds: result.userIds,
      warnings: result.warnings,
      duplicate: result.duplicate,
    };
  },
});

export const appointmentUpdate = defineCommand({
  name: 'appointment.update',
  description:
    'Change an appointment’s title, notes, location, lead or record (the pet, vehicle or property it’s for): only what was edited, each with what the editor saw, and the newest change to each wins.',
  risk: 1,
  input: AppointmentUpdateInput,
  output: AppointmentUpdateOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['appointment.updated'],
  offline: 'anytime',
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [appt] = await ctx.tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.id, input.appointmentId), eq(appointments.workspaceId, ws)))
      .for('update');
    if (!appt) throw HfosError.notFound('Appointment not found.');
    if (input.leadId) await requireLead(ctx.tx, ws, input.leadId);
    if (input.customRecordId) await requireCustomRecord(ctx.tx, ws, input.customRecordId);
    const seen: NonNullable<typeof input.base> = input.base ?? {};
    const merged = mergeFields(
      appt,
      [
        {
          key: 'title',
          column: 'title',
          value: input.title,
          base: seen.title,
          kind: 'text',
          label: 'title',
        },
        {
          key: 'notes',
          column: 'notes',
          value: input.notes === undefined ? undefined : (input.notes ?? null),
          base: seen.notes,
          kind: 'text',
          label: 'notes',
        },
        {
          key: 'location',
          column: 'location',
          value: input.location,
          base: seen.location,
          kind: 'json',
          label: 'location',
        },
        {
          key: 'leadId',
          column: 'leadId',
          value: input.leadId === undefined ? undefined : (input.leadId ?? null),
          base: seen.leadId,
          kind: 'id',
          label: 'lead',
        },
        {
          key: 'customRecordId',
          column: 'customRecordId',
          value: input.customRecordId === undefined ? undefined : (input.customRecordId ?? null),
          base: seen.customRecordId,
          kind: 'id',
          label: 'record',
        },
      ],
      mergeColumns(appointments),
      ctx.meta,
    );
    const { patch } = merged;
    const notApplied = merged.notApplied.map((n) => n.key);
    if (merged.notApplied.length) {
      const [first] = await attendeesOf(ctx.tx, appt.id);
      await logNotApplied(
        ctx,
        merged.notApplied,
        { type: 'appointment', id: appt.id },
        { leadId: appt.leadId, personId: first?.personId ?? null },
      );
    }
    const updated = [...merged.applied];
    if (!updated.length) return { appointmentId: appt.id, updated, notApplied };
    await ctx.tx.update(appointments).set(patch).where(eq(appointments.id, appt.id));
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of updated) {
      before[k] = (appt as Record<string, unknown>)[k];
      after[k] = patch[k];
    }
    const title = (patch.title as string | undefined) ?? appt.title;
    await ctx.emit({
      type: 'appointment.updated',
      entityType: 'appointment',
      entityId: appt.id,
      payload: { calendarId: appt.calendarId, fields: updated },
      before: { title: appt.title, ...before },
      after: { title, ...after },
    });
    return { appointmentId: appt.id, updated, notApplied };
  },
});

export const appointmentReschedule = defineCommand({
  name: 'appointment.reschedule',
  description:
    'Move an appointment to a new time (and length), keeping who works it. Warnings can be acknowledged; an overlap can’t.',
  risk: 2,
  input: AppointmentRescheduleInput,
  output: AppointmentRescheduleOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['appointment.rescheduled'],
  offline: { freshMinutes: FRESH_MINUTES },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
    requireScheduled(appt);
    const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
    const start = Date.parse(input.startsAt);
    const minutes =
      input.durationMinutes ?? Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / MIN);
    const staffIds = await staffIdsOf(ctx.tx, appt.id);
    const { span, warnings } = await checkExisting(
      ctx,
      calendar,
      appt,
      { start, minutes, userIds: staffIds },
      input.acknowledgeWarnings,
    );
    const [moved] = await ctx.tx
      .update(appointments)
      .set({ startsAt: new Date(span.start), endsAt: new Date(span.end) })
      .where(eq(appointments.id, appt.id))
      .returning();
    const from = { startsAt: appt.startsAt.toISOString(), endsAt: appt.endsAt.toISOString() };
    const to = { startsAt: iso(span.start), endsAt: iso(span.end) };
    const eventId = await ctx.emit({
      type: 'appointment.rescheduled',
      entityType: 'appointment',
      entityId: appt.id,
      payload: { calendarId: appt.calendarId, from, to, notify: input.notify, by: 'staff' },
      before: { title: appt.title, ...from },
      after: await appointmentSnapshot(ctx.tx, moved!),
    });
    await logAppointmentActivity(ctx, moved!, 'appointment_rescheduled', eventId, {
      meta: { from: from.startsAt, to: to.startsAt },
    });
    return { appointmentId: appt.id, ...to, warnings };
  },
});

export const appointmentReassign = defineCommand({
  name: 'appointment.reassign',
  description: 'Change who works an appointment (the first person hosts).',
  risk: 2,
  input: AppointmentReassignInput,
  output: AppointmentReassignOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['appointment.reassigned'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
    requireScheduled(appt);
    const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
    if (calendar.config.team.assignment === 'none')
      throw HfosError.rule(
        'calendar_has_no_staff',
        409,
        'This calendar books without staff, so there’s nobody to hand it to.',
      );
    const userIds = [...new Set(input.userIds)];
    const was = await staffIdsOf(ctx.tx, appt.id);
    if (JSON.stringify(was) === JSON.stringify(userIds))
      return { appointmentId: appt.id, userIds, warnings: [] };
    // Staff on a booking see the bills tied to it, so putting somebody on one that has any, when that shows
    // them bills they can't otherwise see — yourself included — takes records.assign, as it does for a lead or
    // a customer. Asked of the database, which sees the bills when the member can't.
    const added = userIds.filter((u) => !was.includes(u));
    if (ctx.actor.type === 'human' && added.length && !scopeCan(ctx.scope, 'records.assign')) {
      const [shown] = await rows<{ yes: boolean }>(
        ctx.tx,
        sql`select private.appointment_has_money(${ws}::uuid, ${appt.id}::uuid)
              and exists (select 1 from unnest(array[${sql.join(
                added.map((u) => sql`${u}::uuid`),
                sql`, `,
              )}]) as t(u) where private.sees_money_as_member(${ws}::uuid, t.u)) as yes`,
      );
      if (shown?.yes)
        throw HfosError.rule(
          'appointment_assign_managers_only',
          403,
          'This booking has bills on it, so only owners and admins can add people who would see them.',
        );
    }
    const minutes = Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / MIN);
    const { warnings } = await checkExisting(
      ctx,
      calendar,
      appt,
      { start: appt.startsAt.getTime(), minutes, userIds },
      input.acknowledgeWarnings,
    );
    const before = await appointmentSnapshot(ctx.tx, appt);
    await replaceStaff(ctx.tx, ws, appt.id, userIds);
    await ctx.emit({
      type: 'appointment.reassigned',
      entityType: 'appointment',
      entityId: appt.id,
      payload: {
        calendarId: appt.calendarId,
        fromUserIds: was,
        toUserIds: userIds,
        notify: input.notify,
        reason: 'staff',
      },
      before: { title: appt.title, staff: before.staff },
      after: await appointmentSnapshot(ctx.tx, appt),
    });
    return { appointmentId: appt.id, userIds, warnings };
  },
});

export const appointmentCancel = defineCommand({
  name: 'appointment.cancel',
  description: 'Cancel an appointment for everyone on it, optionally telling the customers.',
  risk: 2,
  input: AppointmentCancelInput,
  output: AppointmentCancelOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['appointment.cancelled', 'waitlist.seat_freed'],
  offline: { freshMinutes: FRESH_MINUTES },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
    if (appt.status === 'cancelled') return { appointmentId: appt.id, status: appt.status };
    requireScheduled(appt);
    const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
    await lockBooking(ctx.tx, calendar.id);
    await cancelAppointment(ctx, appt, {
      reason: input.reason ?? null,
      notify: input.notify,
      by: 'staff',
    });
    if (appt.kind === 'booking' && appt.capacity === 1) await signalSeatFreed(ctx, calendar, appt);
    return { appointmentId: appt.id, status: 'cancelled' as const };
  },
});

export const appointmentSetStatus = defineCommand({
  name: 'appointment.set_status',
  description: 'Mark an appointment done, or a no-show.',
  risk: 1,
  input: AppointmentSetStatusInput,
  output: AppointmentSetStatusOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['appointment.completed', 'appointment.no_show'],
  offline: 'anytime',
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
    if (appt.status === 'cancelled')
      throw HfosError.rule('appointment_not_scheduled', 409, 'This appointment was cancelled.');
    if (appt.status === input.status) return { appointmentId: appt.id, status: appt.status };
    const [updated] = await ctx.tx
      .update(appointments)
      .set({ status: input.status })
      .where(eq(appointments.id, appt.id))
      .returning();
    const completed = input.status === 'completed';
    await ctx.tx
      .update(appointmentAttendees)
      .set({ status: completed ? 'attended' : 'no_show' })
      .where(
        and(
          eq(appointmentAttendees.appointmentId, appt.id),
          inArray(
            appointmentAttendees.status,
            completed ? ['booked', 'no_show'] : ['booked', 'attended'],
          ),
        ),
      );
    const eventId = await ctx.emit({
      type: completed ? 'appointment.completed' : 'appointment.no_show',
      entityType: 'appointment',
      entityId: appt.id,
      payload: { calendarId: appt.calendarId, from: appt.status, to: input.status },
      before: { title: appt.title, status: appt.status },
      after: await appointmentSnapshot(ctx.tx, updated!),
    });
    await logAppointmentActivity(
      ctx,
      updated!,
      completed ? 'appointment_completed' : 'appointment_no_show',
      eventId,
    );
    return { appointmentId: appt.id, status: input.status };
  },
});

/**
 * "Still there" on the job-check push (Automations' "Did the job happen?"): the visit is running over. Nothing
 * about it changes; the worker asks again in an hour.
 */
export const appointmentStillGoing = defineCommand({
  name: 'appointment.still_going',
  description: 'Say a visit is running over, so the "How did it go?" push asks again in an hour.',
  risk: 0,
  input: AppointmentStillGoingInput,
  output: AppointmentStillGoingOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['appointment.still_going'],
  offline: 'anytime',
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
    if (appt.status !== 'scheduled')
      throw HfosError.rule(
        'appointment_not_scheduled',
        409,
        appt.status === 'cancelled'
          ? 'This appointment was cancelled.'
          : 'Someone already said how this one went.',
      );
    await ctx.emit({
      type: 'appointment.still_going',
      entityType: 'appointment',
      entityId: appt.id,
      payload: { calendarId: appt.calendarId },
      after: { title: appt.title },
      broadcast: false,
    });
    return { appointmentId: appt.id };
  },
});

export const appointmentAddAttendee = defineCommand({
  name: 'appointment.add_attendee',
  description: 'Add a customer to a session or group appointment, if seats are left.',
  risk: 2,
  input: AppointmentAddAttendeeInput,
  output: AppointmentAddAttendeeOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['attendee.added'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
    requireScheduled(appt);
    const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
    await lockBooking(ctx.tx, calendar.id);
    const attendee = await attendeeFromPerson(
      ctx.tx,
      ws,
      input.personId,
      input.seats,
      staffSource(ctx),
    );
    const joined = await joinSession(ctx, {
      calendar,
      sessionId: appt.id,
      attendee,
      customer: false,
    });
    const fresh = await requireAppointment(ctx.tx, ws, appt.id);
    const eventId = await ctx.emit({
      type: 'attendee.added',
      entityType: 'appointment',
      entityId: appt.id,
      payload: {
        calendarId: appt.calendarId,
        attendeeId: joined.attendeeId,
        personId: input.personId,
        seats: input.seats,
        notify: input.notify,
      },
      after: await appointmentSnapshot(ctx.tx, fresh),
    });
    await logAppointmentActivity(ctx, fresh, 'appointment_booked', eventId, {
      personIds: [input.personId],
    });
    return {
      appointmentId: appt.id,
      attendeeId: joined.attendeeId!,
      seatsTaken: fresh.seatsTaken,
      capacity: fresh.capacity,
    };
  },
});

export const appointmentRemoveAttendee = defineCommand({
  name: 'appointment.remove_attendee',
  description: 'Take a customer off an appointment (their seats open up).',
  risk: 2,
  input: AppointmentRemoveAttendeeInput,
  output: AppointmentRemoveAttendeeOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['attendee.removed', 'waitlist.seat_freed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
    const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
    await lockBooking(ctx.tx, calendar.id);
    const [att] = await ctx.tx
      .select()
      .from(appointmentAttendees)
      .where(
        and(
          eq(appointmentAttendees.appointmentId, appt.id),
          eq(appointmentAttendees.personId, input.personId),
          eq(appointmentAttendees.status, 'booked'),
        ),
      );
    if (!att) throw HfosError.notFound('They aren’t booked on this.');
    await ctx.tx
      .update(appointmentAttendees)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(appointmentAttendees.id, att.id));
    const [fresh] = await ctx.tx
      .update(appointments)
      .set({ seatsTaken: dsql`greatest(${appointments.seatsTaken} - ${att.seats}, 0)` })
      .where(eq(appointments.id, appt.id))
      .returning();
    const eventId = await ctx.emit({
      type: 'attendee.removed',
      entityType: 'appointment',
      entityId: appt.id,
      payload: {
        calendarId: appt.calendarId,
        attendeeId: att.id,
        personId: att.personId,
        seats: att.seats,
        notify: input.notify,
      },
      after: await appointmentSnapshot(ctx.tx, fresh!),
    });
    await logAppointmentActivity(ctx, fresh!, 'appointment_cancelled', eventId, {
      personIds: [att.personId],
      meta: { by: 'staff' },
    });
    if (fresh!.status === 'scheduled') await signalSeatFreed(ctx, calendar, fresh!);
    return { appointmentId: appt.id, seatsTaken: fresh!.seatsTaken };
  },
});

export const sessionPublish = defineCommand({
  name: 'session.publish',
  description: 'Publish a date on a fixed-sessions calendar that customers take seats in.',
  risk: 1,
  input: SessionPublishInput,
  output: SessionPublishOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['session.published'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const calendar = await loadCalendar(ctx.tx, ws, input.calendarId);
    assertOpen(calendar);
    if (calendar.config.schedule.mode !== 'sessions')
      throw HfosError.rule(
        'not_sessions_mode',
        409,
        'This calendar books open hours. Switch it to fixed sessions to publish dates.',
      );
    const result = await bookAppointment(ctx, {
      calendar,
      startsAt: Date.parse(input.startsAt),
      serviceId: input.serviceId,
      durationMinutes: input.durationMinutes,
      partySize: 1,
      locationKind: input.location ? input.location.kind : undefined,
      choice: {
        mode: 'staff',
        userIds: input.userIds,
        acknowledgeWarnings: input.acknowledgeWarnings,
      },
      kind: 'session',
      capacity: input.capacity,
      attendee: null,
      title: input.title,
      notes: input.notes,
      location: input.location,
      source: staffSource(ctx),
    });
    const appt = await requireAppointment(ctx.tx, ws, result.appointmentId);
    await ctx.emit({
      type: 'session.published',
      entityType: 'appointment',
      entityId: appt.id,
      payload: {
        calendarId: calendar.id,
        startsAt: iso(result.startsAt),
        capacity: appt.capacity,
        userIds: result.userIds,
      },
      after: await appointmentSnapshot(ctx.tx, appt),
    });
    return {
      appointmentId: appt.id,
      startsAt: iso(result.startsAt),
      endsAt: iso(result.endsAt),
      capacity: appt.capacity,
      warnings: result.warnings,
    };
  },
});

function skipReason(e: HfosError): string {
  if (e.rule === 'needs_confirmation') {
    const warnings =
      (e.details as { warnings?: { message: string }[] } | undefined)?.warnings ?? [];
    return warnings.map((w) => w.message).join('; ') || e.message;
  }
  return e.message;
}

export const seriesCreate = defineCommand({
  name: 'series.create',
  description:
    'Repeat an appointment (or, on a sessions calendar, a session) weekly or monthly. Books every date that fits and reports the ones that don’t.',
  risk: 2,
  input: SeriesCreateInput,
  output: SeriesCreateOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['series.created'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const calendar = await loadCalendar(ctx.tx, ws, input.calendarId);
    assertOpen(calendar);
    const { config } = calendar;
    if (!config.recurring.staffSeries)
      throw HfosError.rule('series_off', 409, 'Repeats are off for this calendar.');
    if (input.leadId) await requireLead(ctx.tx, ws, input.leadId);
    if (input.customRecordId) await requireCustomRecord(ctx.tx, ws, input.customRecordId);
    const sessions = config.schedule.mode === 'sessions';
    const occurrences = expandRecurrence(input.rule, input.firstDate, calendar.timeZone).slice(
      0,
      config.recurring.maxOccurrences,
    );
    if (!occurrences.length)
      throw HfosError.validation([{ path: 'rule', message: 'No dates match this repeat.' }]);
    const service = await resolveService(ctx.tx, calendar, input.serviceId);
    await lockBooking(
      ctx.tx,
      calendar.id,
      resolveTerms(config, service).requiredResources.map((r) => r.resourceId),
    );
    const [series] = await ctx.tx
      .insert(appointmentSeries)
      .values({
        workspaceId: ws,
        calendarId: calendar.id,
        rule: input.rule as unknown as Record<string, unknown>,
        createdBy: me,
      })
      .returning({ id: appointmentSeries.id });
    const attendee =
      input.personId && !sessions
        ? await attendeeFromPerson(ctx.tx, ws, input.personId, input.partySize, 'series')
        : null;
    const created: string[] = [];
    const skipped: { occurrence: number; date: string; startsAt: string; reason: string }[] = [];
    let prefer: readonly string[] | undefined = input.userIds;
    for (const occ of occurrences) {
      try {
        const r = await bookAppointment(ctx, {
          calendar,
          startsAt: occ.startsAt,
          serviceId: service?.id ?? null,
          durationMinutes: input.durationMinutes,
          partySize: input.partySize,
          locationKind: input.location ? input.location.kind : undefined,
          // Series continuity: the first occurrence's people are kept when free.
          choice: { mode: 'staff', userIds: input.userIds, acknowledgeWarnings: false },
          preferUserIds: prefer,
          kind: sessions ? 'session' : 'booking',
          capacity: sessions ? input.capacity : undefined,
          attendee,
          title: input.title,
          notes: input.notes,
          location: input.location,
          leadId: input.leadId,
          customRecordId: input.customRecordId,
          source: 'series',
          seriesId: series!.id,
          occurrence: occ.index + 1,
          skipLock: true,
        });
        created.push(r.appointmentId);
        prefer ??= r.userIds;
      } catch (e) {
        if (!(e instanceof HfosError) || e.status !== 409) throw e;
        skipped.push({
          occurrence: occ.index + 1,
          date: occ.date,
          startsAt: iso(occ.startsAt),
          reason: skipReason(e),
        });
      }
    }
    if (!created.length)
      throw new HfosError(
        'conflict',
        409,
        'None of these dates fit.',
        { skipped },
        'series_no_fit',
      );
    const first = await requireAppointment(ctx.tx, ws, created[0]!);
    const eventId = await ctx.emit({
      type: 'series.created',
      entityType: 'appointment',
      entityId: series!.id,
      payload: {
        seriesId: series!.id,
        calendarId: calendar.id,
        appointmentIds: created,
        skipped: skipped.length,
        // The first visit's confirmation (handlers/appointment-messages.ts); the reminders go either way.
        notify: input.notify,
      },
      after: {
        ...(await appointmentSnapshot(ctx.tx, first)),
        occurrences: created.length,
        skipped: skipped.length,
      },
    });
    await logAppointmentActivity(ctx, first, 'appointment_booked', eventId, {
      meta: { seriesId: series!.id, occurrences: created.length },
    });
    return { seriesId: series!.id, appointmentIds: created, skipped };
  },
});

export const seriesCancel = defineCommand({
  name: 'series.cancel',
  description:
    'Cancel one occurrence of a series, it and the ones after it, or every upcoming one.',
  risk: 2,
  input: SeriesCancelInput,
  output: SeriesCancelOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['series.cancelled', 'waitlist.seat_freed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
    if (!appt.seriesId)
      throw HfosError.validation([
        { path: 'appointmentId', message: 'This appointment isn’t part of a series.' },
      ]);
    const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
    await lockBooking(ctx.tx, calendar.id);
    const now = await dbNow(ctx.tx);
    const scoped =
      input.scope === 'this'
        ? eq(appointments.id, appt.id)
        : input.scope === 'following'
          ? gte(appointments.occurrence, appt.occurrence ?? 1)
          : gte(appointments.startsAt, new Date(now));
    const list = await ctx.tx
      .select()
      .from(appointments)
      .where(
        and(eq(appointments.seriesId, appt.seriesId), eq(appointments.status, 'scheduled'), scoped),
      )
      .orderBy(asc(appointments.startsAt));
    const personIds = new Set<string>();
    for (const a of list) {
      const attendees = await ctx.tx
        .select({ personId: appointmentAttendees.personId })
        .from(appointmentAttendees)
        .where(
          and(
            eq(appointmentAttendees.appointmentId, a.id),
            eq(appointmentAttendees.status, 'booked'),
          ),
        );
      for (const p of attendees) personIds.add(p.personId);
      await markCancelled(ctx.tx, a.id);
    }
    const ids = list.map((a) => a.id);
    if (!ids.length) return { seriesId: appt.seriesId, cancelled: [] };
    const eventId = await ctx.emit({
      type: 'series.cancelled',
      entityType: 'appointment',
      entityId: appt.seriesId,
      payload: {
        seriesId: appt.seriesId,
        calendarId: appt.calendarId,
        scope: input.scope,
        appointmentIds: ids,
        personIds: [...personIds],
        reason: input.reason ?? null,
        notify: input.notify,
      },
      after: { title: appt.title, cancelled: ids.length, scope: input.scope },
    });
    await logAppointmentActivity(ctx, list[0]!, 'appointment_cancelled', eventId, {
      personIds: [...personIds],
      meta: { seriesId: appt.seriesId, cancelled: ids.length, reason: input.reason ?? null },
    });
    // Each freed 1:1 time goes to the people waiting for it, as when one visit is cancelled (appointment.cancel).
    for (const a of list)
      if (a.kind === 'booking' && a.capacity === 1) await signalSeatFreed(ctx, calendar, a);
    return { seriesId: appt.seriesId, cancelled: ids };
  },
});

export const waitlistAdd = defineCommand({
  name: 'waitlist.add',
  description:
    'Put a customer on a calendar’s waitlist: for a full session, or for a window they want.',
  risk: 1,
  input: WaitlistAddInput,
  output: WaitlistAddOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['waitlist.added'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const calendar = await loadCalendar(ctx.tx, ws, input.calendarId);
    if (!calendar.config.waitlist.enabled)
      throw HfosError.rule('waitlist_off', 409, 'This calendar’s waitlist is off.');
    const now = await dbNow(ctx.tx);
    if (input.appointmentId) {
      const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
      if (appt.calendarId !== calendar.id) throw HfosError.notFound('Appointment not found.');
      requireScheduled(appt);
      // A wait for a session ends when it starts (waitlist.expire), as the booking page says.
      if (appt.startsAt.getTime() <= now)
        throw HfosError.rule('session_started', 409, 'This session has already started.');
      const [live] = await ctx.tx
        .select({ id: waitlistEntries.id, position: waitlistEntries.position })
        .from(waitlistEntries)
        .where(
          and(
            eq(waitlistEntries.appointmentId, appt.id),
            eq(waitlistEntries.personId, input.personId),
            inArray(waitlistEntries.status, ['waiting', 'offered']),
          ),
        );
      if (live) return { entryId: live.id, position: live.position };
    } else {
      // The booking page's rule: a window of time that has all passed would only expire at once.
      const issue = wantedWindowIssue(
        Date.parse(input.wantedFrom!),
        Date.parse(input.wantedTo!),
        now,
      );
      // The words as the message too, so the Assistant and the API say what's wrong, not only the screen.
      if (issue) throw HfosError.validation([{ path: 'wantedTo', message: issue }], issue);
    }
    const contact = await attendeeFromPerson(ctx.tx, ws, input.personId, input.seats, 'staff');
    const [pos] = await rows<{ n: number }>(
      ctx.tx,
      sql`select coalesce(max(position), 0)::int + 1 as n from app.waitlist_entries
          where calendar_id = ${calendar.id} and status in ('waiting', 'offered')`,
    );
    const [row] = await ctx.tx
      .insert(waitlistEntries)
      .values({
        workspaceId: ws,
        calendarId: calendar.id,
        appointmentId: input.appointmentId ?? null,
        wantedFrom: input.wantedFrom ? new Date(input.wantedFrom) : null,
        wantedTo: input.wantedTo ? new Date(input.wantedTo) : null,
        personId: input.personId,
        seats: input.seats,
        position: pos?.n ?? 1,
        contactPhoneE164: contact.contactPhoneE164,
        contactEmail: contact.contactEmail,
        smsOk: contact.smsOk,
        source: staffSource(ctx),
        createdBy: me,
      })
      .returning({ id: waitlistEntries.id, position: waitlistEntries.position });
    if (!row) throw HfosError.forbidden();
    const person = await requirePerson(ctx.tx, ws, input.personId);
    await ctx.emit({
      type: 'waitlist.added',
      entityType: input.appointmentId ? 'appointment' : 'calendar',
      entityId: input.appointmentId ?? calendar.id,
      payload: {
        entryId: row.id,
        calendarId: calendar.id,
        personId: input.personId,
        seats: input.seats,
      },
      after: {
        customer: `${person.firstName} ${person.lastName}`.trim(),
        calendar: calendar.name,
        position: row.position,
        seats: input.seats,
      },
    });
    return { entryId: row.id, position: row.position };
  },
});

export const waitlistRemove = defineCommand({
  name: 'waitlist.remove',
  description: 'Take someone off a waitlist.',
  risk: 1,
  input: WaitlistRemoveInput,
  output: WaitlistRemoveOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['waitlist.removed', 'waitlist.seat_freed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const mine = and(eq(waitlistEntries.id, input.entryId), eq(waitlistEntries.workspaceId, ws));
    const [found] = await ctx.tx
      .select({ calendarId: waitlistEntries.calendarId })
      .from(waitlistEntries)
      .where(mine);
    if (!found) throw HfosError.notFound('Waitlist entry not found.');
    // The calendar's booking lock, then the entry's row, as taking an offer does (waitlist-offer.ts): a customer
    // taking their offer right now finishes first or waits for this, so their booking is never undone here.
    await lockBooking(ctx.tx, found.calendarId);
    const [entry] = await ctx.tx.select().from(waitlistEntries).where(mine).for('update');
    if (!entry) throw HfosError.notFound('Waitlist entry not found.');
    if (entry.status === 'booked')
      throw HfosError.rule(
        'already_booked',
        409,
        'They’re already booked from the waitlist. Cancel the booking instead.',
      );
    if (entry.status !== 'waiting' && entry.status !== 'offered') return { entryId: entry.id };
    await ctx.tx
      .update(waitlistEntries)
      .set({ status: 'removed' })
      .where(eq(waitlistEntries.id, entry.id));
    await ctx.emit({
      type: 'waitlist.removed',
      entityType: entry.appointmentId ? 'appointment' : 'calendar',
      entityId: entry.appointmentId ?? entry.calendarId,
      payload: { entryId: entry.id, calendarId: entry.calendarId, personId: entry.personId },
      before: { status: entry.status, position: entry.position },
      after: { status: 'removed' },
    });
    // Someone taken off while holding an offer lets go of the time, so it goes to the next person waiting for
    // it, as when an offer runs out (the worker offers it only while it’s still open).
    const offer =
      entry.status === 'offered' ? (entry.offer as { fromAppointmentId?: unknown }) : null;
    if (typeof offer?.fromAppointmentId === 'string') {
      const calendar = await loadCalendar(ctx.tx, ws, entry.calendarId);
      const freed = await requireAppointment(ctx.tx, ws, offer.fromAppointmentId);
      await signalSeatFreed(ctx, calendar, freed);
    }
    return { entryId: entry.id };
  },
});

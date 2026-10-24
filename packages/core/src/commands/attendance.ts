/**
 * Attendance one person at a time (funnels). A group session's attendees each join, attend or miss it on their
 * own; marking the whole appointment done or a no-show (appointment.set_status) stays for everybody else.
 *
 * - **Joined** is opening the session: the person's own Join link (the worker's /j/ page), or a teammate ticking
 *   it. Their seat stays booked, so capacity and reminders read it as they always have.
 * - **Attended** and **no-show** are how it went for them: a teammate's tick, or the worker at the session's end
 *   for everyone given a Join link (attended when they opened it).
 *
 * Each change is an event a workflow can start on, or wait for, for that one person: `attendee.joined` ("Were you
 * able to log on?" goes only to who hasn't), `attendee.attended` and `attendee.no_show`.
 */
import { and, eq, sql } from 'drizzle-orm';
import { appointmentAttendees } from '@hfos/db/schema';
import { logAppointmentActivity, requireAppointment } from '../calendar/appointments';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { AttendeeSetAttendanceInput, AttendeeSetAttendanceOutput } from '../schemas/calendar';

export const attendeeSetAttendance = defineCommand({
  name: 'attendee.set_attendance',
  description:
    'Mark one person on an appointment as joined (they opened the session), attended or a no-show, without changing anyone else on it.',
  risk: 1,
  input: AttendeeSetAttendanceInput,
  output: AttendeeSetAttendanceOutput,
  permission: 'appointments.write',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: ['attendee.joined', 'attendee.attended', 'attendee.no_show'],
  actors: ['human', 'system'],
  offline: 'anytime',
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [seat] = await ctx.tx
      .select()
      .from(appointmentAttendees)
      .where(
        and(
          eq(appointmentAttendees.id, input.attendeeId),
          eq(appointmentAttendees.workspaceId, ws),
        ),
      )
      .for('update');
    if (!seat)
      throw HfosError.notFound(
        'That booking isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    const appt = await requireAppointment(ctx.tx, ws, seat.appointmentId);
    if (seat.status === 'cancelled' || appt.status === 'cancelled')
      throw HfosError.rule(
        'booking_cancelled',
        409,
        'This booking was cancelled, so there’s no attendance to mark. Book them again if they’re coming.',
      );
    const out = (changed: boolean, row = seat) => ({
      appointmentId: appt.id,
      attendeeId: seat.id,
      status: row.status,
      joinedAt: row.joinedAt?.toISOString() ?? null,
      changed,
    });
    const payload = {
      personId: seat.personId,
      appointmentId: appt.id,
      calendarId: appt.calendarId,
      attendeeId: seat.id,
    };

    if (input.attendance === 'joined') {
      if (seat.joinedAt) return out(false);
      const [row] = await ctx.tx
        .update(appointmentAttendees)
        .set({ joinedAt: sql`now()` })
        .where(eq(appointmentAttendees.id, seat.id))
        .returning();
      await ctx.emit({
        type: 'attendee.joined',
        entityType: 'appointment',
        entityId: appt.id,
        payload,
        after: { title: appt.title, attendeeId: seat.id },
      });
      return out(true, row);
    }

    const status = input.attendance;
    if (seat.status === status) return out(false);
    const [row] = await ctx.tx
      .update(appointmentAttendees)
      .set({ status, attendanceSetAt: sql`now()` })
      .where(eq(appointmentAttendees.id, seat.id))
      .returning();
    const eventId = await ctx.emit({
      type: status === 'attended' ? 'attendee.attended' : 'attendee.no_show',
      entityType: 'appointment',
      entityId: appt.id,
      payload: { ...payload, from: seat.status, to: status },
      before: { status: seat.status },
      after: { title: appt.title, attendeeId: seat.id, status },
    });
    await logAppointmentActivity(
      ctx,
      appt,
      status === 'attended' ? 'attendee_attended' : 'attendee_no_show',
      eventId,
      { personIds: [seat.personId] },
    );
    return out(true, row);
  },
});

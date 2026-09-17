/**
 * Confirming a booking (M8). Staff mark it confirmed for the customer (attendee.confirm, whose Undo takes back only
 * a staff mark), and the customer presses Confirm on their manage link (attendee.confirm_online: the worker runs it
 * as the system actor after its own checks, like attendee.cancel_online). A customer's text (C, or YES while an ask
 * is open) confirms in message.receive. A booking that moves needs confirming again: 0041's triggers clear it.
 */
import { and, eq } from 'drizzle-orm';
import { sql } from '@hfos/db/client';
import { appointmentAttendees } from '@hfos/db/schema';
import {
  appointmentSnapshot,
  logAppointmentActivity,
  requireAppointment,
  requireScheduled,
  type AppointmentRow,
} from '../calendar/appointments';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import {
  AttendeeConfirmInput,
  AttendeeConfirmOnlineInput,
  AttendeeConfirmOnlineOutput,
  AttendeeConfirmOutput,
} from '../schemas/calendar';
import { loadBooked } from './appointment-online';

export type ConfirmedVia = 'sms' | 'link' | 'staff' | 'ai';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/**
 * Records that a seat was confirmed: `attendee.confirmed` (the worker clears the attention item, and thanks a
 * customer who texted) and a timeline entry on the customer. The caller has set the columns.
 */
export async function announceConfirmed(
  ctx: CommandContext,
  appt: AppointmentRow,
  attendee: { readonly id: string; readonly personId: string },
  via: ConfirmedVia,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const eventId = await ctx.emit({
    type: 'attendee.confirmed',
    entityType: 'appointment',
    entityId: appt.id,
    payload: {
      calendarId: appt.calendarId,
      attendeeId: attendee.id,
      personId: attendee.personId,
      via,
      by: via === 'staff' ? 'staff' : via === 'ai' ? 'ai' : 'customer',
      ...extra,
    },
    after: { ...(await appointmentSnapshot(ctx.tx, appt)), confirmedVia: via },
  });
  await logAppointmentActivity(ctx, appt, 'appointment_confirmed', eventId, {
    personIds: [attendee.personId],
    meta: { via },
  });
  return eventId;
}

type SeatRow = typeof appointmentAttendees.$inferSelect;

const confirmation = (appt: AppointmentRow, seat: SeatRow, changed: boolean) => ({
  appointmentId: appt.id,
  attendeeId: seat.id,
  confirmedAt: seat.confirmedAt?.toISOString() ?? null,
  confirmedVia: (seat.confirmedVia as ConfirmedVia | null) ?? null,
  changed,
});

export const attendeeConfirm = defineCommand({
  name: 'attendee.confirm',
  description:
    'Mark a booking confirmed for the customer (they said so on the phone, say), or take back a confirmation someone on the team marked. A customer’s own confirmation stays.',
  risk: 1,
  input: AttendeeConfirmInput,
  output: AttendeeConfirmOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['attendee.confirmed', 'attendee.confirmation_removed'],
  offline: 'anytime',
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
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
    if (!seat) throw HfosError.notFound('Booking not found.');
    const appt = await requireAppointment(ctx.tx, ws, seat.appointmentId);
    if (input.confirmed) {
      if (seat.confirmedAt) return confirmation(appt, seat, false);
      if (seat.status === 'cancelled')
        throw HfosError.rule('booking_cancelled', 409, 'This booking was cancelled.');
      requireScheduled(appt);
      // The database stamps the time, at the moment the person marked it (0062); the mark is in this person's name.
      const [row] = await ctx.tx
        .update(appointmentAttendees)
        .set({ confirmedAt: changeMoment(ctx.meta), confirmedVia: 'staff', confirmedBy: me })
        .where(eq(appointmentAttendees.id, seat.id))
        .returning();
      await announceConfirmed(ctx, appt, seat, 'staff', { confirmedBy: me });
      return confirmation(appt, row!, true);
    }
    if (!seat.confirmedAt) return confirmation(appt, seat, false);
    if (seat.confirmedVia !== 'staff')
      throw HfosError.rule(
        'confirmation_not_staff',
        409,
        'The customer confirmed this themselves, so it stays confirmed.',
      );
    const [row] = await ctx.tx
      .update(appointmentAttendees)
      .set({ confirmedAt: null, confirmedVia: null, confirmedBy: null })
      .where(eq(appointmentAttendees.id, seat.id))
      .returning();
    const eventId = await ctx.emit({
      type: 'attendee.confirmation_removed',
      entityType: 'appointment',
      entityId: appt.id,
      payload: {
        calendarId: appt.calendarId,
        attendeeId: seat.id,
        personId: seat.personId,
        via: 'staff',
      },
      before: { confirmedVia: 'staff', confirmedBy: seat.confirmedBy },
      after: { ...(await appointmentSnapshot(ctx.tx, appt)), confirmedVia: null },
    });
    await logAppointmentActivity(ctx, appt, 'appointment_confirmation_removed', eventId, {
      personIds: [seat.personId],
    });
    return confirmation(appt, row!, true);
  },
});

export const attendeeConfirmOnline = defineCommand({
  name: 'attendee.confirm_online',
  description:
    'A customer confirms their booking with the Confirm button on their manage link (the worker runs this for them). Once is enough; pressing it again changes nothing.',
  risk: 1,
  input: AttendeeConfirmOnlineInput,
  output: AttendeeConfirmOnlineOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['attendee.confirmed'],
  actors: ['system'],
  async handler(ctx, input) {
    // Two presses at once confirm once.
    await ctx.tx.execute(
      sql`select 1 from app.appointment_attendees where id = ${input.attendeeId}
          and workspace_id = ${ctx.scope.workspaceId!} for update`,
    );
    const { att, appt } = await loadBooked(ctx, input.attendeeId, input.manageVersion);
    if (appt.startsAt.getTime() <= Date.now())
      throw HfosError.rule('appointment_started', 409, 'This appointment has already started.');
    if (att.confirmedAt) return confirmation(appt, att, false);
    const [row] = await ctx.tx
      .update(appointmentAttendees)
      .set({ confirmedAt: new Date(), confirmedVia: 'link', confirmedBy: null })
      .where(eq(appointmentAttendees.id, att.id))
      .returning();
    await announceConfirmed(ctx, appt, att, 'link');
    return confirmation(appt, row!, true);
  },
});

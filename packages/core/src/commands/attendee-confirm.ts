/**
 * Confirming a booking (M8). Staff mark it confirmed for the customer (attendee.confirm, whose Undo takes back only
 * a staff mark), and the customer presses Confirm on their manage link (attendee.confirm_online: the worker runs it
 * as the system actor after its own checks, like attendee.cancel_online). A customer's text (C, or YES while an ask
 * is open) confirms in message.receive. A booking that moves needs confirming again: 0041's triggers clear it.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { sql } from '@hfos/db/client';
import { appointmentAttendees } from '@hfos/db/schema';
import {
  appointmentSnapshot,
  logAppointmentActivity,
  requireAppointment,
  requireScheduled,
  type AppointmentRow,
} from '../calendar/appointments';
import { userRef } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changedSince, logLaterChange, whoChangedIt } from '../kernel/later-change';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import {
  AttendeeConfirmInput,
  AttendeeConfirmOnlineInput,
  AttendeeConfirmOnlineOutput,
  AttendeeConfirmOutput,
} from '../schemas/calendar';
import { uuid } from '../schemas/common';
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
    if (!seat)
      throw HfosError.notFound(
        'That booking isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    const appt = await requireAppointment(ctx.tx, ws, seat.appointmentId);
    const on = { personId: seat.personId, leadId: appt.leadId };
    if (input.confirmed) {
      if (seat.confirmedAt) return confirmation(appt, seat, false);
      if (seat.status === 'cancelled')
        throw HfosError.rule(
          'booking_cancelled',
          409,
          'This booking was cancelled, so there’s nothing to confirm. Book them again if they still need a visit.',
        );
      requireScheduled(appt);
      // Moved to another time after this was marked (on a phone, perhaps long before it had signal): the customer
      // said yes to the old time, so it stays unconfirmed.
      if (changedSince(ctx.meta, appt.rescheduledAt)) {
        const who = await whoChangedIt(
          ctx.tx,
          { type: 'appointment', id: appt.id },
          ['appointment.rescheduled'],
          appt.rescheduledAt,
        );
        await logLaterChange(
          ctx,
          {
            key: 'confirmed',
            tried: 'mark the visit confirmed',
            because: `${who ? `${who} moved it` : 'it was moved'} to another time after that`,
            changedAt: appt.rescheduledAt,
          },
          { type: 'appointment', id: appt.id },
          on,
        );
        return { ...confirmation(appt, seat, false), notApplied: ['confirmed'] };
      }
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
    // Confirmed again after this was taken back (on a phone, perhaps long before it had signal): that stands.
    if (changedSince(ctx.meta, seat.confirmedAt)) {
      const who =
        seat.confirmedVia === 'staff'
          ? (await userRef(ctx.tx, seat.confirmedBy))?.fullName
          : 'the customer';
      await logLaterChange(
        ctx,
        {
          key: 'confirmed',
          tried: 'take back the visit’s confirmation',
          because: `${who ? `${who} confirmed it` : 'it was confirmed'} again after that`,
          changedAt: seat.confirmedAt,
        },
        { type: 'appointment', id: appt.id },
        on,
      );
      return { ...confirmation(appt, seat, false), notApplied: ['confirmed'] };
    }
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
      throw HfosError.rule(
        'appointment_started',
        409,
        'This appointment has already started, so there’s nothing left to confirm.',
      );
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

/** attendee.confirm_by_call: the customer said yes on a call the AI teammate placed to confirm it. */
export const AttendeeConfirmByCallInput = z.object({ workspaceId: uuid, attendeeId: uuid });

export const attendeeConfirmByCall = defineCommand({
  name: 'attendee.confirm_by_call',
  description:
    'Worker: the customer confirmed their visit on a call the AI teammate placed to ask. Once is enough.',
  risk: 1,
  input: AttendeeConfirmByCallInput,
  output: AttendeeConfirmOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['attendee.confirmed'],
  actors: ['system'],
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
    if (!seat) throw HfosError.notFound('Booking not found.');
    const appt = await requireAppointment(ctx.tx, ws, seat.appointmentId);
    if (seat.confirmedAt) return confirmation(appt, seat, false);
    if (seat.status === 'cancelled')
      throw HfosError.rule(
        'booking_cancelled',
        409,
        'This booking was cancelled, so there’s nothing to confirm. Offer them a new time if they still want one.',
      );
    requireScheduled(appt);
    if (appt.startsAt.getTime() <= Date.now())
      throw HfosError.rule(
        'appointment_started',
        409,
        'This appointment has already started, so it can’t be confirmed now.',
      );
    const [row] = await ctx.tx
      .update(appointmentAttendees)
      .set({ confirmedAt: new Date(), confirmedVia: 'ai', confirmedBy: null })
      .where(eq(appointmentAttendees.id, seat.id))
      .returning();
    await announceConfirmed(ctx, appt, seat, 'ai', { byCall: true });
    return confirmation(appt, row!, true);
  },
});

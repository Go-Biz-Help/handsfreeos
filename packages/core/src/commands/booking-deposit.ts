/**
 * A time held while a customer pays for it, and what happens at the end of the hold.
 *
 * Chris's rule, in two commands: **a card is held, not charged, until the time is confirmed**, and
 * `booking.confirm_deposit` is the moment it is confirmed — one transaction that checks the time is still the
 * customer's, issues the deposit invoice and tells everyone the booking is real. The worker captures the card
 * only after this has committed, so a time that goes while they are typing costs them nothing.
 *
 * `booking.release_hold` is the other end: the expiry job, or a payment that never came. It gives the time
 * back without a word to the customer — nobody was ever told they had it — and withdraws the draft invoice
 * that was going to be the deposit.
 *
 * Both are the worker's alone. A held booking is a real appointment holding a real slot; what makes it a hold
 * rather than a booking is that nothing was announced and its deposit invoice is still a draft.
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { appointmentAttendees, appointments, invoices } from '@hfos/db/schema';
import {
  cancelAppointment,
  markCancelled,
  othersBooked,
  requireAppointment,
  signalSeatFreed,
  staffIdsOf,
} from '../calendar/appointments';
import { lockBooking } from '../calendar/booking';
import { loadCalendar } from '../calendar/load';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import {
  BookingConfirmDepositInput,
  BookingConfirmDepositOutput,
  BookingReleaseHoldInput,
  BookingReleaseHoldOutput,
} from '../schemas/calendar';
import { announceBooked } from './appointment';
import { DEPOSIT_HOLD_JOB, depositHoldKey } from './appointment-online';
import { invoiceSend } from './invoice';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const holdLost = () =>
  HfosError.rule(
    'booking_hold_lost',
    409,
    'That time has gone. Nothing was charged — pick another time and we’ll hold that one.',
  );

type HeldRow = {
  attendee: typeof appointmentAttendees.$inferSelect;
  appointment: typeof appointments.$inferSelect;
};

async function heldBooking(ctx: CommandContext, attendeeId: string): Promise<HeldRow | null> {
  const ws = ctx.scope.workspaceId!;
  const [att] = await ctx.tx
    .select()
    .from(appointmentAttendees)
    .where(and(eq(appointmentAttendees.id, attendeeId), eq(appointmentAttendees.workspaceId, ws)));
  if (!att) return null;
  const appt = await requireAppointment(ctx.tx, ws, att.appointmentId);
  return { attendee: att, appointment: appt };
}

/** The deposit invoice raised for a booking: a draft is a hold still waiting, anything else was paid for. */
async function depositInvoice(ctx: CommandContext, attendeeId: string) {
  const [row] = await ctx.tx
    .select({
      id: invoices.id,
      status: invoices.status,
      number: invoices.number,
      amountPaidCents: invoices.amountPaidCents,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.workspaceId, ctx.scope.workspaceId!),
        eq(invoices.attendeeId, attendeeId),
        eq(invoices.origin, 'booking'),
      ),
    )
    .orderBy(invoices.createdAt)
    .limit(1);
  return row ?? null;
}

/** The hold is over, either way: the job that would have given the time back has nothing left to do. */
async function dropHoldJob(ctx: CommandContext, attendeeId: string): Promise<void> {
  await ctx.tx.execute(
    sql`update app.scheduled_jobs set status = 'cancelled'
        where kind = ${DEPOSIT_HOLD_JOB} and dedupe_key = ${depositHoldKey(attendeeId)}
          and status = 'pending'`,
  );
}

export const bookingConfirmDeposit = defineCommand({
  name: 'booking.confirm_deposit',
  description:
    'Worker: the deposit is in hand, so the held time becomes a real booking. Checks the time is still theirs, issues the deposit invoice and announces the booking — all in one transaction, so the card is captured only once this has stood.',
  risk: 2,
  input: BookingConfirmDepositInput,
  output: BookingConfirmDepositOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.booked', 'invoice.sent'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const found = await heldBooking(ctx, input.attendeeId);
    if (!found) throw holdLost();
    const { attendee, appointment } = found;
    // Serialised against every other booking on this calendar, so the check and the confirmation are one act.
    await lockBooking(ctx.tx, appointment.calendarId);
    const fresh = await heldBooking(ctx, input.attendeeId);
    if (
      !fresh ||
      fresh.attendee.status !== 'booked' ||
      fresh.appointment.status !== 'scheduled' ||
      fresh.appointment.startsAt.getTime() <= Date.now()
    )
      throw holdLost();

    const invoice = await depositInvoice(ctx, input.attendeeId);
    if (!invoice || invoice.id !== input.invoiceId)
      throw HfosError.notFound('That deposit doesn’t belong to this booking.');
    // Already confirmed (a second attempt, or a repeated press): the answer is the booking it already made.
    if (invoice.status !== 'draft') {
      await dropHoldJob(ctx, input.attendeeId);
      return {
        appointmentId: appointment.id,
        attendeeId: attendee.id,
        invoiceId: invoice.id,
        confirmed: false,
        number: invoice.number,
      };
    }

    // Issued here and not when the hold was taken: a draft is what says "still being paid for", and a number
    // belongs to a document that is really out. No channels: they are on the page, paying, right now.
    const { output: sent } = await executeCommandWithin(ctx, invoiceSend, {
      workspaceId: ws,
      invoiceId: invoice.id,
      channels: [],
    });
    await dropHoldJob(ctx, input.attendeeId);
    const calendar = await loadCalendar(ctx.tx, ws, appointment.calendarId);
    await announceBooked(
      ctx,
      {
        appointmentId: appointment.id,
        attendeeId: attendee.id,
        manageVersion: attendee.manageVersion,
        userIds: await staffIdsOf(ctx.tx, appointment.id),
        startsAt: appointment.startsAt.getTime(),
        endsAt: appointment.endsAt.getTime(),
        serviceId: appointment.serviceId,
        title: appointment.title,
        joined: false,
        duplicate: false,
        warnings: [],
      },
      'appointment_booked_online',
      {
        joined: false,
        personCreated: false,
        leadId: appointment.leadId,
        smsOk: attendee.smsOk,
        depositInvoiceId: invoice.id,
        calendarName: calendar.name,
      },
      [attendee.personId],
    );
    return {
      appointmentId: appointment.id,
      attendeeId: attendee.id,
      invoiceId: invoice.id,
      confirmed: true,
      number: sent.number,
    };
  },
});

export const bookingReleaseHold = defineCommand({
  name: 'booking.release_hold',
  description:
    'Worker: a held time nobody paid for goes back on the calendar, and the draft deposit invoice behind it is withdrawn. Nothing is said to the customer — they were never told the time was theirs.',
  risk: 2,
  input: BookingReleaseHoldInput,
  output: BookingReleaseHoldOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.cancelled', 'attendee.cancelled', 'invoice.voided', 'waitlist.seat_freed'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const found = await heldBooking(ctx, input.attendeeId);
    if (!found) return { attendeeId: input.attendeeId, released: false };
    const { attendee, appointment } = found;
    await lockBooking(ctx.tx, appointment.calendarId);
    const invoice = await depositInvoice(ctx, input.attendeeId);
    // Paid for, or on its way: the hold became a booking and this has nothing to give back.
    if (
      attendee.status !== 'booked' ||
      appointment.status !== 'scheduled' ||
      (invoice && invoice.status !== 'draft')
    ) {
      await dropHoldJob(ctx, input.attendeeId);
      return { attendeeId: attendee.id, released: false };
    }
    await dropHoldJob(ctx, input.attendeeId);
    // A draft that was going to be the deposit is withdrawn — but only while nothing has been attempted
    // against it. Once there is a payment row the ledger has something to say, and the pay route finishes
    // the story (it gives the money back and withdraws the draft itself if nothing landed).
    const [attempted] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.payments where invoice_id = ${invoice?.id ?? null}::uuid`,
    );
    if (invoice && (attempted?.n ?? 0) === 0) {
      await ctx.tx
        .update(invoices)
        .set({
          status: 'void',
          voidedAt: dsql`now()`,
          voidReason: input.reason ?? 'The deposit wasn’t paid, so the time went back.',
        })
        .where(eq(invoices.id, invoice.id));
      await ctx.emit({
        type: 'invoice.voided',
        entityType: 'invoice',
        entityId: invoice.id,
        payload: {
          invoiceId: invoice.id,
          personId: attendee.personId,
          reason: input.reason ?? null,
        },
        before: { status: 'draft' },
        after: { status: 'void', reason: input.reason ?? null },
      });
    }

    const calendar = await loadCalendar(ctx.tx, ws, appointment.calendarId);
    // Never a word to the customer: a hold was never a confirmed booking, so there is nothing to un-say.
    if (
      appointment.kind === 'booking' &&
      (await othersBooked(ctx.tx, appointment.id, attendee.id)) === 0
    ) {
      await cancelAppointment(ctx, appointment, {
        reason: input.reason ?? 'The deposit wasn’t paid in time.',
        notify: false,
        by: 'calendar_change',
      });
      if (appointment.capacity === 1) await signalSeatFreed(ctx, calendar, appointment);
      return { attendeeId: attendee.id, released: true };
    }
    await ctx.tx
      .update(appointmentAttendees)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(appointmentAttendees.id, attendee.id));
    const [after] = await ctx.tx
      .update(appointments)
      .set({ seatsTaken: dsql`greatest(${appointments.seatsTaken} - ${attendee.seats}, 0)` })
      .where(eq(appointments.id, appointment.id))
      .returning();
    if (
      appointment.kind === 'booking' &&
      (await othersBooked(ctx.tx, appointment.id, attendee.id)) === 0
    )
      await markCancelled(ctx.tx, appointment.id);
    await ctx.emit({
      type: 'attendee.cancelled',
      entityType: 'appointment',
      entityId: appointment.id,
      payload: {
        calendarId: appointment.calendarId,
        attendeeId: attendee.id,
        personId: attendee.personId,
        seats: attendee.seats,
        reason: input.reason ?? null,
        notify: false,
        by: 'calendar_change',
      },
    });
    if (after) await signalSeatFreed(ctx, calendar, after);
    return { attendeeId: attendee.id, released: true };
  },
});

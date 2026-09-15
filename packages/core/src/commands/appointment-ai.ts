/**
 * The AI teammate books, moves and cancels for the customer it's talking to (M7). These share the booking
 * page's internals: its locks and bookAppointment, the clientId lookup, its caps, leadFor, the booked
 * announcement, and the calendar's notice, horizon and policies. The customer is always the person in the
 * conversation the teammate is answering, never an id the model gave; the calendar must be one the teammate's
 * settings list, read from the database; and nothing here ever grants SMS consent.
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { appointmentAttendees, appointments } from '@hfos/db/schema';
import {
  AI_TEAMMATE_SOURCE,
  assertTeammateCalendar,
  chatIdentityUnverified,
  requireAiConversation,
} from '../ai-team/reach';
import { bookAppointment, findBookingByClientId, type AttendeeDraft } from '../calendar/booking';
import { loadCalendar, resolveService } from '../calendar/load';
import { bookableDurations, defaultLocationKind } from '../calendar/terms';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { aiEmployeeOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { AiEmployeeActor, CommandContext } from '../kernel/types';
import { isOptedOut } from '../messaging/store';
import {
  AppointmentBookForCustomerInput,
  AppointmentBookForCustomerOutput,
  AttendeeCancelForCustomerInput,
  AttendeeCancelForCustomerOutput,
  AttendeeRescheduleForCustomerInput,
  AttendeeRescheduleForCustomerOutput,
} from '../schemas/ai-team';
import { announceBooked } from './appointment';
import {
  assertBookable,
  bookingOutput,
  cancelBooking,
  enforceCaps,
  leadFor,
  loadBooked,
  rescheduleBooking,
} from './appointment-online';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

function aiOf(ctx: CommandContext): AiEmployeeActor {
  const ai = aiEmployeeOf(ctx.actor);
  if (!ai) throw HfosError.forbidden('Only the AI teammate books this way.');
  return ai;
}

/** The customer in the conversation the AI teammate is answering, while it still handles it. */
async function customerOf(ctx: CommandContext, ai: AiEmployeeActor) {
  const conv = await requireAiConversation(ctx, ai);
  if (!conv.personId)
    throw HfosError.rule(
      'no_customer',
      409,
      'Link this conversation to a customer before booking for them.',
    );
  return { conv, person: await requirePerson(ctx.tx, ctx.scope.workspaceId!, conv.personId) };
}

/** That customer's own booking on an appointment (the model names the appointment, never the person). */
async function customerBooking(ctx: CommandContext, ai: AiEmployeeActor, appointmentId: string) {
  const { conv, person } = await customerOf(ctx, ai);
  // Anyone can type someone else's number into a website chat, so a chat never changes existing bookings
  // (the customer's manage link does).
  if (conv.channel === 'chat') throw chatIdentityUnverified();
  const [att] = await ctx.tx
    .select({ id: appointmentAttendees.id })
    .from(appointmentAttendees)
    .where(
      and(
        eq(appointmentAttendees.workspaceId, ctx.scope.workspaceId!),
        eq(appointmentAttendees.appointmentId, appointmentId),
        eq(appointmentAttendees.personId, person.id),
        eq(appointmentAttendees.status, 'booked'),
      ),
    )
    .limit(1);
  if (!att) throw HfosError.forbidden('That booking isn’t this customer’s.', 'not_this_customer');
  return loadBooked(ctx, att.id);
}

/** The links in confirmations sent before the change stop working, so only the newest one manages it. */
async function bumpManageVersion(ctx: CommandContext, attendeeId: string): Promise<void> {
  await ctx.tx
    .update(appointmentAttendees)
    .set({ manageVersion: dsql`${appointmentAttendees.manageVersion} + 1` })
    .where(eq(appointmentAttendees.id, attendeeId));
}

export const appointmentBookForCustomer = defineCommand({
  name: 'appointment.book_for_customer',
  description:
    'The AI teammate books the customer it’s talking to at a time one of its calendars offers, under the booking page’s rules and limits. The customer gets the usual confirmation.',
  risk: 2,
  input: AppointmentBookForCustomerInput,
  output: AppointmentBookForCustomerOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.booked', 'lead.created'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const ai = aiOf(ctx);
    const ws = ctx.scope.workspaceId!;
    await assertTeammateCalendar(ctx.tx, ai, input.calendarId);
    const { conv, person } = await customerOf(ctx, ai);
    const calendar = await loadCalendar(ctx.tx, ws, input.calendarId);
    assertBookable(calendar);
    const earlier = await findBookingByClientId(ctx.tx, ws, input.clientId);
    if (earlier?.attendeeId) return bookingOutput(ctx.tx, earlier, false);
    const { config } = calendar;
    const service = await resolveService(ctx.tx, calendar, input.serviceId);
    if (
      input.durationMinutes !== undefined &&
      !bookableDurations(config, service).includes(input.durationMinutes)
    )
      throw HfosError.validation([
        { path: 'durationMinutes', message: 'Pick one of the lengths offered.' },
      ]);
    const phone = person.phoneE164;
    const email = person.email;
    await enforceCaps(ctx.tx, ws, calendar.id, phone, email);
    // Texts about the booking go only to a number that never said STOP and that opted in or is texting us
    // right now. The customer's consent itself never changes here.
    const stopped = phone ? await isOptedOut(ctx.tx, ws, phone) : false;
    const smsOk =
      !!phone &&
      !stopped &&
      person.smsConsent !== 'opted_out' &&
      (person.smsConsent === 'opted_in' || conv.channel === 'sms');
    const attendee: AttendeeDraft = {
      personId: person.id,
      seats: 1,
      intake: {},
      contactPhoneE164: phone,
      contactEmail: email,
      smsOk,
      // Filed under its own source; it counts in the booking page's caps and gets its confirmations.
      source: 'ai_teammate',
    };
    const result = await bookAppointment(ctx, {
      calendar,
      startsAt: Date.parse(input.startsAt),
      sessionId: input.sessionId ?? null,
      serviceId: service?.id ?? null,
      durationMinutes: input.durationMinutes,
      partySize: 1,
      locationKind: defaultLocationKind(config),
      choice: { mode: 'customer' },
      attendee,
      notes: input.notes ?? null,
      clientId: input.clientId,
      source: 'ai_teammate',
    });
    if (result.duplicate) return bookingOutput(ctx.tx, result, false);
    const host = result.userIds[0] ?? null;
    const owner =
      config.crm.ownership === 'assigned_staff'
        ? (host ?? calendar.ownerUserId)
        : config.crm.ownership === 'calendar_owner'
          ? calendar.ownerUserId
          : null;
    let leadId: string | null = null;
    if (config.crm.createLead && !result.joined) {
      leadId = await leadFor(
        ctx,
        person.id,
        config.crm.createLead,
        `${result.title} (booked by ${ai.teammateName})`,
        owner,
        AI_TEAMMATE_SOURCE,
      );
      if (leadId)
        await ctx.tx
          .update(appointments)
          .set({ leadId })
          .where(eq(appointments.id, result.appointmentId));
    }
    await announceBooked(
      ctx,
      result,
      'appointment_booked',
      { joined: result.joined, personCreated: false, leadId, smsOk, by: 'ai_teammate' },
      [person.id],
    );
    return bookingOutput(ctx.tx, result, false);
  },
});

export const attendeeRescheduleForCustomer = defineCommand({
  name: 'attendee.reschedule_for_customer',
  description:
    'The AI teammate moves a booking of the customer it’s talking to, on one of its calendars, within the calendar’s reschedule policy.',
  risk: 2,
  input: AttendeeRescheduleForCustomerInput,
  output: AttendeeRescheduleForCustomerOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.rescheduled', 'attendee.rescheduled', 'waitlist.seat_freed'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const ai = aiOf(ctx);
    const booked = await customerBooking(ctx, ai, input.appointmentId);
    const config = await assertTeammateCalendar(ctx.tx, ai, booked.calendar.id);
    if (!config.book.reschedule)
      throw HfosError.rule(
        'reschedule_off',
        409,
        'The AI teammate doesn’t move bookings. Someone on the team can.',
      );
    const moved = await rescheduleBooking(ctx, booked, input);
    await bumpManageVersion(ctx, moved.attendeeId);
    return moved;
  },
});

export const attendeeCancelForCustomer = defineCommand({
  name: 'attendee.cancel_for_customer',
  description:
    'The AI teammate cancels a booking of the customer it’s talking to, on one of its calendars, within the calendar’s cancellation policy.',
  risk: 2,
  input: AttendeeCancelForCustomerInput,
  output: AttendeeCancelForCustomerOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.cancelled', 'attendee.cancelled', 'waitlist.seat_freed'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const ai = aiOf(ctx);
    const booked = await customerBooking(ctx, ai, input.appointmentId);
    const config = await assertTeammateCalendar(ctx.tx, ai, booked.calendar.id);
    if (!config.book.cancel)
      throw HfosError.rule(
        'cancel_off',
        409,
        'The AI teammate doesn’t cancel bookings. Someone on the team can.',
      );
    const cancelled = await cancelBooking(ctx, booked, input);
    await bumpManageVersion(ctx, booked.att.id);
    return cancelled;
  },
});

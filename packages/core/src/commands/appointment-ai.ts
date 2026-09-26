/**
 * The AI teammate books, moves and cancels for the customer it's talking to (M7). These share the booking
 * page's internals: its locks and bookAppointment, the clientId lookup, its caps, leadFor, the booked
 * announcement, and the calendar's notice, horizon and policies. The customer is always the person in the
 * conversation the teammate is answering, never an id the model gave; the calendar must be one the teammate's
 * settings list, read from the database; and nothing here ever grants SMS consent.
 */
import { and, asc, eq, inArray, sql as dsql } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import {
  appointmentAttendees,
  appointments,
  appointmentSeries,
  appointmentServices,
  waitlistEntries,
} from '@hfos/db/schema';
import {
  AI_TEAMMATE_SOURCE,
  assertTeammateCalendar,
  assertTeammateMayBook,
  chatIdentityUnverified,
  chatVerified,
  requireAiConversation,
} from '../ai-team/reach';
import {
  appointmentSnapshot,
  requireAppointment,
  requireScheduled,
  staffIdsOf,
} from '../calendar/appointments';
import {
  bookAppointment,
  findBookingByClientId,
  lockBooking,
  type AttendeeDraft,
  type BookingResult,
} from '../calendar/booking';
import { expandRecurrence, RecurrenceRule } from '../calendar/engine/recurrence';
import { localDateOf, zonedParts } from '../calendar/engine/zoned';
import { loadCalendar, resolveService } from '../calendar/load';
import { bookableDurations, defaultLocationKind, resolveTerms } from '../calendar/terms';
import { leadFor } from '../crm/intake';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { aiEmployeeOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandIn } from '../kernel/execute';
import type { AiEmployeeActor, CommandContext, RequestMeta } from '../kernel/types';
import { isOptedOut } from '../messaging/store';
import {
  AppointmentAddForCustomerInput,
  AppointmentAddForCustomerOutput,
  AppointmentBookForCustomerInput,
  AppointmentBookForCustomerOutput,
  AttendeeCancelForCustomerInput,
  AttendeeCancelForCustomerOutput,
  AttendeeRescheduleForCustomerInput,
  AttendeeRescheduleForCustomerOutput,
  type DraftAction,
  SeriesBookForCustomerInput,
  SeriesBookForCustomerOutput,
  WaitlistJoinForCustomerInput,
  WaitlistJoinForCustomerOutput,
} from '../schemas/ai-team';
import { announceBooked, checkExisting } from './appointment';
import { wantedWindowIssue } from './waitlist-online';
import {
  estimateAnswerForCustomer,
  estimateCreateForCustomer,
  invoiceCreateForCustomer,
  subscriptionStartForCustomer,
} from './money-ai';
import {
  assertBookable,
  bookingOutput,
  cancelBooking,
  enforceCaps,
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
  // Anyone can type someone else's number into a website chat, so a chat changes existing bookings only once
  // its visitor typed back the code sent to the customer (M18); otherwise the customer's manage link does.
  if (!(await chatVerified(ctx.tx, conv))) throw chatIdentityUnverified();
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

/**
 * The customer as a booking's (or a waitlist place's) contact. Texts about it go only to a number that never
 * said STOP and that opted in or is texting us right now; the customer's consent itself never changes here.
 * Filed under the teammate's own source, so it counts in the booking page's caps and gets its confirmations.
 */
async function customerAttendee(
  ctx: CommandContext,
  conv: { readonly channel: string },
  person: {
    readonly id: string;
    readonly phoneE164: string | null;
    readonly email: string | null;
    readonly smsConsent: string;
  },
): Promise<AttendeeDraft> {
  const phone = person.phoneE164;
  const stopped = phone ? await isOptedOut(ctx.tx, ctx.scope.workspaceId!, phone) : false;
  const smsOk =
    !!phone &&
    !stopped &&
    person.smsConsent !== 'opted_out' &&
    (person.smsConsent === 'opted_in' || conv.channel === 'sms');
  return {
    personId: person.id,
    seats: 1,
    intake: {},
    contactPhoneE164: phone,
    contactEmail: person.email,
    smsOk,
    source: 'ai_teammate',
  };
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
    // Its calendars, and never one that asks for a deposit: that is paid on the customer's own page.
    await assertTeammateMayBook(ctx.tx, ai, input.calendarId, input.serviceId ?? null);
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
    await enforceCaps(ctx.tx, ws, calendar.id, person.phoneE164, person.email);
    const attendee = await customerAttendee(ctx, conv, person);
    const smsOk = attendee.smsOk;
    const result = await bookAppointment(ctx, {
      calendar,
      startsAt: Date.parse(input.startsAt),
      sessionId: input.sessionId ?? null,
      serviceId: service?.id ?? null,
      durationMinutes: input.durationMinutes,
      partySize: 1,
      locationKind: defaultLocationKind(config),
      postalCode: input.postalCode ?? null,
      point: input.point ?? null,
      choice: { mode: 'customer' },
      attendee,
      notes: input.notes ?? null,
      clientId: input.clientId,
      source: 'ai_teammate',
    });
    if (result.duplicate) return bookingOutput(ctx.tx, result, false);
    const leadId = await bookingLead(ctx, ai, calendar, result, person.id);
    if (leadId)
      await ctx.tx
        .update(appointments)
        .set({ leadId })
        .where(eq(appointments.id, result.appointmentId));
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
    // A move onto a paying calendar is a booking like any other: it takes a deposit, so it isn't its to make.
    const config = await assertTeammateMayBook(
      ctx.tx,
      ai,
      booked.calendar.id,
      booked.appt.serviceId,
    );
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

/** The lead a booking opens, when its calendar opens one, for the owner its settings name. */
async function bookingLead(
  ctx: CommandContext,
  ai: AiEmployeeActor,
  calendar: Awaited<ReturnType<typeof loadCalendar>>,
  result: { readonly userIds: readonly string[]; readonly title: string; readonly joined: boolean },
  personId: string,
): Promise<string | null> {
  const { config } = calendar;
  if (!config.crm.createLead || result.joined) return null;
  const host = result.userIds[0] ?? null;
  const owner =
    config.crm.ownership === 'assigned_staff'
      ? (host ?? calendar.ownerUserId)
      : config.crm.ownership === 'calendar_owner'
        ? calendar.ownerUserId
        : null;
  return leadFor(
    ctx,
    personId,
    config.crm.createLead,
    `${result.title} (booked by ${ai.teammateName})`,
    owner,
    AI_TEAMMATE_SOURCE,
  );
}

const HH_MM = (at: number, timeZone: string) => {
  const p = zonedParts(at, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/**
 * M18: repeat visits for the customer the AI teammate is talking to. Only where the calendar lets customers
 * repeat (`recurring.customerSeries`) and the teammate's settings allow it (`book.repeats`), never on a calendar
 * that takes money, and never more than the calendar's own limit. The first visit must fit (the teammate offered
 * it); later ones that don't are skipped and reported, as a series a person books is. The customer gets the first
 * visit's confirmation and reminders for all of them.
 */
export const seriesBookForCustomer = defineCommand({
  name: 'series.book_for_customer',
  description:
    'The AI teammate books repeat visits (weekly, or monthly on the same weekday) for the customer it’s talking to, on one of its calendars that lets customers repeat. The first visit is a time the calendar offers; later ones that don’t fit are skipped.',
  risk: 2,
  input: SeriesBookForCustomerInput,
  output: SeriesBookForCustomerOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.booked', 'series.created', 'lead.created'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const ai = aiOf(ctx);
    const ws = ctx.scope.workspaceId!;
    const teammate = await assertTeammateMayBook(ctx.tx, ai, input.calendarId, input.serviceId);
    if (!teammate.book.repeats)
      throw HfosError.rule(
        'repeats_off',
        409,
        'The AI teammate doesn’t book repeat visits. Someone on the team can.',
      );
    const { conv, person } = await customerOf(ctx, ai);
    const calendar = await loadCalendar(ctx.tx, ws, input.calendarId);
    assertBookable(calendar);
    const { config } = calendar;
    if (!config.recurring.customerSeries || config.schedule.mode === 'sessions')
      throw HfosError.rule(
        'series_off',
        409,
        `${calendar.name} doesn’t let customers repeat a visit. Book one visit instead.`,
      );
    // Once: the first visit carries the clientId, and a retry finds its series.
    const earlier = await findBookingByClientId(ctx.tx, ws, input.clientId);
    if (earlier?.attendeeId) {
      const [first] = await ctx.tx
        .select({ seriesId: appointments.seriesId })
        .from(appointments)
        .where(eq(appointments.id, earlier.appointmentId));
      if (first?.seriesId) {
        const list = await ctx.tx
          .select({ id: appointments.id })
          .from(appointments)
          .where(eq(appointments.seriesId, first.seriesId))
          .orderBy(asc(appointments.startsAt));
        return {
          seriesId: first.seriesId,
          appointmentIds: list.map((a) => a.id),
          skipped: [],
          duplicate: true,
        };
      }
    }
    const service = await resolveService(ctx.tx, calendar, input.serviceId);
    if (
      input.durationMinutes !== undefined &&
      !bookableDurations(config, service).includes(input.durationMinutes)
    )
      throw HfosError.validation([
        { path: 'durationMinutes', message: 'Pick one of the lengths offered.' },
      ]);
    const tz = calendar.timeZone;
    const firstAt = Date.parse(input.startsAt);
    const rule = RecurrenceRule.parse({
      freq: input.every === 'week' ? 'weekly' : 'monthly_nth',
      interval: input.interval,
      count: Math.min(input.times, config.recurring.maxOccurrences),
      localTime: HH_MM(firstAt, tz),
    });
    const occurrences = expandRecurrence(rule, localDateOf(firstAt, tz), tz);
    if (occurrences[0]?.startsAt !== firstAt)
      throw HfosError.validation([
        { path: 'startsAt', message: 'Start the repeats at a time the calendar offers.' },
      ]);
    await enforceCaps(ctx.tx, ws, calendar.id, person.phoneE164, person.email);
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
        rule: rule as unknown as Record<string, unknown>,
      })
      .returning({ id: appointmentSeries.id });
    const attendee = await customerAttendee(ctx, conv, person);
    const created: BookingResult[] = [];
    const skipped: { date: string; startsAt: string; reason: string }[] = [];
    let prefer: readonly string[] | undefined;
    for (const occ of occurrences) {
      try {
        const r = await bookAppointment(ctx, {
          calendar,
          startsAt: occ.startsAt,
          serviceId: service?.id ?? null,
          durationMinutes: input.durationMinutes,
          partySize: 1,
          locationKind: defaultLocationKind(config),
          postalCode: input.postalCode ?? null,
          point: input.point ?? null,
          choice: { mode: 'customer' },
          // The same person each visit when they're free.
          preferUserIds: prefer,
          attendee,
          notes: input.notes ?? null,
          clientId: occ.index === 0 ? input.clientId : `${input.clientId}#${occ.index + 1}`,
          source: 'ai_teammate',
          seriesId: series!.id,
          occurrence: occ.index + 1,
          skipLock: true,
        });
        created.push(r);
        prefer ??= r.userIds;
      } catch (e) {
        // The first visit is the one the customer picked: if it's gone, nothing is booked.
        if (occ.index === 0 || !(e instanceof HfosError) || e.status !== 409) throw e;
        skipped.push({
          date: occ.date,
          startsAt: new Date(occ.startsAt).toISOString(),
          reason: e.message,
        });
      }
    }
    const first = created[0]!;
    const leadId = await bookingLead(ctx, ai, calendar, first, person.id);
    if (leadId)
      await ctx.tx
        .update(appointments)
        .set({ leadId })
        .where(
          inArray(
            appointments.id,
            created.map((r) => r.appointmentId),
          ),
        );
    await announceBooked(
      ctx,
      first,
      'appointment_booked',
      {
        joined: false,
        personCreated: false,
        leadId,
        smsOk: attendee.smsOk,
        by: 'ai_teammate',
        seriesId: series!.id,
      },
      [person.id],
    );
    const appt = await requireAppointment(ctx.tx, ws, first.appointmentId);
    await ctx.emit({
      type: 'series.created',
      entityType: 'appointment',
      entityId: series!.id,
      payload: {
        seriesId: series!.id,
        calendarId: calendar.id,
        appointmentIds: created.map((r) => r.appointmentId),
        skipped: skipped.length,
      },
      after: {
        ...(await appointmentSnapshot(ctx.tx, appt)),
        occurrences: created.length,
        skipped: skipped.length,
      },
    });
    return {
      seriesId: series!.id,
      appointmentIds: created.map((r) => r.appointmentId),
      skipped,
      duplicate: false,
    };
  },
});

/**
 * M18: a place on one of the teammate's calendars' waitlists for the customer it's talking to, for a full
 * session or the window of time they want. Only where the calendar keeps a waitlist and the teammate's settings
 * allow it (`book.waitlist`); never on a calendar that takes money. They hear when a spot opens, the way anyone
 * on the waitlist does.
 */
export const waitlistJoinForCustomer = defineCommand({
  name: 'waitlist.join_for_customer',
  description:
    'The AI teammate puts the customer it’s talking to on one of its calendars’ waitlists, for a full session or the times they want. They hear when a spot opens.',
  risk: 1,
  input: WaitlistJoinForCustomerInput,
  output: WaitlistJoinForCustomerOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['waitlist.added'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const ai = aiOf(ctx);
    const ws = ctx.scope.workspaceId!;
    const teammate = await assertTeammateMayBook(ctx.tx, ai, input.calendarId);
    if (!teammate.book.waitlist)
      throw HfosError.rule(
        'waitlist_not_allowed',
        409,
        'The AI teammate doesn’t add people to waitlists. Someone on the team can.',
      );
    const { conv, person } = await customerOf(ctx, ai);
    const calendar = await loadCalendar(ctx.tx, ws, input.calendarId);
    assertBookable(calendar);
    if (!calendar.config.waitlist.enabled)
      throw HfosError.rule('waitlist_off', 409, `${calendar.name} doesn’t keep a waitlist.`);
    let wantedFrom: Date | null = null;
    let wantedTo: Date | null = null;
    if (input.appointmentId) {
      const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
      if (appt.calendarId !== calendar.id) throw HfosError.notFound('Appointment not found.');
      requireScheduled(appt);
      // The same rules and words as the booking page and the team's own waitlist.add.
      if (appt.startsAt.getTime() <= Date.now())
        throw HfosError.rule('session_started', 409, 'This session has already started.');
    } else {
      wantedFrom = new Date(input.wantedFrom!);
      wantedTo = new Date(input.wantedTo!);
      const issue = wantedWindowIssue(wantedFrom.getTime(), wantedTo.getTime(), Date.now());
      if (issue) throw HfosError.validation([{ path: 'wantedTo', message: issue }], issue);
    }
    await lockBooking(ctx.tx, calendar.id, []);
    // Already waiting for the same session, or for a window that overlaps this one: that place stands.
    const [live] = await rows<{ id: string; position: number }>(
      ctx.tx,
      sql`select id, position from app.waitlist_entries
          where calendar_id = ${calendar.id} and person_id = ${person.id} and status in ('waiting', 'offered')
            and ${
              input.appointmentId
                ? sql`appointment_id = ${input.appointmentId}`
                : sql`appointment_id is null and wanted_from < ${wantedTo!.toISOString()}::timestamptz
                    and wanted_to > ${wantedFrom!.toISOString()}::timestamptz`
            }
          limit 1`,
    );
    if (live) return { entryId: live.id, position: live.position, alreadyWaiting: true };
    const contact = await customerAttendee(ctx, conv, person);
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
        wantedFrom,
        wantedTo,
        personId: person.id,
        seats: 1,
        position: pos?.n ?? 1,
        contactPhoneE164: contact.contactPhoneE164,
        contactEmail: contact.contactEmail,
        smsOk: contact.smsOk,
        source: 'ai_teammate',
      })
      .returning({ id: waitlistEntries.id, position: waitlistEntries.position });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'waitlist.added',
      entityType: input.appointmentId ? 'appointment' : 'calendar',
      entityId: input.appointmentId ?? calendar.id,
      payload: { entryId: row.id, calendarId: calendar.id, personId: person.id, seats: 1 },
      after: {
        customer: `${person.firstName} ${person.lastName}`.trim(),
        calendar: calendar.name,
        position: row.position,
        seats: 1,
      },
    });
    return { entryId: row.id, position: row.position, alreadyWaiting: false };
  },
});

const MIN = 60_000;

/**
 * M18: more on one of the customer's upcoming visits, on the teammate's calendars:
 * - another service the calendar offers: the visit runs that service's length longer, when the people on it
 *   (and its resources) are free for it, at the price the price list gives it today. Never on a visit shared
 *   with other customers, or one that takes a payment up front;
 * - more people coming, on a visit with that many seats left;
 * - a note for the team (a gate code, pets, what's wrong), added under what's there.
 * The customer hears it from the teammate's reply; the calendar sync picks up a longer visit.
 */
export const appointmentAddForCustomer = defineCommand({
  name: 'appointment.add_for_customer',
  description:
    'The AI teammate adds to an upcoming visit of the customer it’s talking to: another service the calendar offers (when the team is free for the extra time), more people (when seats are left), or a note for the team.',
  risk: 2,
  input: AppointmentAddForCustomerInput,
  output: AppointmentAddForCustomerOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.updated'],
  actors: ['ai_employee'],
  async handler(ctx, input) {
    const ai = aiOf(ctx);
    const ws = ctx.scope.workspaceId!;
    const booked = await customerBooking(ctx, ai, input.appointmentId);
    const { calendar } = booked;
    if (input.serviceId || input.guests) {
      // A visit paid for up front changes on the customer's page or by a person, never here.
      try {
        await assertTeammateMayBook(ctx.tx, ai, calendar.id, booked.appt.serviceId);
      } catch (e) {
        if (e instanceof HfosError && e.rule === 'deposit_required')
          throw HfosError.rule(
            'takes_payment',
            409,
            'That visit takes a payment up front, so only someone on the team can add to it. Add a note, or hand off.',
          );
        throw e;
      }
    } else await assertTeammateCalendar(ctx.tx, ai, calendar.id);
    // Locked, so two changes at once don't both add their time.
    const [appt] = await ctx.tx
      .select()
      .from(appointments)
      .where(eq(appointments.id, booked.appt.id))
      .for('update');
    if (!appt) throw HfosError.notFound('Appointment not found.');
    if (appt.startsAt.getTime() <= Date.now())
      throw HfosError.rule(
        'visit_started',
        409,
        'That visit has already started, so it can’t change now. Hand off if they need something.',
      );
    const [att] = await ctx.tx
      .select()
      .from(appointmentAttendees)
      .where(eq(appointmentAttendees.id, booked.att.id))
      .for('update');
    const patch: Partial<typeof appointments.$inferInsert> = {};
    const fields: string[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (input.serviceId) {
      if (appt.capacity > 1 || appt.seatsTaken > att!.seats)
        throw HfosError.rule(
          'shared_visit',
          409,
          'Other customers share that visit, so its length can’t change. Book the extra service as its own visit, or hand off.',
        );
      const service = await resolveService(ctx.tx, calendar, input.serviceId);
      if (!service || service.archived)
        throw HfosError.validation([
          { path: 'serviceId', message: 'That isn’t a service this calendar offers.' },
        ]);
      const [already] = await ctx.tx
        .select({ id: appointmentServices.id })
        .from(appointmentServices)
        .where(
          and(
            eq(appointmentServices.appointmentId, appt.id),
            eq(appointmentServices.serviceId, service.id),
          ),
        )
        .limit(1);
      if (already || appt.serviceId === service.id)
        throw HfosError.rule('already_on_visit', 409, `${service.name} is already on that visit.`);
      const staff = await staffIdsOf(ctx.tx, appt.id);
      if (service.eligibleUserIds.length && !staff.some((u) => service.eligibleUserIds.includes(u)))
        throw HfosError.rule(
          'not_their_service',
          409,
          `Whoever is coming to that visit doesn’t do ${service.name}. Book it as its own visit, or hand off.`,
        );
      const minutes = resolveTerms(calendar.config, service).durations[0] ?? 0;
      const total = Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / MIN) + minutes;
      if (minutes > 0) {
        try {
          await checkExisting(
            ctx,
            calendar,
            appt,
            { start: appt.startsAt.getTime(), minutes: total, userIds: staff },
            false,
          );
        } catch (e) {
          if (!(e instanceof HfosError) || e.status !== 409) throw e;
          throw HfosError.rule(
            'does_not_fit',
            409,
            `There isn’t time for ${service.name} on that visit: something else is booked right after, or it runs past hours. Offer it as its own visit, or hand off.`,
          );
        }
        patch.endsAt = new Date(appt.startsAt.getTime() + total * MIN);
        before['endsAt'] = appt.endsAt.toISOString();
        after['endsAt'] = patch.endsAt.toISOString();
      }
      await ctx.tx.insert(appointmentServices).values({
        workspaceId: ws,
        appointmentId: appt.id,
        serviceId: service.id,
        name: service.name,
        durationMinutes: minutes,
        priceCents: service.priceCents ?? null,
        source: 'ai_teammate',
      });
      fields.push('services');
      after['service'] = service.name;
    }

    let seats = att!.seats;
    if (input.guests) {
      if (appt.seatsTaken + input.guests > appt.capacity)
        throw HfosError.rule(
          'no_seats',
          409,
          appt.capacity - appt.seatsTaken > 0
            ? `That visit has room for ${appt.capacity - appt.seatsTaken} more, not ${input.guests}.`
            : 'That visit has no room for anyone else. Book them their own time, or hand off.',
        );
      seats = att!.seats + input.guests;
      await ctx.tx
        .update(appointmentAttendees)
        .set({ seats })
        .where(eq(appointmentAttendees.id, att!.id));
      patch.seatsTaken = appt.seatsTaken + input.guests;
      fields.push('seats');
      before['seats'] = att!.seats;
      after['seats'] = seats;
    }

    if (input.note) {
      const line = `From the customer, via ${ai.teammateName}: ${input.note}`;
      const notes = appt.notes?.trim() ? `${appt.notes.trim()}\n\n${line}` : line;
      if (notes.length > 5000)
        throw HfosError.rule(
          'notes_full',
          409,
          'That visit’s notes are full. Add a note to the customer instead.',
        );
      patch.notes = notes;
      fields.push('notes');
      after['note'] = input.note;
    }

    const [updated] = Object.keys(patch).length
      ? await ctx.tx.update(appointments).set(patch).where(eq(appointments.id, appt.id)).returning()
      : [appt];
    await ctx.emit({
      type: 'appointment.updated',
      entityType: 'appointment',
      entityId: appt.id,
      payload: { calendarId: appt.calendarId, fields, by: 'ai_teammate' },
      before: { title: appt.title, ...before },
      after: { title: appt.title, ...after },
    });
    const services = await ctx.tx
      .select({
        name: appointmentServices.name,
        durationMinutes: appointmentServices.durationMinutes,
        priceCents: appointmentServices.priceCents,
      })
      .from(appointmentServices)
      .where(eq(appointmentServices.appointmentId, appt.id))
      .orderBy(asc(appointmentServices.createdAt));
    return {
      appointmentId: appt.id,
      endsAt: updated!.endsAt.toISOString(),
      services,
      seats,
      noteAdded: !!input.note,
    };
  },
});

export type HeldActionKind = DraftAction['kind'];

/**
 * Carries out one change the AI teammate held back: as its reply goes out (automatic), or once a person approves
 * its draft (`ai_teammate.send_draft`, with the approver on the actor). `clientId` is fixed per run or draft and
 * action, so a retry does it once. Returns the visit it made or changed (a series' first), or null.
 */
export async function runHeldAction(
  tx: Tx,
  ai: AiEmployeeActor,
  meta: RequestMeta,
  a: DraftAction,
  clientId: string,
): Promise<{ readonly kind: HeldActionKind; readonly appointmentId: string | null }> {
  const workspaceId = ai.workspaceId;
  switch (a.kind) {
    case 'book': {
      const r = await executeCommandIn(
        tx,
        appointmentBookForCustomer,
        {
          workspaceId,
          calendarId: a.calendarId,
          startsAt: a.startsAt,
          serviceId: a.serviceId,
          ...(a.durationMinutes ? { durationMinutes: a.durationMinutes } : {}),
          sessionId: a.sessionId,
          notes: a.notes,
          postalCode: a.postalCode,
          point: a.point,
          clientId,
        },
        ai,
        meta,
      );
      return { kind: a.kind, appointmentId: r.output.appointmentId };
    }
    case 'reschedule': {
      const r = await executeCommandIn(
        tx,
        attendeeRescheduleForCustomer,
        {
          workspaceId,
          appointmentId: a.appointmentId,
          startsAt: a.startsAt,
          sessionId: a.sessionId,
        },
        ai,
        meta,
      );
      return { kind: a.kind, appointmentId: r.output.appointmentId };
    }
    case 'cancel': {
      const r = await executeCommandIn(
        tx,
        attendeeCancelForCustomer,
        { workspaceId, appointmentId: a.appointmentId, reason: a.reason },
        ai,
        meta,
      );
      return { kind: a.kind, appointmentId: r.output.appointmentId };
    }
    case 'book_series': {
      const r = await executeCommandIn(
        tx,
        seriesBookForCustomer,
        {
          workspaceId,
          calendarId: a.calendarId,
          startsAt: a.startsAt,
          serviceId: a.serviceId,
          ...(a.durationMinutes ? { durationMinutes: a.durationMinutes } : {}),
          every: a.every,
          interval: a.interval,
          times: a.times,
          notes: a.notes,
          postalCode: a.postalCode,
          point: a.point,
          clientId,
        },
        ai,
        meta,
      );
      return { kind: a.kind, appointmentId: r.output.appointmentIds[0] ?? null };
    }
    case 'waitlist': {
      await executeCommandIn(
        tx,
        waitlistJoinForCustomer,
        {
          workspaceId,
          calendarId: a.calendarId,
          appointmentId: a.appointmentId,
          wantedFrom: a.wantedFrom,
          wantedTo: a.wantedTo,
        },
        ai,
        meta,
      );
      return { kind: a.kind, appointmentId: null };
    }
    case 'add_to_visit': {
      const r = await executeCommandIn(
        tx,
        appointmentAddForCustomer,
        {
          workspaceId,
          appointmentId: a.appointmentId,
          serviceId: a.serviceId,
          guests: a.guests,
          note: a.note,
        },
        ai,
        meta,
      );
      return { kind: a.kind, appointmentId: r.output.appointmentId };
    }
    // Money only ever sits in an approval draft; each command refuses without the approver on the actor.
    case 'share_link':
      // The approved message carries the link; there is nothing else to do.
      return { kind: a.kind, appointmentId: null };
    case 'create_invoice':
      await executeCommandIn(
        tx,
        invoiceCreateForCustomer,
        { workspaceId, title: a.title, lines: a.lines },
        ai,
        meta,
      );
      return { kind: a.kind, appointmentId: null };
    case 'create_estimate':
      await executeCommandIn(
        tx,
        estimateCreateForCustomer,
        { workspaceId, title: a.title, lines: a.lines },
        ai,
        meta,
      );
      return { kind: a.kind, appointmentId: null };
    case 'estimate_answer':
      await executeCommandIn(
        tx,
        estimateAnswerForCustomer,
        {
          workspaceId,
          estimateId: a.estimateId,
          accepted: a.accepted,
          name: a.name,
          reason: a.reason,
        },
        ai,
        meta,
      );
      return { kind: a.kind, appointmentId: null };
    case 'start_plan':
      await executeCommandIn(
        tx,
        subscriptionStartForCustomer,
        { workspaceId, planId: a.planId },
        ai,
        meta,
      );
      return { kind: a.kind, appointmentId: null };
  }
}

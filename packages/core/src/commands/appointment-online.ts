/**
 * The booking page's commands. The system actor only: the worker runs them for signed-out customers after
 * its own checks (rate limits, bot check, honeypot) and the HMAC manage link.
 *
 * - The customer is matched by phone, then email, else created through person.create's internals; an
 *   existing customer record is never edited (the booking keeps the typed contact details itself).
 * - The SMS box starts unticked; texts are allowed only when it is ticked and the number never said STOP.
 * - Reschedule and cancel apply the policies of the revision the booking was made under.
 *
 * The AI teammate's booking commands (appointment-ai.ts) share these internals: the caps, the lead, the
 * booking checks, and moving or cancelling a booking under its calendar's policies.
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { appointmentAttendees, appointmentResources, appointments, people } from '@hfos/db/schema';
import {
  appointmentSnapshot,
  cancelAppointment,
  logAppointmentActivity,
  markCancelled,
  othersBooked,
  replaceStaff,
  requireAppointment,
  requireScheduled,
  revisionConfig,
  signalSeatFreed,
  staffIdsOf,
} from '../calendar/appointments';
import {
  bookAppointment,
  findBookingByClientId,
  isRetryable,
  loadAssignmentState,
  lockBooking,
  saveAssignmentState,
  unavailableError,
  type AttendeeDraft,
  type BookingResult,
} from '../calendar/booking';
import type { CalendarConfig } from '../calendar/config';
import { DEPOSIT_HOLD_MS } from '../calendar/deposit';
import { computeSlots } from '../calendar/engine/slots';
import { chooseAssignment } from '../calendar/engine/strategies';
import { isLocalDate } from '../calendar/engine/zoned';
import {
  dbNow,
  iso,
  loadCalendar,
  loadCatalogService,
  loadSlotInput,
  resolveService,
  type LoadedCalendar,
} from '../calendar/load';
import { bookableDurations, defaultLocationKind, resolveTerms } from '../calendar/terms';
import { findOrCreateCustomer, leadFor } from '../crm/intake';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { isOptedOut, scheduleJob } from '../messaging/store';
import {
  AppointmentBookOnlineInput,
  AppointmentBookOnlineOutput,
  AttendeeCancelOnlineInput,
  AttendeeCancelOnlineOutput,
  AttendeeRescheduleOnlineInput,
  AttendeeRescheduleOnlineOutput,
} from '../schemas/calendar';
import { announceBooked } from './appointment';
import { recordOffersConsent } from '../messaging/offers';

const MIN = 60_000;
const HOUR = 3_600_000;
const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

// ---- Intake answers ----

type Answer = string | number | boolean | string[] | null;

/** Answers must match the calendar's questions: known ids, the right kind, required ones present. */
export function validateIntake(
  questions: CalendarConfig['intake']['questions'],
  answers: Readonly<Record<string, Answer>>,
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const known = new Set(questions.map((q) => q.id));
  for (const key of Object.keys(answers))
    if (!known.has(key)) issues.push({ path: `intake.${key}`, message: 'Unknown question.' });
  for (const q of questions) {
    const v = answers[q.id];
    const empty =
      v === undefined ||
      v === null ||
      v === '' ||
      (Array.isArray(v) && v.length === 0) ||
      (q.kind === 'checkbox' && v === false);
    if (empty) {
      if (q.required) issues.push({ path: `intake.${q.id}`, message: 'Please answer this.' });
      continue;
    }
    const ok =
      q.kind === 'short_text'
        ? typeof v === 'string' && v.length <= 200
        : q.kind === 'long_text'
          ? typeof v === 'string'
          : q.kind === 'select'
            ? typeof v === 'string' && q.options.includes(v)
            : q.kind === 'multi_select'
              ? Array.isArray(v) && v.every((x) => q.options.includes(x))
              : q.kind === 'checkbox'
                ? typeof v === 'boolean'
                : q.kind === 'number'
                  ? typeof v === 'number' && Number.isFinite(v)
                  : typeof v === 'string' && isLocalDate(v);
    if (!ok)
      issues.push({ path: `intake.${q.id}`, message: 'That answer doesn’t fit the question.' });
  }
  return issues;
}

// ---- Helpers ----

/** Three online bookings an hour per phone (or email) and thirty per calendar (the AI teammate's count too). */
export async function enforceCaps(
  tx: Tx,
  workspaceId: string,
  calendarId: string,
  phone: string | null,
  email: string | null,
): Promise<void> {
  const [r] = await rows<{ by_contact: number; by_calendar: number }>(
    tx,
    sql`select
          (select count(*)::int from app.appointment_attendees a
            where a.workspace_id = ${workspaceId} and a.source in ('booking_page', 'ai_teammate')
              and a.created_at > now() - interval '1 hour'
              and ((${phone}::text is not null and a.contact_phone_e164 = ${phone}::text)
                or (${phone}::text is null and ${email}::text is not null and a.contact_email = ${email}::text))
          ) as by_contact,
          (select count(*)::int from app.appointment_attendees a join app.appointments p on p.id = a.appointment_id
            where p.calendar_id = ${calendarId} and a.source in ('booking_page', 'ai_teammate')
              and a.created_at > now() - interval '1 hour') as by_calendar`,
  );
  if ((r?.by_contact ?? 0) >= 3)
    throw HfosError.rule(
      'too_many_bookings',
      429,
      'That’s a lot of bookings at once. Try again in an hour, or give us a call.',
    );
  if ((r?.by_calendar ?? 0) >= 30)
    throw HfosError.rule(
      'too_many_bookings',
      429,
      'This calendar is very busy right now. Try again soon, or give us a call.',
    );
}

export async function bookingOutput(
  tx: Tx,
  r: BookingResult,
  created: boolean,
  hold?: { held: boolean; expiresAt: string | null },
) {
  const [att] = r.attendeeId
    ? await tx
        .select({ personId: appointmentAttendees.personId })
        .from(appointmentAttendees)
        .where(eq(appointmentAttendees.id, r.attendeeId))
    : [];
  const [appt] = await tx
    .select({ leadId: appointments.leadId })
    .from(appointments)
    .where(eq(appointments.id, r.appointmentId));
  if (!att || !r.attendeeId) throw HfosError.internal();
  return {
    appointmentId: r.appointmentId,
    attendeeId: r.attendeeId,
    manageVersion: r.manageVersion ?? 1,
    personId: att.personId,
    personCreated: created,
    leadId: appt?.leadId ?? null,
    startsAt: iso(r.startsAt),
    endsAt: iso(r.endsAt),
    userIds: r.userIds,
    joined: r.joined,
    duplicate: r.duplicate,
    held: hold?.held ?? false,
    holdExpiresAt: hold?.expiresAt ?? null,
  };
}

/** The job that gives a time back when nobody pays for it, keyed so one booking has exactly one. */
export const DEPOSIT_HOLD_JOB = 'booking.deposit_hold';
export const depositHoldKey = (attendeeId: string): string => `deposit-hold:${attendeeId}`;

/**
 * Whether this booking is still a hold, and until when. The pending expiry job **is** the hold: it is written
 * in the same transaction as the booking and it is gone the moment the deposit is paid, so a doubled submit is
 * answered with the hold it already made rather than a second one.
 */
export async function holdState(
  tx: Tx,
  attendeeId: string,
): Promise<{ held: boolean; expiresAt: string | null }> {
  const [job] = await rows<{ run_at: Date | string }>(
    tx,
    sql`select run_at from app.scheduled_jobs
        where kind = ${DEPOSIT_HOLD_JOB} and dedupe_key = ${depositHoldKey(attendeeId)}
          and status = 'pending'
        limit 1`,
  );
  return job
    ? { held: true, expiresAt: new Date(job.run_at).toISOString() }
    : { held: false, expiresAt: null };
}

/**
 * A customer's booking while it still stands, with the policies of the revision it was made under. A manage
 * link names its version too, and a stale link is refused.
 */
export async function loadBooked(ctx: CommandContext, attendeeId: string, manageVersion?: number) {
  const ws = ctx.scope.workspaceId!;
  const [att] = await ctx.tx
    .select()
    .from(appointmentAttendees)
    .where(and(eq(appointmentAttendees.id, attendeeId), eq(appointmentAttendees.workspaceId, ws)));
  if (!att)
    throw HfosError.notFound(
      'We can’t find that booking. Use the newest link we sent you, or give us a call.',
    );
  if (manageVersion !== undefined && att.manageVersion !== manageVersion)
    throw HfosError.rule(
      'manage_link_stale',
      410,
      'This link is out of date. Use the newest one we sent you.',
    );
  if (att.status !== 'booked')
    throw HfosError.rule(
      'booking_cancelled',
      409,
      'This booking was cancelled. Book a new time if you still need one.',
    );
  const appt = await requireAppointment(ctx.tx, ws, att.appointmentId);
  requireScheduled(appt);
  const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
  const { policies } = await revisionConfig(ctx.tx, calendar, appt.calendarRevision);
  return { att, appt, calendar, policies };
}

export type BookedAttendee = Awaited<ReturnType<typeof loadBooked>>;

export function assertBookable(calendar: LoadedCalendar): void {
  if (!calendar.config.public)
    throw HfosError.notFound(
      'We can’t find that calendar. Check the link, or give us a call to book.',
    );
  if (calendar.status !== 'active')
    throw HfosError.rule(
      'calendar_not_bookable',
      409,
      'This calendar isn’t taking bookings right now. Give us a call to book instead.',
    );
}

function assertBefore(
  cutoffHours: number,
  startsAt: Date,
  now: number,
  rule: string,
  verb: string,
) {
  if (startsAt.getTime() <= now)
    throw HfosError.rule(
      rule,
      409,
      `This appointment has already started, so online ${verb} are closed. Give us a call instead.`,
    );
  if (startsAt.getTime() - now < cutoffHours * HOUR)
    throw HfosError.rule(
      rule,
      409,
      `Online ${verb} close ${cutoffHours} ${cutoffHours === 1 ? 'hour' : 'hours'} before the appointment. Give us a call instead.`,
    );
}

// ---- Commands ----

export const appointmentBookOnline = defineCommand({
  name: 'appointment.book_online',
  description:
    'A customer books on the public booking page (the worker runs this for them). Checks the time on fresh data, picks staff, matches or creates the customer and optionally opens a lead.',
  risk: 2,
  input: AppointmentBookOnlineInput,
  output: AppointmentBookOnlineOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.booked', 'person.created', 'lead.created'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const calendar = await loadCalendar(ctx.tx, ws, input.calendarId);
    assertBookable(calendar);
    const earlier = await findBookingByClientId(ctx.tx, ws, input.clientId);
    if (earlier?.attendeeId)
      return bookingOutput(ctx.tx, earlier, false, await holdState(ctx.tx, earlier.attendeeId));
    const { config } = calendar;
    const service = await resolveService(ctx.tx, calendar, input.serviceId);
    const issues: { path: string; message: string }[] = [];
    if (
      input.durationMinutes !== undefined &&
      !bookableDurations(config, service).includes(input.durationMinutes)
    )
      issues.push({ path: 'durationMinutes', message: 'Pick one of the lengths offered.' });
    const locationKind =
      input.locationKind === undefined ? defaultLocationKind(config) : input.locationKind;
    if (
      locationKind &&
      config.locations.options.length &&
      !config.locations.options.some((o) => o.kind === locationKind)
    )
      issues.push({ path: 'locationKind', message: 'Pick one of the places offered.' });
    const maxParty = resolveTerms(config, service).maxPartySize;
    if (input.partySize > maxParty)
      issues.push({
        path: 'partySize',
        message: `One booking holds up to ${maxParty} ${maxParty === 1 ? 'person' : 'people'}.`,
      });
    issues.push(...validateIntake(config.intake.questions, input.intake));
    if (issues.length) throw HfosError.validation(issues);

    const phone = input.customer.phone ?? null;
    const email = input.customer.email ?? null;
    await enforceCaps(ctx.tx, ws, calendar.id, phone, email);
    const { personId, created } = await findOrCreateCustomer(ctx, input.customer, 'Booking page');
    const person = await requirePerson(ctx.tx, ws, personId);
    const stopped = phone ? await isOptedOut(ctx.tx, ws, phone) : false;
    // Ticked, a number, and never a STOP (on the number or the customer).
    const smsOk = input.smsConsent && !!phone && !stopped && person.smsConsent !== 'opted_out';
    if (created && smsOk)
      await ctx.tx
        .update(people)
        .set({ smsConsent: 'opted_in', smsConsentAt: new Date(), smsConsentSource: 'booking_page' })
        .where(eq(people.id, personId));
    // The separate box for offers: kept the same way, a new customer's yes, with a number and no STOP.
    if (created && input.offersConsent && !!phone && !stopped)
      await recordOffersConsent(ctx.tx, personId, 'booking_page');
    const attendee: AttendeeDraft = {
      personId,
      seats: input.partySize,
      intake: input.intake,
      contactPhoneE164: phone,
      contactEmail: email,
      smsOk,
      source: 'booking_page',
      linkRef: input.linkRef ?? null,
    };
    const result = await bookAppointment(ctx, {
      calendar,
      startsAt: Date.parse(input.startsAt),
      sessionId: input.sessionId ?? null,
      serviceId: service?.id ?? null,
      durationMinutes: input.durationMinutes,
      partySize: input.partySize,
      locationKind,
      postalCode: input.postalCode ?? null,
      point: input.point ?? null,
      chosenUserId: input.chosenUserId ?? null,
      choice: { mode: 'customer' },
      attendee,
      notes: input.notes ?? null,
      location:
        locationKind === 'customer_address'
          ? {
              kind: 'customer_address',
              address: input.address ?? null,
              meetingUrl: null,
              video: null,
              postalCode: input.postalCode ?? null,
            }
          : undefined,
      clientId: input.clientId,
      source: 'booking_page',
    });
    if (result.duplicate)
      return bookingOutput(
        ctx.tx,
        result,
        false,
        result.attendeeId ? await holdState(ctx.tx, result.attendeeId) : undefined,
      );

    const host = result.userIds[0] ?? null;
    const owner =
      config.crm.ownership === 'assigned_staff'
        ? // Nobody works it (a calendar without staff): the calendar's owner stands in.
          (host ?? calendar.ownerUserId)
        : config.crm.ownership === 'calendar_owner'
          ? calendar.ownerUserId
          : null;
    if (created && config.crm.assignContactOwner && owner)
      await ctx.tx.update(people).set({ ownerUserId: owner }).where(eq(people.id, personId));
    let leadId: string | null = null;
    if (config.crm.createLead && !result.joined) {
      leadId = await leadFor(
        ctx,
        personId,
        config.crm.createLead,
        `${result.title} (booked online)`,
        owner,
      );
      if (leadId)
        await ctx.tx
          .update(appointments)
          .set({ leadId })
          .where(eq(appointments.id, result.appointmentId));
    }
    /**
     * A calendar that asks for money holds the time instead of confirming it: nothing is announced, so no
     * confirmation reaches the customer and no reminder is armed until the deposit is paid
     * (booking.confirm_deposit does both). A hold nobody pays for runs out and gives the time back.
     */
    if (input.hold) {
      const expiresAt = new Date(Date.now() + DEPOSIT_HOLD_MS);
      await scheduleJob(ctx.tx, {
        kind: DEPOSIT_HOLD_JOB,
        dedupeKey: depositHoldKey(result.attendeeId!),
        runAt: expiresAt,
        payload: { attendeeId: result.attendeeId, appointmentId: result.appointmentId },
        workspaceId: ws,
        organizationId: ctx.scope.organizationId,
      });
      return bookingOutput(ctx.tx, result, created, {
        held: true,
        expiresAt: expiresAt.toISOString(),
      });
    }
    await announceBooked(
      ctx,
      result,
      'appointment_booked_online',
      { joined: result.joined, personCreated: created, leadId, smsOk },
      [personId],
    );
    return bookingOutput(ctx.tx, result, created);
  },
});

/**
 * Moves a customer's booking within its calendar's reschedule policy (from the manage link, or by the AI
 * teammate for the customer it's talking to). Its own appointment moves when it's the only booking on it,
 * keeping its people when they're free; a seat in a session or group time becomes a seat at the new time.
 * Emits appointment.rescheduled or attendee.rescheduled, and waitlist.seat_freed.
 */
export async function rescheduleBooking(
  ctx: CommandContext,
  booked: BookedAttendee,
  input: { readonly startsAt: string; readonly sessionId?: string | null },
): Promise<{ appointmentId: string; attendeeId: string; startsAt: string; endsAt: string }> {
  const ws = ctx.scope.workspaceId!;
  const { att, appt, calendar, policies } = booked;
  assertBookable(calendar);
  const rules = policies.reschedule;
  if (!rules.allowed)
    throw HfosError.rule(
      'reschedule_not_allowed',
      409,
      'This booking can’t be moved online. Give us a call to change it.',
    );
  const now = await dbNow(ctx.tx);
  assertBefore(rules.cutoffHours, appt.startsAt, now, 'reschedule_cutoff', 'changes');
  if (att.rescheduleCount >= rules.maxTimes)
    throw HfosError.rule(
      'reschedule_limit',
      409,
      'This booking was already moved as many times as allowed. Give us a call to change it.',
    );
  const start = Date.parse(input.startsAt);
  const minutes = Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / MIN);
  const from = { startsAt: appt.startsAt.toISOString(), endsAt: appt.endsAt.toISOString() };
  const location = (appt.location ?? {}) as { kind?: string | null; postalCode?: string | null };

  if (appt.kind === 'booking' && appt.capacity === 1) {
    // The customer's own appointment moves; its people stay when they are free at the new time.
    const needs = await ctx.tx
      .select({ resourceId: appointmentResources.resourceId })
      .from(appointmentResources)
      .where(eq(appointmentResources.appointmentId, appt.id));
    await lockBooking(
      ctx.tx,
      calendar.id,
      needs.map((n) => n.resourceId),
    );
    const service = appt.serviceId ? await loadCatalogService(ctx.tx, ws, appt.serviceId) : null;
    const base = {
      from: start,
      to: start + 1,
      durationMinutes: minutes,
      partySize: att.seats,
      locationKind: (location.kind ?? null) as never,
      postalCode: location.postalCode ?? null,
      excludeAppointmentIds: [appt.id],
    };
    const current = await staffIdsOf(ctx.tx, appt.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded = await loadSlotInput(ctx.tx, calendar, base, { service });
      const slot = computeSlots(loaded.input).find(
        (s) => s.start === start && s.sessionId === null,
      );
      if (!slot) break;
      const state = await loadAssignmentState(ctx.tx, calendar.id);
      const keep = current.every((u) => slot.userIds.includes(u));
      const picked = keep
        ? { userIds: current, nextState: state }
        : chooseAssignment(slot, loaded.config, state, {
            now: loaded.input.now,
            preferUserIds: current,
          });
      const end = start + minutes * MIN;
      try {
        await ctx.tx.transaction(async (sp) => {
          await sp
            .update(appointments)
            .set({ startsAt: new Date(start), endsAt: new Date(end) })
            .where(eq(appointments.id, appt.id));
          if (!keep) await replaceStaff(sp, ws, appt.id, picked.userIds);
          await saveAssignmentState(sp, ws, calendar.id, state, picked.nextState);
        });
      } catch (e) {
        if (isRetryable(e)) continue;
        throw e;
      }
      await ctx.tx
        .update(appointmentAttendees)
        .set({ rescheduleCount: dsql`${appointmentAttendees.rescheduleCount} + 1` })
        .where(eq(appointmentAttendees.id, att.id));
      const moved = await requireAppointment(ctx.tx, ws, appt.id);
      const to = { startsAt: iso(start), endsAt: iso(end) };
      const eventId = await ctx.emit({
        type: 'appointment.rescheduled',
        entityType: 'appointment',
        entityId: appt.id,
        payload: {
          calendarId: calendar.id,
          from,
          to,
          notify: true,
          by: 'customer',
          attendeeId: att.id,
          userIds: picked.userIds,
        },
        before: { title: appt.title, ...from },
        after: await appointmentSnapshot(ctx.tx, moved),
      });
      await logAppointmentActivity(ctx, moved, 'appointment_rescheduled', eventId, {
        personIds: [att.personId],
        meta: { from: from.startsAt, to: to.startsAt, by: 'customer' },
      });
      return { appointmentId: appt.id, attendeeId: att.id, ...to };
    }
    throw await unavailableError(ctx.tx, calendar, base, start, service);
  }

  // A seat in a session or group time: take a seat at the new time, then give up the old one. The new seat
  // is filed under whoever moved it: the AI teammate, or the customer from their manage link.
  const onCalendar = calendar.config.services.items.some((i) => i.serviceId === appt.serviceId);
  const source =
    ctx.actor.type === 'ai_employee' ? ('ai_teammate' as const) : ('booking_page' as const);
  const moved = await bookAppointment(ctx, {
    calendar,
    startsAt: start,
    sessionId: input.sessionId ?? null,
    serviceId: onCalendar ? appt.serviceId : undefined,
    durationMinutes: calendar.config.schedule.mode === 'sessions' ? undefined : minutes,
    partySize: att.seats,
    choice: { mode: 'customer' },
    attendee: {
      personId: att.personId,
      seats: att.seats,
      intake: att.intake as Record<string, unknown>,
      contactPhoneE164: att.contactPhoneE164,
      contactEmail: att.contactEmail,
      smsOk: att.smsOk,
      source,
    },
    source,
  });
  if (moved.appointmentId === appt.id)
    return { appointmentId: appt.id, attendeeId: att.id, ...from };
  await ctx.tx
    .update(appointmentAttendees)
    .set({ status: 'cancelled', cancelledAt: new Date() })
    .where(eq(appointmentAttendees.id, att.id));
  await ctx.tx
    .update(appointments)
    .set({ seatsTaken: dsql`greatest(${appointments.seatsTaken} - ${att.seats}, 0)` })
    .where(eq(appointments.id, appt.id));
  if (appt.kind === 'booking' && (await othersBooked(ctx.tx, appt.id, att.id)) === 0)
    await markCancelled(ctx.tx, appt.id);
  if (moved.attendeeId)
    await ctx.tx
      .update(appointmentAttendees)
      .set({ rescheduleCount: att.rescheduleCount + 1 })
      .where(eq(appointmentAttendees.id, moved.attendeeId));
  const target = await requireAppointment(ctx.tx, ws, moved.appointmentId);
  const to = { startsAt: iso(moved.startsAt), endsAt: iso(moved.endsAt) };
  const eventId = await ctx.emit({
    type: 'attendee.rescheduled',
    entityType: 'appointment',
    entityId: target.id,
    payload: {
      calendarId: calendar.id,
      fromAppointmentId: appt.id,
      toAppointmentId: target.id,
      fromAttendeeId: att.id,
      attendeeId: moved.attendeeId,
      manageVersion: moved.manageVersion,
      from,
      to,
      notify: true,
      by: 'customer',
    },
    before: { title: appt.title, ...from },
    after: await appointmentSnapshot(ctx.tx, target),
  });
  await logAppointmentActivity(ctx, target, 'appointment_rescheduled', eventId, {
    personIds: [att.personId],
    meta: { from: from.startsAt, to: to.startsAt, by: 'customer' },
  });
  const old = await requireAppointment(ctx.tx, ws, appt.id);
  if (old.status === 'scheduled') await signalSeatFreed(ctx, calendar, old);
  return { appointmentId: target.id, attendeeId: moved.attendeeId!, ...to };
}

export const attendeeRescheduleOnline = defineCommand({
  name: 'attendee.reschedule_online',
  description:
    'A customer moves their booking from the manage link, within the calendar’s reschedule policy.',
  risk: 2,
  input: AttendeeRescheduleOnlineInput,
  output: AttendeeRescheduleOnlineOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.rescheduled', 'attendee.rescheduled', 'waitlist.seat_freed'],
  actors: ['system'],
  async handler(ctx, input) {
    return rescheduleBooking(
      ctx,
      await loadBooked(ctx, input.attendeeId, input.manageVersion),
      input,
    );
  },
});

/**
 * Cancels a customer's booking within its calendar's cancellation policy (from the manage link, or by the AI
 * teammate). The whole appointment when it was theirs alone, otherwise their seats. Emits
 * appointment.cancelled or attendee.cancelled, and waitlist.seat_freed.
 */
export async function cancelBooking(
  ctx: CommandContext,
  booked: BookedAttendee,
  input: { readonly reason?: string | null },
): Promise<{ appointmentId: string; attendeeId: string; appointmentCancelled: boolean }> {
  const { att, appt, calendar, policies } = booked;
  const rules = policies.cancel;
  if (!rules.allowed)
    throw HfosError.rule(
      'cancel_not_allowed',
      409,
      'This booking can’t be cancelled online. Give us a call to cancel.',
    );
  assertBefore(
    rules.cutoffHours,
    appt.startsAt,
    await dbNow(ctx.tx),
    'cancel_cutoff',
    'cancellations',
  );
  await lockBooking(ctx.tx, calendar.id);
  if (appt.kind === 'booking' && (await othersBooked(ctx.tx, appt.id, att.id)) === 0) {
    await cancelAppointment(ctx, appt, {
      reason: input.reason ?? null,
      notify: true,
      by: 'customer',
    });
    if (appt.capacity === 1) await signalSeatFreed(ctx, calendar, appt);
    return { appointmentId: appt.id, attendeeId: att.id, appointmentCancelled: true };
  }
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
    type: 'attendee.cancelled',
    entityType: 'appointment',
    entityId: appt.id,
    payload: {
      calendarId: calendar.id,
      attendeeId: att.id,
      personId: att.personId,
      seats: att.seats,
      reason: input.reason ?? null,
      by: 'customer',
    },
    after: await appointmentSnapshot(ctx.tx, fresh!),
  });
  await logAppointmentActivity(ctx, fresh!, 'appointment_cancelled', eventId, {
    personIds: [att.personId],
    meta: { reason: input.reason ?? null, by: 'customer' },
  });
  await signalSeatFreed(ctx, calendar, fresh!);
  return { appointmentId: appt.id, attendeeId: att.id, appointmentCancelled: false };
}

export const attendeeCancelOnline = defineCommand({
  name: 'attendee.cancel_online',
  description:
    'A customer cancels their booking from the manage link, within the calendar’s cancellation policy.',
  risk: 2,
  input: AttendeeCancelOnlineInput,
  output: AttendeeCancelOnlineOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.cancelled', 'attendee.cancelled', 'waitlist.seat_freed'],
  actors: ['system'],
  async handler(ctx, input) {
    return cancelBooking(ctx, await loadBooked(ctx, input.attendeeId, input.manageVersion), input);
  },
});

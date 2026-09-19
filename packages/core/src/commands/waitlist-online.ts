/**
 * The booking page's waitlist: a signed-out customer joins the waitlist for a full session, or for the
 * times they want on a calendar with no open times. The system actor only: the worker runs it after its
 * rate limits, bot check and honeypot.
 *
 * Like booking online, the customer is matched by phone, then email, else created, and an existing
 * customer is never edited; the SMS box starts unticked and never overrides a STOP. Positions are handed
 * out under the calendar's booking lock, so two joins at once never share one.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { rows, sql } from '@hfos/db/client';
import { appointmentAttendees, people, waitlistEntries } from '@hfos/db/schema';
import { requireAppointment, requireScheduled } from '../calendar/appointments';
import { lockBooking } from '../calendar/booking';
import { dbNow, loadCalendar, loadCatalogService } from '../calendar/load';
import { resolveTerms } from '../calendar/terms';
import { findOrCreateCustomer } from '../crm/intake';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { isOptedOut } from '../messaging/store';
import { OnlineCustomer } from '../schemas/calendar';
import { isoDateTime, uuid } from '../schemas/common';

const DAY = 86_400_000;

export const WaitlistJoinOnlineInput = z
  .object({
    workspaceId: uuid,
    calendarId: uuid,
    /** A full session; or leave it out and give the wanted window for a 1:1 opening. */
    appointmentId: uuid.nullable().optional(),
    wantedFrom: isoDateTime.optional(),
    wantedTo: isoDateTime.optional(),
    seats: z.int().min(1).max(100).default(1),
    customer: OnlineCustomer,
    /** The unticked-by-default "Text me" box. */
    smsConsent: z.boolean().default(false),
  })
  .refine((v) => !!v.appointmentId || (!!v.wantedFrom && !!v.wantedTo), {
    path: ['appointmentId'],
    error: 'Pick a session, or the times you want.',
  });
export const WaitlistJoinOnlineOutput = z.object({
  entryId: uuid,
  position: z.int(),
  personId: uuid,
  personCreated: z.boolean(),
  /** They were already waiting for this session; nothing new was added. */
  alreadyWaiting: z.boolean(),
});

/** Three waitlist joins an hour per phone (or email). */
async function enforceCaps(
  ctx: CommandContext,
  phone: string | null,
  email: string | null,
): Promise<void> {
  const [r] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from app.waitlist_entries e
        where e.workspace_id = ${ctx.scope.workspaceId!} and e.source = 'booking_page'
          and e.created_at > now() - interval '1 hour'
          and ((${phone}::text is not null and e.contact_phone_e164 = ${phone}::text)
            or (${phone}::text is null and ${email}::text is not null and e.contact_email = ${email}::text))`,
  );
  if ((r?.n ?? 0) >= 3)
    throw HfosError.rule(
      'too_many_bookings',
      429,
      'That’s a lot of waitlist requests at once. Try again in an hour, or give us a call.',
    );
}

const tooMany = () =>
  HfosError.validation([{ path: 'seats', message: 'That’s more people than one booking holds.' }]);

export const waitlistJoinOnline = defineCommand({
  name: 'waitlist.join_online',
  description:
    'A customer joins a calendar’s waitlist from the public booking page (the worker runs this for them): for a full session, or for times they want.',
  risk: 1,
  input: WaitlistJoinOnlineInput,
  output: WaitlistJoinOnlineOutput,
  permission: null,
  scope: (i: { workspaceId: string }) => ({
    kind: 'workspace' as const,
    workspaceId: i.workspaceId,
  }),
  emits: ['waitlist.added', 'person.created'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const calendar = await loadCalendar(ctx.tx, ws, input.calendarId);
    if (!calendar.config.public) throw HfosError.notFound('Calendar not found.');
    if (calendar.status !== 'active')
      throw HfosError.rule(
        'calendar_not_bookable',
        409,
        'This calendar isn’t taking bookings right now.',
      );
    if (!calendar.config.waitlist.enabled)
      throw HfosError.rule('waitlist_off', 409, 'This calendar’s waitlist is off.');
    await lockBooking(ctx.tx, calendar.id);
    const now = await dbNow(ctx.tx);

    let appointmentId: string | null = null;
    if (input.appointmentId) {
      const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
      if (appt.calendarId !== calendar.id) throw HfosError.notFound('Session not found.');
      requireScheduled(appt);
      if (appt.startsAt.getTime() <= now)
        throw HfosError.rule('session_started', 409, 'This session has already started.');
      const service = appt.serviceId ? await loadCatalogService(ctx.tx, ws, appt.serviceId) : null;
      if (
        input.seats > Math.min(resolveTerms(calendar.config, service).maxPartySize, appt.capacity)
      )
        throw tooMany();
      if (appt.seatsTaken + input.seats <= appt.capacity)
        throw HfosError.rule(
          'seats_available',
          409,
          'Good news: there are seats left. Book them instead.',
        );
      appointmentId = appt.id;
    } else {
      const from = Date.parse(input.wantedFrom!);
      const to = Date.parse(input.wantedTo!);
      const issue = !(to > from)
        ? 'End after the start.'
        : to <= now
          ? 'Pick times that haven’t passed.'
          : to - from > 90 * DAY
            ? 'Pick 90 days or fewer.'
            : null;
      if (issue) throw HfosError.validation([{ path: 'wantedTo', message: issue }]);
      if (input.seats > resolveTerms(calendar.config, null).maxPartySize) throw tooMany();
    }

    const phone = input.customer.phone ?? null;
    const email = input.customer.email ?? null;
    await enforceCaps(ctx, phone, email);
    const { personId, created } = await findOrCreateCustomer(ctx, input.customer, 'Booking page');
    if (appointmentId) {
      const [booked] = await ctx.tx
        .select({ id: appointmentAttendees.id })
        .from(appointmentAttendees)
        .where(
          and(
            eq(appointmentAttendees.appointmentId, appointmentId),
            eq(appointmentAttendees.personId, personId),
            eq(appointmentAttendees.status, 'booked'),
          ),
        );
      if (booked) throw HfosError.rule('already_booked', 409, 'You’re already booked on this one.');
      const [live] = await ctx.tx
        .select({ id: waitlistEntries.id, position: waitlistEntries.position })
        .from(waitlistEntries)
        .where(
          and(
            eq(waitlistEntries.appointmentId, appointmentId),
            eq(waitlistEntries.personId, personId),
            inArray(waitlistEntries.status, ['waiting', 'offered']),
          ),
        );
      if (live)
        return {
          entryId: live.id,
          position: live.position,
          personId,
          personCreated: created,
          alreadyWaiting: true,
        };
    }

    const person = await requirePerson(ctx.tx, ws, personId);
    const stopped = phone ? await isOptedOut(ctx.tx, ws, phone) : false;
    // Ticked, a number, and never a STOP (on the number or the customer).
    const smsOk = input.smsConsent && !!phone && !stopped && person.smsConsent !== 'opted_out';
    if (created && smsOk)
      await ctx.tx
        .update(people)
        .set({ smsConsent: 'opted_in', smsConsentAt: new Date(), smsConsentSource: 'booking_page' })
        .where(eq(people.id, personId));
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
        appointmentId,
        wantedFrom: appointmentId ? null : new Date(input.wantedFrom!),
        wantedTo: appointmentId ? null : new Date(input.wantedTo!),
        personId,
        seats: input.seats,
        position: pos?.n ?? 1,
        contactPhoneE164: phone,
        contactEmail: email,
        smsOk,
        source: 'booking_page',
      })
      .returning({ id: waitlistEntries.id, position: waitlistEntries.position });
    if (!row) throw HfosError.internal();
    await ctx.emit({
      type: 'waitlist.added',
      entityType: appointmentId ? 'appointment' : 'calendar',
      entityId: appointmentId ?? calendar.id,
      payload: {
        entryId: row.id,
        calendarId: calendar.id,
        personId,
        seats: input.seats,
        by: 'customer',
      },
      after: {
        customer: `${person.firstName} ${person.lastName}`.trim(),
        calendar: calendar.name,
        position: row.position,
        seats: input.seats,
      },
    });
    return {
      entryId: row.id,
      position: row.position,
      personId,
      personCreated: created,
      alreadyWaiting: false,
    };
  },
});

/**
 * The waitlist, worked by the worker (the system actor only):
 * - waitlist.promote: seats opened in a session or group time, so the oldest waiting entries that fit are
 *   booked into it through the booking core and told (appointment.booked with notify).
 * - waitlist.offer: a 1:1 time opened on an hours calendar, so the oldest waiting entry whose wanted window
 *   covers it is offered that time for the calendar's offerMinutes. The entry keeps the offer (0019).
 * - waitlist.expire: an offer ran out. Its entry expires and the time goes to the next person, or, when
 *   someone else took the time meanwhile, the entry waits again in its old place. It also ends a wait for a
 *   window of time once the whole window has passed, and a wait for a session once it starts or is cancelled:
 *   the entry expires, and nobody is told.
 * - waitlist.claim_online: the customer takes their offer from its link, booked through
 *   appointment.book_online with the entry's own clientId, so claiming twice books once.
 *
 * Locks: the calendar's booking lock first, then the entry's row, like every booking.
 */
import { and, asc, eq, gt, isNull, lt, lte } from 'drizzle-orm';
import { z } from 'zod';
import { rows, sql, type Tx } from '@hfos/db/client';
import { appointmentAttendees, appointments, waitlistEntries } from '@hfos/db/schema';
import { requireAppointment } from '../calendar/appointments';
import {
  findBookingByClientId,
  joinSession,
  lockBooking,
  type AttendeeDraft,
} from '../calendar/booking';
import { LocationKind } from '../calendar/config';
import { computeSlots } from '../calendar/engine/slots';
import {
  dbNow,
  iso,
  loadCalendar,
  loadCatalogService,
  loadSlotInput,
  type LoadedCalendar,
} from '../calendar/load';
import { bookableDurations, resolveTerms } from '../calendar/terms';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { isOptedOut } from '../messaging/store';
import { AppointmentBookOnlineInput, AppointmentBookOnlineOutput } from '../schemas/calendar';
import { isoDateTime, uuid } from '../schemas/common';
import { announceBooked } from './appointment';
import { appointmentBookOnline } from './appointment-online';

const MIN = 60_000;
const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** What a waitlist entry was offered: the freed time, its length, its service and the kind of place. */
export const WaitlistOffer = z.object({
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  durationMinutes: z.int(),
  serviceId: uuid.nullable(),
  locationKind: LocationKind.nullable(),
  /** The cancelled appointment whose time this is. */
  fromAppointmentId: uuid,
  offeredAt: isoDateTime,
});
export type WaitlistOffer = z.infer<typeof WaitlistOffer>;

export function parseWaitlistOffer(raw: unknown): WaitlistOffer | null {
  const parsed = WaitlistOffer.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The clientId an offer's booking carries: claiming twice books once. */
export const waitlistClientId = (entryId: string): string => `waitlist-${entryId}`;

const displayName = (p: { firstName: string; lastName: string }) =>
  `${p.firstName} ${p.lastName}`.trim() || 'Customer';

/**
 * Whether a customer could book the offered time right now: the calendar's own rules (hours, notice, who is
 * free) on fresh data, for this many people. The same check appointment.book_online makes.
 */
export async function offerStillOpen(
  tx: Tx,
  calendar: LoadedCalendar,
  offer: WaitlistOffer,
  partySize: number,
): Promise<boolean> {
  const start = Date.parse(offer.startsAt);
  const onCalendar =
    !!offer.serviceId &&
    calendar.config.services.items.some((i) => i.serviceId === offer.serviceId);
  const service = onCalendar
    ? await loadCatalogService(tx, calendar.workspaceId, offer.serviceId!)
    : null;
  if (onCalendar && (!service || service.archived)) return false;
  try {
    const loaded = await loadSlotInput(
      tx,
      calendar,
      {
        from: start,
        to: start + 1,
        serviceId: service?.id ?? null,
        durationMinutes: offer.durationMinutes,
        partySize,
        locationKind: offer.locationKind,
        postalCode: null,
      },
      { service },
    );
    return computeSlots(loaded.input).some((s) => s.start === start && s.sessionId === null);
  } catch (e) {
    // Settings that no longer allow this length or place: not bookable.
    if (e instanceof HfosError) return false;
    throw e;
  }
}

// ---- Promotion into a session or group time ----

export const WaitlistPromoteInput = z.object({ workspaceId: uuid, appointmentId: uuid });
export const WaitlistPromoteOutput = z.object({
  booked: z.array(z.object({ entryId: uuid, attendeeId: uuid, personId: uuid })),
});

export const waitlistPromote = defineCommand({
  name: 'waitlist.promote',
  description:
    'Worker: seats opened in a session or group time, so the oldest waiting customers that fit are booked into it and told.',
  risk: 2,
  input: WaitlistPromoteInput,
  output: WaitlistPromoteOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.booked'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
    const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
    const booked: { entryId: string; attendeeId: string; personId: string }[] = [];
    if (!calendar.config.waitlist.enabled || appt.status !== 'scheduled') return { booked };
    await lockBooking(ctx.tx, calendar.id);
    if (appt.startsAt.getTime() <= (await dbNow(ctx.tx))) return { booked };
    for (let round = 0; round < 50; round++) {
      const session = await requireAppointment(ctx.tx, ws, appt.id);
      const left = session.capacity - session.seatsTaken;
      if (session.status !== 'scheduled' || left <= 0) break;
      const [entry] = await ctx.tx
        .select()
        .from(waitlistEntries)
        .where(
          and(
            eq(waitlistEntries.appointmentId, appt.id),
            eq(waitlistEntries.status, 'waiting'),
            lte(waitlistEntries.seats, left),
          ),
        )
        .orderBy(asc(waitlistEntries.position), asc(waitlistEntries.createdAt))
        .limit(1);
      if (!entry) break;
      const [already] = await ctx.tx
        .select({ id: appointmentAttendees.id })
        .from(appointmentAttendees)
        .where(
          and(
            eq(appointmentAttendees.appointmentId, appt.id),
            eq(appointmentAttendees.personId, entry.personId),
            eq(appointmentAttendees.status, 'booked'),
          ),
        );
      if (!already) {
        const person = await requirePerson(ctx.tx, ws, entry.personId);
        const stopped = entry.contactPhoneE164
          ? await isOptedOut(ctx.tx, ws, entry.contactPhoneE164)
          : false;
        const attendee: AttendeeDraft = {
          personId: entry.personId,
          seats: entry.seats,
          contactPhoneE164: entry.contactPhoneE164,
          contactEmail: entry.contactEmail,
          // Texts only as agreed when they joined, and never after a STOP.
          smsOk: entry.smsOk && !stopped && person.smsConsent !== 'opted_out',
          source: entry.source,
        };
        const result = await joinSession(ctx, {
          calendar,
          sessionId: appt.id,
          attendee,
          customer: false,
        });
        await announceBooked(
          ctx,
          result,
          'appointment_booked_waitlist',
          { notify: true, fromWaitlist: true, entryId: entry.id },
          [entry.personId],
        );
        booked.push({
          entryId: entry.id,
          attendeeId: result.attendeeId!,
          personId: entry.personId,
        });
      }
      // Booked now, or already on it (staff added them meanwhile): either way their wait is over.
      await ctx.tx
        .update(waitlistEntries)
        .set({ status: 'booked', offerExpiresAt: null })
        .where(eq(waitlistEntries.id, entry.id));
    }
    return { booked };
  },
});

// ---- Offers for a freed 1:1 time ----

export const WaitlistOfferInput = z.object({ workspaceId: uuid, appointmentId: uuid });
export const WaitlistOfferOutput = z.object({
  entryId: uuid.nullable(),
  expiresAt: isoDateTime.nullable(),
  /** False when nothing was offered, or the offer already stood (the worker asked again). */
  created: z.boolean(),
});

export const waitlistOffer = defineCommand({
  name: 'waitlist.offer',
  description:
    'Worker: a 1:1 time opened on an hours calendar, so the next waiting customer whose wanted times cover it is offered it for the calendar’s offer window.',
  risk: 2,
  input: WaitlistOfferInput,
  output: WaitlistOfferOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['waitlist.offered'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const none = { entryId: null, expiresAt: null, created: false };
    const appt = await requireAppointment(ctx.tx, ws, input.appointmentId);
    const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
    const { config } = calendar;
    // Offers are claimed on the public page, so only calendars customers can book online make them.
    if (
      !config.waitlist.enabled ||
      config.schedule.mode !== 'hours' ||
      !config.public ||
      calendar.status !== 'active' ||
      appt.kind !== 'booking' ||
      appt.capacity !== 1
    )
      return none;
    await lockBooking(ctx.tx, calendar.id);
    const now = await dbNow(ctx.tx);
    if (appt.startsAt.getTime() <= now) return none;
    const [live] = await rows<{ id: string; offer_expires_at: Date | string }>(
      ctx.tx,
      sql`select id, offer_expires_at from app.waitlist_entries
          where calendar_id = ${calendar.id} and status = 'offered' and offer_expires_at > now()
            and offer ->> 'fromAppointmentId' = ${appt.id}
          limit 1`,
    );
    if (live)
      return {
        entryId: live.id,
        expiresAt: new Date(live.offer_expires_at).toISOString(),
        created: false,
      };
    const minutes = Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / MIN);
    const onCalendar =
      !!appt.serviceId && config.services.items.some((i) => i.serviceId === appt.serviceId);
    const service = onCalendar ? await loadCatalogService(ctx.tx, ws, appt.serviceId!) : null;
    if (!bookableDurations(config, service).includes(minutes)) return none;
    const kind = ((appt.location ?? {}) as { kind?: unknown }).kind;
    const parsedKind = LocationKind.safeParse(kind);
    // The kind of place, never the last customer's address.
    const locationKind =
      parsedKind.success && config.locations.options.some((o) => o.kind === parsedKind.data)
        ? parsedKind.data
        : null;
    const offer: WaitlistOffer = {
      startsAt: appt.startsAt.toISOString(),
      endsAt: appt.endsAt.toISOString(),
      durationMinutes: minutes,
      serviceId: service?.id ?? null,
      locationKind,
      fromAppointmentId: appt.id,
      offeredAt: iso(now),
    };
    const candidates = await ctx.tx
      .select()
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.calendarId, calendar.id),
          isNull(waitlistEntries.appointmentId),
          eq(waitlistEntries.status, 'waiting'),
          lt(waitlistEntries.wantedFrom, appt.endsAt),
          gt(waitlistEntries.wantedTo, appt.startsAt),
        ),
      )
      .orderBy(asc(waitlistEntries.position), asc(waitlistEntries.createdAt))
      .limit(50);
    const maxParty = resolveTerms(config, service).maxPartySize;
    const open = new Map<number, boolean>();
    for (const e of candidates) {
      // Nobody to tell, or too many people for one booking.
      if ((!e.contactPhoneE164 && !e.contactEmail) || e.seats > maxParty) continue;
      if (!open.has(e.seats))
        open.set(e.seats, await offerStillOpen(ctx.tx, calendar, offer, e.seats));
      if (!open.get(e.seats)) continue;
      const expires = new Date(now + config.waitlist.offerMinutes * MIN);
      await ctx.tx
        .update(waitlistEntries)
        .set({ status: 'offered', offerExpiresAt: expires, offer })
        .where(eq(waitlistEntries.id, e.id));
      const person = await requirePerson(ctx.tx, ws, e.personId);
      await ctx.emit({
        type: 'waitlist.offered',
        entityType: 'calendar',
        entityId: calendar.id,
        payload: {
          entryId: e.id,
          calendarId: calendar.id,
          personId: e.personId,
          startsAt: offer.startsAt,
          expiresAt: expires.toISOString(),
          fromAppointmentId: appt.id,
        },
        after: {
          customer: displayName(person),
          calendar: calendar.name,
          startsAt: offer.startsAt,
          expiresAt: expires.toISOString(),
        },
      });
      return { entryId: e.id, expiresAt: expires.toISOString(), created: true };
    }
    return none;
  },
});

// ---- An offer running out ----

export const WaitlistExpireInput = z.object({ workspaceId: uuid, entryId: uuid });
export const WaitlistExpireOutput = z.object({
  status: z.enum(['waiting', 'offered', 'booked', 'expired', 'removed']),
  /** The offer ran out, or the window of time or the session they wanted passed, just now. */
  expired: z.boolean(),
  /** When it runs out, while it hasn't yet: the offer, the end of the window, or the session's start. */
  expiresAt: isoDateTime.nullable(),
  fromAppointmentId: uuid.nullable(),
});

type EntryRow = {
  id: string;
  calendar_id: string;
  appointment_id: string | null;
  person_id: string;
  status: 'waiting' | 'offered' | 'booked' | 'expired' | 'removed';
  seats: number;
  wanted_to: Date | string | null;
  offer: unknown;
  offer_expires_at: Date | string | null;
  contact_phone_e164: string | null;
  contact_email: string | null;
  sms_ok: boolean;
};

/** The entry under the calendar's booking lock, then its own row lock (the order every booking takes them). */
async function lockEntry(tx: Tx, workspaceId: string, entryId: string): Promise<EntryRow | null> {
  const [first] = await tx
    .select({ calendarId: waitlistEntries.calendarId })
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.id, entryId), eq(waitlistEntries.workspaceId, workspaceId)));
  if (!first) return null;
  await lockBooking(tx, first.calendarId);
  const [row] = await rows<EntryRow>(
    tx,
    sql`select id, calendar_id, appointment_id, person_id, status::text as status, seats, wanted_to, offer,
          offer_expires_at, contact_phone_e164, contact_email, sms_ok
        from app.waitlist_entries where id = ${entryId} and workspace_id = ${workspaceId} for update`,
  );
  return row ?? null;
}

export const waitlistExpire = defineCommand({
  name: 'waitlist.expire',
  description:
    'Worker: a waitlist offer ran out, the window of time someone waited for has passed, or the session they waited for started or was cancelled. A lapsed offer’s time goes to the next person; if someone else took it meanwhile, they wait again while their window lasts.',
  risk: 1,
  input: WaitlistExpireInput,
  output: WaitlistExpireOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['waitlist.offer_expired', 'waitlist.window_passed', 'waitlist.session_passed'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const e = await lockEntry(ctx.tx, ws, input.entryId);
    if (!e) throw HfosError.notFound('Waitlist entry not found.');
    const offer = parseWaitlistOffer(e.offer);
    const out = (
      status: EntryRow['status'],
      expired: boolean,
      expiresAt: string | null = null,
    ) => ({ status, expired, expiresAt, fromAppointmentId: offer?.fromAppointmentId ?? null });
    const now = await dbNow(ctx.tx);
    // Someone waiting for a window of time stops waiting once all of it has passed; someone waiting for a seat in
    // a session, once it starts, or at once when it's cancelled: there's no seat left to give them.
    const session = e.appointment_id
      ? await requireAppointment(ctx.tx, ws, e.appointment_id)
      : null;
    const waitEnd = session
      ? session.status === 'scheduled'
        ? session.startsAt.getTime()
        : now
      : e.wanted_to
        ? new Date(e.wanted_to).getTime()
        : null;
    const waitOver = waitEnd !== null && waitEnd <= now;
    if (e.status === 'waiting' && waitEnd !== null) {
      if (!waitOver) return out('waiting', false, iso(waitEnd));
      await ctx.tx
        .update(waitlistEntries)
        .set({ status: 'expired', offerExpiresAt: null })
        .where(eq(waitlistEntries.id, e.id));
      const calendar = await loadCalendar(ctx.tx, ws, e.calendar_id);
      const person = await requirePerson(ctx.tx, ws, e.person_id);
      const after = { customer: displayName(person), calendar: calendar.name, status: 'expired' };
      // Nobody is told: the times they asked for came and went without an opening, or the session they waited
      // for started or was called off (its customers heard about that).
      if (session)
        await ctx.emit({
          type: 'waitlist.session_passed',
          entityType: 'appointment',
          entityId: session.id,
          payload: {
            entryId: e.id,
            calendarId: calendar.id,
            personId: e.person_id,
            appointmentId: session.id,
          },
          before: { status: 'waiting' },
          after: {
            ...after,
            title: session.title,
            startsAt: session.startsAt.toISOString(),
            reason: session.status === 'cancelled' ? 'session_cancelled' : 'session_started',
          },
        });
      else
        await ctx.emit({
          type: 'waitlist.window_passed',
          entityType: 'calendar',
          entityId: calendar.id,
          payload: { entryId: e.id, calendarId: calendar.id, personId: e.person_id },
          before: { status: 'waiting' },
          after: { ...after, reason: 'window_passed' },
        });
      // An offer they let go of earlier was passed on then; there's nothing to pass on now.
      return { ...out('expired', true), fromAppointmentId: null };
    }
    if (e.status !== 'offered') return out(e.status, false);
    const until = e.offer_expires_at ? new Date(e.offer_expires_at).getTime() : 0;
    if (until > now) return out('offered', false, iso(until));
    const calendar = await loadCalendar(ctx.tx, ws, e.calendar_id);
    // Still free: they let it lapse, and it goes to the next person. Taken: they didn't lose their turn, unless
    // the window they wanted has passed meanwhile.
    const free = offer ? await offerStillOpen(ctx.tx, calendar, offer, e.seats) : false;
    const next = free || waitOver ? ('expired' as const) : ('waiting' as const);
    await ctx.tx
      .update(waitlistEntries)
      .set({ status: next, offerExpiresAt: null })
      .where(eq(waitlistEntries.id, e.id));
    const person = await requirePerson(ctx.tx, ws, e.person_id);
    await ctx.emit({
      type: 'waitlist.offer_expired',
      entityType: 'calendar',
      entityId: calendar.id,
      payload: {
        entryId: e.id,
        calendarId: calendar.id,
        personId: e.person_id,
        returned: next === 'waiting',
      },
      before: { status: 'offered' },
      after: { customer: displayName(person), calendar: calendar.name, status: next },
    });
    // Only a time still free goes on to the next person.
    return free ? out(next, true) : { ...out(next, true), fromAppointmentId: null };
  },
});

// ---- Claiming an offer from its link ----

export const WaitlistClaimOnlineInput = z.object({ workspaceId: uuid, entryId: uuid });
export const WaitlistClaimOnlineOutput = AppointmentBookOnlineOutput.extend({ entryId: uuid });

export const waitlistClaimOnline = defineCommand({
  name: 'waitlist.claim_online',
  description:
    'A customer takes the time a waitlist offer holds for them, from its link (the worker runs this for them). Books it like the public booking page.',
  risk: 2,
  input: WaitlistClaimOnlineInput,
  output: WaitlistClaimOnlineOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['appointment.booked', 'person.created', 'lead.created', 'waitlist.claimed'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const gone = () =>
      HfosError.rule(
        'offer_not_active',
        409,
        'This offer isn’t open anymore. You’re told when another time opens, or you can contact the business.',
      );
    const e = await lockEntry(ctx.tx, ws, input.entryId);
    if (!e)
      throw HfosError.notFound(
        'This offer isn’t there anymore. Contact the business to find another time.',
      );
    const clientId = waitlistClientId(e.id);
    if (e.status === 'booked') {
      // Claimed already (a second tap, or a retry): the same booking.
      const earlier = await findBookingByClientId(ctx.tx, ws, clientId);
      if (!earlier?.attendeeId) throw gone();
      const [att] = await ctx.tx
        .select({ personId: appointmentAttendees.personId })
        .from(appointmentAttendees)
        .where(eq(appointmentAttendees.id, earlier.attendeeId));
      const [appt] = await ctx.tx
        .select({ leadId: appointments.leadId })
        .from(appointments)
        .where(eq(appointments.id, earlier.appointmentId));
      return {
        appointmentId: earlier.appointmentId,
        attendeeId: earlier.attendeeId,
        manageVersion: earlier.manageVersion ?? 1,
        personId: att?.personId ?? e.person_id,
        personCreated: false,
        leadId: appt?.leadId ?? null,
        startsAt: iso(earlier.startsAt),
        endsAt: iso(earlier.endsAt),
        userIds: earlier.userIds,
        joined: false,
        duplicate: true,
        entryId: e.id,
      };
    }
    const offer = parseWaitlistOffer(e.offer);
    if (e.status !== 'offered' || !offer) throw gone();
    const until = e.offer_expires_at ? new Date(e.offer_expires_at).getTime() : 0;
    if (until <= (await dbNow(ctx.tx)))
      throw HfosError.rule(
        'offer_expired',
        410,
        'This offer ran out, so the time isn’t held for you anymore. Contact the business to find another time.',
      );
    const person = await requirePerson(ctx.tx, ws, e.person_id);
    const booked = await appointmentBookOnline.handler(
      ctx,
      AppointmentBookOnlineInput.parse({
        workspaceId: ws,
        calendarId: e.calendar_id,
        startsAt: offer.startsAt,
        serviceId: offer.serviceId,
        durationMinutes: offer.durationMinutes,
        partySize: e.seats,
        ...(offer.locationKind ? { locationKind: offer.locationKind } : {}),
        customer: {
          firstName: person.firstName || 'Customer',
          lastName: person.lastName,
          phone: e.contact_phone_e164,
          email: e.contact_email,
        },
        smsConsent: e.sms_ok,
        clientId,
      }),
    );
    await ctx.tx
      .update(waitlistEntries)
      .set({ status: 'booked', offerExpiresAt: null })
      .where(eq(waitlistEntries.id, e.id));
    await ctx.emit({
      type: 'waitlist.claimed',
      entityType: 'appointment',
      entityId: booked.appointmentId,
      payload: {
        entryId: e.id,
        calendarId: e.calendar_id,
        personId: booked.personId,
        attendeeId: booked.attendeeId,
      },
      after: { customer: displayName(person), startsAt: offer.startsAt },
    });
    return { ...booked, entryId: e.id };
  },
});

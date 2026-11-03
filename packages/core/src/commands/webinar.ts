/**
 * Webinars (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 1): the link anyone can use, `/live/<key>` (the owner's
 * 5c). Its door form saves a seat on the webinar's session, the way the booking page does, and while the webinar is
 * open the page goes straight in on the seat's own Join link. The worker runs it for signed-out people, after its rate
 * limits and bot check.
 *
 * - **The customer is matched** by phone, then email, else made, as on the booking page, and the boxes they tick are
 *   kept the same way. An existing customer record is never edited.
 * - **A seat they already have is theirs again:** no second seat and no second confirmation.
 * - **Only a new customer gets their Join link on the page.** Anyone already on file is sent theirs (the worker), so
 *   typing someone else's phone or email gets nobody in as them.
 * - **Any time until the webinar ends,** whatever the calendar's booking window says: walking in late is what the link
 *   is for. The calendar needn't be on the booking site either: the link is the team's to share.
 */
import { eq, and } from 'drizzle-orm';
import { people, videoCalls } from '@hfos/db/schema';
import { z } from 'zod';
import { requireAppointment } from '../calendar/appointments';
import { joinSession, lockBooking, type AttendeeDraft } from '../calendar/booking';
import { dbNow, iso, loadCalendar } from '../calendar/load';
import { findOrCreateCustomer } from '../crm/intake';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { WEBINAR_WORDS } from '../meetings/video-calls';
import { recordCallConsent } from '../messaging/call-consent';
import { recordOffersConsent } from '../messaging/offers';
import { isOptedOut } from '../messaging/store';
import { OnlineCustomer } from '../schemas/calendar';
import { isoDateTime, uuid } from '../schemas/common';
import { announceBooked } from './appointment';
import { BOOKINGS_AN_HOUR, enforceCaps } from './appointment-online';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const gone = () =>
  HfosError.notFound('This link doesn’t open a webinar anymore. Ask the business for a new one.');

export const webinarRegister = defineCommand({
  name: 'webinar.register',
  description:
    'Worker: someone on a webinar’s link anyone can use saves a seat on it from the door form. A seat they already have is theirs again.',
  risk: 2,
  input: z.object({
    workspaceId: uuid,
    callId: uuid,
    customer: OnlineCustomer,
    /** The unticked "Text me" box, as on the booking page. */
    smsConsent: z.boolean().default(false),
    /** The separate box for offers, shown when the business sends them. */
    offersConsent: z.boolean().default(false),
    /** The "OK to call" box, shown when the business asks for one. */
    callConsent: z.boolean().default(false),
  }),
  output: z.object({
    appointmentId: uuid,
    attendeeId: uuid,
    personId: uuid,
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    /** They had a seat already: nothing new was booked or sent. */
    duplicate: z.boolean(),
    /**
     * A new customer, made from this form. Only then does the page get their Join link back: anyone already on file
     * is sent theirs, so typing someone else's details gets nobody in as them.
     */
    personCreated: z.boolean(),
  }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['appointment.booked', 'person.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [call] = await ctx.tx
      .select()
      .from(videoCalls)
      .where(and(eq(videoCalls.id, input.callId), eq(videoCalls.workspaceId, ws)));
    if (!call || call.format !== 'webinar' || !call.appointmentId) throw gone();
    const appt = await requireAppointment(ctx.tx, ws, call.appointmentId).catch(() => {
      throw gone();
    });
    if (appt.status === 'cancelled')
      throw HfosError.rule('webinar_cancelled', 409, WEBINAR_WORDS.doorCancelled);
    const now = await dbNow(ctx.tx);
    if (appt.status !== 'scheduled' || (appt.endsAt.getTime() <= now && call.state !== 'live'))
      throw HfosError.rule(
        'webinar_over',
        409,
        `${WEBINAR_WORDS.doorOver} Get in touch with the business to hear about the next one.`,
      );
    const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
    if (calendar.status !== 'active')
      throw HfosError.rule(
        'calendar_not_bookable',
        409,
        'This webinar isn’t taking sign-ups right now. Get in touch with the business to join.',
      );
    await lockBooking(ctx.tx, calendar.id);

    const phone = input.customer.phone ?? null;
    const email = input.customer.email ?? null;
    await enforceCaps(ctx.tx, ws, calendar.id, phone, email, BOOKINGS_AN_HOUR.sessions);
    const { personId, created } = await findOrCreateCustomer(ctx, input.customer, 'Webinar link');
    const person = await requirePerson(ctx.tx, ws, personId);
    const stopped = phone ? await isOptedOut(ctx.tx, ws, phone) : false;
    // Ticked, a number, and never a STOP: the booking page's rule.
    const smsOk = input.smsConsent && !!phone && !stopped && person.smsConsent !== 'opted_out';
    if (created && smsOk)
      await ctx.tx
        .update(people)
        .set({ smsConsent: 'opted_in', smsConsentAt: new Date(), smsConsentSource: 'booking_page' })
        .where(eq(people.id, personId));
    if (created && input.offersConsent && !!phone && !stopped)
      await recordOffersConsent(ctx.tx, personId, 'booking_page');
    if (created && input.callConsent)
      await recordCallConsent(ctx.tx, ws, personId, `Webinar link: ${appt.title}`);

    const attendee: AttendeeDraft = {
      personId,
      seats: 1,
      intake: {},
      contactPhoneE164: phone,
      contactEmail: email,
      smsOk,
      source: 'booking_page',
      linkRef: null,
    };
    const result = await joinSession(ctx, {
      calendar,
      sessionId: appt.id,
      attendee,
      customer: true,
    }).catch((e: unknown) => {
      // The booking page's "That time was just taken" means full here: there's only the one webinar.
      if (e instanceof HfosError && e.rule === 'slot_taken')
        throw HfosError.rule(
          'webinar_full',
          409,
          `${WEBINAR_WORDS.doorFull} Ask the business about the next one.`,
        );
      throw e;
    });
    if (!result.duplicate)
      await announceBooked(
        ctx,
        result,
        'appointment_booked_online',
        { joined: result.joined, personCreated: created, leadId: null, smsOk, webinarLink: true },
        [personId],
      );
    return {
      appointmentId: result.appointmentId,
      attendeeId: result.attendeeId!,
      personId,
      startsAt: iso(result.startsAt),
      endsAt: iso(result.endsAt),
      duplicate: result.duplicate,
      personCreated: created,
    };
  },
});

export const webinarCommands = [webinarRegister] as const;

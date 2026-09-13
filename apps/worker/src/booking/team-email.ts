/**
 * The team hears about online bookings and cancellations: one email to each person on the appointment whose
 * account allows it (users.settings.notifications.bookingEmail, on unless turned off), when the calendar sends
 * staff emails. A marker event (appointment.team_emailed, caused by the event it answers) keeps a retry from
 * sending twice; it commits on its own, so a later handler failing can't take it back.
 */
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { formatPhone } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { users } from '@hfos/db/schema';
import { teamBookingEmail } from '../emails/templates';
import type { HandlerContext } from '../handlers/types';
import { tenantOf } from '../services';
import { recordSystemEvent } from '../system-event';
import { inSentence, whereLine, withArticle } from './messages';
import { loadBooking } from './visit';
import { clock, dayShort, timeRange, weekdayShort, zoneName } from './when';

export async function emailTeam(
  ctx: HandlerContext,
  about: 'booked' | 'cancelled',
  attendeeId: string,
  opts: { readonly reason?: string | null; readonly fromWaitlist?: boolean } = {},
): Promise<void> {
  const scope = tenantOf(ctx.scope);
  const [done] = await rows(
    ctx.tx,
    sql`select 1 from app.events
        where causation_id = ${ctx.event.id} and event_type = 'appointment.team_emailed'
          and payload ->> 'attendeeId' = ${attendeeId}
        limit 1`,
  );
  if (done) return;
  const b = await loadBooking(ctx.tx, ctx, attendeeId);
  if (!b || !b.calendar.config.notifications.staffEmail || b.staffIds.length === 0) return;
  const team = await ctx.tx
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      settings: users.settings,
    })
    .from(users)
    .where(inArray(users.id, [...b.staffIds]));
  const recipients = team.filter(
    (u) =>
      (u.settings as { notifications?: { bookingEmail?: boolean } }).notifications?.bookingEmail !==
      false,
  );
  if (recipients.length === 0) return;
  const v = b.visit;
  const tz = v.timeZone;
  const customer = `${b.person.firstName} ${b.person.lastName}`.trim() || 'A customer';
  const group = v.kind === 'session' || b.appt.capacity > 1;
  const seats = v.seats === 1 ? 'a seat' : `${v.seats} seats`;
  const sentence =
    about === 'cancelled'
      ? group
        ? `cancelled their ${v.seats === 1 ? 'seat' : `${v.seats} seats`} in ${v.title} online`
        : `cancelled their ${inSentence(v.title)} online`
      : opts.fromWaitlist
        ? `was booked into ${v.title} from the waitlist`
        : group
          ? `booked ${seats} in ${v.title} online`
          : `booked ${withArticle(inSentence(v.title))} with you online`;
  const phone = b.attendee.contactPhoneE164
    ? `${formatPhone(b.attendee.contactPhoneE164)} · ${b.attendee.smsOk ? 'texts OK' : 'no texts'}`
    : null;
  const content = teamBookingEmail({
    about,
    customer,
    sentence,
    title: v.title,
    whenShort: `${weekdayShort(v.startsAt, tz)} ${clock(v.startsAt, tz)}`,
    when: `${dayShort(v.startsAt, tz)}, ${timeRange(v.startsAt, v.endsAt, tz)} ${zoneName(tz, 'long', v.startsAt)}`,
    where: whereLine(v),
    phone,
    email: b.attendee.contactEmail,
    reason: opts.reason ?? null,
    link: `${ctx.webUrl}/app/w/${scope.workspaceId}/calendar?appt=${b.appt.id}`,
  });
  for (const r of recipients) await ctx.mailer.send({ to: String(r.email), ...content });
  await asWorker(ctx.db, scope, (tx) =>
    recordSystemEvent(tx, {
      type: 'appointment.team_emailed',
      action: 'appointment.team_email',
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'appointment',
      entityId: b.appt.id,
      payload: { attendeeId, about, recipients: recipients.length, _broadcast: false },
      after: {
        title: v.title,
        customer,
        about,
        emailed: recipients.map((r) => r.fullName || String(r.email)),
      },
      correlationId: ctx.event.correlationId ?? randomUUID(),
      causationId: ctx.event.id,
    }),
  );
}

/**
 * A short thank-you after a customer confirms by text (a C, or YES while asked): "Thanks, Denise. You're
 * confirmed for tomorrow at 10:00 AM." Only for confirmations by text (the Confirm button and staff marks get
 * none), only while the booking stands and is still confirmed by text, only to a number the business may text,
 * and never in quiet hours: then it's skipped, not held, since by morning it would only be noise.
 *
 * One reply can confirm two bookings (message.receive confirms every open ask for the number), so the thanks
 * names every booking that reply confirmed, and its clientId comes from the reply: one thank-you per reply,
 * however many attendee.confirmed events or retries run it.
 */
import { workspaceMessaging, type RequestMeta } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { TenantScope, WorkerServices } from '../services';
import { clientIdFor, quietEndAt, reachOf, sendText } from './deliver';
import { confirmedThanksText } from './messages';
import { loadBooking } from './visit';

export interface ThanksOptions {
  /** The customer's reply that confirmed it (attendee.confirmed's messageId), when known. */
  readonly messageId: string | null;
  readonly now: number;
  readonly meta: RequestMeta;
}

export async function sendConfirmedThanks(
  s: WorkerServices,
  scope: TenantScope,
  attendeeId: string,
  o: ThanksOptions,
): Promise<void> {
  const found = await asWorker(s.db, scope, async (tx) => {
    const b = await loadBooking(tx, s, attendeeId);
    const a = b?.attendee;
    // Gone, cancelled, started, or no longer confirmed by text (moved since, which clears it): no thanks.
    if (!b || !a || a.confirmedVia !== 'sms' || !a.confirmedAt || !a.contactPhoneE164) return null;
    if (a.status !== 'booked' || b.appt.status !== 'scheduled' || b.visit.startsAt <= o.now)
      return null;
    // What the reply confirmed: this number's bookings confirmed by text at that moment, soonest first.
    const at = a.confirmedAt.getTime();
    const confirmed = await rows<{ starts_at: Date | string }>(
      tx,
      sql`select p.starts_at from app.appointment_attendees t
            join app.appointments p on p.id = t.appointment_id
          where t.workspace_id = ${scope.workspaceId} and t.contact_phone_e164 = ${a.contactPhoneE164}
            and t.confirmed_via = 'sms' and t.status = 'booked' and p.status = 'scheduled'
            and t.confirmed_at between ${new Date(at - 1000).toISOString()}::timestamptz
              and ${new Date(at + 1000).toISOString()}::timestamptz
            and p.starts_at > ${new Date(o.now).toISOString()}::timestamptz
          order by p.starts_at, t.id`,
    );
    const reach = await reachOf(
      tx,
      scope.workspaceId,
      {
        phone: a.contactPhoneE164,
        email: null,
        smsOk: a.smsOk,
        personConsent: b.person.smsConsent,
      },
      { text: true, email: false },
    );
    return {
      b,
      phone: a.contactPhoneE164,
      confirmedAt: a.confirmedAt,
      starts: confirmed.map((r) => new Date(r.starts_at).getTime()),
      reach,
      m: await workspaceMessaging(tx, scope.workspaceId),
    };
  });
  if (!found) return;
  const { b, phone, confirmedAt, starts, reach, m } = found;
  if (quietEndAt(m.settings.quietHours, m.timezone, o.now) !== null) return;
  if (reach.text !== null) return;
  await sendText(
    s,
    scope,
    phone,
    confirmedThanksText({
      startsAt: starts.length ? starts : [b.visit.startsAt],
      timeZone: b.visit.timeZone,
      firstName: b.person.firstName.trim(),
      now: o.now,
      first: reach.firstText,
    }),
    o.messageId
      ? clientIdFor('confirm-thanks', o.messageId)
      : clientIdFor('confirm-thanks', attendeeId, confirmedAt.toISOString()),
    o.meta,
  );
}

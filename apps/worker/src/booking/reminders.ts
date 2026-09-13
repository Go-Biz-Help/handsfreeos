/**
 * Appointment reminders, by the calendar's notification settings (the day before at 4 PM local and 2 hours
 * before, unless changed).
 *
 * A booking, a reschedule, a seat moved to another session or an added attendee arms one appointment.reminder
 * job per attendee and reminder, keyed appt-reminder:<attendeeId>:<key>; arming again only ever pulls a job
 * earlier. The job re-reads everything when it runs, so cancels and reschedules need no cleanup:
 * - skipped when the booking or appointment is off, the calendar's reminders are off, or it has started;
 * - it waits again when its time, worked out from the current start, is still ahead;
 * - it is done once per start (reminder_state), and its clientId carries the start, so a retry sends once;
 * - a text that would land in quiet hours goes when they end if that is still 45 minutes before the start,
 *   otherwise by email at its time; with no email it is skipped. Every outcome is recorded.
 */
import { eq } from 'drizzle-orm';
import {
  bookedTooLate,
  parseReminderState,
  reminderDueAt,
  reminderKey,
  scheduleJob,
  workspaceMessaging,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, type Tx } from '@hfos/db/client';
import { appointments } from '@hfos/db/schema';
import type { JobHandler, JobResult } from '../jobs';
import { tenantOf, workerMeta, type TenantScope, type WorkerServices } from '../services';
import {
  clientIdFor,
  quietEndAt,
  reachOf,
  record,
  sendEmail,
  sendText,
  wasSent,
  type RecordInput,
} from './deliver';
import { emailInsteadWhy, reminderEmail, reminderText } from './messages';
import { loadBooking } from './visit';

const MIN = 60_000;
/** A text moved past quiet hours still has to arrive this long before the start. */
const QUIET_SHIFT_MARGIN = 45 * MIN;

export const reminderJobKey = (attendeeId: string, key: string): string =>
  `appt-reminder:${attendeeId}:${key}`;

/**
 * Arms a booking's reminders for its current start. `bookedAt` is when that start was set (the event's
 * time): a reminder that would come too soon after it, or whose time has passed, is skipped as booked_late.
 * The jobs go in `tx` (the outbox handler's transaction); the records are their own commands.
 */
export async function armReminders(
  s: WorkerServices,
  tx: Tx,
  scope: TenantScope,
  attendeeId: string,
  bookedAt: number,
  meta: RequestMeta,
): Promise<void> {
  const b = await loadBooking(tx, s, attendeeId);
  if (!b || b.attendee.status !== 'booked' || b.appt.status !== 'scheduled') return;
  const n = b.calendar.config.notifications;
  if (!n.reminderChannels.text && !n.reminderChannels.email) return;
  const start = b.visit.startsAt;
  const startIso = new Date(start).toISOString();
  const state = parseReminderState(b.attendee.reminderState);
  for (const reminder of n.reminders) {
    const key = reminderKey(reminder);
    const prev = state.reminders[key];
    // Already sent, or already skipped, for this very start.
    if (prev && prev.startsAt === startIso && prev.status !== 'scheduled') continue;
    const due = reminderDueAt(reminder, start, b.visit.timeZone);
    if (bookedTooLate(reminder, start, bookedAt) || due <= bookedAt) {
      await record(
        s,
        scope,
        attendeeId,
        { key, status: 'skipped', reason: 'booked_late', startsAt: start },
        meta,
      );
      continue;
    }
    await scheduleJob(
      tx,
      {
        kind: 'appointment.reminder',
        dedupeKey: reminderJobKey(attendeeId, key),
        runAt: new Date(due),
        payload: { attendeeId, key },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      },
      { pullEarlier: true },
    );
    await record(
      s,
      scope,
      attendeeId,
      { key, status: 'scheduled', startsAt: start, dueAt: due },
      meta,
    );
  }
}

/** Moved while the reminder went out: run again for the new start, which waits or skips as it should. */
async function again(
  s: WorkerServices,
  scope: TenantScope,
  appointmentId: string,
  start: number,
): Promise<JobResult> {
  const [a] = await asWorker(s.db, scope, (tx) =>
    tx
      .select({ startsAt: appointments.startsAt })
      .from(appointments)
      .where(eq(appointments.id, appointmentId)),
  );
  return a && a.startsAt.getTime() !== start ? { rescheduleAt: new Date() } : undefined;
}

export const appointmentReminder: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const attendeeId = String(ctx.job.payload['attendeeId'] ?? '');
  const key = String(ctx.job.payload['key'] ?? '');
  const meta = workerMeta(null, ctx.job.id);
  const now = ctx.now;
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const b = await loadBooking(tx, ctx, attendeeId);
    if (!b) return null;
    const reach = await reachOf(
      tx,
      scope.workspaceId,
      {
        phone: b.attendee.contactPhoneE164,
        email: b.attendee.contactEmail,
        smsOk: b.attendee.smsOk,
        personConsent: b.person.smsConsent,
      },
      b.calendar.config.notifications.reminderChannels,
    );
    return { b, reach, m: await workspaceMessaging(tx, scope.workspaceId) };
  });
  if (!found) return;
  const { b, reach, m } = found;
  const start = b.visit.startsAt;
  const startIso = new Date(start).toISOString();
  const note = (r: Omit<RecordInput, 'key' | 'startsAt'>) =>
    record(ctx, scope, attendeeId, { key, startsAt: start, ...r }, meta);

  const prev = parseReminderState(b.attendee.reminderState).reminders[key];
  if (prev && prev.startsAt === startIso && prev.status !== 'scheduled') return;
  if (b.attendee.status !== 'booked' || b.appt.status !== 'scheduled')
    return note({ status: 'skipped', reason: 'cancelled' });
  if (start <= now) return note({ status: 'skipped', reason: 'started' });
  const n = b.calendar.config.notifications;
  const reminder = n.reminders.find((r) => reminderKey(r) === key);
  if (!reminder || (!n.reminderChannels.text && !n.reminderChannels.email))
    return note({ status: 'skipped', reason: 'reminders_off' });
  const due = reminderDueAt(reminder, start, b.visit.timeZone);
  if (due > now + 250) return { rescheduleAt: new Date(due) };

  const clientId = clientIdFor('remind', attendeeId, key, startIso);
  const firstName = b.person.firstName.trim();
  const base = {
    reminder,
    visit: b.visit,
    business: b.business,
    firstName,
    now,
    manageUrl: b.manageUrl,
  };
  let textWhy = reach.text;
  if (reach.text === null) {
    const end = quietEndAt(m.settings.quietHours, m.timezone, now);
    if (end === null) {
      const sent = await sendText(
        ctx,
        scope,
        b.attendee.contactPhoneE164!,
        reminderText({ ...base, first: reach.firstText, why: null }),
        clientId,
        meta,
      );
      if (wasSent(sent)) {
        await note({ status: 'sent', channel: 'sms', messageId: sent.messageId });
        return again(ctx, scope, b.appt.id, start);
      }
      textWhy = sent.refused;
    } else if (end <= start - QUIET_SHIFT_MARGIN) {
      // Quiet hours end in time: the text goes then.
      await note({ status: 'scheduled', channel: 'sms', reason: 'quiet_hours', dueAt: end });
      return { rescheduleAt: new Date(end) };
    } else textWhy = 'quiet_hours';
  }
  if (reach.email === null) {
    const sent = await sendEmail(
      ctx,
      scope,
      b.attendee.contactEmail!,
      reminderEmail({ ...base, first: false, why: emailInsteadWhy(textWhy, firstName) }),
      clientId,
      meta,
    );
    if (!wasSent(sent)) return note({ status: 'skipped', reason: sent.refused });
    await note({ status: 'sent', channel: 'email', reason: textWhy, messageId: sent.messageId });
    return again(ctx, scope, b.appt.id, start);
  }
  return note({
    status: 'skipped',
    reason: textWhy === 'quiet_hours' || textWhy === 'opted_out' ? textWhy : 'no_contact',
  });
};

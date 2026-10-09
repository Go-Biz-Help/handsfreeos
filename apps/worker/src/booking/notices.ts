/**
 * Customer notices about one booking: its confirmation, and that it moved, changed hands or was cancelled.
 *
 * Each goes by text when the customer agreed and texting is set up (the calendar's confirmation switches
 * allowing), otherwise by email. In quiet hours the email goes now, when there is one, and the text waits for
 * the end of quiet hours in an appointment.notice job. Everything is re-read when it runs and every clientId
 * is fixed, so a retried event or job sends once. The confirmation's outcome is recorded in reminder_state.
 */
import { scheduleJob, workspaceMessaging, type RequestMeta } from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { readingBin } from '../bin/index';
import type { JobHandler } from '../jobs';
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
import {
  cancelledEmail,
  cancelledText,
  confirmationEmail,
  confirmationText,
  movedEmail,
  movedText,
  reassignedEmail,
  reassignedText,
  type EmailText,
} from './messages';
import { loadBooking, type LoadedBooking } from './visit';

export type NoticeKind = 'confirmation' | 'moved' | 'reassigned' | 'cancelled';
const KINDS: readonly NoticeKind[] = ['confirmation', 'moved', 'reassigned', 'cancelled'];

export interface NoticeOptions {
  /** The event it answers: part of the clientId (one notice per change) and of the held text's job. */
  readonly eventId: string;
  readonly now: number;
  readonly meta: RequestMeta;
  /** Booked into a session from its waitlist. */
  readonly fromWaitlist?: boolean;
  /** Where a moved booking was. */
  readonly movedFrom?: number | null;
  /** The customer did it online. */
  readonly byCustomer?: boolean;
  /** A cancelled repeat visit: how many of the ones after it went with it. */
  readonly laterToo?: number;
  /** The held text at the end of quiet hours: a text, or nothing. */
  readonly textOnly?: boolean;
}

export type NoticeResult = void | { readonly rescheduleAt: Date };

/** Whether the notice still fits the booking as it is now (a cancel since, a start that passed). */
function stillApplies(b: LoadedBooking, kind: NoticeKind, now: number): boolean {
  if (b.visit.startsAt <= now) return false;
  if (kind === 'cancelled')
    return b.attendee.status === 'cancelled' || b.appt.status === 'cancelled';
  if (kind === 'reassigned' && b.visit.staff.length === 0) return false;
  return b.attendee.status === 'booked' && b.appt.status === 'scheduled';
}

function compose(
  b: LoadedBooking,
  kind: NoticeKind,
  o: NoticeOptions,
  first: boolean,
): { text: string; email: EmailText } {
  const base = { visit: b.visit, business: b.business, firstName: b.person.firstName.trim() };
  if (kind === 'confirmation') {
    const i = {
      ...base,
      manageUrl: b.manageUrl,
      icsUrl: b.icsUrl,
      policies: b.policies,
      fromWaitlist: !!o.fromWaitlist,
      first,
    };
    return { text: confirmationText(i), email: confirmationEmail(i) };
  }
  if (kind === 'moved') {
    const i = {
      ...base,
      from: o.movedFrom ?? null,
      manageUrl: b.manageUrl,
      icsUrl: b.icsUrl,
      policies: b.policies,
      first,
    };
    return { text: movedText(i), email: movedEmail(i) };
  }
  if (kind === 'reassigned') {
    const i = { ...base, manageUrl: b.manageUrl, first };
    return { text: reassignedText(i), email: reassignedEmail(i) };
  }
  const i = { ...base, byCustomer: !!o.byCustomer, first, laterToo: o.laterToo ?? 0 };
  return { text: cancelledText(i), email: cancelledEmail(i) };
}

/** Sends one notice to one booking's customer (see the file comment for the channel rules). */
export async function sendNotice(
  s: WorkerServices,
  scope: TenantScope,
  attendeeId: string,
  kind: NoticeKind,
  o: NoticeOptions,
): Promise<NoticeResult> {
  const found = await asWorker(s.db, scope, async (tx) => {
    // A booking deleted for good still tells its customers it's cancelled, when asked (bin/index.ts).
    const b =
      kind === 'cancelled'
        ? await readingBin(tx, () => loadBooking(tx, s, attendeeId))
        : await loadBooking(tx, s, attendeeId);
    if (!b || !stillApplies(b, kind, o.now)) return null;
    const reach = await reachOf(
      tx,
      scope.workspaceId,
      {
        phone: b.attendee.contactPhoneE164,
        email: b.attendee.contactEmail,
        smsOk: b.attendee.smsOk,
        personConsent: b.person.smsConsent,
      },
      b.calendar.config.notifications.confirmation,
    );
    return { b, reach, m: await workspaceMessaging(tx, scope.workspaceId) };
  });
  if (!found) return;
  const { b, reach, m } = found;
  const confirmation = kind === 'confirmation';
  // One confirmation per booking (a re-booked seat gets a new manage version); one notice per change.
  const clientId = confirmation
    ? clientIdFor('confirm', attendeeId, b.attendee.manageVersion)
    : clientIdFor(kind, o.eventId, attendeeId);
  const content = compose(b, kind, o, reach.firstText);
  const note = (r: Omit<RecordInput, 'key' | 'startsAt'>) =>
    confirmation
      ? record(
          s,
          scope,
          attendeeId,
          { key: 'confirmation', startsAt: b.visit.startsAt, ...r },
          o.meta,
        )
      : Promise.resolve();
  let textWhy = reach.text;
  if (reach.text === null) {
    const end = quietEndAt(m.settings.quietHours, m.timezone, o.now);
    if (end === null) {
      const sent = await sendText(
        s,
        scope,
        b.attendee.contactPhoneE164!,
        content.text,
        clientId,
        o.meta,
      );
      if (wasSent(sent)) {
        await note({ status: 'sent', channel: 'sms', messageId: sent.messageId });
        return;
      }
      textWhy = sent.refused;
    } else if (o.textOnly) return { rescheduleAt: new Date(end) };
    else {
      // Quiet hours: the email now, when there is one, and the text once they end.
      await asWorker(s.db, scope, (tx) =>
        scheduleJob(tx, {
          kind: 'appointment.notice',
          dedupeKey: `appt-notice:${kind}:${attendeeId}:${o.eventId}`,
          runAt: new Date(end),
          payload: { attendeeId, kind, eventId: o.eventId, fromWaitlist: !!o.fromWaitlist },
          workspaceId: scope.workspaceId,
          organizationId: scope.organizationId,
        }),
      );
      const emailed =
        reach.email === null
          ? await sendEmail(s, scope, b.attendee.contactEmail!, content.email, clientId, o.meta)
          : null;
      if (emailed && wasSent(emailed))
        await note({
          status: 'sent',
          channel: 'email',
          reason: 'quiet_hours',
          messageId: emailed.messageId,
        });
      else await note({ status: 'scheduled', channel: 'sms', reason: 'quiet_hours', dueAt: end });
      return;
    }
  }
  // A held text that can no longer go (a STOP since): its email went out already, or there was none.
  if (o.textOnly) return;
  if (reach.email === null) {
    const sent = await sendEmail(
      s,
      scope,
      b.attendee.contactEmail!,
      content.email,
      clientId,
      o.meta,
    );
    await note(
      wasSent(sent)
        ? { status: 'sent', channel: 'email', reason: textWhy, messageId: sent.messageId }
        : { status: 'skipped', reason: sent.refused },
    );
    return;
  }
  await note({
    status: 'skipped',
    reason:
      textWhy === 'text_off' && reach.email === 'email_off'
        ? 'confirmation_off'
        : textWhy === 'opted_out'
          ? 'opted_out'
          : 'no_contact',
  });
}

/** A text held back by quiet hours goes now (or waits again when quiet hours were moved later). */
export const appointmentNotice: JobHandler = async (ctx) => {
  const p = ctx.job.payload as {
    attendeeId?: string;
    kind?: string;
    eventId?: string;
    fromWaitlist?: boolean;
  };
  const kind = KINDS.find((k) => k === p.kind);
  if (!p.attendeeId || !kind || !p.eventId) return;
  return sendNotice(ctx, tenantOf(ctx.scope), p.attendeeId, kind, {
    eventId: p.eventId,
    now: ctx.now,
    meta: workerMeta(null, ctx.job.id),
    fromWaitlist: !!p.fromWaitlist,
    textOnly: true,
  });
};

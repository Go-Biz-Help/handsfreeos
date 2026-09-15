/**
 * What customers and the team hear when appointments change. Each runs after the calendar write-through for
 * its event (handlers/index.ts lists them in order) and is safe to run again: notices use fixed clientIds,
 * reminders re-arm idempotently, and the team email leaves a marker.
 *
 * Staff changes message the customer only when they asked to (the event's `notify`); customers' own online
 * bookings and changes always get theirs.
 * - appointment.booked: the confirmation, the reminders, and the team's "New booking" email when online.
 * - attendee.added: a confirmation when asked; the reminders.
 * - appointment.rescheduled, attendee.rescheduled: a notice (a seat moved to another session is a new
 *   booking, so its notice carries the new link); the reminders re-armed.
 * - appointment.reassigned: a notice when asked.
 * - appointment.cancelled, attendee.cancelled, attendee.removed: a notice; the team hears about online ones.
 * - series.created: the reminders for every occurrence's customers.
 * - attendee.confirmed: a short thank-you when the customer confirmed by text (onConfirmedThanks).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { appointmentAttendees } from '@hfos/db/schema';
import { sendConfirmedThanks } from '../booking/confirm';
import { sendNotice, type NoticeKind, type NoticeOptions } from '../booking/notices';
import { armReminders } from '../booking/reminders';
import { emailTeam } from '../booking/team-email';
import { tenantOf, workerMeta } from '../services';
import type { EventHandler, HandlerContext } from './types';

type Payload = Record<string, unknown>;

const payloadOf = (ctx: HandlerContext): Payload => (ctx.event.payload ?? {}) as Payload;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 100) : [];
const metaOf = (ctx: HandlerContext) => workerMeta(ctx.event.correlationId, ctx.event.id);
const byCustomer = (p: Payload) => p['by'] === 'customer';
/** Staff changes tell the customer only when asked; a customer's own change always gets its notice. */
const wantsNotice = (p: Payload) => byCustomer(p) || p['notify'] === true;

async function bookedAttendees(tx: Tx, appointmentId: string): Promise<string[]> {
  const list = await tx
    .select({ id: appointmentAttendees.id })
    .from(appointmentAttendees)
    .where(
      and(
        eq(appointmentAttendees.appointmentId, appointmentId),
        eq(appointmentAttendees.status, 'booked'),
      ),
    )
    .orderBy(asc(appointmentAttendees.createdAt), asc(appointmentAttendees.id));
  return list.map((a) => a.id);
}

/** Of these bookings, the ones customers made online: on the booking page, or with the AI teammate. */
async function onlineOnes(tx: Tx, attendeeIds: readonly string[]): Promise<Set<string>> {
  if (attendeeIds.length === 0) return new Set();
  const list = await tx
    .select({ id: appointmentAttendees.id, source: appointmentAttendees.source })
    .from(appointmentAttendees)
    .where(inArray(appointmentAttendees.id, [...attendeeIds]));
  return new Set(
    list.filter((a) => a.source === 'booking_page' || a.source === 'ai_teammate').map((a) => a.id),
  );
}

/** The bookings an appointment.cancelled took down (its payload names the people). */
async function cancelledOnes(tx: Tx, appointmentId: string, p: Payload): Promise<string[]> {
  const personIds = strings(p['personIds']);
  if (personIds.length === 0) return [];
  const list = await tx
    .select({ id: appointmentAttendees.id })
    .from(appointmentAttendees)
    .where(
      and(
        eq(appointmentAttendees.appointmentId, appointmentId),
        inArray(appointmentAttendees.personId, personIds),
        eq(appointmentAttendees.status, 'cancelled'),
      ),
    );
  return list.map((a) => a.id);
}

async function notice(
  ctx: HandlerContext,
  attendeeIds: readonly string[],
  kind: NoticeKind,
  extra: Partial<NoticeOptions> = {},
): Promise<void> {
  const scope = tenantOf(ctx.scope);
  for (const id of new Set(attendeeIds))
    await sendNotice(ctx, scope, id, kind, {
      eventId: ctx.event.id,
      now: Date.now(),
      meta: metaOf(ctx),
      ...extra,
    });
}

/** appointment.booked: the confirmation (online bookings always; staff ones when they asked). */
export const onBookedConfirm: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  const one = str(p['attendeeId']);
  const ids = one ? [one] : await bookedAttendees(ctx.tx, appointmentId);
  const online = await onlineOnes(ctx.tx, ids);
  await notice(
    ctx,
    ids.filter((id) => online.has(id) || p['notify'] === true),
    'confirmation',
    { fromWaitlist: p['fromWaitlist'] === true },
  );
};

/** appointment.booked: "New booking" to the people on it, when a customer booked online. */
export const onBookedTeamEmail: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const id = str(p['attendeeId']);
  if (!id || !(await onlineOnes(ctx.tx, [id])).has(id)) return;
  await emailTeam(ctx, 'booked', id, { fromWaitlist: p['fromWaitlist'] === true });
};

/** attendee.added: a confirmation when staff asked. */
export const onAddedConfirm: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const id = str(p['attendeeId']);
  if (id && p['notify'] === true) await notice(ctx, [id], 'confirmation');
};

/** Bookings whose reminders an event (re)arms, for the start that event set. */
export const onArmReminders: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const appointmentId = ctx.event.entityId;
  let ids: string[] = [];
  switch (ctx.event.eventType) {
    case 'appointment.booked':
      ids = str(p['attendeeId'])
        ? [str(p['attendeeId'])!]
        : appointmentId
          ? await bookedAttendees(ctx.tx, appointmentId)
          : [];
      break;
    case 'appointment.rescheduled':
      ids = appointmentId ? await bookedAttendees(ctx.tx, appointmentId) : [];
      break;
    case 'attendee.rescheduled':
    case 'attendee.added':
      ids = str(p['attendeeId']) ? [str(p['attendeeId'])!] : [];
      break;
    case 'series.created':
      for (const id of strings(p['appointmentIds']))
        ids.push(...(await bookedAttendees(ctx.tx, id)));
      break;
  }
  const scope = tenantOf(ctx.scope);
  const bookedAt = ctx.event.createdAt.getTime();
  for (const id of new Set(ids)) await armReminders(ctx, ctx.tx, scope, id, bookedAt, metaOf(ctx));
};

/** appointment.rescheduled and attendee.rescheduled: "Your AC tune-up is now ...". */
export const onMovedNotice: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const appointmentId = ctx.event.entityId;
  if (!appointmentId || !wantsNotice(p)) return;
  const from = str((p['from'] as { startsAt?: unknown } | undefined)?.startsAt);
  const to = str((p['to'] as { startsAt?: unknown } | undefined)?.startsAt);
  // Asked to "move" to the time it already had (the Assistant handing it to someone else): nothing moved.
  if (from && to && Date.parse(from) === Date.parse(to)) return;
  const one = str(p['attendeeId']);
  const ids =
    ctx.event.eventType === 'attendee.rescheduled'
      ? one
        ? [one]
        : []
      : byCustomer(p) && one
        ? [one]
        : await bookedAttendees(ctx.tx, appointmentId);
  await notice(ctx, ids, 'moved', {
    movedFrom: from ? Date.parse(from) : null,
    byCustomer: byCustomer(p),
  });
};

/** appointment.reassigned: "Marco is now coming ...", when asked. */
export const onReassignedNotice: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const appointmentId = ctx.event.entityId;
  if (!appointmentId || p['notify'] !== true) return;
  await notice(ctx, await bookedAttendees(ctx.tx, appointmentId), 'reassigned');
};

/** appointment.cancelled, attendee.cancelled and attendee.removed: "Your AC tune-up ... is cancelled." */
export const onCancelledNotice: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const appointmentId = ctx.event.entityId;
  if (!appointmentId || !wantsNotice(p)) return;
  const one = str(p['attendeeId']);
  const ids =
    ctx.event.eventType === 'appointment.cancelled'
      ? await cancelledOnes(ctx.tx, appointmentId, p)
      : one
        ? [one]
        : [];
  await notice(ctx, ids, 'cancelled', { byCustomer: byCustomer(p) });
};

/** appointment.cancelled and attendee.cancelled: the people on it hear when a customer cancelled online. */
export const onCancelledTeamEmail: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const appointmentId = ctx.event.entityId;
  if (!appointmentId || !byCustomer(p)) return;
  const one = str(p['attendeeId']);
  const ids =
    ctx.event.eventType === 'appointment.cancelled'
      ? await cancelledOnes(ctx.tx, appointmentId, p)
      : one
        ? [one]
        : [];
  for (const id of ids) await emailTeam(ctx, 'cancelled', id, { reason: str(p['reason']) });
};

/**
 * attendee.confirmed: a short thank-you when the customer confirmed by text (a C, or YES while asked); never for
 * the Confirm button or a staff mark, and never in quiet hours (booking/confirm.ts).
 */
export const onConfirmedThanks: EventHandler = async (ctx) => {
  const p = payloadOf(ctx);
  const id = str(p['attendeeId']);
  if (!id || p['via'] !== 'sms') return;
  await sendConfirmedThanks(ctx, tenantOf(ctx.scope), id, {
    messageId: str(p['messageId']),
    now: Date.now(),
    meta: metaOf(ctx),
  });
};

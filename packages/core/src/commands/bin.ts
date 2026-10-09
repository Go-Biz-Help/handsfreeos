/**
 * Deleting for good, through the Deleted bin (20261027000400; the owner's decisions of 2026-10-08 are in
 * docs/deleting.md): a customer with everything only about them, a conversation, or a booking. What's deleted
 * waits 30 days in the bin, where it can be brought back, and then the worker empties it.
 *
 * Owners only, unless an owner gives "Delete for good" to a role or a person, and never the AI or a workflow
 * (risk 4, people only). The database decides what can't go and says why in words (private.bin_put); these put
 * things in, cancel the bookings still to come first, and say what happened.
 */
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { appointmentAttendees, appointments, binItems, people } from '@hfos/db/schema';
import {
  cancelAppointment,
  removeSeat,
  requireAppointment,
  signalSeatFreed,
  type AppointmentRow,
} from '../calendar/appointments';
import { lockBooking } from '../calendar/booking';
import { loadCalendar } from '../calendar/load';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import {
  AppointmentDeleteInput,
  BinDeleteOutput,
  BinEmptyInput,
  BinEmptyOutput,
  BinRestoreInput,
  BinRestoreOutput,
  ConversationDeleteInput,
  PersonDeleteInput,
  type BinKind,
} from '../schemas/bin';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type BinItem = typeof binItems.$inferSelect;

/** Puts one thing in the bin, and says so in its history: the one line that stays whole once it's emptied. */
async function putInBin(ctx: CommandContext, kind: BinKind, id: string): Promise<BinItem> {
  const [put] = await rows<{ id: string }>(
    ctx.tx,
    sql`select private.bin_put(${kind}, ${id}::uuid) as id`,
  );
  const [item] = await ctx.tx.select().from(binItems).where(eq(binItems.id, put!.id));
  await ctx.emit({
    type: `${kind}.deleted`,
    entityType: kind,
    entityId: id,
    payload: { name: item!.name, binItemId: item!.id, purgeAfter: item!.purgeAfter.toISOString() },
    before: { name: item!.name },
    after: { name: item!.name, deleted: true, contents: item!.contents },
  });
  return item!;
}

const answer = (deleted: { id: string; item: BinItem }[]) => ({
  deleted: deleted.map(({ id, item }) => ({ id, binItemId: item.id, name: item.name })),
  purgeAfter: (deleted[0]?.item.purgeAfter ?? new Date()).toISOString(),
});

/** A booking cancelled first, the way Cancel does it: the calendar locked, and a 1:1's time offered on. */
async function cancelFirst(
  ctx: CommandContext,
  appt: AppointmentRow,
  opts: { readonly notify: boolean; readonly reason: string | null },
): Promise<void> {
  const ws = ctx.scope.workspaceId!;
  const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
  await lockBooking(ctx.tx, calendar.id);
  await cancelAppointment(ctx, appt, { reason: opts.reason, notify: opts.notify, by: 'staff' });
  if (appt.kind === 'booking' && appt.capacity === 1) await signalSeatFreed(ctx, calendar, appt);
}

/**
 * A customer's bookings still to come, cancelled before they're deleted and without telling them: the whole
 * booking when nobody else is on it, and only their seat on a class time or a booking with others. A duplicate
 * merged into them goes with them, so theirs too.
 */
async function cancelTheirUpcoming(ctx: CommandContext, personId: string): Promise<void> {
  const ws = ctx.scope.workspaceId!;
  const theirs = (
    await ctx.tx
      .select({ id: people.id })
      .from(people)
      .where(
        and(
          eq(people.workspaceId, ws),
          or(eq(people.id, personId), eq(people.mergedIntoId, personId)),
          isNull(people.binItemId),
        ),
      )
  ).map((p) => p.id);
  // Nobody to look for: gone, or in the bin already (private.bin_put says which).
  if (theirs.length === 0) return;
  const now = changeMoment(ctx.meta);
  const seats = await ctx.tx
    .select({ seat: appointmentAttendees, appt: appointments })
    .from(appointmentAttendees)
    .innerJoin(appointments, eq(appointments.id, appointmentAttendees.appointmentId))
    .where(
      and(
        inArray(appointmentAttendees.personId, theirs),
        eq(appointmentAttendees.status, 'booked'),
        eq(appointments.status, 'scheduled'),
        gt(appointments.endsAt, now),
      ),
    );
  const done = new Set<string>();
  for (const { appt } of seats) {
    if (done.has(appt.id)) continue;
    done.add(appt.id);
    const booked = await ctx.tx
      .select({ id: appointmentAttendees.id })
      .from(appointmentAttendees)
      .where(
        and(
          eq(appointmentAttendees.appointmentId, appt.id),
          eq(appointmentAttendees.status, 'booked'),
        ),
      );
    // A class time stays on the calendar for everyone else, even with nobody left on it.
    if (appt.kind === 'booking' && booked.every((b) => seats.some((s) => s.seat.id === b.id))) {
      await cancelFirst(ctx, appt, { notify: false, reason: null });
      continue;
    }
    const calendar = await loadCalendar(ctx.tx, ws, appt.calendarId);
    await lockBooking(ctx.tx, calendar.id);
    for (const s of seats.filter((x) => x.appt.id === appt.id))
      await removeSeat(ctx, appt, calendar, s.seat, { notify: false });
  }
  // What's left still to come that goes with them, with nobody booked on it: a visit for one of their leads, or a
  // booking they were taken off and nobody else was on (private.bin_rows_of's bookings).
  const theirArray = `{${theirs.join(',')}}`;
  const left = await rows<{ id: string }>(
    ctx.tx,
    sql`select a.id from app.appointments a
        where a.workspace_id = ${ws}::uuid and a.kind = 'booking' and a.bin_item_id is null
          and a.status = 'scheduled' and a.ends_at > ${now.toISOString()}::timestamptz
          and (exists (select 1 from app.appointment_attendees t
                       where t.appointment_id = a.id and t.person_id = any (${theirArray}::uuid[]))
               or a.lead_id in (select l.id from app.leads l where l.person_id = any (${theirArray}::uuid[])))
          and not exists (select 1 from app.appointment_attendees o
                          where o.appointment_id = a.id and not (o.person_id = any (${theirArray}::uuid[])))`,
  );
  for (const { id } of left)
    await cancelFirst(ctx, await requireAppointment(ctx.tx, ws, id), {
      notify: false,
      reason: null,
    });
}

export const personDelete = defineCommand({
  name: 'person.delete',
  description:
    'Delete customers for good, with everything only about them: they wait 30 days in the Deleted bin first. Their bills stay, with just their name.',
  risk: 4,
  input: PersonDeleteInput,
  output: BinDeleteOutput,
  permission: 'records.delete',
  scope: inWorkspace,
  emits: ['person.deleted', 'appointment.cancelled', 'attendee.removed', 'waitlist.seat_freed'],
  async handler(ctx, input) {
    const deleted: { id: string; item: BinItem }[] = [];
    for (const id of input.personIds) {
      await cancelTheirUpcoming(ctx, id);
      deleted.push({ id, item: await putInBin(ctx, 'person', id) });
    }
    return answer(deleted);
  },
});

export const conversationDelete = defineCommand({
  name: 'conversation.delete',
  description:
    'Delete conversations for good, with their messages and calls: they wait 30 days in the Deleted bin first. The customer stays.',
  risk: 4,
  input: ConversationDeleteInput,
  output: BinDeleteOutput,
  permission: 'records.delete',
  scope: inWorkspace,
  emits: ['conversation.deleted'],
  async handler(ctx, input) {
    const deleted: { id: string; item: BinItem }[] = [];
    for (const id of input.conversationIds)
      deleted.push({ id, item: await putInBin(ctx, 'conversation', id) });
    return answer(deleted);
  },
});

export const appointmentDelete = defineCommand({
  name: 'appointment.delete',
  description:
    'Delete a booking for good: one still to come is cancelled first, telling the customers if asked. It waits 30 days in the Deleted bin.',
  risk: 4,
  input: AppointmentDeleteInput,
  output: BinDeleteOutput,
  permission: 'records.delete',
  scope: inWorkspace,
  emits: ['appointment.deleted', 'appointment.cancelled', 'waitlist.seat_freed'],
  async handler(ctx, input) {
    const appt = await requireAppointment(ctx.tx, ctx.scope.workspaceId!, input.appointmentId);
    if (appt.status === 'scheduled' && appt.endsAt > changeMoment(ctx.meta))
      await cancelFirst(ctx, appt, { notify: input.notify, reason: input.reason ?? null });
    return answer([{ id: appt.id, item: await putInBin(ctx, 'appointment', appt.id) }]);
  },
});

export const binRestore = defineCommand({
  name: 'bin.restore',
  description:
    'Bring something back from the Deleted bin, as it was. A conversation whose line has had a new one since joins it.',
  risk: 2,
  input: BinRestoreInput,
  output: BinRestoreOutput,
  permission: 'records.delete',
  scope: inWorkspace,
  emits: ['bin.restored'],
  async handler(ctx, input) {
    const [r] = await rows<{
      r: { kind: BinKind; recordId: string; name: string; folded: number };
    }>(ctx.tx, sql`select private.restore_bin_item(${input.binItemId}::uuid) as r`);
    const back = r!.r;
    await ctx.emit({
      type: 'bin.restored',
      entityType: back.kind,
      entityId: back.recordId,
      payload: { name: back.name, kind: back.kind, joined: back.folded },
      after: { name: back.name, restored: true },
    });
    return { kind: back.kind, recordId: back.recordId, name: back.name, joined: back.folded };
  },
});

export const binEmpty = defineCommand({
  name: 'bin.empty',
  description:
    'Delete now what’s in the Deleted bin, or all of it, rather than waiting the 30 days. It can’t be brought back after.',
  risk: 4,
  input: BinEmptyInput,
  output: BinEmptyOutput,
  permission: 'records.delete',
  scope: inWorkspace,
  emits: ['bin.emptied'],
  async handler(ctx, input) {
    const ids = input.all
      ? (
          await ctx.tx
            .select({ id: binItems.id })
            .from(binItems)
            .where(and(eq(binItems.workspaceId, input.workspaceId), isNull(binItems.purgingSince)))
        ).map((b) => b.id)
      : (input.binItemIds ?? []);
    if (ids.length === 0) return { emptying: 0 };
    const started = await rows<{
      bin_item_id: string;
      kind: BinKind;
      record_id: string;
      name: string;
    }>(ctx.tx, sql`select * from private.bin_start_purge(${`{${ids.join(',')}}`}::uuid[])`);
    // The worker empties each one (a batch at a time) when it hears of it.
    for (const s of started)
      await ctx.emit({
        type: 'bin.emptied',
        entityType: s.kind,
        entityId: s.record_id,
        payload: { name: s.name, kind: s.kind, binItemId: s.bin_item_id },
        after: { name: s.name, emptied: true },
      });
    return { emptying: started.length };
  },
});

export const binCommands = [
  personDelete,
  conversationDelete,
  appointmentDelete,
  binRestore,
  binEmpty,
];

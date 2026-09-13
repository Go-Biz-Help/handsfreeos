/**
 * The worker's record of a booking's confirmation and reminders, kept on the attendee (reminder_state):
 * scheduled, sent by text or email, or skipped and why. The calendar's appointment sheet reads it through
 * appointment.get. A record that changes nothing writes nothing; sent and skipped ones are audited.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { rows, sql } from '@hfos/db/client';
import { appointmentAttendees } from '@hfos/db/schema';
import { parseReminderState } from '../calendar/reminders';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import type { ReminderEntry } from '../schemas/calendar';
import { isoDateTime, uuid } from '../schemas/common';

/** 'confirmation', or a reminder: 'day_before' or 'before_<minutes>'. */
export const REMINDER_RECORD_KEY = /^(confirmation|day_before|before_\d{1,5})$/;

export const AttendeeRecordReminderInput = z.object({
  workspaceId: uuid,
  attendeeId: uuid,
  key: z.string().regex(REMINDER_RECORD_KEY, 'Name the confirmation or one of the reminders.'),
  status: z.enum(['scheduled', 'sent', 'skipped']),
  channel: z.enum(['sms', 'email']).nullable().default(null),
  reason: z.string().trim().max(60).nullable().default(null),
  /** The appointment start this is for. */
  startsAt: isoDateTime,
  dueAt: isoDateTime.nullable().default(null),
  messageId: uuid.nullable().default(null),
});
export const AttendeeRecordReminderOutput = z.object({ attendeeId: uuid, changed: z.boolean() });

const sameEntry = (a: ReminderEntry | null, b: ReminderEntry): boolean =>
  !!a &&
  a.status === b.status &&
  a.channel === b.channel &&
  a.reason === b.reason &&
  a.startsAt === b.startsAt &&
  a.dueAt === b.dueAt &&
  a.messageId === b.messageId;

export const attendeeRecordReminder = defineCommand({
  name: 'attendee.record_reminder',
  description:
    'Worker: records what happened to a booking’s confirmation or one of its reminders: scheduled, sent by text or email, or skipped and why.',
  risk: 1,
  input: AttendeeRecordReminderInput,
  output: AttendeeRecordReminderOutput,
  permission: null,
  scope: (i: { workspaceId: string }) => ({
    kind: 'workspace' as const,
    workspaceId: i.workspaceId,
  }),
  emits: ['attendee.reminder_recorded'],
  actors: ['system'],
  async handler(ctx, input) {
    // Locked: two reminders finishing at once each keep the other's entry.
    const [row] = await rows<{
      id: string;
      appointment_id: string;
      reminder_state: unknown;
      title: string;
      customer: string;
    }>(
      ctx.tx,
      sql`select a.id, a.appointment_id, a.reminder_state, p.title,
            coalesce(nullif(btrim(c.first_name || ' ' || c.last_name), ''), 'Customer') as customer
          from app.appointment_attendees a
          join app.appointments p on p.id = a.appointment_id
          join app.people c on c.id = a.person_id
          where a.id = ${input.attendeeId} and a.workspace_id = ${ctx.scope.workspaceId!}
          for update of a`,
    );
    if (!row) throw HfosError.notFound('Booking not found.');
    const state = parseReminderState(row.reminder_state);
    const entry: ReminderEntry = {
      status: input.status,
      channel: input.channel,
      reason: input.reason,
      startsAt: input.startsAt,
      dueAt: input.dueAt,
      at: new Date().toISOString(),
      messageId: input.messageId,
    };
    const before =
      input.key === 'confirmation' ? state.confirmation : (state.reminders[input.key] ?? null);
    if (sameEntry(before, entry)) return { attendeeId: row.id, changed: false };
    const next =
      input.key === 'confirmation'
        ? { ...state, confirmation: entry }
        : { ...state, reminders: { ...state.reminders, [input.key]: entry } };
    await ctx.tx
      .update(appointmentAttendees)
      .set({ reminderState: next })
      .where(eq(appointmentAttendees.id, row.id));
    if (entry.status !== 'scheduled')
      await ctx.emit({
        type: 'attendee.reminder_recorded',
        entityType: 'appointment',
        entityId: row.appointment_id,
        payload: {
          attendeeId: row.id,
          key: input.key,
          status: entry.status,
          channel: entry.channel,
          reason: entry.reason,
        },
        after: {
          title: row.title,
          customer: row.customer,
          reminder: input.key,
          status: entry.status,
          channel: entry.channel,
          reason: entry.reason,
        },
      });
    return { attendeeId: row.id, changed: true };
  },
});

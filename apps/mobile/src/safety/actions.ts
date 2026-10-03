import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import {
  change,
  newId,
  type ChangeOptions,
  type ChangeResult,
  type CommandName,
  type InputOf,
} from '@/changes';
import type { SqlRunner } from '@/changes/outbox';
import { CHANNEL_ID } from '@/push/present';

import {
  endAfterAdding,
  OPEN_STATES,
  reminderAt,
  reminderData,
  reminderId,
  safetyTimesOf,
  toldOf,
  type ContactRow,
} from './check-in';

/**
 * Checking in, adding time and checking out, from this phone (round six, core). Each is a change that waits on the
 * phone with no signal (`anytime` in the phone's contract) and writes the check-in here at once, and each sets or
 * clears the reminder for the planned end, so the person is asked even with no signal at all. The reminder's own
 * buttons (I'm OK, +15 min) do the same through `changeFromPress`, so pressing one with no signal checks out or moves
 * the reminder on this phone too.
 */

/** SQL the changes write to the phone's own copy before anything is sent. */
export const CHECK_IN_INSERT = `
  INSERT INTO safety_checkins (id, workspace_id, user_id, appointment_id, place, latitude, longitude, started_at,
    planned_end_at, extended_count, state, alert_round, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'in', 0, ?, ?)`;
export const CHECK_IN_EXTEND = `
  UPDATE safety_checkins SET planned_end_at = ?, extended_count = coalesce(extended_count, 0) + 1, state = 'in',
    updated_at = ? WHERE id = ?`;
export const CHECK_IN_OUT = `
  UPDATE safety_checkins SET state = 'out', checked_out_at = ?, updated_at = ? WHERE id = ?`;

/** What the reminder says, read from the phone's copy. */
export const REMINDER_CHECK_IN = `
  SELECT c.id, c.workspace_id, c.user_id, c.place, c.planned_end_at, c.state, w.name AS business, w.timezone,
    w.settings
  FROM safety_checkins c LEFT JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?`;
export const REMINDER_CONTACTS = `
  SELECT contact_user_id, name, agreed_at, stopped_at FROM safety_contacts
  WHERE workspace_id = ? AND user_id = ? ORDER BY position, created_at`;
export const REMINDER_TEAM = `SELECT user_id FROM workspace_memberships WHERE workspace_id = ?`;

interface Reminder {
  readonly checkInId: string;
  readonly workspaceId: string;
  readonly business: string;
  readonly place: string;
  readonly plannedEndAt: string;
  readonly timeZone: string;
  readonly contacts: readonly string[];
  readonly askAfterMinutes: number;
  readonly alertAfterMinutes: number;
}

/** The reminder for a check-in as the phone's copy has it now, or null when it's not open (or not here). */
async function reminderOf(tx: SqlRunner, checkInId: string): Promise<Reminder | null> {
  const c = await tx.getOptional<{
    id: string;
    workspace_id: string;
    user_id: string;
    place: string;
    planned_end_at: string;
    state: string;
    business: string | null;
    timezone: string | null;
    settings: string | null;
  }>(REMINDER_CHECK_IN, [checkInId]);
  if (!c || !OPEN_STATES.includes(c.state)) return null;
  const contacts = await tx.getAll<ContactRow>(REMINDER_CONTACTS, [c.workspace_id, c.user_id]);
  const team = await tx.getAll<{ user_id: string }>(REMINDER_TEAM, [c.workspace_id]);
  return {
    checkInId: c.id,
    workspaceId: c.workspace_id,
    business: c.business ?? 'HandsFreeOS',
    place: c.place,
    plannedEndAt: new Date(Date.parse(c.planned_end_at)).toISOString(),
    timeZone: c.timezone ?? 'UTC',
    contacts: toldOf(contacts, new Set(team.map((t) => t.user_id))),
    ...safetyTimesOf(c.settings),
  };
}

/** Adds time on this phone (from the planned end, or from when it was asked once that's passed); the new reminder. */
async function extendHere(
  tx: SqlRunner,
  checkInId: string,
  minutes: number,
  at: number,
): Promise<Reminder | null> {
  const c = await tx.getOptional<{ planned_end_at: string; state: string }>(
    'SELECT planned_end_at, state FROM safety_checkins WHERE id = ?',
    [checkInId],
  );
  if (!c || !OPEN_STATES.includes(c.state)) return null;
  const end = endAfterAdding(c.planned_end_at, minutes, at);
  await tx.execute(CHECK_IN_EXTEND, [end, new Date(at).toISOString(), checkInId]);
  return reminderOf(tx, checkInId);
}

async function setReminder(r: Reminder): Promise<void> {
  const data = reminderData({ ...r, newId });
  await Notifications.cancelScheduledNotificationAsync(reminderId(r.checkInId)).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    identifier: reminderId(r.checkInId),
    content: {
      title: data.title ?? '',
      ...(data.subtitle ? { subtitle: data.subtitle } : {}),
      body: data.body ?? '',
      data: { ...data },
      categoryIdentifier: data.category,
      sound: 'default',
      ...(Platform.OS === 'android' ? { priority: 'max' } : { interruptionLevel: 'timeSensitive' }),
      autoDismiss: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: reminderAt(r.plannedEndAt, r.askAfterMinutes),
      ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
    },
  });
}

const clearReminder = (checkInId: string) =>
  Notifications.cancelScheduledNotificationAsync(reminderId(checkInId)).catch(() => {});

export async function checkIn(input: {
  readonly workspaceId: string;
  readonly userId: string;
  readonly place: string;
  readonly plannedEndAt: string;
  readonly appointmentId?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}): Promise<string> {
  const id = newId();
  const now = new Date().toISOString();
  const made: { reminder: Reminder | null } = { reminder: null };
  await change(
    'safety.check_in',
    {
      workspaceId: input.workspaceId,
      id,
      place: input.place,
      plannedEndAt: input.plannedEndAt,
      ...(input.appointmentId ? { appointmentId: input.appointmentId } : {}),
      ...(input.latitude !== undefined && input.longitude !== undefined
        ? { latitude: input.latitude, longitude: input.longitude }
        : {}),
    },
    {
      optimistic: async (tx) => {
        await tx.execute(CHECK_IN_INSERT, [
          id,
          input.workspaceId,
          input.userId,
          input.appointmentId ?? null,
          input.place,
          input.latitude ?? null,
          input.longitude ?? null,
          now,
          input.plannedEndAt,
          now,
          now,
        ]);
        made.reminder = await reminderOf(tx, id);
      },
    },
  );
  if (made.reminder) await setReminder(made.reminder);
  return id;
}

export async function addTime(
  c: { readonly workspaceId: string; readonly checkInId: string },
  minutes: number,
): Promise<void> {
  await changeFromPress('safety.extend', { ...c, minutes }, {});
}

export async function checkOut(c: {
  readonly workspaceId: string;
  readonly checkInId: string;
}): Promise<void> {
  await changeFromPress('safety.check_out', c, {});
}

/**
 * Makes a change, and for the check-in ones writes them to the phone's copy and moves or clears the reminder: the
 * screen's buttons and the reminder's own (push/device.ts) both come here. A press heard twice is made once, and then
 * neither writes nor moves anything again.
 */
export async function changeFromPress<N extends CommandName>(
  name: N,
  input: InputOf<N>,
  options: ChangeOptions,
  make: typeof change = change,
): Promise<ChangeResult<N>> {
  const at = Math.min(options.madeAt ?? Date.now(), Date.now());
  if (name === 'safety.extend') {
    const { checkInId, minutes } = input as InputOf<'safety.extend'>;
    // Written only when the change is made here: a press heard twice leaves the reminder as the first one set it.
    const made: { wrote: boolean; reminder: Reminder | null } = { wrote: false, reminder: null };
    const result = await make(name, input, {
      ...options,
      optimistic: async (tx) => {
        made.wrote = true;
        made.reminder = await extendHere(tx, checkInId, minutes, at);
      },
    });
    if (made.reminder) await setReminder(made.reminder);
    else if (made.wrote) await clearReminder(checkInId);
    return result;
  }
  if (name === 'safety.check_out') {
    const { checkInId } = input as InputOf<'safety.check_out'>;
    const when = new Date(at).toISOString();
    const result = await make(name, input, {
      ...options,
      optimistic: (tx) => tx.execute(CHECK_IN_OUT, [when, when, checkInId]),
    });
    await clearReminder(checkInId);
    return result;
  }
  return make(name, input, options);
}

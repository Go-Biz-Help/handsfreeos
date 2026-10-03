import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { change, newId } from '@/changes';
import { CHANNEL_ID } from '@/push/present';

import { endAfterAdding, reminderData, reminderId } from './check-in';

/**
 * Checking in, adding time and checking out, from this phone (round six, core). Each is a change that waits on the
 * phone with no signal (`anytime` in the phone's contract) and writes the check-in here at once, and each sets or
 * clears the reminder for the planned end, so the person is asked even with no signal at all.
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

export interface ReminderContext {
  readonly business: string;
  readonly timeZone: string;
  readonly contacts: readonly string[];
  readonly alertAfterMinutes: number;
}

async function setReminder(
  c: { checkInId: string; workspaceId: string; place: string; plannedEndAt: string },
  r: ReminderContext,
): Promise<void> {
  const data = reminderData({ ...c, ...r, newId });
  await Notifications.cancelScheduledNotificationAsync(reminderId(c.checkInId)).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    identifier: reminderId(c.checkInId),
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
      date: new Date(c.plannedEndAt),
      ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
    },
  });
}

const clearReminder = (checkInId: string) =>
  Notifications.cancelScheduledNotificationAsync(reminderId(checkInId)).catch(() => {});

export async function checkIn(
  input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly place: string;
    readonly plannedEndAt: string;
    readonly appointmentId?: string;
    readonly latitude?: number;
    readonly longitude?: number;
  },
  reminder: ReminderContext,
): Promise<string> {
  const id = newId();
  const now = new Date().toISOString();
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
      optimistic: (tx) =>
        tx.execute(CHECK_IN_INSERT, [
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
        ]),
    },
  );
  await setReminder(
    {
      checkInId: id,
      workspaceId: input.workspaceId,
      place: input.place,
      plannedEndAt: input.plannedEndAt,
    },
    reminder,
  );
  return id;
}

export async function addTime(
  c: {
    readonly workspaceId: string;
    readonly checkInId: string;
    readonly place: string;
    readonly plannedEndAt: string;
  },
  minutes: number,
  reminder: ReminderContext,
): Promise<string> {
  const now = Date.now();
  const end = endAfterAdding(c.plannedEndAt, minutes, now);
  await change(
    'safety.extend',
    { workspaceId: c.workspaceId, checkInId: c.checkInId, minutes },
    {
      optimistic: (tx) =>
        tx.execute(CHECK_IN_EXTEND, [end, new Date(now).toISOString(), c.checkInId]),
    },
  );
  await setReminder({ ...c, plannedEndAt: end }, reminder);
  return end;
}

export async function checkOut(c: {
  readonly workspaceId: string;
  readonly checkInId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await change(
    'safety.check_out',
    { workspaceId: c.workspaceId, checkInId: c.checkInId },
    { optimistic: (tx) => tx.execute(CHECK_IN_OUT, [now, now, c.checkInId]) },
  );
  await clearReminder(c.checkInId);
}

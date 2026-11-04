import type { PushData } from '@hfos/core';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { CHANNEL_ID, notificationOf } from '@/push/present';

import { isDemoId } from './ids';

/**
 * A scene's notifications (src/demo): built by the code that shows a real push (`notificationOf`), with its category's
 * buttons and, for the urgent kinds, time-sensitive on an iPhone, then set off by the phone itself a few seconds later,
 * so the presenter has time to lock it.
 */

const platform: 'ios' | 'android' = Platform.OS === 'ios' ? 'ios' : 'android';

/** Whether this phone shows HandsFreeOS's notifications at all. */
export async function notificationsAllowed(): Promise<boolean> {
  const p = await Notifications.getPermissionsAsync();
  return p.granted || p.status === 'granted';
}

export async function scheduleDemoPush(data: PushData, inSeconds: number): Promise<void> {
  const notification = notificationOf(data, platform);
  if (!notification) return;
  await Notifications.scheduleNotificationAsync({
    identifier: notification.identifier,
    content: { ...notification.content },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: Math.max(1, inSeconds),
      ...(platform === 'android' ? { channelId: CHANNEL_ID } : {}),
    },
  });
}

const isDemoNotification = (n: {
  request: { identifier: string; content: { data?: unknown } };
}) => {
  const data = n.request.content.data;
  const notificationId =
    data && typeof data === 'object' ? (data as { notificationId?: unknown }).notificationId : null;
  return isDemoId(notificationId) || n.request.identifier.includes('de300000-');
};

/** Takes away every scene notification: the ones showing, and the ones still to come. */
export async function clearDemoPushes(): Promise<void> {
  const [scheduled, shown] = await Promise.all([
    Notifications.getAllScheduledNotificationsAsync(),
    Notifications.getPresentedNotificationsAsync(),
  ]);
  await Promise.all([
    ...scheduled
      .filter((r) => isDemoNotification({ request: r }))
      .map((r) => Notifications.cancelScheduledNotificationAsync(r.identifier)),
    ...shown
      .filter(isDemoNotification)
      .map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
  ]);
}

import type { PushData } from '@hfos/core';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import { changes } from '@/changes';
import { startCall } from '@/inbox/calls';
import { appVersion } from '@/lib/app-version';
import { session } from '@/lib/auth';
import { cachedMe } from '@/lib/businesses';
import { config } from '@/lib/config';
import { deviceStore } from '@/lib/device-store';
import { networkSnapshot, subscribeNetwork } from '@/lib/network';
import { pendingLinks } from '@/links/pending';
import { copyLogger } from '@/sync/logger';

import HfosPhone from '../../modules/hfos-phone';

import { allCategories } from './categories';
import {
  followUpOfResponse,
  notificationIdentifierOf,
  pressOf,
  pushDataOfNotification,
  showsPush,
  taskEventOf,
} from './payload';
import {
  CHANNEL_ID,
  CHANNEL_NAME,
  followUpNotificationOf,
  Presenter,
  type LocalNotification,
} from './present';
import { PressRunner, type PressOutcome } from './press';
import { PushRegistration, type PushPermission } from './registration';
import { pretendLocked, rememberPress } from './test-flags';

/**
 * Push notifications on this phone, wired to Expo's notifications module, the session, the queue of changes and the
 * route map: registering the phone, the categories and their buttons, showing Android's data-only pushes, and running
 * presses. `index.ts` defines the background task before anything else loads; `startApp` starts the rest.
 */

export const PUSH_TASK = 'hfos-push';

export const pushPlatform: 'ios' | 'android' = Platform.OS === 'ios' ? 'ios' : 'android';

const log = (message: string, error?: unknown) =>
  copyLogger.log({ level: 40, message, error } as Parameters<typeof copyLogger.log>[0]);

async function schedule(notification: LocalNotification): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    identifier: notification.identifier,
    content: { ...notification.content },
    trigger: notification.trigger,
  });
}

/** The channel (Android) and every category's buttons: at every start, before a push can arrive or be shown. */
async function prepareNotifications(): Promise<void> {
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: CHANNEL_NAME,
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      enableVibrate: true,
      vibrationPattern: [0, 250, 250, 250],
      showBadge: true,
    });
  for (const category of allCategories())
    await Notifications.setNotificationCategoryAsync(
      category.id,
      category.actions.map((action) => ({
        identifier: action.identifier,
        buttonTitle: action.buttonTitle,
        ...(action.textInput ? { textInput: action.textInput } : {}),
        options: { ...action.options },
      })),
    );
}

const permissionOf = (p: Notifications.NotificationPermissionsStatus) => ({
  status: p.status as PushPermission,
  canAskAgain: p.canAskAgain,
});

/** This phone on the person's list of phones that get notifications. */
export const pushRegistration = new PushRegistration({
  platform: pushPlatform,
  projectId: config.easProjectId,
  standInTokens: config.e2e,
  appVersion,
  deviceName: () => Constants.deviceName?.trim() || null,
  notifications: {
    prepare: prepareNotifications,
    getPermissions: async () => permissionOf(await Notifications.getPermissionsAsync()),
    requestPermissions: async () =>
      permissionOf(
        await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowBadge: true, allowSound: true },
        }),
      ),
    expoPushToken: async (projectId) =>
      (await Notifications.getExpoPushTokenAsync({ projectId })).data,
    onTokenChange: (listener) => {
      const subscription = Notifications.addPushTokenListener(() => listener());
      return () => subscription.remove();
    },
  },
  register: async (input) => {
    await changes.change('push_device.register', input);
  },
  remove: async (input) => {
    await changes.change('push_device.remove', input);
  },
  session,
  network: { online: () => networkSnapshot().online, subscribe: subscribeNetwork },
  appActive: {
    isActive: () => AppState.currentState === 'active',
    subscribe: (listener) => {
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') listener();
      });
      return () => sub.remove();
    },
  },
  store: deviceStore,
  newId: () => Crypto.randomUUID(),
  log,
});

/** Someone is signed in here, and the push's business is one of theirs. */
function forThisPhone(data: PushData): boolean {
  const state = session.getState();
  if (state.status !== 'signedIn') return false;
  const me = cachedMe(state.person.userId);
  return Boolean(me?.businesses.some((b) => b.id === data.workspaceId));
}

export const presenter = new Presenter({ platform: pushPlatform, schedule, forThisPhone });

/** Waits for something the app is doing, up to a limit. */
function waitFor(
  check: () => boolean,
  subscribe: (listener: () => void) => () => void,
  timeoutMs: number,
): Promise<boolean> {
  if (check()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    const unsubscribe = subscribe(() => {
      if (check()) finish(true);
    });
    const timer = setTimeout(() => finish(check()), timeoutMs);
  });
}

export const pressRunner = new PressRunner({
  platform: pushPlatform,
  now: Date.now,
  ready: async () => {
    await waitFor(() => session.getState().status !== 'starting', session.subscribe, 10_000);
    const state = session.getState();
    if (state.status !== 'signedIn') return null;
    const userId = state.person.userId;
    const open = await waitFor(
      () => changes.getSnapshot().userId === userId,
      changes.subscribe,
      20_000,
    );
    if (!open) throw new Error('This phone’s copy of your business didn’t open in time.');
    return { userId, businessIds: cachedMe(userId)?.businesses.map((b) => b.id) ?? [] };
  },
  phoneLocked: () => pretendLocked() || (Platform.OS === 'android' && HfosPhone.isDeviceLocked()),
  change: (name, input, options) => changes.change(name, input, options),
  sendNow: (id) => changes.sendQueuedNow(id),
  openLink: (path) => pendingLinks.open(path),
  startCall: (target, workspaceId) => startCall(target, { workspaceId }),
  appInFront: () => AppState.currentState === 'active',
  askAbout: (changeId) => pendingLinks.ask(changeId),
  unlockToRun: () => pendingLinks.unlockToRun(),
  followUp: async (followUp) => {
    // What a sent reply leaves to say goes only over that push's own notification: a newer message about the same
    // conversation keeps its place, and a notification the person already cleared stays cleared.
    if (followUp.kind === 'done') {
      const presented = await Notifications.getPresentedNotificationsAsync();
      const identifier = notificationIdentifierOf(followUp.data);
      if (!showsPush(presented, identifier, followUp.data.notificationId)) return;
    }
    await schedule(followUpNotificationOf(followUp, pushPlatform));
  },
  dismiss: async (identifier, notificationId) => {
    const presented = await Notifications.getPresentedNotificationsAsync();
    if (showsPush(presented, identifier, notificationId))
      await Notifications.dismissNotificationAsync(identifier);
  },
  store: deviceStore,
  log,
});

/** Runs a notification response (a press or a tap) and keeps what happened for the test tools. */
export async function handleResponse(response: unknown): Promise<PressOutcome | null> {
  const press = pressOf(response);
  if (!press) return null;
  try {
    const outcome = await pressRunner.handle(press, { followUp: followUpOfResponse(response) });
    rememberPress(outcome);
    return outcome;
  } catch (error) {
    log('A notification press failed', error);
    return null;
  }
}

/**
 * The background task (Android): a data-only push arriving, shown by the app; or a button pressed while the app is in
 * the background or closed. `startApp` runs first, so the sign-in, the lock and the person's copy are there.
 */
export async function runPushTask(payload: unknown, startApp: () => Promise<void>): Promise<void> {
  const event = taskEventOf(payload);
  if (event.kind === 'other') return;
  await startApp();
  if (event.kind === 'received') {
    await presenter.present(event.data).catch((error: unknown) => log('Showing a push', error));
    return;
  }
  await handleResponse(payload);
}

/**
 * Signing out: this phone comes off the person's list while the API still knows who they are, and their notifications
 * go from the phone. Never holds the sign-out up for long: with no answer in a few seconds it goes ahead.
 */
export async function pushBeforeSignOut(): Promise<void> {
  pendingLinks.take();
  pendingLinks.takeAsk();
  pendingLinks.takeUnlock();
  pressRunner.clearPending();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    pushRegistration.beforeSignOut(),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 6_000);
    }),
  ]);
  clearTimeout(timer);
  await Notifications.dismissAllNotificationsAsync().catch(() => undefined);
}

let started = false;

/**
 * Once the app has started: what a notification does while the app is open, the presses heard before the app's
 * listeners were there (an iPhone launched by a button, a tap that opened the app), the background task, and
 * registering this phone.
 */
export function startPush(): void {
  if (started) return;
  started = true;

  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const content = notification.request.content;
      // An Android data-only push has no words of its own: the app shows it as a notification of its own instead.
      if (!content.title && !content.body)
        return {
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
        };
      const data = pushDataOfNotification(notification);
      // A quiet update, or what a press left to say (the person just pressed): no banner, no sound.
      const quiet =
        data?.quiet === true ||
        Boolean(content.data && typeof content.data === 'object' && 'followUp' in content.data);
      return {
        shouldShowBanner: !quiet,
        shouldShowList: true,
        shouldPlaySound: !quiet,
        shouldSetBadge: false,
      };
    },
  });

  // A data-only push arriving with the app open (the background task also hears it; the presenter shows it once).
  Notifications.addNotificationReceivedListener((notification) => {
    if (Platform.OS !== 'android') return;
    const content = notification.request.content;
    if (content.title || content.body) return;
    const data = pushDataOfNotification(notification);
    if (data) void presenter.present(data).catch((error: unknown) => log('Showing a push', error));
  });

  Notifications.addNotificationResponseReceivedListener((response) => {
    void handleResponse(response);
  });
  const last = Notifications.getLastNotificationResponse();
  if (last) {
    Notifications.clearLastNotificationResponse();
    void handleResponse(last);
  }

  if (Platform.OS === 'android')
    void Notifications.registerTaskAsync(PUSH_TASK).catch((error: unknown) =>
      log('Registering the notification task', error),
    );
  void prepareNotifications().catch((error: unknown) => log('Setting up notifications', error));
  pushRegistration.start();
}

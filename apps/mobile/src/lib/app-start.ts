import { AppState } from 'react-native';

import { changes } from '@/changes';
import { registerTestFixers } from '@/changes/test-actions';
import { registerCustomerFixers } from '@/customers/fixers';
import { registerInboxFixers } from '@/inbox/fixers';
import { startPush } from '@/push/device';
import { watchFollowing } from '@/safety/follow';
import { phoneCopy } from '@/sync';
import { prepareCopiesFolder } from '@/sync/device-files';

import { applyAppearance } from './appearance';
import { session } from './auth';
import { biometrics } from './biometrics';
import { lock, lockEnabledFor } from './lock';
import { networkSnapshot, startNetworkWatch, subscribeNetwork } from './network';
import { forgetSignInFromEarlierInstall } from './secure-storage';
import { supabase } from './supabase';

let starting: Promise<void> | null = null;

/** Locks the app if this person has Face ID on and the phone can check it. */
export async function lockIfEnabled(): Promise<void> {
  const state = session.getState();
  if (state.status !== 'signedIn' || !lockEnabledFor(state.person.userId)) return;
  if ((await biometrics.info()).available) lock.lock();
}

/**
 * Everything the app does once, before the first screen: the appearance, watching for signal, the saved sign-in, the
 * lock, the copies' folder (kept out of backups), then the person's copy of their businesses (opened now, connected
 * once unlocked) with the queue of changes made on it, and notifications (registering this phone, and presses heard
 * before the screens were there). The splash screen stays up until it's done, so a locked app never shows a customer's
 * name first. Android's background task runs it too, with no screen, before it shows a push or runs a button.
 */
export function startApp(): Promise<void> {
  starting ??= (async () => {
    applyAppearance();
    startNetworkWatch();
    await forgetSignInFromEarlierInstall();
    await session.start();
    await lockIfEnabled();
    prepareCopiesFolder();
    registerTestFixers();
    registerInboxFixers();
    registerCustomerFixers();
    changes.start();
    phoneCopy.start();
    startPush();
    watchFollowing();

    // supabase-js can't tell when a phone app is in front: refresh the sign-in only while it is.
    AppState.addEventListener('change', (state) => {
      if (state === 'active') supabase.auth.startAutoRefresh();
      else supabase.auth.stopAutoRefresh();
    });
    // Signal back: refresh an access token that ran out while offline (a refusal then signs out).
    subscribeNetwork(() => {
      if (networkSnapshot().online) void session.refreshIfDue();
    });
  })();
  return starting;
}

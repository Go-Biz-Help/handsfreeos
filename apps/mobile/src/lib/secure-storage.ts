import * as SecureStore from 'expo-secure-store';

import { deviceStore } from './device-store';

/** Where supabase-js keeps the sign-in (its `storageKey`); it also writes `<key>-user` and `<key>-code-verifier`. */
export const SESSION_KEY = 'hfos.session';
const SESSION_KEYS = [SESSION_KEY, `${SESSION_KEY}-user`, `${SESSION_KEY}-code-verifier`];

/**
 * Readable once the phone has been unlocked after starting, and never copied to another phone or a backup. Not
 * `requireAuthentication`: supabase-js reads this on every refresh, which would ask for Face ID over and over, and
 * the phone deletes such keys whenever its Face ID changes. Face ID is the app's own lock instead (`lock.ts`).
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** The session storage supabase-js reads and writes, kept in the iOS Keychain or the Android Keystore. */
export const secureSessionStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key, OPTIONS),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value, OPTIONS),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key, OPTIONS),
};

export async function readStoredSessionText(): Promise<string | null> {
  return secureSessionStorage.getItem(SESSION_KEY);
}

export async function removeStoredSession(): Promise<void> {
  await Promise.all(SESSION_KEYS.map((key) => secureSessionStorage.removeItem(key)));
}

const INSTALL_KEY = 'install';

/**
 * The iOS Keychain outlives deleting the app, so a reinstalled app would find the last person still signed in. The
 * device store's file goes with the app, so a missing install mark means a fresh install: clear the old sign-in.
 */
export async function forgetSignInFromEarlierInstall(): Promise<void> {
  if (deviceStore.get<string>(INSTALL_KEY)) return;
  await removeStoredSession();
  deviceStore.set(INSTALL_KEY, new Date().toISOString());
}

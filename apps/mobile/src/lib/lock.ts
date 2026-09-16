import { useSyncExternalStore } from 'react';

import { deviceStore } from './device-store';

/**
 * The app's own lock. When someone is signed in and "Unlock with Face ID" is on, the app locks when it starts and when
 * it comes back after a few minutes away, and Face ID (or a fingerprint, or the phone's passcode) opens it. Locking
 * never touches the sign-in, so it works the same with no signal.
 */

/** Away this long, and the app locks again. Shorter trips (answering a text, a photo) don't ask twice. */
export const LOCK_AFTER_MS = 5 * 60_000;

/** Whether coming back to the app should lock it. */
export function lockOnReturn(
  backgroundAt: number | null,
  now: number,
  afterMs = LOCK_AFTER_MS,
): boolean {
  return backgroundAt !== null && now - backgroundAt >= afterMs;
}

const faceIdKey = (userId: string) => `person.${userId}.faceId`;

/** "Unlock with Face ID" for this person on this phone: on unless they turned it off. */
export function lockEnabledFor(userId: string): boolean {
  return deviceStore.get<boolean>(faceIdKey(userId)) !== false;
}

export function setLockEnabledFor(userId: string, enabled: boolean): void {
  deviceStore.set(faceIdKey(userId), enabled);
}

export interface LockSnapshot {
  readonly locked: boolean;
}

let snapshot: LockSnapshot = { locked: false };
const listeners = new Set<() => void>();

function set(locked: boolean) {
  if (snapshot.locked === locked) return;
  snapshot = { locked };
  for (const listener of listeners) listener();
}

export const lock = {
  lock: () => set(true),
  unlock: () => set(false),
  isLocked: () => snapshot.locked,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useLock(): LockSnapshot {
  return useSyncExternalStore(
    lock.subscribe,
    () => snapshot,
    () => snapshot,
  );
}

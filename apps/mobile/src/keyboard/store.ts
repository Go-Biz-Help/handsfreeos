import {
  KEYBOARD_DATA_KEY,
  KEYBOARD_SEEN_KEY,
  readKeyboardData,
  readKeyboardSeen,
  type KeyboardData,
  type KeyboardSeen,
} from '@hfos/core';
import { useSyncExternalStore } from 'react';

import HfosShared from '../../modules/hfos-shared';

/**
 * The copy of templates and links the HandsFreeOS keyboard reads (docs/phone-keyboard.md), kept by the app through
 * modules/hfos-shared, and what the Phone keyboard screen shows about it.
 */

/** The Android keyboard's own pick of business (KeyboardData.kt); forgotten with the copy. */
const ANDROID_PICK_KEY = 'keyboard-pick';

export function readStoredKeyboard(): KeyboardData | null {
  try {
    return readKeyboardData(HfosShared.read(KEYBOARD_DATA_KEY));
  } catch {
    return null;
  }
}

/** What the iPhone keyboard said when it last opened with Full Access. */
export function readKeyboardSeenStamp(): KeyboardSeen | null {
  try {
    return readKeyboardSeen(HfosShared.read(KEYBOARD_SEEN_KEY));
  } catch {
    return null;
  }
}

let written: string | null = null;

/** Saves the copy, unless it's what was saved last. */
export function storeKeyboard(data: KeyboardData): boolean {
  const json = JSON.stringify(data);
  if (json === written) return true;
  try {
    const ok = HfosShared.write(KEYBOARD_DATA_KEY, json);
    if (ok) written = json;
    publish();
    return ok;
  } catch {
    return false;
  }
}

/** Signing out (or another person signing in) leaves nothing of theirs for the keyboard. */
export function forgetKeyboard(): void {
  written = null;
  try {
    HfosShared.write(KEYBOARD_DATA_KEY, null);
    HfosShared.write(ANDROID_PICK_KEY, null);
  } catch {
    // No App Group (a build without the keyboard): there was nothing to forget.
  }
  publish();
}

// ---------- what the Phone keyboard screen shows ----------

/** Why the templates aren't on the keyboard: no signal, or this person can't use the Inbox here. */
export type KeyboardProblem = 'signal' | 'not_yours' | null;

interface KeyboardStatus {
  readonly refreshing: boolean;
  readonly problem: KeyboardProblem;
  /** Bumped on every save, so the screen reads the copy again. */
  readonly version: number;
}

let status: KeyboardStatus = { refreshing: false, problem: null, version: 0 };
const listeners = new Set<() => void>();
const refreshers = new Set<() => Promise<void>>();

function publish() {
  status = { ...status, version: status.version + 1 };
  for (const listener of listeners) listener();
}

export function setKeyboardStatus(next: Partial<Omit<KeyboardStatus, 'version'>>): void {
  status = { ...status, ...next };
  publish();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useKeyboardStatus(): KeyboardStatus {
  return useSyncExternalStore(
    subscribe,
    () => status,
    () => status,
  );
}

/** The business open now keeps the copy fresh (`KeepKeyboardFresh`); Update now asks it to fetch again. */
export function onKeyboardRefresh(refresh: () => Promise<void>): () => void {
  refreshers.add(refresh);
  return () => {
    refreshers.delete(refresh);
  };
}

export async function refreshKeyboard(): Promise<void> {
  await Promise.all([...refreshers].map((refresh) => refresh()));
}

interface SessionLike {
  getState(): { readonly status: string; readonly person?: { readonly userId: string } };
  subscribe(listener: () => void): () => void;
}

/**
 * Forgets the keyboard's copy when the person signs out, or their sign-in ends, so whoever signs in next starts with
 * none: the copy is the signed-in person's own.
 */
export function watchKeyboardOwner(session: SessionLike): void {
  let signedIn = session.getState().status === 'signedIn';
  if (session.getState().status === 'signedOut') forgetKeyboard();
  session.subscribe(() => {
    const state = session.getState();
    if (state.status === 'signedOut' && signedIn) forgetKeyboard();
    if (state.status !== 'starting') signedIn = state.status === 'signedIn';
  });
}

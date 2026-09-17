import { useSyncExternalStore } from 'react';

import { testToolsEnabled } from '@/lib/config';
import { deviceStore } from '@/lib/device-store';

import type { PressOutcome } from './press';

/**
 * Test builds only: pretending the phone is locked, for the unlock rule (Maestro can't lock an emulator and unlock it
 * again), and the last press the phone ran, so a flow can read what a button did.
 */

const PRETEND_LOCKED_KEY = 'test.phoneLocked';
const LAST_PRESS_KEY = 'test.lastPress';

export function pretendLocked(): boolean {
  return testToolsEnabled && deviceStore.get<boolean>(PRETEND_LOCKED_KEY) === true;
}

export function setPretendLocked(locked: boolean): void {
  if (locked) deviceStore.set(PRETEND_LOCKED_KEY, true);
  else deviceStore.remove(PRETEND_LOCKED_KEY);
}

export function usePretendLocked(): boolean {
  return useSyncExternalStore(deviceStore.subscribe, pretendLocked, pretendLocked);
}

export interface LastPress {
  readonly at: number;
  readonly outcome: PressOutcome;
}

export function rememberPress(outcome: PressOutcome, at = Date.now()): void {
  if (!testToolsEnabled) return;
  deviceStore.set(LAST_PRESS_KEY, { at, outcome } satisfies LastPress);
}

const lastPress = () => deviceStore.get<LastPress>(LAST_PRESS_KEY) ?? null;

export function useLastPress(): LastPress | null {
  return useSyncExternalStore(deviceStore.subscribe, lastPress, lastPress);
}

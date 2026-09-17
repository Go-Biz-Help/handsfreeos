import { useSyncExternalStore } from 'react';

import { deviceStore } from './device-store';

/**
 * How many changes made on this phone haven't reached HandsFreeOS. A stand-in until the queue of changes arrives (M10
 * step 10): development and test builds set it in Settings to see the strip, the sign-out warning and what signing out
 * keeps on the phone.
 */
const WAITING_KEY = 'test.waiting';

export function waitingCount(): number {
  const n = deviceStore.get<number>(WAITING_KEY);
  return typeof n === 'number' && n > 0 ? Math.floor(n) : 0;
}

export function setTestWaiting(n: number): void {
  if (n > 0) deviceStore.set(WAITING_KEY, n);
  else deviceStore.remove(WAITING_KEY);
}

export function useWaitingCount(): number {
  return useSyncExternalStore(deviceStore.subscribe, waitingCount, waitingCount);
}

/** "4 changes", "1 change". */
export function changesWord(n: number): string {
  return `${n} ${n === 1 ? 'change' : 'changes'}`;
}

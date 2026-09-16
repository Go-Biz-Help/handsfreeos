import { useSyncExternalStore } from 'react';

import { deviceStore } from './device-store';
import { useNetwork } from './network';

/**
 * What the status line says: "Up to date", or "Offline — 4 changes waiting". The count is a stand-in until the queue
 * of changes arrives (M10 step 10); development and test builds can set it in Settings to see the strip and the
 * sign-out warning.
 */
export interface SyncStatus {
  readonly online: boolean;
  /** Changes made on this phone that haven't reached HandsFreeOS. */
  readonly waiting: number;
  /** Every change has gone and the phone has signal. */
  readonly upToDate: boolean;
  /** When the phone last had signal: what "As of 8:58 AM" shows while offline. */
  readonly asOf: number;
}

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

export function useSyncStatus(): SyncStatus {
  const network = useNetwork();
  const waiting = useWaitingCount();
  return {
    online: network.online,
    waiting,
    upToDate: network.online && waiting === 0,
    asOf: network.lastOnlineAt,
  };
}

/** "4 changes", "1 change". */
export function changesWord(n: number): string {
  return `${n} ${n === 1 ? 'change' : 'changes'}`;
}

/** The strip under the top bar, or null when there's nothing to say. */
export function stripText(status: Pick<SyncStatus, 'online' | 'waiting'>): string | null {
  if (!status.online)
    return status.waiting > 0 ? `Offline — ${changesWord(status.waiting)} waiting` : 'Offline';
  return status.waiting > 0 ? `${changesWord(status.waiting)} waiting to send` : null;
}

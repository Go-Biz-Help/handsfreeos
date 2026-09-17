import { localDateOf, localInstant } from '@hfos/core';
import { useSyncExternalStore } from 'react';

import { testToolsEnabled } from '@/lib/config';
import { deviceStore } from '@/lib/device-store';

/**
 * Test builds only: pretend the business's local time is a given clock time (the quiet-hours question at 9:40 PM),
 * and slow resumable uploads down so a flow can close the app halfway. Store builds ignore both.
 */

const PRETEND_TIME_KEY = 'test.pretendBusinessTime';
const SLOW_UPLOADS_KEY = 'test.slowUploads';

/** 9:40 PM, the canvas's quiet-hours moment. */
export const PRETEND_EVENING = '21:40';

/** A pause between the pieces of a resumable upload while slow uploads are on. */
export const SLOW_PIECE_PAUSE_MS = 8_000;

export function pretendBusinessTime(): string | null {
  if (!testToolsEnabled) return null;
  const value = deviceStore.get<string>(PRETEND_TIME_KEY);
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : null;
}

export function setPretendBusinessTime(clock: string | null): void {
  if (clock) deviceStore.set(PRETEND_TIME_KEY, clock);
  else deviceStore.remove(PRETEND_TIME_KEY);
}

/** The moment quiet hours are judged at, where the business is: now, or today at the pretended time there. */
export function quietHoursMoment(timeZone: string, now = Date.now()): Date {
  const clock = pretendBusinessTime();
  if (!clock) return new Date(now);
  try {
    return new Date(localInstant(localDateOf(now, timeZone), clock, timeZone));
  } catch {
    return new Date(now);
  }
}

export function slowUploads(): boolean {
  return testToolsEnabled && deviceStore.get<boolean>(SLOW_UPLOADS_KEY) === true;
}

export function setSlowUploads(slow: boolean): void {
  if (slow) deviceStore.set(SLOW_UPLOADS_KEY, true);
  else deviceStore.remove(SLOW_UPLOADS_KEY);
}

export function pauseBetweenPieces(): number {
  return slowUploads() ? SLOW_PIECE_PAUSE_MS : 0;
}

export function useTestOverrides(): { pretendTime: string | null; slowUploads: boolean } {
  const pretendTime = useSyncExternalStore(deviceStore.subscribe, pretendBusinessTime);
  const slow = useSyncExternalStore(deviceStore.subscribe, slowUploads);
  return { pretendTime, slowUploads: slow };
}

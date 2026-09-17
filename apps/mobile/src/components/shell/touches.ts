import * as React from 'react';
import type { GestureResponderEvent } from 'react-native';

/**
 * Whether a finger is on the screen, so the shell never moves what's under it (step 10's finding: the status strip
 * appearing moved everything below it by its height, and a tap landed on whatever moved there). `Screen` reports the
 * touches that start and end anywhere inside it; the strip waits for the finger to lift before it opens or closes.
 */

let fingers = 0;
let changedAt = 0;
const listeners = new Set<() => void>();

function set(count: number, now = Date.now()) {
  const next = Math.max(0, count);
  if (next === fingers) return;
  fingers = next;
  changedAt = now;
  for (const listener of listeners) listener();
}

export const touches = {
  /** How many fingers are down now. */
  count: (): number => fingers,
  /** When a finger last went down or lifted. */
  changedAt: (): number => changedAt,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** `onTouchStart` on a screen's root view: every finger now down. */
  start(event: GestureResponderEvent): void {
    set(Math.max(event.nativeEvent.touches?.length ?? 0, 1));
  },
  /**
   * `onTouchEnd` and `onTouchCancel`: the fingers still down. Some phones still list the finger that lifted among the
   * current touches, so it's taken out by its identifier.
   */
  end(event: GestureResponderEvent): void {
    const lifted = new Set((event.nativeEvent.changedTouches ?? []).map((t) => t.identifier));
    set((event.nativeEvent.touches ?? []).filter((t) => !lifted.has(t.identifier)).length);
  },
  /** Tests: every finger up. */
  reset(): void {
    set(0);
  },
};

/** The longest a change waits for a finger to lift, in case the end of a touch never arrives (a modal took it). */
export const HOLD_FOR_FINGER_MAX_MS = 3_000;

/**
 * `value`, except that a change between "something" and "nothing" waits until no finger is down (at most
 * `HOLD_FOR_FINGER_MAX_MS`). A change from one something to another applies at once: it doesn't move anything.
 */
export function useSettledWhileTouched<T>(value: T | null): T | null {
  const [settled, setSettled] = React.useState<T | null>(value);
  React.useEffect(() => {
    const appears = (settled === null) !== (value === null);
    if (!appears || touches.count() === 0) {
      if (settled !== value) setSettled(value);
      return;
    }
    const apply = () => setSettled(value);
    const unsubscribe = touches.subscribe(() => {
      if (touches.count() === 0) apply();
    });
    const timer = setTimeout(apply, HOLD_FOR_FINGER_MAX_MS);
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [value, settled]);
  return settled;
}

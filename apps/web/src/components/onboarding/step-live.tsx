'use client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';

/**
 * Draws a wizard step again when what it counts changes, here or anywhere else (the worker finishing a scan, a
 * teammate adding a service), so its place on the side and its footer keep up.
 */
export function StepLive({ kinds }: { kinds: readonly string[] }) {
  useLiveRefresh(kinds);
  return null;
}

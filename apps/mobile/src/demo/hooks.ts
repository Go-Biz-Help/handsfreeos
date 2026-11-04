import * as React from 'react';

import { useBusinessIfAny } from '@/components/shell/business-context';

import { demoWorld } from './scenes';
import { useDemo, type PhoneDemo } from './state';
import type { PhoneDemoWorld } from './world';

/** The scene playing in the business on screen for the person signed in, or null. */
export function useBusinessDemo(): PhoneDemo | null {
  const ctx = useBusinessIfAny();
  return useDemo(ctx?.userId ?? '', ctx?.business.id ?? '');
}

/**
 * The made-up rows the scene playing here has put on the screens, or null when none is playing: the inbox, a thread and
 * the draft cards add them to the copy's own.
 */
export function useDemoWorld(): PhoneDemoWorld | null {
  const demo = useBusinessDemo();
  return React.useMemo(() => (demo ? demoWorld(demo) : null), [demo]);
}

import type { LocationObject } from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { startApp } from '@/lib/app-start';

import { FOLLOW_TASK, onLocations } from './follow';

/**
 * Where the phone is, while a check-in follows it (`follow.ts`). Defined at the top of the app's entry (`index.ts`),
 * like the push task beside it: iPhone can start the app in the background just to hand it a reading, and a task
 * that isn't defined in time is unregistered. The app starts first, so the sign-in is there to send it with.
 */
TaskManager.defineTask<{ locations?: LocationObject[] }>(FOLLOW_TASK, async ({ data, error }) => {
  if (error || !data?.locations) return;
  await startApp();
  await onLocations(data.locations);
});

import * as TaskManager from 'expo-task-manager';

import { startApp } from '@/lib/app-start';

import { PUSH_TASK, runPushTask } from './device';

/**
 * The background task Android wakes the app for (expo-notifications' `registerTaskAsync`): a data-only push arriving,
 * and a button pressed on a notification while the app is in the background or closed. It must be defined before the
 * app renders anything, at the top of the app's entry (`index.ts`): when Android starts the app just for it, no screen
 * is mounted, and a task that isn't defined in time is unregistered.
 */
TaskManager.defineTask(PUSH_TASK, async ({ data, error }) => {
  if (error) return;
  await runPushTask(data, startApp);
});

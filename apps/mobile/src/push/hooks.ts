import { useSyncExternalStore } from 'react';

import { pushRegistration } from './device';
import type { RegistrationSnapshot } from './registration';

/** This phone's registration for notifications: its permission, token and status. */
export function usePushRegistration(): RegistrationSnapshot {
  return useSyncExternalStore(
    pushRegistration.subscribe,
    pushRegistration.getSnapshot,
    pushRegistration.getSnapshot,
  );
}

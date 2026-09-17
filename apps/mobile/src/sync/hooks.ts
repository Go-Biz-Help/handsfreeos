import * as React from 'react';

import { isKept, useKeepChoices } from '@/lib/businesses';

import { businessCopyOf, type BusinessCopy } from './business-copy';
import { phoneCopy } from './index';
import type { PhoneCopySnapshot } from './phone-copy';

export { businessCopyOf, type BusinessCopy } from './business-copy';

/** This person's copy on the phone: whether it's open, PowerSync's status, and the business on screen. */
export function usePhoneCopy(): PhoneCopySnapshot {
  return React.useSyncExternalStore(
    phoneCopy.subscribe,
    phoneCopy.getSnapshot,
    phoneCopy.getSnapshot,
  );
}

/** Tells the copy which business is on screen while this component is, so one that isn't kept still syncs. */
export function useOpenBusiness(businessId: string): void {
  React.useEffect(() => phoneCopy.openBusiness(businessId), [businessId]);
}

/** A business's copy on this phone, as the business's screens, the switcher and Settings show it. */
export function useBusinessCopy(businessId: string): BusinessCopy {
  const { sync } = usePhoneCopy();
  return businessCopyOf(sync, businessId, Date.now());
}

/** Whether each business works with no signal: kept, with its first copy finished. */
export function useWorksOffline(userId: string): (businessId: string) => boolean {
  const { sync } = usePhoneCopy();
  const choices = useKeepChoices(userId);
  return React.useCallback(
    (businessId: string) =>
      isKept(choices, businessId) && businessCopyOf(sync, businessId, 0).complete,
    [choices, sync],
  );
}

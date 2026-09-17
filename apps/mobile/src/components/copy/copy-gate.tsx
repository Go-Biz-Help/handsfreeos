import { PowerSyncContext } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import { isKept, useKeepChoices } from '@/lib/businesses';
import { useSyncStatus } from '@/lib/sync-status';
import { useBusinessCopy, useOpenBusiness, usePhoneCopy } from '@/sync/hooks';

import {
  CantProtectCopy,
  CopyDidNotOpen,
  CopyLocked,
  CopyOpening,
  GettingCopy,
} from './copy-screens';

/**
 * The signed-in app reads the person's copy on the phone: screens below here query it with PowerSync's hooks. Until it
 * opens there's nothing to show, and a phone that can't keep it encrypted gets no copy at all.
 */
export function PhoneCopyGate({ children }: { children: React.ReactNode }) {
  const { state } = usePhoneCopy();
  if (state.status === 'refused') return <CantProtectCopy />;
  if (state.status === 'failed') return <CopyDidNotOpen message={state.message} />;
  if (state.status !== 'open') return <CopyOpening />;
  return <PowerSyncContext.Provider value={state.db}>{children}</PowerSyncContext.Provider>;
}

/** Tells the copy which business is open, for as long as its screens are. */
export function OpenBusiness({ businessId }: { businessId: string }) {
  useOpenBusiness(businessId);
  return null;
}

/**
 * A business's screens need its copy: while the first one comes down they show how far it's got, and a copy that
 * hasn't synced in 30 days stays locked until it does.
 */
export function BusinessCopyGate({ children }: { children: React.ReactNode }) {
  const { business, userId } = useBusiness();
  const copy = useBusinessCopy(business.id);
  // Signal as the copy sees it: no signal, or the test builds' Disconnect.
  const { online } = useSyncStatus();
  const choices = useKeepChoices(userId);
  if (copy.locked) return <CopyLocked online={online} />;
  if (!copy.complete)
    return (
      <GettingCopy percent={copy.percent} online={online} kept={isKept(choices, business.id)} />
    );
  return <>{children}</>;
}

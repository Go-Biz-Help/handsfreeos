import type { SyncStatus } from '@powersync/common';

import { copyLocked } from './rules';
import { BUSINESS_STREAM, businessParameters } from './subscriptions';

export interface BusinessCopy {
  /** Its first copy has finished: it works with no signal while it stays on the phone. */
  readonly complete: boolean;
  /** How much of the first copy has arrived, 0–99, while it's downloading; null before it starts or once it's done. */
  readonly percent: number | null;
  /** The whole copy hasn't finished a sync in 30 days: "Connect to bring this phone up to date". */
  readonly locked: boolean;
}

/** A business's copy on this phone, from PowerSync's status for its subscription. */
export function businessCopyOf(
  sync: SyncStatus | null,
  businessId: string,
  nowMs: number,
): BusinessCopy {
  const stream = sync?.forStream({
    name: BUSINESS_STREAM,
    parameters: businessParameters(businessId),
  });
  const complete = stream?.subscription.hasSynced === true;
  const fraction = stream?.progress?.downloadedFraction;
  return {
    complete,
    percent: !complete && fraction !== undefined ? Math.min(99, Math.floor(fraction * 100)) : null,
    locked: copyLocked(sync?.lastSyncedAt, nowMs),
  };
}

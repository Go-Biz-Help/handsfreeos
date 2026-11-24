import { apiBrowser, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

type BillingStatus = Ok<'/v1/queries/billing.status'>;

/** The look-up under way for a business's billing status. */
const asking = new Map<string, Promise<BillingStatus>>();

/**
 * A business's billing status for the parts of the shell that ask as a page opens (the failed-payment guard, the
 * trial's last-days note): asked together they share one look-up, where each made its own on every full load. Nothing
 * is kept once it's answered, so the next page asks afresh.
 */
export function billingStatusNow(workspaceId: string): Promise<BillingStatus> {
  const under = asking.get(workspaceId);
  if (under) return under;
  const asked = apiBrowser()
    .POST('/v1/queries/billing.status', { body: { workspaceId } })
    .then(unwrap)
    .finally(() => asking.delete(workspaceId));
  asking.set(workspaceId, asked);
  return asked;
}

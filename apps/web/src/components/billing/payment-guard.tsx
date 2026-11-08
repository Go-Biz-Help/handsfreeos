'use client';
import { paymentBlockOf } from '@hfos/core';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { readPaymentSkip } from '@/lib/payment-skip';

/**
 * The failed-payment page in front of the CRM (20261027023600, the owner's call of 2026-11-08): on every screen opened
 * in the business, ask whether a plan payment is owed, and send them to `/payment/<business>` while it is, unless they
 * skipped it for now on this device (up to 72 hours after it failed) or staff gave them more time.
 *
 * Settings → Billing stays open, so whoever manages money can sort out the cards there. Support looking in and anyone
 * viewing as a teammate never get it: the layout leaves this out for them.
 */
export function PaymentGuard({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (pathname.endsWith('/settings/billing')) return;
    let gone = false;
    void apiBrowser()
      .POST('/v1/queries/billing.status', { body: { workspaceId } })
      .then(unwrap)
      .then((status) => {
        if (gone) return;
        const block = paymentBlockOf(status.owed, new Date(), readPaymentSkip(workspaceId));
        if (block?.show) router.replace(`/payment/${workspaceId}`);
      })
      // Only a check: when it can't be asked, the screen opens as it would.
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [pathname, router, workspaceId]);
  return null;
}

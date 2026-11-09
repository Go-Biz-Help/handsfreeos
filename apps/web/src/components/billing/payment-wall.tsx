'use client';
import { BILLING_WORDS as W, money, paymentSkipUntil, type PaymentBlock } from '@hfos/core';
import { CircleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { Ok } from '@/lib/api/types';
import { writePaymentSkip } from '@/lib/payment-skip';
import { OwedPanel, usePlanCardReturn } from './billing-bits';

type Owed = NonNullable<Ok<'/v1/queries/billing.status'>['owed']>;

/**
 * What the failed-payment page shows (20261027023600): the payment that didn't go through and the ways out for whoever
 * manages money, who to ask for everyone else, and Skip for now while it may still be skipped.
 */
export function PaymentWall({
  workspaceId,
  owed,
  block,
  canManage,
  askWho,
  cardCount,
  others,
}: {
  workspaceId: string;
  owed: Owed;
  block: PaymentBlock;
  canManage: boolean;
  askWho: string | null;
  cardCount: number;
  /** The other businesses they're in, which they can open meanwhile. */
  others: readonly { readonly id: string; readonly name: string }[];
}) {
  const router = useRouter();
  const home = `/app/w/${workspaceId}`;
  const backIn = useCallback(() => {
    router.replace(home);
    router.refresh();
  }, [home, router]);
  usePlanCardReturn({ workspaceId, from: 'payment', onPaid: backIn });

  const skip = () => {
    writePaymentSkip(workspaceId, paymentSkipUntil(owed, new Date()));
    router.replace(home);
  };

  return (
    <Card className="w-full max-w-[560px] px-6 py-6" data-testid="payment-wall">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger-text" strokeWidth={2} />
        <h1 className="text-xl font-semibold leading-[1.3] tracking-[-0.01em]">{W.blockTitle}</h1>
      </div>
      <div className="mt-4">
        {canManage ? (
          <OwedPanel
            workspaceId={workspaceId}
            owed={owed}
            from="payment"
            hasCards={cardCount > 0}
            onPaid={backIn}
          />
        ) : (
          <div data-testid="payment-wall-ask">
            <p className="text-[13px]">{W.owedLine(owed.amountCents, owed.failedAt)}</p>
            <p className="mt-2 text-[13px] text-text-2">{W.blockNotManager(askWho)}</p>
            <p className="sr-only">{money(owed.amountCents)}</p>
          </div>
        )}
      </div>
      <div className="mt-6 border-t border-border pt-4">
        {block.canSkip ? (
          <>
            <p className="text-[13px] text-text-2">{W.blockSkipHint(block.lockedAt)}</p>
            <Button
              variant="secondary"
              className="mt-3"
              onClick={skip}
              data-testid="payment-wall-skip"
            >
              {W.skip}
            </Button>
          </>
        ) : (
          <p className="text-[13px] text-text-2" data-testid="payment-wall-locked">
            {W.blockLocked}
          </p>
        )}
        {others.length > 0 ? (
          <div className="mt-4">
            <p className="text-xs font-medium text-text-3">{W.otherBusiness}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {others.map((b) => (
                <ButtonLink key={b.id} href={`/app/w/${b.id}`} variant="ghost" size="sm">
                  {b.name}
                </ButtonLink>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

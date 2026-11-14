'use client';
/**
 * The stand-in for Stripe's page in a practice business (Admin → Try onboarding, 20261027027400): what a new customer
 * would pay, or the trial they'd start, and a button that does it with `practice.pay`. No card is charged and no
 * founding spot is used. Then on to the guided setup, as coming back from Stripe goes.
 */
import {
  FOUNDING_PICK_WORDS,
  PRACTICE_WORDS as W,
  money,
  type FoundingPickOffer,
} from '@hfos/core';
import { CreditCard } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FieldError } from '@/components/ui/field';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { foundingPlanHref } from '@/lib/founding-plan';

export function PracticeCheckout({
  workspaceId,
  business,
  offer,
  amountCents,
  trialDays,
}: {
  workspaceId: string;
  business: string;
  offer: Pick<FoundingPickOffer, 'offerId' | 'name' | 'billing'>;
  /** What the first charge would be: the plan's price, or less with a code. */
  amountCents: number;
  /** Days free first, when the plan or a code gives some. */
  trialDays: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/practice.pay', {
          body: { workspaceId, offerId: offer.offerId, trialDays },
        }),
      );
      router.replace(`/onboarding/${workspaceId}`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Card
      className="w-[480px] max-w-full rounded-dialog p-9 max-md:p-6"
      data-testid="practice-checkout"
    >
      <h1 className="text-2xl font-semibold leading-tight tracking-tight">{W.payTitle}</h1>
      <p className="mt-1.5 text-[13.5px] text-text-2">{W.payNote}</p>
      <div className="mt-6 flex flex-col gap-1 rounded-menu bg-card-2 px-4 py-3.5">
        <span className="text-[13px] text-text-3">{business}</span>
        <span className="text-[15px] font-semibold">
          {offer.name} · {money(amountCents)}{' '}
          <span className="font-normal text-text-2">{FOUNDING_PICK_WORDS.per(offer.billing)}</span>
        </span>
      </div>
      <div className="mt-4 flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">{W.payCard}</span>
        <div className="flex h-11 items-center gap-2.5 rounded-control border border-border bg-card-2 px-3 text-[14px] text-text-3">
          <CreditCard className="h-4 w-4" strokeWidth={1.5} />
          4242 4242 4242 4242
        </div>
      </div>
      <FieldError>{error}</FieldError>
      <Button
        size="lg"
        className="mt-5 w-full"
        loading={busy}
        onClick={() => void pay()}
        data-testid="practice-checkout-pay"
      >
        {busy ? W.paying : trialDays ? W.trialButton(trialDays) : W.payButton(money(amountCents))}
      </Button>
      <p className="mt-3.5 text-center text-[13px]">
        <Link href={foundingPlanHref(workspaceId)} className="text-accent-text hover:underline">
          {W.back}
        </Link>
      </p>
    </Card>
  );
}

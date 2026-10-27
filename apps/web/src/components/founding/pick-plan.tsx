'use client';

/**
 * Picking a founding spot and paying for it, straight after signing up (20261027012700): $497 a year or $97 a month,
 * first come, first served.
 *
 * Nothing here decides whether there is a spot. The counts are shown; pressing Pay holds one in the database, under
 * the cap's lock, or comes back saying they're gone. The payment itself is the page every founding payment uses: it
 * waits for Stripe's page, sends them there, and waits for Stripe's word when they come back.
 */
import { FOUNDING_PICK_WORDS as W, foundingPrice, type FoundingPickOffer } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { forgetOthersSearches } from '@/components/search/search-provider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FieldError } from '@/components/ui/field';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { supabaseBrowser } from '@/lib/supabase/client';

export function PickPlan({
  workspaceId,
  business,
  offers,
  first,
  canPay,
}: {
  workspaceId: string;
  /** The business's name, as they typed it a moment ago. */
  business: string;
  /** The spots on sale (`foundingPickable`), cheapest first. */
  offers: readonly FoundingPickOffer[];
  /** The one picked to start with: the website's choice, or the first with room. */
  first: string;
  /** Whether this person may pay for the business (`money.manage`). */
  canPay: boolean;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = offers.find((o) => o.offerId === picked && o.remaining > 0) ?? null;
  const noneLeft = offers.every((o) => o.remaining <= 0);

  const pay = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/founding.buy', {
          body: { workspaceId, offerId: chosen.offerId },
        }),
      );
      router.push(`/founding/checkout/${out.checkoutId}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      // The counts may have moved: somebody took the last spot, or the other plan is the one left.
      router.refresh();
    }
  };

  return (
    <Card
      className="w-[560px] max-w-full rounded-dialog p-9 max-md:p-6"
      data-testid="founding-plan"
    >
      <h1 className="text-2xl font-semibold leading-tight tracking-tight">{W.title}</h1>
      <p className="mt-1.5 text-[13.5px] text-text-2">{W.sub(business)}</p>

      {!canPay ? (
        <p
          className="mt-6 rounded-menu bg-card-2 px-4 py-3.5 text-[13.5px] text-text-2"
          data-testid="founding-plan-not-yours"
        >
          {W.notYours(business)}
        </p>
      ) : noneLeft ? (
        <p
          className="mt-6 rounded-menu bg-warning-soft px-4 py-3.5 text-[13.5px] text-warning-text"
          data-testid="founding-plan-none-left"
        >
          {W.noneLeft}
        </p>
      ) : (
        <>
          <div className="mt-6 flex flex-col gap-2.5" role="radiogroup" aria-label={W.title}>
            {offers.map((o) => (
              <RadioCard
                key={o.offerId}
                selected={o.offerId === chosen?.offerId}
                onSelect={() => {
                  if (o.remaining > 0) setPicked(o.offerId);
                }}
                className={o.remaining > 0 ? undefined : 'cursor-not-allowed opacity-60'}
                testId={`founding-plan-${o.offerId}`}
                title={
                  <>
                    {foundingPrice(o.priceCents)}{' '}
                    <span className="font-normal text-text-2">{W.per(o.billing)}</span>
                  </>
                }
                description={
                  <>
                    {o.name} · {o.remaining > 0 ? W.left(o.remaining, o.seatCap) : W.full}
                    <br />
                    {W.renews(o.billing)}
                  </>
                }
              />
            ))}
          </div>
          <FieldError>{error}</FieldError>
          <Button
            size="lg"
            className="mt-5 w-full"
            loading={busy}
            disabled={!chosen}
            data-testid="founding-plan-pay"
            onClick={() => void pay()}
          >
            {busy ? W.paying : W.pay(chosen?.priceCents ?? 0)}
          </Button>
          <p className="mt-3.5 text-center text-xs text-text-3">{W.fine}</p>
        </>
      )}
    </Card>
  );
}

/** The plan page's way out: there's nothing else to go to until a spot is paid for. */
export function PlanSignOut() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      data-testid="founding-plan-sign-out"
      onClick={async () => {
        forgetOthersSearches(null);
        await supabaseBrowser().auth.signOut();
        router.replace('/sign-in');
        router.refresh();
      }}
    >
      {W.signOut}
    </Button>
  );
}

'use client';
import { FOUNDING_PLAN_WORDS, type FoundingPlanFacts } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * A founding seat paid by the year (20261027009400), on Settings → Usage & balance: when it renews and for how much,
 * stopping it renewing (or starting it again while the year is paid for), and paying a refused renewal with another
 * card. That payment is a founding checkout like the first one, so it goes through the same page that waits for
 * Stripe and sends them there.
 */
export function FoundingPlanCard({
  workspaceId,
  plan,
}: {
  workspaceId: string;
  plan: FoundingPlanFacts & { readonly paidThrough: string };
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<'stop' | 'keep' | 'pay' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setRenewing = async (renewing: boolean) => {
    setBusy(renewing ? 'keep' : 'stop');
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/founding.set_renewing', {
          body: { workspaceId, renewing },
        }),
      );
      setAsking(false);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const pay = async () => {
    setBusy('pay');
    setError(null);
    try {
      const started = unwrap(
        await apiBrowser().POST('/v1/commands/founding.pay_renewal', { body: { workspaceId } }),
      );
      // The page that waits for Stripe's address, then sends them there; and the one they come back to.
      router.push(`/founding/checkout/${started.checkoutId}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  const refused = plan.renewalProblem !== null;

  return (
    <Card id="founding" className="px-[22px] py-5" data-testid="usage-founding">
      <h2 className="text-lg font-semibold leading-[1.3] tracking-[-0.005em]">
        {FOUNDING_PLAN_WORDS.title}
      </h2>
      <p className="mt-1 max-w-[460px] text-[13px] text-text-2">
        {FOUNDING_PLAN_WORDS.price(plan.priceCents)}
      </p>

      {refused ? (
        <p className="mt-4 rounded-[10px] bg-danger-soft px-3.5 py-3 text-[13px] text-danger-text">
          {FOUNDING_PLAN_WORDS.refused(plan.renewalProblem ?? '')}
        </p>
      ) : (
        <p className="mt-4 text-[13px]" data-testid="usage-founding-line">
          {plan.renewing
            ? FOUNDING_PLAN_WORDS.renews(plan.paidThrough, plan.priceCents)
            : FOUNDING_PLAN_WORDS.stopped(plan.paidThrough)}
        </p>
      )}
      {error && !asking ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {refused ? (
          <Button onClick={pay} disabled={busy !== null} data-testid="usage-founding-pay">
            {busy === 'pay' ? FOUNDING_PLAN_WORDS.paying : FOUNDING_PLAN_WORDS.pay}
          </Button>
        ) : null}
        {plan.renewing ? (
          <Button
            variant="secondary"
            onClick={() => {
              setError(null);
              setAsking(true);
            }}
            disabled={busy !== null}
            data-testid="usage-founding-stop"
          >
            {FOUNDING_PLAN_WORDS.stop}
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => setRenewing(true)}
            disabled={busy !== null}
            data-testid="usage-founding-keep"
          >
            {FOUNDING_PLAN_WORDS.keep}
          </Button>
        )}
      </div>

      <Dialog open={asking} onOpenChange={(o) => (o ? null : setAsking(false))}>
        <DialogContent
          title={FOUNDING_PLAN_WORDS.stopTitle}
          description={FOUNDING_PLAN_WORDS.stopDescription(plan.paidThrough)}
        >
          {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {FOUNDING_PLAN_WORDS.cancel}
            </Button>
            <Button
              onClick={() => setRenewing(false)}
              disabled={busy !== null}
              data-testid="usage-founding-stop-confirm"
            >
              {busy === 'stop' ? FOUNDING_PLAN_WORDS.stopping : FOUNDING_PLAN_WORDS.stopConfirm}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

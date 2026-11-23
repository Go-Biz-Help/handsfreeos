'use client';
import { PAYMENTS_SETUP_WORDS as P, WIZARD_WORDS } from '@hfos/core';
import { ArrowRight, Clock, Wallet } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { PAYMENT_RESULT, PROVIDER_NAME } from '@/components/settings/payment-connection-card';
import { ButtonLink } from '@/components/ui/button';
import { setupHref } from '@/lib/setup';

/**
 * The wizard's payments step (board 5b): the guided payments setup (the owner, 23 Nov 2026, "a" on picks P1 to P4)
 * on a page of its own, seven questions and then the Stripe or Square sign-in, which comes back to its Done screen
 * and from there here. A sign-in started from this step before the guided setup still comes back here, with
 * `?payments=` saying how it went.
 */
export function PaymentsSetup({
  workspaceId,
  said,
  waiting,
  result,
  started,
}: {
  workspaceId: string;
  /** "Getting paid" was the answer to what matters most. */
  said: boolean;
  /** An account connected and still being checked by the provider. */
  waiting: string | null;
  /** `?payments=` from the sign-in. */
  result: string | null;
  /** The guided setup has answers saved: it picks up where they left off. */
  started: boolean;
}) {
  const router = useRouter();

  const told = useRef(false);
  useEffect(() => {
    if (!result || told.current) return;
    told.current = true;
    const r = PAYMENT_RESULT[result] ?? PAYMENT_RESULT.failed!;
    if (r.tone === 'success') toast.success(r.text);
    else if (r.tone === 'error') toast.error(r.text);
    else toast(r.text);
    router.replace(setupHref(workspaceId, 'payments'), { scroll: false });
  }, [result, router, workspaceId]);

  if (waiting)
    return (
      <div
        className="flex items-start gap-3 rounded-menu bg-warning-soft px-4 py-3.5 text-[13.5px] text-warning-text"
        data-testid="setup-payments-waiting"
      >
        <Clock className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
        {WIZARD_WORDS.paymentsWaiting(PROVIDER_NAME[waiting] ?? waiting)}
      </div>
    );

  return (
    <>
      {said ? <p className="-mt-2 text-[13.5px] text-text-2">{WIZARD_WORDS.paymentsSaid}</p> : null}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-menu border border-border bg-card px-4 py-4"
        data-testid="setup-payments-guided"
      >
        <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-[10px] bg-accent-soft text-accent-text">
          <Wallet className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <span className="flex min-w-0 flex-1 basis-[240px] flex-col gap-0.5">
          <span className="text-[15px] font-semibold">{P.summary.setUp}</span>
          <span className="text-[13.5px] text-text-2">{P.summary.setUpHint}</span>
        </span>
        <ButtonLink
          href={`/onboarding/${workspaceId}/payments?from=setup`}
          variant="primary"
          data-testid="setup-payments-start"
        >
          {started ? P.summary.resume : P.summary.start}
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </ButtonLink>
      </div>
    </>
  );
}

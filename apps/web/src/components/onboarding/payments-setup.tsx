'use client';
import { WIZARD_WORDS } from '@hfos/core';
import { Clock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  connectPaymentAccount,
  PAYMENT_RESULT,
  PROVIDER_NAME,
} from '@/components/settings/payment-connection-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RadioCard } from '@/components/ui/radio-card';
import { errorMessage } from '@/lib/api/client';
import { keepSetupReturn } from '@/lib/setup-return';
import { setupHref } from '@/lib/setup';

type Provider = 'stripe' | 'square';

/**
 * The wizard's payments step (board 5b): Stripe or Square, through the same sign-in as Settings → Payments. The
 * sign-in comes back here rather than to Settings (`keepSetupReturn`), with `?payments=` saying how it went.
 */
export function PaymentsSetup({
  workspaceId,
  said,
  waiting,
  result,
}: {
  workspaceId: string;
  /** "Getting paid" was the answer to what matters most. */
  said: boolean;
  /** An account connected and still being checked by the provider. */
  waiting: string | null;
  /** `?payments=` from the sign-in. */
  result: string | null;
}) {
  const router = useRouter();
  const [provider, setProvider] = useState<Provider>('stripe');
  const [busy, setBusy] = useState(false);

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

  const connect = () => {
    setBusy(true);
    keepSetupReturn(workspaceId, 'payments');
    connectPaymentAccount(workspaceId, provider).catch((e: unknown) => {
      toast.error(errorMessage(e));
      setBusy(false);
    });
  };

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
        role="radiogroup"
        aria-label={WIZARD_WORDS.titles.payments}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {(['stripe', 'square'] as const).map((p) => {
          const words = WIZARD_WORDS.providers[p];
          return (
            <RadioCard
              key={p}
              selected={provider === p}
              onSelect={() => setProvider(p)}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {words.title}
                  {'badge' in words ? <Badge variant="gray">{words.badge}</Badge> : null}
                </span>
              }
              description={words.detail}
              testId={`setup-payments-${p}`}
            />
          );
        })}
      </div>
      <div>
        <Button loading={busy} onClick={connect} data-testid="setup-payments-connect">
          {WIZARD_WORDS.connect(WIZARD_WORDS.providers[provider].title)}
        </Button>
      </div>
    </>
  );
}

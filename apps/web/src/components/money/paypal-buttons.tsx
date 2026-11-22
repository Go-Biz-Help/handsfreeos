'use client';
/**
 * PayPal's buttons on a customer's page (PayPal plan, part 4): PayPal, Venmo, Pay Later and PayPal's own card
 * button, as the business left them on in Settings → Payments. They sit beside Stripe's or Square's fields, or
 * stand alone when PayPal is the account the money goes to.
 *
 * Pressing one asks the worker for the order (phase one, `method: 'paypal'`); PayPal's window approves it; phase
 * two names the order, and the worker captures it and reads the answer back from PayPal. The page never decides
 * on its own that anything was paid.
 *
 * With the stand-in provider (development and tests) there is no PayPal script, so a plain PayPal button goes to
 * the stand-in's own page instead, and comes back through the page's address like any provider that sends the
 * customer away.
 */
import { CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { loadPayPal, type PayPalButtonsConfig } from '@/lib/payments/provider-scripts';

export type { PayPalButtonsConfig };

/** What phase one answered: PayPal's order to approve, the stand-in's page, or nothing (the page said why). */
export type PayPalStart = { readonly orderId: string } | { readonly hostedUrl: string } | null;

const NOT_REACHED = 'We couldn’t reach PayPal, so nothing was charged. Try again in a minute.';

export function PayPalButtons({
  config,
  disabled,
  start,
  approved,
  cancelled,
  failed,
}: {
  config: PayPalButtonsConfig;
  disabled: boolean;
  start(): Promise<PayPalStart>;
  approved(orderId: string): void;
  cancelled(): void;
  failed(message: string): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [going, setGoing] = useState(false);
  // The latest handlers, so PayPal's buttons (drawn once) always call into the page as it is now.
  const calls = useRef({ start, approved, cancelled, failed });
  calls.current = { start, approved, cancelled, failed };

  const { standIn, clientId, merchantId, partnerAttributionId, intent, venmo, payLater } = config;

  useEffect(() => {
    if (standIn || !box.current) return;
    const target = box.current;
    let live = true;
    let close: (() => Promise<void>) | undefined;
    setProblem(null);
    loadPayPal({ clientId, merchantId, partnerAttributionId, intent, venmo, payLater })
      .then(async (paypal) => {
        if (!live) return;
        const buttons = paypal.Buttons({
          style: { layout: 'vertical', shape: 'rect', label: 'pay', height: 45 },
          async createOrder() {
            const got = await calls.current.start();
            if (got && 'orderId' in got) return got.orderId;
            // Nothing for PayPal to open: the page already said why, or is on its way elsewhere.
            if (got && 'hostedUrl' in got) window.location.assign(got.hostedUrl);
            throw new Error('no order');
          },
          async onApprove(data) {
            calls.current.approved(data.orderID);
          },
          onCancel() {
            calls.current.cancelled();
          },
          onError(err) {
            // Our own "no order" above is not PayPal's failure: the page has already said what happened.
            if (err instanceof Error && err.message === 'no order') return;
            calls.current.failed(NOT_REACHED);
          },
        });
        close = buttons.close?.bind(buttons);
        target.replaceChildren();
        await buttons.render(target);
      })
      .catch(() => live && setProblem(NOT_REACHED));
    return () => {
      live = false;
      void close?.().catch(() => undefined);
    };
  }, [standIn, clientId, merchantId, partnerAttributionId, intent, venmo, payLater]);

  if (standIn)
    return (
      <Button
        size="lg"
        variant="secondary"
        className="w-full"
        loading={going}
        disabled={disabled}
        onClick={() => {
          setGoing(true);
          void calls.current
            .start()
            .then((got) => {
              if (got && 'hostedUrl' in got) window.location.assign(got.hostedUrl);
              else setGoing(false);
            })
            .catch(() => setGoing(false));
        }}
        data-testid="pay-paypal"
      >
        PayPal
      </Button>
    );

  return (
    <div className="flex flex-col gap-2" data-testid="pay-paypal">
      <div
        ref={box}
        aria-busy={!problem && !box.current?.childElementCount}
        className={disabled ? 'pointer-events-none opacity-60' : undefined}
      />
      {problem ? (
        <p className="flex items-start gap-1.5 text-[13px] text-danger-text" role="alert">
          <CircleAlert size={15} className="mt-0.5 flex-none" aria-hidden />
          {problem}
        </p>
      ) : null}
    </div>
  );
}

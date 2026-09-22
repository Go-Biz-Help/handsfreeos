'use client';

/**
 * Where a founding seat's payment has got to (0093), for the person paying.
 *
 * Two jobs. On the way out it waits for the worker to make Stripe's page and then sends them there. On the way
 * back it waits for **Stripe's own event** to turn the seat on — being sent back to this page proves nothing,
 * since anybody can type its address, so the page only ever reads what the database says.
 */
import { CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ButtonLink } from '@/components/ui/button';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { WORKSPACE_COOKIE } from '@/lib/workspace-cookie';

type Status = Ok<'/v1/queries/founding.checkout_status'>;

/** How often, and for how long, before saying it is taking longer than it should. */
const EVERY_MS = 1500;
const PATIENCE = 40;

const Note = ({
  tone,
  icon,
  children,
  testId,
}: {
  tone: 'wait' | 'good' | 'warn';
  icon: React.ReactNode;
  children: React.ReactNode;
  testId: string;
}) => (
  <div
    data-testid={testId}
    className={`mt-6 flex gap-3 rounded-menu px-4 py-3.5 text-[13.5px] leading-relaxed ${
      tone === 'good'
        ? 'bg-success-soft text-success-text'
        : tone === 'warn'
          ? 'bg-warning-soft text-warning-text'
          : 'bg-card-2 text-text-2'
    }`}
  >
    {icon}
    <span>{children}</span>
  </div>
);

export function CheckoutStatus({
  initial,
  back,
}: {
  initial: Status;
  /** Where Stripe sent them back from: the page after paying, the page after giving up, or neither. */
  back: 'paid' | 'cancel' | null;
}) {
  const [s, setS] = useState(initial);
  const [asked, setAsked] = useState(0);
  const [leaving, setLeaving] = useState(false);

  const waiting =
    s.status === 'pending' ||
    (s.status === 'open' && back === 'paid') ||
    (s.status === 'paid' && !s.seatActive && !s.problem);

  useEffect(() => {
    if (!waiting || asked >= PATIENCE) return;
    const t = setTimeout(async () => {
      try {
        const next = unwrap(
          await apiBrowser().POST('/v1/queries/founding.checkout_status', {
            body: { checkoutId: s.checkoutId },
          }),
        );
        setS(next);
      } catch {
        // A blip: the next round asks again.
      }
      setAsked((n) => n + 1);
    }, EVERY_MS);
    return () => clearTimeout(t);
  }, [waiting, asked, s.checkoutId]);

  // On the way out, straight to Stripe the moment the page exists.
  useEffect(() => {
    if (s.status === 'open' && s.url && back === null && !leaving) {
      setLeaving(true);
      window.location.assign(s.url);
    }
  }, [s.status, s.url, back, leaving]);

  const spinner = (
    <Loader2 className="h-[18px] w-[18px] flex-none animate-spin" strokeWidth={1.5} />
  );
  const clock = <Clock className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />;

  if (s.seatActive)
    return (
      <>
        <Note
          tone="good"
          testId="checkout-done"
          icon={<CheckCircle2 className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />}
        >
          Paid, and it’s yours: {s.offerName}, for as long as HandsFreeOS exists. A receipt is on
          its way from Stripe.
        </Note>
        <ButtonLink
          href={`/app/w/${s.workspaceId}`}
          variant="primary"
          size="lg"
          className="mt-5 w-full"
          onClick={() => {
            document.cookie = `${WORKSPACE_COOKIE}=${s.workspaceId}; path=/; max-age=31536000; samesite=lax`;
          }}
        >
          Open your workspace
        </ButtonLink>
      </>
    );

  if (s.status === 'paid')
    return s.problem ? (
      <Note tone="warn" testId="checkout-stranded" icon={clock}>
        Your payment went through, but we couldn’t turn the seat on by ourselves. We’ve been told
        and will sort it out with you — you won’t be charged again.
      </Note>
    ) : (
      <Note tone="wait" testId="checkout-finishing" icon={spinner}>
        Payment received. Turning your seat on…
      </Note>
    );

  if (s.status === 'expired' || s.status === 'failed')
    return (
      <Note tone="warn" testId={`checkout-${s.status}`} icon={clock}>
        {s.problem || 'This payment didn’t go through, and nothing was taken.'} Open your claim link
        again to start over.
      </Note>
    );

  if (asked >= PATIENCE)
    return (
      <Note tone="warn" testId="checkout-slow" icon={clock}>
        This is taking longer than it should. Refresh this page in a minute — nothing is lost, and
        you won’t be charged twice.
      </Note>
    );

  if (s.status === 'pending')
    return (
      <Note tone="wait" testId="checkout-preparing" icon={spinner}>
        Getting your secure payment page ready…
      </Note>
    );

  // Open: waiting on Stripe's word, back from giving up, or on the way there.
  if (back === 'paid')
    return (
      <Note tone="wait" testId="checkout-confirming" icon={spinner}>
        Checking with Stripe…
      </Note>
    );
  if (back === 'cancel')
    return (
      <>
        <Note tone="warn" testId="checkout-cancelled" icon={clock}>
          You didn’t finish paying, and nothing was taken. Your seat is still held for you.
        </Note>
        {s.url ? (
          <ButtonLink href={s.url} variant="primary" size="lg" className="mt-5 w-full">
            Go back to paying
          </ButtonLink>
        ) : null}
      </>
    );
  return (
    <>
      <Note tone="wait" testId="checkout-leaving" icon={spinner}>
        Taking you to Stripe’s secure page…
      </Note>
      {s.url ? (
        <ButtonLink href={s.url} variant="secondary" size="lg" className="mt-5 w-full">
          Go now
        </ButtonLink>
      ) : null}
    </>
  );
}
